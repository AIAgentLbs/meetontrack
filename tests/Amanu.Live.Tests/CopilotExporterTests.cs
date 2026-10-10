using System.Text.Json;
using Amanu.App;
using Amanu.Core.Recording;
using Xunit;

namespace Amanu.Live.Tests;

public sealed class CopilotExporterTests
{
    [Fact]
    public void ExportsCurrentSessionBothAudioSidesAndRetainsFinishedSession()
    {
        var type = typeof(AmanuRuntime).Assembly.GetType("Amanu.App.CopilotExporter");
        Assert.NotNull(type);
        var root = Path.Combine(Path.GetTempPath(), "copilot-fixture-" + Guid.NewGuid());
        Directory.CreateDirectory(root);
        try
        {
            dynamic exporter = Activator.CreateInstance(type, Path.Combine(root, "live.json"))!;
            var started = DateTimeOffset.Parse("2026-01-01T12:00:00Z");
            exporter.SetState(new RecordingState(true, false, started, root, null, "fixture"));
            exporter.AddLine(new LiveLine(1, TimeSpan.FromSeconds(1), "me", "Synthetic microphone", true, 2000));
            exporter.AddLine(new LiveLine(2, TimeSpan.FromSeconds(3), "them", "Synthetic remote", false, 4000));
            exporter.AddLine(new LiveLine(2, TimeSpan.FromSeconds(3), "them", "Synthetic remote final", true, 4500));
            exporter.Flush();
            using var active = JsonDocument.Parse(File.ReadAllText(Path.Combine(root,"live.json")));
            Assert.Equal(1, active.RootElement.GetProperty("version").GetInt32());
            Assert.Equal("recording", active.RootElement.GetProperty("status").GetString());
            var segments = active.RootElement.GetProperty("segments");
            Assert.Equal(2, segments.GetArrayLength());
            Assert.Equal("microphone", segments[0].GetProperty("source").GetString());
            Assert.Equal("system", segments[1].GetProperty("source").GetString());
            Assert.False(segments[1].GetProperty("provisional").GetBoolean());
            var id = active.RootElement.GetProperty("meeting_id").GetString();
            exporter.SetState(RecordingState.Ready);
            exporter.Flush();
            using var ended = JsonDocument.Parse(File.ReadAllText(Path.Combine(root,"live.json")));
            Assert.Equal("finished", ended.RootElement.GetProperty("status").GetString());
            Assert.Equal(id, ended.RootElement.GetProperty("meeting_id").GetString());
            Assert.Equal(2, ended.RootElement.GetProperty("segments").GetArrayLength());
            exporter.Dispose();
        }
        finally { Directory.Delete(root,true); }
    }
}
