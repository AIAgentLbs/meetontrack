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

    // J1: the server names the session a command is for; the recorder acts only while it is the live one.
    [Theory]
    [InlineData(new[] { "stop" }, "stop")]
    [InlineData(new[] { "stop", "--session", "A1" }, "stop A1")]
    public void Command_line_carries_the_session(string[] arguments, string line)
    {
        Assert.Equal(line, RecordVerbs.PipeLine(arguments));
    }

    [Fact]
    public void Malformed_arguments_are_refused()
    {
        Assert.Null(RecordVerbs.PipeLine(new[] { "stop", "--session" }));
        Assert.Null(RecordVerbs.PipeLine(new[] { "stop", "--other", "A1" }));
    }

    [Theory]
    [InlineData("stop", "stop", null)]
    [InlineData("stop A1", "stop", "A1")]
    public void Pipe_line_is_read_back(string line, string verb, string? session)
    {
        Assert.Equal((verb, session), RecordVerbs.Parse(line));
    }

    [Theory]
    [InlineData("A1", "A1", true)]
    [InlineData("A1", "B2", false)]
    [InlineData("A1", "", false)]
    [InlineData(null, "B2", true)]
    public void Mismatch_is_refused_match_is_accepted(string? session, string live, bool accepted)
    {
        Assert.Equal(accepted, RecordVerbs.Accepts(session, live));
    }
}
