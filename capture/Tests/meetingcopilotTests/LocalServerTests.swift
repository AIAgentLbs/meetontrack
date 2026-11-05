import Foundation
import Testing
@testable import meetingcopilot

/// The app owns the assistant's server now: it starts it, starts it again when
/// it dies, and stops it on quit. A shell script stands in for Python.
@MainActor
@Suite("The app runs the assistant server as its child", .serialized)
struct LocalServerTests {
    private func command(_ script: String) throws -> LocalServer.Command {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        return LocalServer.Command(
            executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", script],
            environment: [:], directory: root, log: root.appendingPathComponent("server.log"))
    }

    /// Never the real 43121: a server under test must not touch an installed assistant.
    private var spare: Int { LocalServer.freePort() ?? 0 }

    private func wait(_ condition: () -> Bool) async {
        for _ in 0..<100 where !condition() { try? await Task.sleep(for: .milliseconds(50)) }
    }

    @Test("A server that dies is started again, and quit stops it for good")
    func restartsThenStops() async throws {
        let server = LocalServer(command: try command("sleep 30"), port: spare, probe: { _ in nil })
        server.checkInterval = 0.05
        server.start()
        await wait { server.launches == 1 }
        #expect(server.launches == 1)
        let first = try #require(server.pid)
        kill(first, SIGKILL)
        await wait { server.launches == 2 }
        #expect(server.launches == 2)
        let second = try #require(server.pid)
        #expect(second != first)
        server.stop(grace: 1)
        #expect(server.pid == nil)
        #expect(kill(second, 0) == -1)
        try? await Task.sleep(for: .milliseconds(300))
        #expect(server.launches == 2)
    }

    @Test("The app's own server is used, not started twice")
    func adoptsOwnServer() async throws {
        let server = LocalServer(command: try command("sleep 30"), instance: "own",
                                 port: spare, probe: { _ in .init(version: "0.1.19", instance: "own") })
        var ready = false
        server.whenReady { ready = true }
        server.start()
        await wait { ready }
        #expect(ready)
        #expect(server.launches == 0)
        server.stop()
    }

    @Test("A same-version server the app did not start is not adopted (MEETONTRACK-116)")
    func refusesForeignInstance() async throws {
        let server = LocalServer(command: try command("sleep 30"), expectedVersion: "0.1.19", instance: "own",
                                 port: spare, probe: { _ in .init(version: "0.1.19", instance: "someone-else") })
        server.checkInterval = 0.05
        server.start()
        await wait { server.launches == 1 }
        #expect(server.launches == 1)
        #expect(!server.isReady)
        server.stop(grace: 1)
        // A build without a payload has no child of its own: it uses whatever answers.
        #expect(LocalServer(command: nil).isOurs(.init(version: "0.1.19", instance: "")))
    }

