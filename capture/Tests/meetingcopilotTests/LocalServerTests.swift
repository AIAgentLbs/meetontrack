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

    private func wait(_ condition: () -> Bool) async {
        for _ in 0..<100 where !condition() { try? await Task.sleep(for: .milliseconds(50)) }
    }

    @Test("A server that dies is started again, and quit stops it for good")
    func restartsThenStops() async throws {
        let server = LocalServer(command: try command("sleep 30"), probe: { nil })
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
                                 probe: { .init(version: "0.1.19", instance: "own") })
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
                                 probe: { .init(version: "0.1.19", instance: "someone-else") })
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
                                 instance: "token-1", probe: { nil })
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
        let server = LocalServer(command: try command(script), probe: { nil })
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
                                 probe: { .init(version: "0.1.18", instance: "") })
        server.checkInterval = 0.05
        server.start()
        await wait { server.launches == 1 }
        #expect(server.launches == 1)
        #expect(!server.isReady)
        server.stop(grace: 1)
    }

    @Test("A server that never answers after starting is restarted")
    func startupHang() async throws {
        let server = LocalServer(command: try command("sleep 30"), probe: { nil })
        server.checkInterval = 0.05
        server.hangLimit = 0.2
        server.start()
        await wait { server.launches == 2 }
        #expect(server.launches == 2)
        server.stop(grace: 1)
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
        #expect(AssistantLinkPolicy.decide(local, newWindow: false) == .load)
        #expect(AssistantLinkPolicy.decide(URL(string: "http://localhost:43121/api/archive/report/x/report.pdf"), newWindow: true) == .openExternally)
        #expect(AssistantLinkPolicy.decide(URL(string: "https://accounts.google.com/o/oauth2"), newWindow: false) == .openExternally)
        #expect(AssistantLinkPolicy.decide(URL(string: "https://drive.google.com/file/d/1"), newWindow: true) == .openExternally)
        #expect(AssistantLinkPolicy.decide(URL(string: "http://127.0.0.1:9999/"), newWindow: false) == .openExternally)
        #expect(AssistantLinkPolicy.decide(URL(string: "file:///etc/passwd"), newWindow: false) == .ignore)
        #expect(AssistantLinkPolicy.decide(URL(string: "about:blank"), newWindow: false) == .load)
        #expect(AssistantLinkPolicy.decide(nil, newWindow: false) == .ignore)
    }
}
