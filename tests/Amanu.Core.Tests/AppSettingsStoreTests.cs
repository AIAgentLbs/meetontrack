using System.Text.Json.Nodes;
using Amanu.Core.Configuration;

namespace Amanu.Core.Tests;

public sealed class AppSettingsStoreTests
{
    private const string Documents = @"C:\Users\Beta\Documents";

    [Fact]
    public void A_missing_file_means_defaults_and_is_not_written()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");

        var load = new AppSettingsStore(configPath, Documents).Load();

        Assert.Equal(Path.Combine(Documents, "MeetOnTrack Recordings"), load.Settings.RecordingsDirectory);
        Assert.True(load.Settings.AutoRecord.Enabled);
        Assert.Empty(load.Problems);
        Assert.False(File.Exists(configPath));
    }

    [Fact]
    public void An_unreadable_file_at_startup_means_conservative_settings_and_is_left_alone()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");
        File.WriteAllText(configPath, "{ definitely not json");

        var load = new AppSettingsStore(configPath, Documents).Load();

        Assert.True(load.IsUnreadable);
        Assert.False(load.Settings.AutoRecord.Enabled);
        Assert.Equal("local", load.Settings.Transcription.Engine);
        Assert.Equal("none", load.Settings.Summary.Backend);
        Assert.Equal("{ definitely not json", File.ReadAllText(configPath));
        Assert.Single(Directory.GetFiles(temporary.Path));
    }

    [Fact]
    public void An_unreadable_file_later_keeps_the_settings_last_read()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");
        File.WriteAllText(configPath, """{ "summary": { "backend": "ollama" } }""");
        var store = new AppSettingsStore(configPath, Documents);
        var good = store.Load().Settings;

        File.WriteAllText(configPath, """{ "summary": { "backend": "ollama" """);
        var load = store.Load(good);

        Assert.True(load.IsUnreadable);
        Assert.Equal("ollama", load.Settings.Summary.Backend);
        Assert.True(load.Settings.AutoRecord.Enabled);
    }

    [Fact]
    public void Saving_over_an_unreadable_file_is_refused()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");
        File.WriteAllText(configPath, "{ broken");
        var store = new AppSettingsStore(configPath, Documents);

        Assert.Throws<ConfigUnreadableException>(() => store.Save(store.Defaults));
        Assert.Equal("{ broken", File.ReadAllText(configPath));
    }

    [Fact]
    public void A_value_of_the_wrong_kind_falls_back_to_its_default_and_is_reported()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");
        File.WriteAllText(configPath, """{ "auto_record": { "enabled": "false", "start_delay_seconds": 5 }, "summary": { "backend": "olama" } }""");

        var load = new AppSettingsStore(configPath, Documents).Load();

        Assert.False(load.IsUnreadable);
        Assert.Equal(2, load.Problems.Count);
        Assert.True(load.Settings.AutoRecord.Enabled);
        Assert.Equal(5, load.Settings.AutoRecord.StartDelaySeconds);
        Assert.Equal("auto", load.Settings.Summary.Backend);
    }

    [Fact]
    public void Only_what_differs_from_the_defaults_is_written()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");
        var store = new AppSettingsStore(configPath, Documents);
        var settings = store.Defaults;
        settings.KeepAudio = true;
        settings.AutoRecord.StartDelaySeconds = 4;

        store.Save(settings);

        var written = JsonNode.Parse(File.ReadAllText(configPath))!.AsObject();
        Assert.Equal(2, written.Count);
        Assert.True(written["keep_audio"]!.GetValue<bool>());
        Assert.Equal(4, written["auto_record"]!["start_delay_seconds"]!.GetValue<int>());
        var reread = store.Load().Settings;
        Assert.True(reread.KeepAudio);
        Assert.Equal(4, reread.AutoRecord.StartDelaySeconds);
        Assert.Equal(15, reread.AutoRecord.StopDelaySeconds);
    }

    [Fact]
    public void Keys_nothing_reads_survive_a_save()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");
        File.WriteAllText(configPath, """{ "from_a_newer_version": { "x": 1 } }""");
        var store = new AppSettingsStore(configPath, Documents);
        var settings = store.Load().Settings;

        settings.KeepAudio = true;
        store.Save(settings);

        Assert.Contains("from_a_newer_version", File.ReadAllText(configPath));
    }

    [Fact]
    public void Keys_other_programs_own_survive_a_save_nested_ones_included()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");
        File.WriteAllText(configPath, """
            { "ai": { "choice": { "provider": "codex", "model": "m" } },
              "summary": { "backend": "ollama", "web_only": "kept" },
              "auto_record": { "enabled": true } }
            """);
        var store = new AppSettingsStore(configPath, Documents);
        var previous = store.Load().Settings;
        var settings = previous.Clone();

        settings.KeepAudio = true;
        store.Save(settings, previous);

        var written = JsonNode.Parse(File.ReadAllText(configPath))!;
        Assert.Equal("codex", written["ai"]!["choice"]!["provider"]!.GetValue<string>());
        Assert.Equal("kept", written["summary"]!["web_only"]!.GetValue<string>());
        Assert.Equal("ollama", written["summary"]!["backend"]!.GetValue<string>());
        Assert.True(written["auto_record"]!["enabled"]!.GetValue<bool>());
        Assert.True(written["keep_audio"]!.GetValue<bool>());
    }

    [Fact]
    public void A_newer_edit_by_another_program_is_not_reverted_by_a_save()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");
        File.WriteAllText(configPath, """{ "summary": { "backend": "ollama" } }""");
        var store = new AppSettingsStore(configPath, Documents);
        var previous = store.Load().Settings;
        File.WriteAllText(configPath, """{ "summary": { "backend": "codex-cli" }, "stt": { "choice": { "engine": "parakeet" } } }""");
        var settings = previous.Clone();

        settings.AutoRecord.StartDelaySeconds = 4;
        store.Save(settings, previous);

        var written = JsonNode.Parse(File.ReadAllText(configPath))!;
        Assert.Equal("codex-cli", written["summary"]!["backend"]!.GetValue<string>());
        Assert.Equal("parakeet", written["stt"]!["choice"]!["engine"]!.GetValue<string>());
        Assert.Equal(4, written["auto_record"]!["start_delay_seconds"]!.GetValue<int>());
    }

    [Fact]
    public void Putting_a_value_back_to_its_default_removes_only_that_key()
    {
        using var temporary = new TemporaryDirectory();
        var configPath = Path.Combine(temporary.Path, "config.json");
        File.WriteAllText(configPath, """{ "keep_audio": true, "auto_record": { "stop_delay_seconds": 99, "other": 1 } }""");
        var store = new AppSettingsStore(configPath, Documents);
        var previous = store.Load().Settings;
        var settings = previous.Clone();

        settings.AutoRecord.StopDelaySeconds = 15;
        store.Save(settings, previous);

        var written = JsonNode.Parse(File.ReadAllText(configPath))!.AsObject();
        Assert.True(written["keep_audio"]!.GetValue<bool>());
        Assert.Null(written["auto_record"]!["stop_delay_seconds"]);
        Assert.Equal(1, written["auto_record"]!["other"]!.GetValue<int>());
    }

    [Fact]
    public void Clearing_a_value_by_path_restores_its_default()
    {
        var settings = AppSettings.CreateDefault(Documents);
        settings.AutoRecord.StopDelaySeconds = 99;

        var cleared = SettingsDocument.With(settings, "auto_record.stop_delay_seconds", null, Documents);
        var set = SettingsDocument.With(settings, "summary.language", JsonValue.Create("ru"), Documents);

        Assert.Equal(15, cleared.AutoRecord.StopDelaySeconds);
        Assert.Equal("ru", set.Summary.Language);
        Assert.Equal(99, set.AutoRecord.StopDelaySeconds);
    }
}
