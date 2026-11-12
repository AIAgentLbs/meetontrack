import Foundation
import Testing

@testable import meetingcopilot

/// Deep equality of JSON-shaped values, for expectations.
func sameJSON(_ value: Any?, _ expected: [String: Any]) -> Bool {
    NSDictionary(dictionary: value as? [String: Any] ?? [:]).isEqual(to: expected)
}

/// Summary and speaker naming run on the one AI the person chose in the
/// shared config (`ai.choice`) and on nothing else: no default model, no
/// fallback order, no `auto`.
///
/// The fake CLIs here are shell scripts in a temporary folder. Each records
/// its argv one argument per line, its stdin, and the folder it ran in, and
/// prints a canned reply in the provider's own stream format.
struct AIChoiceTests {
    private static let choice = AIChoice(
        provider: "codex", model: "test-model", effort: "high", speed: "priority")

    private func scratch() throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("meetingcopilot-ai-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return URL(fileURLWithPath: LLMBackend.realPath(dir.path), isDirectory: true)
    }

    private func config(_ choice: [String: Any]) -> [String: Any] {
        ["ai": ["choice": choice]]
    }

    // MARK: - resolving a choice

    @Test("A complete choice is runnable; anything less needs a choice")
    func runnableOnlyWhenComplete() {
        let full: [String: Any] = [
            "provider": "claude", "model": "m", "effort": "", "speed": "",
        ]
        #expect(AIChoice.resolve(in: config(full))
            == .ready(AIChoice(provider: "claude", model: "m", effort: "", speed: "")))

