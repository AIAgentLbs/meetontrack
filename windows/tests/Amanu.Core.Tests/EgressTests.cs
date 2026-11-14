using Amanu.Core.Configuration;
using Amanu.Core.Localization;
using Amanu.Core.Processing;

namespace Amanu.Core.Tests;

public sealed class EgressTests
{
    private static AppSettings Settings(bool summary = true, string backend = "auto", bool namesOn = true)
    {
        var settings = AppSettings.CreateDefault("C:\\Docs");
        settings.Summary.Enabled = summary;
        settings.Summary.Backend = backend;
        settings.SpeakerNames.Enabled = namesOn;
        return settings;
    }

    [Fact]
    public void Naming_follows_the_summary_to_ollama()
    {
        Assert.Equal("ollama", MeetingEgress.Route(EgressPurpose.SpeakerNames, Settings(backend: "ollama"))!.Preference);
    }

    [Fact]
    public void With_summaries_off_naming_asks_no_model()
    {
        Assert.Null(MeetingEgress.Route(EgressPurpose.Summary, Settings(summary: false)));
        Assert.Null(MeetingEgress.Route(EgressPurpose.SpeakerNames, Settings(summary: false)));
        Assert.Null(MeetingEgress.Route(EgressPurpose.SpeakerNames, Settings(backend: "none")));
    }

    [Fact]
    public void Naming_has_no_ai_of_its_own_and_an_old_naming_backend_is_not_read()
    {
        using var directory = new TemporaryDirectory();
        var store = new AppSettingsStore(Path.Combine(directory.Path, "config.json"), directory.Path);
        File.WriteAllText(store.ConfigPath, """
            {"summary": {"enabled": false}, "speaker_names": {"backend": "anthropic-api", "model": "x"}}
            """);

        Assert.Null(MeetingEgress.Route(EgressPurpose.SpeakerNames, store.Load().Settings));
        Assert.Equal(MeetingEgress.Route(EgressPurpose.Summary, Settings(backend: "codex-cli")),
            MeetingEgress.Route(EgressPurpose.SpeakerNames, Settings(backend: "codex-cli")));
        Assert.Null(MeetingEgress.Route(EgressPurpose.SpeakerNames, Settings(namesOn: false)));
        Assert.DoesNotContain(SettingsSchema.Entries, entry => entry.Path is "speaker_names.backend" or "speaker_names.model");
    }

    [Fact]
    public void An_old_naming_backend_none_still_keeps_naming_off()
    {
        using var directory = new TemporaryDirectory();
        var store = new AppSettingsStore(Path.Combine(directory.Path, "config.json"), directory.Path);
        File.WriteAllText(store.ConfigPath, """
            {"summary": {"enabled": true, "backend": "auto"}, "speaker_names": {"backend": "none"}}
            """);
        Assert.False(store.Load().Settings.SpeakerNames.Enabled);
        Assert.Null(MeetingEgress.Route(EgressPurpose.SpeakerNames, store.Load().Settings));

        // An explicit choice made since wins over the old backend.
        File.WriteAllText(store.ConfigPath, """
            {"summary": {"enabled": true, "backend": "auto"}, "speaker_names": {"backend": "none", "enabled": true}}
            """);
        Assert.True(store.Load().Settings.SpeakerNames.Enabled);
    }

    [Fact]
    public void Speakers_read_as_you_and_others()
    {
        using (Localized.Use(InterfaceLanguage.English))
        {
            Assert.Equal("You", SpeakerLabels.Display("me"));
            Assert.Equal("Others", SpeakerLabels.Display("them"));
            Assert.Equal("Others B", SpeakerLabels.Display("them B"));
            Assert.Equal("You A", SpeakerLabels.Display("me A"));
            Assert.Equal("Sam", SpeakerLabels.Display("Sam"));
        }
        using (Localized.Use(InterfaceLanguage.Russian))
        {
            Assert.Equal("Вы", SpeakerLabels.Display("me"));
            Assert.Equal("Остальные A", SpeakerLabels.Display("them A"));
        }
    }

    [Fact]
    public void A_misspelt_backend_allows_nothing_rather_than_everything()
    {
        Assert.Empty(LanguageModelChain.Allowed("olama", _ => true));
        Assert.Equal(["ollama"], LanguageModelChain.Allowed("ollama", _ => true));
        Assert.Equal(["anthropic-api", "ollama"], LanguageModelChain.Allowed("auto", name => name is "anthropic-api" or "ollama"));
    }

