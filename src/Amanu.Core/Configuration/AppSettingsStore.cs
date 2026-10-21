using System.Text.Json;
using System.Text.Json.Nodes;
using static Amanu.Core.Localization.Localized;

namespace Amanu.Core.Configuration;

/// <summary>Something wrong with config.json that the person needs to hear about.</summary>
/// <param name="Unreadable">
/// True when the file is not JSON at all. Then nothing in it is obeyed, nothing
/// is written over it, and transcription and summaries wait until it is fixed.
/// False for a single value Amanu cannot use, whose default applies instead.
/// </param>
public sealed record ConfigProblem(bool Unreadable, string Headline, string Explanation)
{
    public static ConfigProblem UnreadableFile(string reason) => new(
        true,
        T("config.json can't be read — transcription and summaries are waiting",
          "config.json не читается — расшифровка и саммари ждут"),
        T($"config.json can't be read ({reason}). Until it is fixed, Meeting Copilot keeps to the settings it last read from it — its defaults, with auto-record off and nothing sent anywhere, if it never could — and keeps recording, but holds transcription and summaries, and saves no changed settings.",
          $"config.json не читается ({reason}). Пока файл не исправлен, Meeting Copilot держится настроек, прочитанных из него в последний раз (а если не смогла прочитать ни разу — настроек по умолчанию с выключенной автозаписью, ничего никуда не отправляя), и продолжает записывать, но расшифровка и саммари ждут, а изменённые настройки не сохраняются."));

    public static ConfigProblem UnusableValue(string key, string found, string expected) => new(
        false,
        T("config.json has a setting Meeting Copilot can't use — see Settings",
          "в config.json есть настройка, которую Meeting Copilot не может использовать, — см. настройки"),
        T($"{key} in config.json is {found}, which Meeting Copilot can't use: it expects {expected}, so the default applies.",
          $"{key} в config.json — {found}, а Meeting Copilot ждёт там {expected}, поэтому действует значение по умолчанию."));
}

public sealed class ConfigUnreadableException(ConfigProblem problem) : InvalidOperationException(problem.Explanation)
{
    public ConfigProblem Problem { get; } = problem;
}

public sealed record SettingsLoad(AppSettings Settings, IReadOnlyList<ConfigProblem> Problems)
{
    public bool IsUnreadable => Problems.Any(problem => problem.Unreadable);
}

/// <summary>
/// Reads and writes config.json. An unparseable file is never replaced and never
/// silently traded for defaults: the last settings read stay in force, and the
/// file waits for the person to fix it.
/// </summary>
public sealed class AppSettingsStore(string configPath, string homeDirectory)
{
    public string ConfigPath => configPath;
    public string HomeDirectory => homeDirectory;

    public AppSettings Defaults => AppSettings.CreateDefault(homeDirectory);

