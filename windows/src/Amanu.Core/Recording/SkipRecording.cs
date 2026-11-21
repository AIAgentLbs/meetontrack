using System.Globalization;
using System.Text.Json;

namespace Amanu.Core.Recording;

/// <summary>
/// Calls the person chose in MeetOnTrack not to record. The web server writes
/// skip-recording.json beside the live transcript; the recorder only reads it.
/// Calls are matched by time, never by id or title: the recorder does not know
/// the server's calendar event ids.
/// </summary>
public static class SkipRecording
{
    public static readonly string DefaultPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
        ".local", "share", "meeting-copilot", "skip-recording.json");

    /// <summary>How long before its start a call already counts as that call.</summary>
    public static readonly TimeSpan Lead = TimeSpan.FromMinutes(5);

    /// <summary>
    /// True when a stored call has start - 5 min &lt;= at &lt; end. A missing, unreadable or
    /// malformed file skips nothing. The file is opened only for the read and shared for
    /// writing and deletion, because the server replaces it with os.replace.
    /// </summary>
    public static bool Covers(DateTimeOffset at, string? path = null)
    {
        try
        {
            using var stream = new FileStream(path ?? DefaultPath, FileMode.Open, FileAccess.Read,
                FileShare.ReadWrite | FileShare.Delete);
            using var document = JsonDocument.Parse(stream);
            var root = document.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("calls", out var calls)
                || calls.ValueKind != JsonValueKind.Array) return false;
            foreach (var call in calls.EnumerateArray())
            {
                if (Instant(call, "start") is { } start && Instant(call, "end") is { } end
                    && start - Lead <= at && at < end) return true;
            }
            return false;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return false;
        }
    }

    private static DateTimeOffset? Instant(JsonElement call, string name) =>
        call.ValueKind == JsonValueKind.Object
        && call.TryGetProperty(name, out var value)
        && value.ValueKind == JsonValueKind.String
        && DateTimeOffset.TryParse(value.GetString(), CultureInfo.InvariantCulture, DateTimeStyles.None, out var instant)
            ? instant
            : null;
}
