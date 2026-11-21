using Amanu.Core.Recording;

namespace Amanu.Core.Tests;

public sealed class SkipRecordingTests
{
    // 09:00+01:00 is 08:00 UTC, the same instant as Start.
    private static readonly DateTimeOffset Start = new(2027, 1, 15, 8, 0, 0, TimeSpan.Zero);

    private const string OneCall = """
        {"version": 1, "calls": [{"key": "2027-01-15T09:00:00+01:00|Pilot review", "event_id": "",
          "start": "2027-01-15T09:00:00+01:00", "end": "2027-01-15T09:30:00+01:00"}]}
        """;

    [Fact]
    public void CoversWindow()
    {
        using var root = new TemporaryDirectory();
        var path = Path.Combine(root.Path, "skip-recording.json");
        File.WriteAllText(path, OneCall);

        Assert.False(SkipRecording.Covers(Start.AddMinutes(-6), path));
        Assert.True(SkipRecording.Covers(Start.AddMinutes(-4), path));
        Assert.True(SkipRecording.Covers(Start.AddMinutes(30).AddSeconds(-1), path));
        Assert.False(SkipRecording.Covers(Start.AddMinutes(30), path));

        File.WriteAllText(path, "not json");
        Assert.False(SkipRecording.Covers(Start, path));
        Assert.False(SkipRecording.Covers(Start, Path.Combine(root.Path, "missing.json")));
    }
}