    [Theory]
    [InlineData("https://api.openai.com/v1", "openai-key")]
    [InlineData("https://openrouter.ai/api/v1", "compatible-key")]
    [InlineData("http://127.0.0.1:8080/v1", "compatible-key")]
    public void Each_key_goes_only_to_its_own_service(string baseUrl, string expected)
    {
        Assert.Equal(expected, KeyRouting.SummaryOpenAiKey(baseUrl, "openai-key", "compatible-key"));
    }

    [Fact]
    public void The_openai_key_never_reaches_a_remote_compatible_server()
    {
        Assert.Null(KeyRouting.SummaryOpenAiKey("https://openrouter.ai/api/v1", "openai-key", null));
        Assert.Equal("openai-key", KeyRouting.SummaryOpenAiKey("http://localhost:1234/v1", "openai-key", null));
    }

    [Theory]
    [InlineData("https://ollama.example.com", true)]
    [InlineData("http://127.0.0.1:11434", true)]
    [InlineData("http://192.168.1.5:11434", false)]
    public void Plain_http_is_only_accepted_on_this_computer(string url, bool acceptable)
    {
        Assert.Equal(acceptable, KeyRouting.AcceptableServer(url));
    }

    [Fact]
    public void Every_server_setting_is_one_advanced_can_edit()
    {
        var advanced = SettingsSchema.AdvancedSections.SelectMany(section => section.Entries).Select(entry => entry.Path).ToHashSet();
        Assert.Equal(["summary.ollama_base_url", "summary.openai_base_url"], KeyRouting.ServerSettings.Order());
        Assert.All(KeyRouting.ServerSettings, path => Assert.Contains(path, advanced));
    }
}

public sealed class CliArgumentsTests
{
    [Fact]
    public void Claude_is_asked_with_no_tools_settings_mcp_or_history()
    {
        var arguments = CliArguments.Claude("C:\\t\\system.txt", null);
        Assert.Equal(
            ["--print", "--system-prompt-file", "C:\\t\\system.txt", "--output-format", "text", "--tools", "",
             "--setting-sources", "", "--mcp-config", """{"mcpServers":{}}""", "--strict-mcp-config",
             "--disable-slash-commands", "--no-session-persistence"],
            arguments);
        Assert.Equal(["--model", "claude-opus-5"], CliArguments.Claude("f", "claude-opus-5").TakeLast(2));
    }

    [Fact]
    public void Codex_switches_off_every_named_mcp_server()
    {
        var arguments = CliArguments.Codex("gpt-5", "out.txt", ["github", "files"]);
        Assert.Equal(
            ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral",
             "-c", "mcp_servers.github.enabled=false", "-c", "mcp_servers.files.enabled=false",
             "--model", "gpt-5", "--output-last-message", "out.txt", "-"],
            arguments);
    }

    [Fact]
    public void Codex_skips_the_config_when_servers_cannot_be_named()
    {
        Assert.Contains("--ignore-user-config", CliArguments.Codex("gpt-5", "o", null));
        Assert.Contains("--ignore-user-config", CliArguments.Codex("gpt-5", "o", ["has.dot"]));
    }

    [Fact]
    public void Codex_without_a_chosen_model_is_left_to_pick_its_own()
    {
        Assert.DoesNotContain("--model", CliArguments.Codex(null, "o", []));
    }

    [Fact]
    public void A_codex_failure_is_told_by_its_error_not_by_the_prompt_it_echoed()
    {
        var output = """
            OpenAI Codex v0.159.0
            --------
            user
            Below is a meeting transcript with speaker labels.
            me: the confidential part
            warning: Model metadata for `gpt-5` not found.
            ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5' model is not supported when using Codex with a ChatGPT account."}}
            ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-5' model is not supported when using Codex with a ChatGPT account."}}
            """;
        Assert.Equal("The 'gpt-5' model is not supported when using Codex with a ChatGPT account.", CliArguments.FailureDetail(output));
        Assert.Equal("Not logged in · Please run /login", CliArguments.FailureDetail("Not logged in · Please run /login\n"));
    }

    [Fact]
    public void Mcp_servers_are_found_in_every_toml_shape()
    {
        const string toml = """
            model = "gpt-5"
            mcp_servers.top.command = "x"
            [mcp_servers.github]
            command = "gh"
            [mcp_servers.github.env]
            TOKEN = "t"
            [mcp_servers]
            inline = { command = "y" }
            """;
        Assert.Equal(["top", "github", "inline"], CliArguments.McpServerNames(toml));
        Assert.Empty(CliArguments.McpServerNames("model = \"gpt-5\"")!);
        Assert.Null(CliArguments.McpServerNames("# mcp_servers are defined elsewhere\nx = \"mcp_servers\""));
    }
}