    /// <param name="lastGood">
    /// What was read before, which stays in force if the file cannot be read now.
    /// Null at startup: then an unreadable file means the conservative settings.
    /// </param>
    public SettingsLoad Load(AppSettings? lastGood = null)
    {
        if (!File.Exists(configPath)) return new(Defaults, []);

        JsonNode? root;
        try
        {
            root = JsonNode.Parse(File.ReadAllText(configPath),
                documentOptions: new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
        }
        catch (JsonException exception)
        {
            return Unreadable(Reason(exception), lastGood);
        }
        catch (IOException exception)
        {
            return Unreadable(exception.Message, lastGood);
        }
        if (root is null) return new(Defaults, []);
        if (root is not JsonObject document)
            return Unreadable(T("the top level is not an object", "верхний уровень — не объект"), lastGood);

        var problems = RemoveUnusableValues(document);
        AppSettings settings;
        try
        {
            settings = SettingsDocument.FromNode(document);
        }
        catch (JsonException exception)
        {
            return Unreadable(Reason(exception), lastGood);
        }
        if (string.IsNullOrWhiteSpace(settings.RecordingsDirectory))
            settings.RecordingsDirectory = AppSettings.DefaultRecordingsDirectory(homeDirectory);
        return new(settings, problems);
    }

    /// <summary>
    /// Writes what changed between <paramref name="previous"/> and
    /// <paramref name="settings"/> into the file as it is on disk now, or refuses
    /// when that file cannot be read. config.json is shared with the web server
    /// and the Mac app, so every other key, nested ones included, and every newer
    /// edit another program made since the last read, stays as it is. The read
    /// and the replace happen under config.json.lock, the lock the web server
    /// takes for its own read-modify-write.
    /// </summary>
    /// <param name="previous">The settings this change started from.</param>
    /// <exception cref="ConfigUnreadableException">The file is there and is not JSON.</exception>
    public void Save(AppSettings settings, AppSettings previous)
    {
        var directory = Path.GetDirectoryName(configPath);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        using var _ = ExclusiveLock(configPath + ".lock");

        var document = new JsonObject();
        if (File.Exists(configPath))
        {
            JsonNode? root;
            try
            {
                root = JsonNode.Parse(File.ReadAllText(configPath),
                    documentOptions: new JsonDocumentOptions { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            }
            catch (JsonException exception)
            {
                throw new ConfigUnreadableException(ConfigProblem.UnreadableFile(Reason(exception)));
            }
            if (root is JsonObject existing) document = existing;
            else if (root is not null)
                throw new ConfigUnreadableException(ConfigProblem.UnreadableFile(T("the top level is not an object", "верхний уровень — не объект")));
        }

        ApplyChanges(document, SettingsDocument.ToNode(previous), SettingsDocument.ToNode(settings), SettingsDocument.ToNode(Defaults));

        var temporary = configPath + ".tmp-" + Guid.NewGuid().ToString("N");
        try
        {
            File.WriteAllText(temporary, document.ToJsonString(AppSettings.JsonOptions) + Environment.NewLine);
            File.Move(temporary, configPath, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
    }

    /// <summary>
    /// Byte 0 of the lock file, as the web server's msvcrt.locking takes it.
    /// Waits about ten seconds, as msvcrt.locking does, then gives up.
    /// </summary>
    private static FileStream ExclusiveLock(string path)
    {
        var stream = new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite | FileShare.Delete);
        // ponytail: .NET has no byte-range lock on macOS; this store only runs on Windows.
        if (OperatingSystem.IsMacOS()) return stream;
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                stream.Lock(0, 1);
                return stream;
            }
            catch (IOException) when (attempt < 100)
            {
                Thread.Sleep(100);
            }
            catch
            {
                stream.Dispose();
                throw;
            }
        }
    }

    /// <summary>
    /// Puts each value that differs between <paramref name="before"/> and
    /// <paramref name="after"/> into <paramref name="target"/>. A value back at
    /// its default is taken out, so the file keeps to the person's decisions.
    /// </summary>
    private static void ApplyChanges(JsonObject target, JsonObject before, JsonObject after, JsonObject? defaults)
    {
        foreach (var key in before.Select(entry => entry.Key).Union(after.Select(entry => entry.Key)).ToList())
        {
            before.TryGetPropertyValue(key, out var old);
            after.TryGetPropertyValue(key, out var value);
            if (JsonNode.DeepEquals(old, value)) continue;
            JsonNode? fallback = null;
            defaults?.TryGetPropertyValue(key, out fallback);
            // Settings load case-insensitively, so the file's own spelling is the one to change.
            var name = target.FirstOrDefault(entry => string.Equals(entry.Key, key, StringComparison.OrdinalIgnoreCase)).Key ?? key;
            if (value is JsonObject newObject)
            {
                if (target[name] is not JsonObject child)
                {
                    child = new JsonObject();
                    target[name] = child;
                }
                ApplyChanges(child, old as JsonObject ?? new JsonObject(), newObject, fallback as JsonObject);
            }
            else if (value is null || JsonNode.DeepEquals(value, fallback))
                target.Remove(name);
            else
                target[name] = value.DeepClone();
        }
    }

    private SettingsLoad Unreadable(string reason, AppSettings? lastGood) =>
        new(lastGood?.Clone() ?? AppSettings.CreateConservative(homeDirectory), [ConfigProblem.UnreadableFile(reason)]);

    private static string Reason(JsonException exception) =>
        exception.LineNumber is { } line
            ? T($"line {line + 1}", $"строка {line + 1}") + (exception.BytePositionInLine is { } column ? T($", column {column + 1}", $", позиция {column + 1}") : "")
            : exception.Message;

    /// <summary>
    /// Takes out every value of the wrong kind — <c>"enabled": "false"</c>, a
    /// string where a switch belongs — so its default applies, and says so. A
    /// quoted "false" reads as off to anybody but a JSON parser, and it used to
    /// make the whole file unreadable.
    /// </summary>
    private static List<ConfigProblem> RemoveUnusableValues(JsonObject document)
    {
        var problems = new List<ConfigProblem>();
        foreach (var entry in SettingsSchema.Entries)
        {
            var keys = entry.Keys;
            JsonNode? parent = document;
            for (var index = 0; index < keys.Length - 1 && parent is not null; index++)
                parent = parent is JsonObject item && item.TryGetPropertyValue(keys[index], out var next) ? next : null;
            if (parent is not JsonObject container || !container.TryGetPropertyValue(keys[^1], out var value) || value is null)
                continue;
            var expected = Expected(entry, value);
            if (expected is null) continue;
            problems.Add(ConfigProblem.UnusableValue(entry.Path, Describe(value), expected));
            container.Remove(keys[^1]);
        }
        return problems;
    }

    private static string? Expected(SettingEntry entry, JsonNode value)
    {
        var kind = value.GetValueKind();
        return entry.Kind switch
        {
            SettingKind.Toggle => kind is JsonValueKind.True or JsonValueKind.False ? null : T("true or false", "true или false"),
            SettingKind.Number => kind == JsonValueKind.Number && value.AsValue().TryGetValue<int>(out _) ? null : T("a whole number", "целое число"),
            SettingKind.Choice => kind == JsonValueKind.String && entry.Options!.Contains(value.GetValue<string>())
                ? null
                : T("one of ", "одно из: ") + string.Join(", ", entry.Options!),
            SettingKind.List => value is JsonArray array && array.All(item => item?.GetValueKind() == JsonValueKind.String)
                ? null : T("a list of strings", "список строк"),
            SettingKind.Command => value is JsonObject ? null : T("an object with executable and arguments", "объект с executable и arguments"),
            _ => kind == JsonValueKind.String ? null : T("a string", "строку"),
        };
    }

    private static string Describe(JsonNode value)
    {
        var text = value.ToJsonString();
        return text.Length <= 40 ? text : text[..40] + "…";
    }
}
