import Foundation

/// The assistant's local web service, run as a child of the app.
///
/// It used to be a separate launchd agent started by the installer, which made
/// MeetOnTrack three things: a recorder, a background service and a browser
/// tab. Now the Python runtime and the web payload live inside the bundle
/// (`Contents/Resources/payload`), the app starts the server when it starts,
/// starts it again if it dies or stops answering, and stops it when it quits.
/// The window can be closed meanwhile: the server belongs to the app, not to
/// the window, so recording and analysis keep going from the menu bar.
///
/// The server also exits by itself when the app disappears without stopping
/// it (`--exit-with-parent` watches its stdin, the write end of which only this
/// process holds), so a crash never leaves an orphan holding the port.
///
/// The port is 43121 unless something else holds it (MEETONTRACK-130): a stale
/// MeetOnTrack service is stopped and the port taken over; any other program is
/// left alone and the service runs on a free port instead. The port in use is
/// recorded in `server-port` next to the log for the installer and the CLI.
@MainActor
final class LocalServer {
    nonisolated static let defaultPort = 43121
    private(set) var port: Int
    var url: URL { URL(string: "http://127.0.0.1:\(port)/")! }
    static let shared = LocalServer(
        command: bundledCommand(),
        expectedVersion: Runtime.appBundle?.infoDictionary?["CFBundleShortVersionString"] as? String)

    /// What `/api/health` reports: the version, and the launch token the app gave its
    /// own child, so another server on the port is never taken for it (MEETONTRACK-116).
    struct Health: Sendable {
        var version: String
        var instance: String
    }

    nonisolated static let instanceVariable = "MEETONTRACK_INSTANCE"

    struct Command {
        var executable: URL
        var arguments: [String]
        var environment: [String: String]
        var directory: URL
        var log: URL
    }

    /// A healthy server that stops answering for this long is restarted.
    var hangLimit: TimeInterval = 60
    var checkInterval: TimeInterval = 2

    private let command: Command?
    /// The version the bundled server reports. A server on the port that
    /// reports another one (a 0.1.18 launchd agent that outlived the upgrade)
    /// is not ours and is never used: its files may already be gone.
    private let expectedVersion: String?
    /// This app run's token, handed to the child in its environment.
    let instance: String
    private let probe: @Sendable (Int) async -> Health?
    private var process: Process?
    private var stdin: Pipe?
    private var timer: Timer?
    private var probing = false
    private var stopping = false
    private var nextLaunch = Date.distantPast
    private var crashes = 0
    /// Last time the server answered, or when it was launched: a server that
    /// never answers after starting is as hung as one that stopped answering.
    private var lastAlive: Date?
    private var waiters: [() -> Void] = []
    private var readyObservers: [() -> Void] = []
    private var troubleWaiters: [() -> Void] = []
    /// Stale MeetOnTrack services stopped on this port; after two the port is given up.
    private var evictions = 0
    private(set) var isReady = false
    /// Neither the usual port nor a free one gave a working service: the window says so.
    private(set) var cannotStart = false
    private(set) var launches = 0
    var pid: pid_t? { process?.processIdentifier }

    init(command: Command?, expectedVersion: String? = nil, instance: String = UUID().uuidString,
         port: Int = LocalServer.defaultPort,
         probe: @escaping @Sendable (Int) async -> Health? = { await LocalServer.health(port: $0) }) {
        self.command = command
        self.port = port
        self.expectedVersion = expectedVersion
        self.instance = instance
        self.probe = probe
    }

    /// Ours: the bundled app adopts only its own child; a build without a payload
    /// (`swift run`) has no child and uses whatever answers.
    func isOurs(_ health: Health?) -> Bool {
        guard let health else { return false }
        if let expectedVersion, health.version != expectedVersion { return false }
        return command == nil || health.instance == instance
    }

    /// Whether this copy can run a server at all: a bare `swift run` build has
    /// no payload, and then the window simply connects to whatever is there.
    var isBundled: Bool { command != nil }

