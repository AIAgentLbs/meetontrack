using System.Text.Json;
using System.Text.Json.Nodes;

namespace Amanu.Core.Configuration;

/// <summary>Settings as a JSON tree, for the edits that go by path rather than by property.</summary>
public static class SettingsDocument
{
    public static JsonObject ToNode(AppSettings settings) =>
        JsonSerializer.SerializeToNode(settings, AppSettings.JsonOptions)!.AsObject();

    public static AppSettings FromNode(JsonNode node) =>
        node.Deserialize<AppSettings>(AppSettings.JsonOptions)
        ?? throw new JsonException("The settings are empty.");

    public static JsonNode? Get(JsonNode root, string path)
    {
        JsonNode? current = root;
        foreach (var key in path.Split('.'))
        {
            if (current is not JsonObject item || !item.TryGetPropertyValue(key, out current)) return null;
        }
        return current;
    }

    /// <summary>
    /// A copy of <paramref name="settings"/> with one value replaced. A null
    /// value puts the default back, which is how a field is cleared.
    /// </summary>
    public static AppSettings With(AppSettings settings, string path, JsonNode? value, string homeDirectory)
    {
        var root = ToNode(settings);
        var keys = path.Split('.');
        var parent = root;
        foreach (var key in keys[..^1])
        {
            if (parent[key] is not JsonObject child)
            {
                child = new JsonObject();
                parent[key] = child;
            }
            parent = child;
        }
        var replacement = value ?? SettingsSchema.DefaultFor(path, homeDirectory);
        parent[keys[^1]] = replacement?.DeepClone();
        return FromNode(root);
    }
}
