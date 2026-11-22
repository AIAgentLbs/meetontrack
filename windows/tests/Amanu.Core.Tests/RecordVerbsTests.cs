using Amanu.Core.Recording;

namespace Amanu.Core.Tests;

public sealed class RecordVerbsTests
{
    // The server's recognition watchdog sends relisten: a recording Stop paused stays paused until an explicit resume.
    [Theory]
    [InlineData("relisten", true, false, false)]
    [InlineData("relisten", false, false, true)]
    [InlineData("resume", true, true, true)]
    [InlineData("resume", false, false, true)]
    [InlineData("pause", false, true, false)]
    [InlineData("pause", true, false, false)]
    public void Only_resume_unpauses(string verb, bool paused, bool togglePause, bool relisten)
    {
        Assert.Equal((togglePause, relisten), RecordVerbs.Effects(verb, paused));
    }

    [Fact]
    public void Unknown_verb_is_refused()
    {
        Assert.Throws<InvalidOperationException>(() => RecordVerbs.Effects("toggle", false));
    }
}