    func start() {
        guard timer == nil else { return }
        stopping = false
        check()
        let timer = Timer(timeInterval: checkInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.check() }
        }
        // Common modes: keep supervising while a modal dialog is up.
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    /// Run `action` once the server answers; at once if it already does.
    func whenReady(_ action: @escaping () -> Void) {
        if isReady { action() } else { waiters.append(action) }
    }

    /// Run `action` every time the service becomes ready again (it may be on another port then).
    func onEveryReady(_ action: @escaping () -> Void) {
        readyObservers.append(action)
    }

    /// Run `action` whenever the service turns out not to start at all (at once if that is already known).
    func whenCannotStart(_ action: @escaping () -> Void) {
        if cannotStart { action() } else { troubleWaiters.append(action) }
    }

    /// Stop on quit: SIGINT lets the server close its socket and state files
    /// (it treats it as Ctrl-C); a server that has not gone in `grace` is killed.
    func stop(grace: TimeInterval = 4) {
        stopping = true
        timer?.invalidate()
        timer = nil
        guard let process, process.isRunning else { return }
        let pid = process.processIdentifier
        process.interrupt()
        let deadline = Date().addingTimeInterval(grace)
        while process.isRunning, Date() < deadline { usleep(50_000) }
        if process.isRunning { kill(pid, SIGKILL) }
        process.waitUntilExit()
        Self.killGroup(pid)
        self.process = nil
        stdin = nil
    }

    /// The server leads its own process group (`--exit-with-parent`); whatever it
    /// started and left running goes with it (MEETONTRACK-114). While any member
    /// lives no other process can get this id, so this never hits a stranger.
    nonisolated static func killGroup(_ pid: pid_t) {
        guard pid > 1 else { return }
        kill(-pid, SIGKILL)
    }

    private func check() {
        guard !probing, !stopping else { return }
        probing = true
        let probe = self.probe, port = self.port
        Task { @MainActor [weak self] in
            let health = await probe(port)
            guard let self else { return }
            self.probing = false
            guard port == self.port else { return }
            self.observe(health)
        }
    }

    private func observe(_ health: Health?) {
        guard !stopping else { return }
        if isOurs(health) {
            lastAlive = Date()
            crashes = 0
            if !isReady {
                isReady = true
                cannotStart = false
                recordPort()
                let ready = waiters
                waiters = []
                ready.forEach { $0() }
                readyObservers.forEach { $0() }
            }
            return
        }
        isReady = false
        if let process, process.isRunning {
            // Answering nothing for a minute is a hang, not a busy moment:
            // every request, health included, has its own thread.
            if let lastAlive, Date().timeIntervalSince(lastAlive) > hangLimit {
                FileHandle.standardError.write(Data("assistant server stopped answering; restarting\n".utf8))
                self.lastAlive = nil
                kill(process.processIdentifier, SIGKILL)
                Self.killGroup(process.processIdentifier)
            }
            return
        }
        guard command != nil, Date() >= nextLaunch, claimPort(health) else { return }
        launch()
    }

    /// Before a launch: is the port ours to take? (MEETONTRACK-130.) A MeetOnTrack service
    /// of this user that is not this run's child (an older version, a previous launch) is
    /// stopped, gently and then for good; it shares this user's archive, so a second server
    /// never runs beside it: one that will not go is reported instead. A port held by
    /// anything else (or by another user's service, which lsof cannot see) is left alone
    /// and a free port is used instead.
    private func claimPort(_ health: Health?) -> Bool {
        if health == nil, Self.isFree(port) { return true }
        // A hung service answers no health check: its command line still tells.
        if let pid = Self.listener(port), pid != getpid(), health != nil || Self.isAssistantServer(pid) {
            guard evictions < 2 else {
                giveUp()
                return false
            }
            evictions += 1
            FileHandle.standardError.write(Data("stopping a stale assistant server (pid \(pid))\n".utf8))
            kill(pid, evictions == 1 ? SIGINT : SIGKILL)
            nextLaunch = Date().addingTimeInterval(1)
            return false
        }
        guard let free = Self.freePort() else {
            giveUp()
            return false
        }
        FileHandle.standardError.write(Data("port \(port) is held by another program; using \(free)\n".utf8))
        port = free
        evictions = 0
        return true
    }