    @Test("The child is told this run's token")
    func passesInstance() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let server = LocalServer(command: try command("echo \"$MEETONTRACK_INSTANCE\" > '\(root.path)'; sleep 30"),
                                 instance: "token-1", port: spare, probe: { _ in nil })
        server.start()
        await wait { (try? String(contentsOf: root, encoding: .utf8)) != nil }
        #expect((try? String(contentsOf: root, encoding: .utf8)) == "token-1\n")
        server.stop(grace: 1)
    }

    @Test("Stopping the server also stops what it started (MEETONTRACK-114)")
    func stopsGrandchildren() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        // The server leads its own process group, as server.py does with --exit-with-parent,
        // and leaves a child that ignores SIGINT behind.
        let script = "exec /usr/bin/perl -e 'setpgrp(0,0); $SIG{INT}=sub{exit 0}; "
            + "if (!fork) { $SIG{INT}=q(IGNORE); open my $f, q(>), q(\(root.path)); print $f $$; close $f; sleep 60; exit } sleep 60'"
        let server = LocalServer(command: try command(script), port: spare, probe: { _ in nil })
        server.start()
        await wait { (try? String(contentsOf: root, encoding: .utf8)).flatMap { Int32($0) } != nil }
        let grandchild = try #require((try? String(contentsOf: root, encoding: .utf8)).flatMap { Int32($0) })
        #expect(kill(grandchild, 0) == 0)
        server.stop(grace: 1)
        await wait { kill(grandchild, 0) != 0 }
        #expect(kill(grandchild, 0) == -1)
    }

    @Test("An old server still holding the port is not adopted")
    func refusesOtherVersion() async throws {
        let server = LocalServer(command: try command("sleep 30"), expectedVersion: "0.1.19",
                                 port: spare, probe: { _ in .init(version: "0.1.18", instance: "") })
        server.checkInterval = 0.05
        server.start()
        await wait { server.launches == 1 }
        #expect(server.launches == 1)
        #expect(!server.isReady)
        server.stop(grace: 1)
    }

    @Test("A server that never answers after starting is restarted")
    func startupHang() async throws {
        let server = LocalServer(command: try command("sleep 30"), port: spare, probe: { _ in nil })
        server.checkInterval = 0.05
        server.hangLimit = 0.2
        server.start()
        await wait { server.launches == 2 }
        #expect(server.launches == 2)
        server.stop(grace: 1)
    }

    /// A listener on a system-picked port, standing in for whatever holds the assistant's port.
    private func holder(respawning: Bool = false) throws -> (Process, Int) {
        let port = try #require(LocalServer.freePort())
        let listen = "/usr/bin/perl -MIO::Socket::INET -e 'my $s = IO::Socket::INET->new(LocalAddr=>q(127.0.0.1),"
            + "LocalPort=>\(port),Listen=>5,ReuseAddr=>1) or die; sleep 60'"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", respawning ? "while :; do \(listen); sleep 0.1; done" : "exec \(listen)"]
        try process.run()
        for _ in 0..<100 where LocalServer.isFree(port) { usleep(20_000) }
        #expect(!LocalServer.isFree(port))
        return (process, port)
    }

    @Test("A stale MeetOnTrack service on the port is stopped and the port taken over (MEETONTRACK-130)")
    func takesOverStaleService() async throws {
        let (stale, port) = try holder()
        defer { if stale.isRunning { kill(stale.processIdentifier, SIGKILL) } }
        let pid = stale.processIdentifier
        let server = LocalServer(command: try command("sleep 30"), expectedVersion: "0.1.22", instance: "own", port: port,
                                 probe: { _ in kill(pid, 0) == 0 ? .init(version: "0.1.21", instance: "old") : nil })
        server.checkInterval = 0.05
        server.start()
        await wait { server.launches == 1 }
        #expect(!stale.isRunning)
        #expect(server.launches == 1)
        #expect(server.port == port)
        server.stop(grace: 1)
    }

    @Test("A MeetOnTrack service that keeps coming back is reported, never run beside (MEETONTRACK-130)")
    func reportsUnstoppableService() async throws {
        let (supervisor, port) = try holder(respawning: true)
        defer { kill(supervisor.processIdentifier, SIGKILL) }
        let server = LocalServer(command: try command("sleep 30"), instance: "own", port: port,
                                 probe: { _ in .init(version: "0.1.18", instance: "") })
        server.checkInterval = 0.05
        var reported = false
        server.whenCannotStart { reported = true }
        server.start()
        for _ in 0..<100 where !reported { try? await Task.sleep(for: .milliseconds(50)) }
        #expect(reported)
        #expect(server.launches == 0)
        #expect(server.port == port)
        server.stop(grace: 1)
    }

    @Test("A port held by another program is left alone; the service runs on a free one (MEETONTRACK-130)")
    func fallsBackFromForeignHolder() async throws {
        let (foreign, port) = try holder()
        defer { kill(foreign.processIdentifier, SIGKILL) }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let ports = root.appendingPathComponent("ports")
        let command = LocalServer.Command(
            executable: URL(fileURLWithPath: "/bin/sh"),
            arguments: ["-c", "echo \"$2\" > '\(ports.path)'; sleep 30", "sh", "--port", String(port)],
            environment: [:], directory: root, log: root.appendingPathComponent("server.log"))
        let server = LocalServer(command: command, instance: "own", port: port, probe: { _ in nil })
        server.checkInterval = 0.05
        server.start()
        await wait { server.launches == 1 }
        #expect(foreign.isRunning)
        #expect(server.port != port)
        await wait { (try? String(contentsOf: ports, encoding: .utf8)) != nil }
        #expect((try? String(contentsOf: ports, encoding: .utf8)) == "\(server.port)\n")
        #expect(server.url.port == server.port)
        server.stop(grace: 1)
    }

    @Test("The port in use is recorded once the app's own service answers")
    func recordsPort() async throws {
        let command = try command("sleep 30")
        let server = LocalServer(command: command, instance: "own", port: 50123,
                                 probe: { _ in .init(version: "", instance: "own") })
        var ready = false
        server.whenReady { ready = true }
        server.start()
        await wait { ready }
        let recorded = try? String(contentsOf: command.directory.appendingPathComponent("server-port"), encoding: .utf8)
        #expect(recorded == "50123\n")
        server.stop()
    }

    @Test("Crash restarts back off up to thirty seconds")
    func backoff() {
        #expect(LocalServer.backoff(1) == 1)
        #expect(LocalServer.backoff(3) == 4)
        #expect(LocalServer.backoff(10) == 30)
    }

    @Test("The bundled command runs the payload's own Python, quietly and with a usable PATH")
    func bundledCommand() throws {
        let resources = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        #expect(LocalServer.bundledCommand(resources: resources) == nil)
        let python = resources.appendingPathComponent("payload/python/bin/python3")
        try FileManager.default.createDirectory(at: python.deletingLastPathComponent(), withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: resources.appendingPathComponent("payload/web"), withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: python.path, contents: Data("#!/bin/sh\n".utf8), attributes: [.posixPermissions: 0o755])
        FileManager.default.createFile(atPath: resources.appendingPathComponent("payload/web/server.py").path, contents: Data())
        let home = URL(fileURLWithPath: "/Users/someone")
        let command = try #require(LocalServer.bundledCommand(
            resources: resources, home: home, environment: ["PATH": "/usr/bin", Runtime.handOffMarker: "1"]))
        #expect(command.executable == python)
        #expect(command.arguments.contains("--exit-with-parent"))
        #expect(command.arguments.contains("--no-open"))
        #expect(command.environment["PYTHONDONTWRITEBYTECODE"] == "1")
        #expect(command.environment["PATH"]?.hasPrefix("/opt/homebrew/bin:") == true)
        #expect(command.environment[Runtime.handOffMarker] == nil)
        #expect(command.log.path == "/Users/someone/.local/share/meeting-copilot/server.log")
    }

    @Test("Local pages stay in the window; everything else goes to the browser")
    func linkPolicy() {
        let local = URL(string: "http://127.0.0.1:43121/")!
        #expect(AssistantLinkPolicy.decide(local, newWindow: false, port: 43121) == .load)
        #expect(AssistantLinkPolicy.decide(URL(string: "http://localhost:43121/api/archive/report/x/report.pdf"), newWindow: true, port: 43121) == .openExternally)
        #expect(AssistantLinkPolicy.decide(URL(string: "https://accounts.google.com/o/oauth2"), newWindow: false, port: 43121) == .openExternally)
        #expect(AssistantLinkPolicy.decide(URL(string: "https://drive.google.com/file/d/1"), newWindow: true, port: 43121) == .openExternally)
        #expect(AssistantLinkPolicy.decide(URL(string: "http://127.0.0.1:9999/"), newWindow: false, port: 43121) == .openExternally)
        #expect(AssistantLinkPolicy.decide(URL(string: "file:///etc/passwd"), newWindow: false, port: 43121) == .ignore)
        #expect(AssistantLinkPolicy.decide(URL(string: "about:blank"), newWindow: false, port: 43121) == .load)
        #expect(AssistantLinkPolicy.decide(nil, newWindow: false, port: 43121) == .ignore)
    }
}