        for key in ["provider", "model", "effort", "speed"] {
            var partial = full
            partial.removeValue(forKey: key)
            #expect(AIChoice.resolve(in: config(partial)) == .needsChoice,
                    "missing \(key) must not run")
        }
        var empty = full
        empty["model"] = ""
        #expect(AIChoice.resolve(in: config(empty)) == .needsChoice)
        var wrongType = full
        wrongType["effort"] = 3
        #expect(AIChoice.resolve(in: config(wrongType)) == .needsChoice)

        #expect(AIChoice.resolve(in: nil) == .needsChoice)
        #expect(AIChoice.resolve(in: ["ai": [:]]) == .needsChoice, "no default when nothing is chosen")
        #expect(AIChoice.resolve(in: ["ai": ["choice": "codex"]]) == .needsChoice)
        // A present ai.choice wins; the per-task choices it replaced are not read any more.
        #expect(AIChoice.resolve(in: ["ai": ["choice": ["provider": "claude"],
                                              "purposes": ["summary": full]]]) == .needsChoice)
    }

    @Test("Until the web app writes ai.choice, the per-task choices are carried over by the shared rule")
    func migrationParityWithPython() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("copilot/web/fixture_ai_choice_migration.json")
        let cases = try #require(
            JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [[String: Any]])
        #expect(cases.count >= 8)
        for item in cases {
            let name = item["name"] as? String ?? "?"
            let expected = item["choice"] as? [String: String]
            let resolved = AIChoice.resolve(in: item["config"] as? [String: Any])
            // A legacy partial choice is carried over by the web app and does not run here either way.
            if let expected, expected.count == 4 {
                #expect(resolved == .ready(AIChoice(
                    provider: expected["provider"]!, model: expected["model"]!,
                    effort: expected["effort"]!, speed: expected["speed"]!)), "\(name)")
            } else {
                #expect(resolved == .needsChoice, "\(name)")
            }
        }
    }

    /// A fake agy that also records the home it was given: its settings, the
    /// sign-in link and the environment (MEETONTRACK-106).
    private func fakeAgy(in dir: URL, log: URL, reply: String) throws -> URL {
        let url = dir.appendingPathComponent("agy")
        _ = try fakeCLI(at: url, log: log, reply: reply)
        var script = try String(contentsOf: url, encoding: .utf8)
        script = script.replacingOccurrences(of: "#!/bin/sh\n", with: """
            #!/bin/sh
            echo "$HOME" > "\(log.path).home"
            cat "$HOME/.gemini/antigravity-cli/settings.json" > "\(log.path).settings"
            readlink "$HOME/.gemini/antigravity-cli/antigravity-oauth-token" > "\(log.path).token"
            env | cut -d= -f1 | sort > "\(log.path).env"
            mkdir -p "$HOME/.gemini/antigravity-cli/conversations" && echo meeting > "$HOME/.gemini/antigravity-cli/conversations/c1.db"

            """)
        try Data(script.utf8).write(to: url)
        return url
    }

    @Test("Antigravity runs isolated: app-owned strict home, exact argv, prompt on stdin, nothing left")
    func antigravityArgv() async throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let person = dir.appendingPathComponent("person", isDirectory: true)
        let token = person.appendingPathComponent(LLMBackend.antigravityToken)
        try FileManager.default.createDirectory(
            at: token.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(#"{"token":{}}"#.utf8).write(to: token)
        // The person's own settings say always-proceed; they must not be read.
        try Data(#"{"toolPermission":"always-proceed"}"#.utf8)
            .write(to: token.deletingLastPathComponent().appendingPathComponent("settings.json"))
        let log = dir.appendingPathComponent("log")
        let agy = try fakeAgy(in: dir, log: log, reply: """
            {"event":"step_update"}
            {"event":"result","result":{"status":"SUCCESS","response":"  the answer  "}}
            """)
        let environment = ["HOME": person.path, "PATH": "/usr/bin:/bin",
                           "GEMINI_API_KEY": "k", "agy_account": "o", "ANTIGRAVITY_PROJECT_ID": "p"]

        let backend = try ready(LLMBackend.resolve(
            config: config(["provider": "antigravity", "model": "fam", "effort": "hi", "speed": ""]),
            tool: { $0 == "agy" ? agy.path : nil }, environment: environment))
        let reply = try await backend.call("SYSTEM", "/plan PROMPT")
        #expect(reply == LLMReply(text: "the answer", model: "fam"))

        let ran = try recorded(log)
        #expect(ran.args == ["--sandbox", "--disable-slash-commands", "--model", "fam-hi",
                             "--input-format", "stream-json", "--output-format", "stream-json", "-p", ""])
        let event = try JSONSerialization.jsonObject(with: Data(ran.stdin.utf8)) as? [String: Any]
        #expect(sameJSON(event, ["event": "user", "message": ["content": "SYSTEM\n\n/plan PROMPT"]]))
        #expect(ran.stdin.hasSuffix("\n"))
        #expect(ran.emptyCwd, "the work folder must be fresh and empty")
        func read(_ suffix: String) throws -> String {
            try String(contentsOf: URL(fileURLWithPath: log.path + suffix), encoding: .utf8)
                .trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let home = try read(".home")
        #expect(home != person.path && home != ran.cwd)
        #expect(sameJSON(try JSONSerialization.jsonObject(with: Data(try read(".settings").utf8)),
                         ["toolPermission": "strict",
                          "permissions": ["deny": ["command(*)", "read_url(*)"]]]))
        #expect(try read(".token") == token.path)
        let names = try read(".env").components(separatedBy: "\n")
        #expect(names.contains("HOME") && names.contains("PATH"))
        #expect(!names.contains { ["GEMINI_API_KEY", "agy_account", "ANTIGRAVITY_PROJECT_ID"].contains($0) })
        #expect(!FileManager.default.fileExists(atPath: home), "the home, with agy's conversation, is removed")
        #expect(!FileManager.default.fileExists(atPath: ran.cwd))
        #expect(FileManager.default.fileExists(atPath: token.path), "the person's sign-in is kept")
    }

    @Test("Antigravity: a blocked action, a failure, no sign-in or a speed tier do not pass as an answer")
    func antigravityFailures() async throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let person = dir.appendingPathComponent("person", isDirectory: true)
        let choice: [String: Any] = ["provider": "antigravity", "model": "m", "effort": "", "speed": ""]
        func backend(_ reply: String) throws -> LLMBackend {
            let agy = try fakeAgy(in: dir, log: dir.appendingPathComponent("log"), reply: reply)
            return try ready(LLMBackend.resolve(
                config: config(choice), tool: { _ in agy.path }, environment: ["HOME": person.path]))
        }

        // No saved sign-in: agy would start one and wait, so it is not run.
        let unsigned = try backend(#"{"event":"result","result":{"status":"SUCCESS","response":"x"}}"#)
        await #expect(throws: LLMError.self) { try await unsigned.call("s", "p") }
        #expect(!FileManager.default.fileExists(atPath: dir.appendingPathComponent("log.args").path))

        let token = person.appendingPathComponent(LLMBackend.antigravityToken)
        try FileManager.default.createDirectory(
            at: token.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("{}".utf8).write(to: token)
        do {
            _ = try await backend(#"""
                {"event":"result","result":{"status":"SUCCESS","response":"","denied_actions":[{"action":"write_file"}]}}
                """#).call("s", "p")
            Issue.record("a denied action is not an answer")
        } catch let error as LLMError {
            #expect(error.description.contains("blocked action (write_file)"))
        }
        let failed = try backend(#"{"event":"result","result":{"status":"ERROR","response":"x","error":"boom"}}"#)
        await #expect(throws: LLMError.self) { try await failed.call("s", "p") }

        var fast = choice
        fast["speed"] = "standard"
        #expect(LLMBackend.resolve(config: config(fast), tool: { _ in "/bin/echo" }).problem
            == "antigravity offers no speed tier standard")
    }

    @Test("A needs-choice purpose says where to choose")
    func needsChoiceSaysWhere() {
        guard case .needsChoice = LLMBackend.resolve(config: [:], tool: { _ in nil })
        else { Issue.record("an unset purpose must need a choice"); return }
        #expect(AIChoice.needsChoiceMessage.contains("Getting started"))
    }

    // MARK: - exact command lines

    @Test("Codex runs with exactly the isolated argv, the prompt on stdin")
    func codexArgv() async throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let bin = dir.appendingPathComponent("pkg/bin", isDirectory: true)
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let log = dir.appendingPathComponent("log")
        let codex = try fakeCLI(at: bin.appendingPathComponent("codex"), log: log, reply: """
            {"type":"thread.started"}
            {"type":"item.completed","item":{"type":"agent_message","text":"first"}}
            {"type":"item.completed","item":{"type":"reasoning","text":"thinking"}}
            {"type":"item.completed","item":{"type":"agent_message","text":"the answer"}}
            """)

        let backend = try ready(LLMBackend.resolve(
            config: config([
                "provider": "codex", "model": "test-model", "effort": "high", "speed": "priority",
            ]), tool: { $0 == "codex" ? codex.path : nil }))
        let reply = try await backend.call("SYSTEM", "PROMPT")
        #expect(reply == LLMReply(text: "the answer", model: "test-model"))

        let ran = try recorded(log)
        let root = dir.appendingPathComponent("pkg").path
        let workdir = ran.cwd
        #expect(ran.args == [
            "--ask-for-approval", "never", "-m", "test-model",
            "-c", #"model_reasoning_effort="high""#,
            "-c", #"service_tier="priority""#,
            "-c", #"default_permissions="meetontrack""#,
            "-c", #"permissions.meetontrack.filesystem={":minimal"="read",""#
                + workdir + #""="read",""# + root + #""="read"}"#,
            "exec", "--ignore-user-config", "--skip-git-repo-check", "--ephemeral",
            "--disable", "shell_tool", "--disable", "unified_exec", "--disable", "multi_agent",
            "--disable", "enable_mcp_apps", "--disable", "skill_search",
            "--disable", "skill_mcp_dependency_install", "--disable", "tool_suggest",
            "-c", #"web_search="disabled""#, "-c", "project_doc_max_bytes=0",
            "-c", "skills.include_instructions=false",
            "-C", workdir, "--json", "-",
        ])
        #expect(ran.stdin == "SYSTEM\n\nPROMPT")
        #expect(ran.emptyCwd, "the work folder must be fresh and empty")
        #expect(!FileManager.default.fileExists(atPath: workdir), "the work folder is removed after")
    }

    @Test("Codex leaves effort and speed out when there are none, and standard means default")
    func codexOptionalFlags() {
        let none = LLMBackend.codexArguments(
            AIChoice(provider: "codex", model: "m", effort: "", speed: ""),
            workdir: "/w", packageRoot: "/p")
        let standard = LLMBackend.codexArguments(
            AIChoice(provider: "codex", model: "m", effort: "", speed: "standard"),
            workdir: "/w", packageRoot: "/p")
        #expect(none == standard)
        #expect(!none.contains { $0.hasPrefix("model_reasoning_effort") || $0.hasPrefix("service_tier") })
    }

    @Test("Codex with no agent message, or a non-zero exit, is a failure")
    func codexFailures() async throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("log")
        let silent = try fakeCLI(at: dir.appendingPathComponent("codex"), log: log,
                                 reply: #"{"type":"turn.completed"}"#)
        let choice: [String: Any] = ["provider": "codex", "model": "m", "effort": "", "speed": ""]
        let backend = try ready(LLMBackend.resolve(
            config: config(choice), tool: { _ in silent.path }))
        await #expect(throws: LLMError.self) { try await backend.call("s", "p") }

        let failing = try fakeCLI(at: dir.appendingPathComponent("codex2"), log: log,
                                  reply: #"{"type":"item.completed","item":{"type":"agent_message","text":"x"}}"#,
                                  status: 1)
        let broken = try ready(LLMBackend.resolve(
            config: config(choice), tool: { _ in failing.path }))
        await #expect(throws: LLMError.self) { try await broken.call("s", "p") }
    }

    @Test("Claude runs with exactly the isolated argv and reports the model it used")
    func claudeArgv() async throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let log = dir.appendingPathComponent("log")
        let claude = try fakeCLI(at: dir.appendingPathComponent("claude"), log: log, reply: """
            {"type":"system","subtype":"init","model":"actual-model-id"}
            {"type":"assistant","message":{}}
            {"type":"result","subtype":"success","is_error":false,"result":"the answer"}
            """)

        let backend = try ready(LLMBackend.resolve(
            config: config([
                "provider": "claude", "model": "alias", "effort": "max", "speed": "fastMode",
            ]), tool: { $0 == "claude" ? claude.path : nil }))
        let reply = try await backend.call("SYSTEM", "PROMPT")
        #expect(reply == LLMReply(text: "the answer", model: "actual-model-id"))

        let ran = try recorded(log)
        #expect(ran.args == [
            "-p", "--output-format", "stream-json", "--verbose",
            "--setting-sources", "", "--strict-mcp-config",
            "--model", "alias", "--effort", "max",
            "--settings", #"{"fastMode":true}"#,
            "--tools", "", "--no-session-persistence",
        ])
        #expect(ran.stdin == "SYSTEM\n\nPROMPT")
        #expect(ran.emptyCwd)
    }

    @Test("Claude without effort or fast mode passes neither")
    func claudeOptionalFlags() {
        let args = LLMBackend.claudeArguments(
            AIChoice(provider: "claude", model: "m", effort: "", speed: "standard"))
        #expect(args == [
            "-p", "--output-format", "stream-json", "--verbose",
            "--setting-sources", "", "--strict-mcp-config", "--model", "m",
            "--tools", "", "--no-session-persistence",
        ])
    }

    @Test("A Claude result flagged as an error is a failure")
    func claudeErrorResult() throws {
        let stdout = Data("""
            {"type":"system","subtype":"init","model":"x"}
            {"type":"result","is_error":true,"result":"Claude usage limit reached"}
            """.utf8)
        #expect(throws: LLMError.self) { try LLMBackend.claudeReply(stdout, requested: "m") }
    }

    @Test("Ollama is asked over /api/chat, with think only when an effort was chosen")
    func ollamaRequest() throws {
        func body(_ effort: String) -> [String: Any] {
            (try? LLMBackend.ollamaBody(
                AIChoice(provider: "ollama", model: "local", effort: effort, speed: ""),
                prompt: "PROMPT", contextLength: 8192)) ?? [:]
        }
        let plain = body("")
        #expect(plain["model"] as? String == "local")
        #expect(plain["stream"] as? Bool == false)
        #expect(plain["think"] == nil)
        let messages = try #require(plain["messages"] as? [[String: String]])
        #expect(messages == [["role": "user", "content": "PROMPT"]])
        #expect(body("true")["think"] as? Bool == true)
        #expect(body("false")["think"] as? Bool == false)
        #expect(body("high")["think"] as? String == "high")

        #expect(LLMBackend.ollamaChatURL(environment: [:]).absoluteString
            == "http://127.0.0.1:11434/api/chat")
        #expect(LLMBackend.ollamaChatURL(environment: ["OLLAMA_HOST": "box:1234/"]).absoluteString
            == "http://box:1234/api/chat")
    }

    @Test("Ollama's context comes from /api/show; unknown or too small is an error, never a silent cut")
    func ollamaContext() throws {
        let show: [String: Any] = ["model_info": [
            "general.architecture": "arch1", "arch1.context_length": 8192, "other.context_length": 99]]
        #expect(LLMBackend.ollamaContextLength(show) == 8192)
        #expect(LLMBackend.ollamaContextLength(["model_info": ["general.architecture": "arch1"]]) == nil)
        #expect(LLMBackend.ollamaContextLength([:]) == nil)

        let choice = AIChoice(provider: "ollama", model: "local", effort: "", speed: "")
        let small = try LLMBackend.ollamaBody(choice, prompt: "abc", contextLength: 8192)
        #expect((small["options"] as? [String: Int])?["num_ctx"] == 3 + LLMBackend.ollamaReplyTokens)
        let limit = LLMBackend.ollamaInputLimit(contextLength: 8192)
        let full = try LLMBackend.ollamaBody(
            choice, prompt: String(repeating: "x", count: limit), contextLength: 8192)
        #expect((full["options"] as? [String: Int])?["num_ctx"] == 8192)
        #expect(throws: LLMError.self) {
            try LLMBackend.ollamaBody(
                choice, prompt: String(repeating: "x", count: limit + 1), contextLength: 8192)
        }
        // MEETONTRACK-8: a CJK character counts by its UTF-8 bytes, Cyrillic as one.
        #expect(LLMBackend.ollamaTokens("жж漢") == 5)
        #expect(throws: LLMError.self) {
            try LLMBackend.ollamaBody(
                choice, prompt: String(repeating: "漢", count: limit / 3 + 1), contextLength: 8192)
        }
    }

    @Test("Summary chunks shrink to the backend's limit, and stay put without one")
    func summaryChunksFitTheBackend() {
        let usual = Summarizer.chunkLimit(backendLimit: nil, overhead: 100)
        #expect(Summarizer.chunkLimit(backendLimit: 4096, overhead: 96) == 4000)
        #expect(Summarizer.chunkLimit(backendLimit: 10_000_000, overhead: 100) == usual)
        // Nothing fits: no flood of tiny calls; the call itself reports too long.
        #expect(Summarizer.chunkLimit(backendLimit: 50, overhead: 100) == usual)
    }

    @Test("Every summary request fits the backend, the final merge included")
    func mergeIsReducedUntilItFits() async throws {
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var sizes: [Int] = []
            func add(_ size: Int) { lock.lock(); sizes.append(size); lock.unlock() }
        }
        let box = Box()
        let budget = 6000
        var backend = LLMBackend(name: "fake", model: "m") { system, prompt in
            box.add(system.count + prompt.count)
            return LLMReply(text: String(repeating: "n", count: 1500), model: "m")
        }
        backend.inputLimit = { budget }
        let body = Array(repeating: String(repeating: "w", count: 400), count: 120)
            .joined(separator: "\n")
        _ = try await Summarizer.produce(body: body, header: "", language: nil, backend: backend)
        #expect(box.sizes.count > 1)
        #expect(box.sizes.allSatisfy { $0 <= budget }, "a request exceeded the budget: \(box.sizes)")

        #expect(Summarizer.mergeBatches(["a", "b", "c"], limit: 1) == [["a"], ["b"], ["c"]])
        #expect(Summarizer.mergeBatches(["aa", "bb", "cc"], limit: 100) == [["aa", "bb", "cc"]])
    }

    @Test("A CJK transcript is chunked by Ollama tokens, so every request fits (MEETONTRACK-153)")
    func cjkChunksFitOllamaTokens() async throws {
        final class Box: @unchecked Sendable {
            let lock = NSLock()
            var sizes: [Int] = []
            func add(_ size: Int) { lock.lock(); sizes.append(size); lock.unlock() }
        }
        let box = Box()
        let budget = 6000
        var backend = LLMBackend(name: "ollama", model: "m") { system, prompt in
            box.add(LLMBackend.ollamaTokens("\(system)\n\n\(prompt)"))
            return LLMReply(text: String(repeating: "注", count: 300), model: "m")
        }
        backend.inputLimit = { budget }
        backend.measure = LLMBackend.ollamaTokens
        // 4000 characters (under the budget by count), 12000 tokens.
        let body = Array(repeating: String(repeating: "漢", count: 40), count: 100)
            .joined(separator: "\n")
        _ = try await Summarizer.produce(body: body, header: "", language: nil, backend: backend)
        #expect(box.sizes.count > 1)
        #expect(box.sizes.allSatisfy { $0 <= budget }, "a request exceeded the budget: \(box.sizes)")

        // The resolved Ollama backend measures in tokens; the CLIs keep characters.
        let ollama = try ready(LLMBackend.resolve(
            config: config(["provider": "ollama", "model": "m", "effort": "", "speed": ""]),
            tool: { _ in nil }))
        #expect(ollama.measure("漢") == 3)
        let codex = try ready(LLMBackend.resolve(
            config: config(["provider": "codex", "model": "m", "effort": "", "speed": ""]),
            tool: { _ in "/bin/echo" }))
        #expect(codex.measure("漢") == 1)
    }

    @Test("The newest installed CLI wins, as in the web server; the override comes first")
    func newestCLIWins() throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        func tool(_ name: String, _ version: String) throws -> String {
            let url = dir.appendingPathComponent(name)
            try "#!/bin/sh\necho \"\(version)\"\n".write(to: url, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
            return url.path
        }
        let old = try tool("old", "codex-cli 0.153.2")
        let new = try tool("new", "codex-cli 0.159.2")
        let mute = try tool("mute", "no version")
        let ask: (String) -> String? = { path in
            let run = try? Subprocess.runSync(executable: path, arguments: ["--version"], timeout: 5)
            return run.map { String(decoding: $0.stdout, as: UTF8.self) }
        }
        #expect(Tooling.newest([old, new], version: ask) == new)
        #expect(Tooling.newest([new, old], version: ask) == new)
        #expect(Tooling.newest([mute, old], version: ask) == old)
        #expect(Tooling.newest([dir.appendingPathComponent("absent").path, mute], version: ask) == mute)
        #expect(Tooling.newest([], version: ask) == nil)
        #expect(Tooling.versionNumbers("codex-cli 0.159.2") == [0, 159, 2])
        #expect(Tooling.overrideVariable("codex") == "MEETING_COPILOT_CODEX")
    }

    @Test("The app and the web server look for CLIs in the same places")
    func toolLocationsMatchTheWebServer() throws {
        let file = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("copilot/web/tool_locations.json")
        var shared = try #require(
            try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        shared.removeValue(forKey: "description")
        #expect(NSDictionary(dictionary: shared).isEqual(to: Tooling.listedLocations))
        #expect(Tooling.listedLocations["codex"]?.contains(
            "/Applications/ChatGPT.app/Contents/Resources/codex") == true)
    }

    // MARK: - migrating the old settings once

    @Test("The app never writes ai: other legacy backends are left for the web app to carry over")
    func legacyBackendsAreNotWrittenHere() {
        for backend in ["codex-cli", "claude-cli", "ollama", "auto", "anthropic-api", "openai-api"] {
            var json: [String: Any] = ["summary": ["backend": backend, "model": "m"]]
            AIChoice.migrateLegacy(&json)
            #expect(json["ai"] == nil, "\(backend) must not be written by the app")
            #expect((json["summary"] as? [String: Any])?["backend"] as? String == backend)
        }
    }

    @Test("A legacy backend of none becomes summaries off, once, and can be turned back on")
    func legacyNoneMigratesToDisabled() throws {
        var json: [String: Any] = ["summary": ["backend": "none", "language": "ru"]]
        AIChoice.migrateLegacy(&json)
        let summary = try #require(json["summary"] as? [String: Any])
        #expect(summary["backend"] == nil)
        #expect(summary["enabled"] as? Bool == false)
        #expect(summary["language"] as? String == "ru")
        #expect(json["ai"] == nil)

        // Turned on in the UI afterwards: the next migration leaves it on.
        var on = json
        on["summary"] = summary.merging(["enabled": true]) { $1 }
        AIChoice.migrateLegacy(&on)
        #expect((on["summary"] as? [String: Any])?["enabled"] as? Bool == true)

        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("config.json")
        try JSONSerialization.data(withJSONObject: ["summary": ["backend": "none"]]).write(to: url)
        Config.migrateLegacyAIChoices(file: url)
        let written = try #require(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        #expect(sameJSON(written["summary"], ["enabled": false]))
    }

    @Test("Migration goes through the locked writer and keeps everything else")
    func migrationWritesTheFile() throws {
        let dir = try scratch()
        defer { try? FileManager.default.removeItem(at: dir) }
        let url = dir.appendingPathComponent("config.json")
        let ai: [String: Any] = ["purposes": ["live_analysis": ["provider": "codex"]]]
        try JSONSerialization.data(withJSONObject: [
            "summary": ["backend": "none", "language": "ru"], "ai": ai,
        ]).write(to: url)

        Config.migrateLegacyAIChoices(file: url)

        let json = try #require(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        #expect(sameJSON(json["ai"], ai))
        #expect(sameJSON(json["summary"], ["enabled": false, "language": "ru"]))
        let mode = try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions]
        #expect(mode as? Int == 0o600)
    }

    // MARK: - no model in the source

    @Test("No AI model id is written into the app's source")
    func noModelLiterals() throws {
        let sources = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources")
        let pattern = try NSRegularExpression(
            pattern: #"gpt-[0-9]|claude-(opus|sonnet|haiku)|gemini-[0-9]|qwen[0-9]"#)
        let files = FileManager.default.enumerator(at: sources, includingPropertiesForKeys: nil)?
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        #expect(!files.isEmpty)
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            let hits = pattern.matches(in: text, range: NSRange(text.startIndex..., in: text))
            #expect(hits.isEmpty, "a model id in \(file.lastPathComponent)")
        }
    }

    // MARK: - helpers

    private func ready(_ resolution: LLMBackendResolution) throws -> LLMBackend {
        guard case .ready(let backend) = resolution else {
            throw LLMError.malformedResponse("expected a runnable backend, got \(resolution)")
        }
        return backend
    }

    private func fakeCLI(at url: URL, log: URL, reply: String, status: Int = 0) throws -> URL {
        let script = """
            #!/bin/sh
            : > "\(log.path).args"
            for arg in "$@"; do printf '%s\\n' "$arg" >> "\(log.path).args"; done
            cat > "\(log.path).stdin"
            pwd -P > "\(log.path).cwd"
            ls -A | wc -l | tr -d ' ' > "\(log.path).count"
            cat <<'REPLY'
            \(reply)
            REPLY
            exit \(status)
            """
        try Data(script.utf8).write(to: url)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: url.path)
        return url
    }

    private func recorded(_ log: URL) throws -> (args: [String], stdin: String, cwd: String, emptyCwd: Bool) {
        func read(_ suffix: String) throws -> String {
            try String(contentsOf: URL(fileURLWithPath: log.path + suffix), encoding: .utf8)
        }
        var args = try read(".args").components(separatedBy: "\n")
        if args.last == "" { args.removeLast() }
        let cwd = try read(".cwd").trimmingCharacters(in: .whitespacesAndNewlines)
        let count = try read(".count").trimmingCharacters(in: .whitespacesAndNewlines)
        return (args, try read(".stdin"), cwd, count == "0")
    }
}