    private func giveUp() {
        guard !cannotStart else { return }
        cannotStart = true
        troubleWaiters.forEach { $0() }
    }

    /// For the installer and `meeting-copilot`, which cannot ask the app; they check it answers.
    private func recordPort() {
        guard let command else { return }
        try? Data("\(port)\n".utf8).write(to: command.directory.appendingPathComponent("server-port"), options: .atomic)
    }

    /// Whether a listener could bind 127.0.0.1:`port` now, the way server.py binds (SO_REUSEADDR).
    nonisolated static func isFree(_ port: Int) -> Bool {
        bound(port) != nil
    }

    /// A port nobody listens on, picked by the system.
    nonisolated static func freePort() -> Int? {
        bound(0)
    }

    private nonisolated static func bound(_ port: Int) -> Int? {
        let socket = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socket >= 0 else { return nil }
        defer { close(socket) }
        var reuse: Int32 = 1
        setsockopt(socket, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let result = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                bind(socket, pointer, length) == 0 && getsockname(socket, pointer, &length) == 0
            }
        }
        return result ? Int(UInt16(bigEndian: address.sin_port)) : nil
    }

    /// Whether `pid` runs a MeetOnTrack server.py: the bundled one, the retired launchd agent's
    /// copy, or one started by hand from a checkout under any name (`python3 web/server.py`).
    nonisolated static func isAssistantServer(_ pid: pid_t) -> Bool {
        let command = run("/bin/ps", ["-o", "command=", "-p", String(pid)])
        if command.contains("/web/server.py")
            && (command.contains("Meeting Copilot Capture.app") || command.contains("meeting-copilot")) {
            return true
        }
        // ponytail: space-split arguments; a script path with spaces is caught by the check above only.
        // The script the interpreter runs: its first argument that is not an option (`python3 -B web/server.py`).
        guard let script = command.split(whereSeparator: \.isWhitespace).dropFirst().first(where: { !$0.hasPrefix("-") }),
              script.hasSuffix("server.py"), let cwd = workingDirectory(pid) else { return false }
        let path = URL(fileURLWithPath: String(script), relativeTo: URL(fileURLWithPath: cwd, isDirectory: true))
            .standardizedFileURL
        // The service's own neighbour, so an unrelated server.py is not mistaken for it.
        return path.path.hasSuffix("/web/server.py")
            && FileManager.default.fileExists(atPath: path.deletingLastPathComponent()
                .appendingPathComponent("ai_providers.py").path)
    }

    /// The working directory of `pid`, if this user may see it.
    private nonisolated static func workingDirectory(_ pid: pid_t) -> String? {
        run("/usr/sbin/lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"])
            .split(separator: "\n").first(where: { $0.hasPrefix("n") }).map { String($0.dropFirst()) }
    }

    private nonisolated static func run(_ tool: String, _ arguments: [String]) -> String {
        let process = Process(), output = Pipe()
        process.executableURL = URL(fileURLWithPath: tool)
        process.arguments = arguments
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return "" }
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self)
    }

    /// The process listening on `port`, if this user may see it.
    nonisolated static func listener(_ port: Int) -> pid_t? {
        // The address probed, not ::1.
        run("/usr/sbin/lsof", ["-nP", "-t", "-iTCP@127.0.0.1:\(port)", "-sTCP:LISTEN"])
            .split(separator: "\n").first.flatMap { pid_t($0) }
    }

    private func launch() {
        guard let command else { return }
        let process = Process()
        process.executableURL = command.executable
        var arguments = command.arguments
        if let index = arguments.firstIndex(of: "--port"), index + 1 < arguments.count {
            arguments[index + 1] = String(port)
        }
        process.arguments = arguments
        process.environment = command.environment.merging([Self.instanceVariable: instance]) { _, own in own }
        process.currentDirectoryURL = command.directory
        let input = Pipe()
        process.standardInput = input
        if let log = Self.openLog(command.log) {
            process.standardOutput = log
            process.standardError = log
        }
        process.terminationHandler = { [weak self] ended in
            let pid = ended.processIdentifier, status = ended.terminationStatus
            // At once, not later on the main actor: a crashed server's helpers must not
            // outlive it, and its group id must not have been reused meanwhile.
            Self.killGroup(pid)
            Task { @MainActor in self?.ended(pid: pid, status: status) }
        }
        do {
            try process.run()
        } catch {
            FileHandle.standardError.write(Data("could not start the assistant server: \(error)\n".utf8))
            crashes += 1
            nextLaunch = Date().addingTimeInterval(Self.backoff(crashes))
            return
        }
        launches += 1
        lastAlive = Date()
        self.process = process
        stdin = input
    }

    private func ended(pid: Int32, status: Int32) {
        guard process?.processIdentifier == pid else { return }
        process = nil
        stdin = nil
        isReady = false
        guard !stopping else { return }
        crashes += 1
        nextLaunch = Date().addingTimeInterval(Self.backoff(crashes))
        FileHandle.standardError.write(Data("assistant server exited (\(status)); restarting\n".utf8))
        if crashes >= 4 { giveUp() }  // still retried; the window says what to do meanwhile
    }

    /// 1, 2, 4 … 30 seconds: a server that crashes on start must not spin.
    nonisolated static func backoff(_ crashes: Int) -> TimeInterval {
        min(30, pow(2, Double(max(0, crashes - 1))))
    }

    /// What a MeetOnTrack server on the port reports, or nil.
    nonisolated static func health(port: Int) async -> Health? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/health") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        guard value["ok"] as? Bool == true, value["service"] as? String == "meeting-copilot" else { return nil }
        return Health(version: value["version"] as? String ?? "", instance: value["instance"] as? String ?? "")
    }

    private static func openLog(_ url: URL) -> FileHandle? {
        let manager = FileManager.default
        try? manager.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        // ponytail: truncate at 10 MB instead of rotating; rotate if anyone needs history.
        if let size = (try? manager.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 10_000_000 {
            try? manager.removeItem(at: url)
        }
        if !manager.fileExists(atPath: url.path) { manager.createFile(atPath: url.path, contents: nil) }
        let handle = try? FileHandle(forWritingTo: url)
        _ = try? handle?.seekToEnd()
        return handle
    }

    /// The bundled runtime and payload, or nil for a build without them.
    nonisolated static func bundledCommand(
        resources: URL? = Runtime.appBundle?.resourceURL,
        home: URL = FileManager.default.homeDirectoryForCurrentUser,
        environment: [String: String] = ProcessInfo.processInfo.environment
    ) -> Command? {
        guard let payload = resources?.appendingPathComponent("payload") else { return nil }
        let python = payload.appendingPathComponent("python/bin/python3")
        let server = payload.appendingPathComponent("web/server.py")
        guard FileManager.default.isExecutableFile(atPath: python.path),
              FileManager.default.fileExists(atPath: server.path) else { return nil }
        let data = home.appendingPathComponent(".local/share/meeting-copilot")
        var env = environment
        // An app started by LaunchServices gets a bare PATH; AI tools live in
        // Homebrew and ~/.local/bin, as the retired launchd agent knew.
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:"
            + home.appendingPathComponent(".local/bin").path
        // The payload is inside a signed bundle: never write bytecode into it.
        env["PYTHONDONTWRITEBYTECODE"] = "1"
        env["PYTHONUNBUFFERED"] = "1"
        env.removeValue(forKey: Runtime.handOffMarker)
        return Command(
            executable: python,
            arguments: ["-B", server.path, "--port", String(defaultPort), "--no-open", "--exit-with-parent"],
            environment: env,
            directory: data,
            log: data.appendingPathComponent("server.log"))
    }
}
