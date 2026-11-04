using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Amanu.Core.Recording;

namespace Amanu.App;

/// <summary>Atomically exports the capture contract. Never blocks WASAPI on disk I/O.</summary>
public sealed class CopilotExporter : IDisposable
{
    private readonly string path;
    private readonly object gate = new();
    private readonly System.Threading.Timer timer;
    private readonly SortedDictionary<long, LiveLine> lines = new();
    private RecordingState state = RecordingState.Ready;
    private string meetingId = "";
    private string directory = "";
    private DateTimeOffset started;
    private bool dirty;
    private bool disposed;
    private DateTimeOffset written;

    public CopilotExporter(string path)
    {
        this.path = path;
        timer = new(_ => { try { Flush(); } catch (IOException) { } catch (UnauthorizedAccessException) { } }, null, 1000, 1000);
    }

    public void SetState(RecordingState next)
    {
        lock (gate)
        {
            if (next.IsRecording && next.SessionDirectory != directory)
            {
                directory = next.SessionDirectory ?? "";
                started = next.StartedAt ?? DateTimeOffset.Now;
                meetingId = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(directory + started.ToString("O"))))[..32];
                lines.Clear();
            }
            state = next;
            dirty = true;
        }
    }

    public void AddLine(LiveLine line)
    {
        lock (gate)
        {
            if (string.IsNullOrEmpty(meetingId)) return;
            lines[line.Id] = line;
            while (lines.Count > 20000) lines.Remove(lines.Keys.First());
            dirty = true;
        }
    }

    public void Flush()
    {
        lock (gate)
        {
            if (disposed || string.IsNullOrEmpty(meetingId) || (!dirty && (!state.IsRecording || DateTimeOffset.Now - written < TimeSpan.FromSeconds(5)))) return;
            var segments = lines.Values.OrderBy(line => line.At).Select(line => new {
                timestamp = (started + line.At).ToString("O"),
                end_timestamp = started.AddMilliseconds(line.AudioThroughMs).ToString("O"),
                source = line.Speaker.StartsWith("me", StringComparison.Ordinal) ? "microphone" : "system",
                speaker = line.Speaker.StartsWith("me", StringComparison.Ordinal) ? "" : "Собеседник",
                text = line.Text, provisional = !line.IsFinal,
            }).ToArray();
            var payload = new { version = 1, source = "meeting-copilot-windows", meeting_id = meetingId,
                title = "MeetOnTrack - " + Path.GetFileName(directory),
                status = state.IsRecording ? state.IsPaused ? "paused" : "recording" : "finished",
                started_at = started.ToString("O"), updated_at = DateTimeOffset.Now.ToString("O"),
                recording_dir = directory, segments };
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var temporary = path + ".tmp";
            File.WriteAllText(temporary, JsonSerializer.Serialize(payload));
            File.Move(temporary, path, overwrite:true);
            dirty = false;
            written = DateTimeOffset.Now;
        }
    }

    public void Dispose() { timer.Dispose(); lock (gate) disposed = true; }
}
