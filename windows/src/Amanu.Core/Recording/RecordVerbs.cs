namespace Amanu.Core.Recording;

/// <summary>What pause, resume and relisten do to a live recording. Only an explicit resume unpauses;
/// relisten (the server's recognition watchdog) restarts recognition of a running recording and never
/// unpauses one, so it cannot undo a Stop's pause.</summary>
public static class RecordVerbs
{
    public static (bool TogglePause, bool Relisten) Effects(string verb, bool paused) => verb switch
    {
        "pause" => (!paused, false),
        "resume" => (paused, true),
        "relisten" => (false, !paused),
        _ => throw new InvalidOperationException("Unknown capture command"),
    };

    /// <summary>The line sent over the control pipe for `record verb [--session id]`: "verb" or "verb id";
    /// null for arguments that are neither.</summary>
    public static string? PipeLine(string[] arguments) => arguments switch
    {
        [var verb] => verb,
        [var verb, "--session", var session] when session.Length > 0 && !session.Contains(' ') => verb + " " + session,
        _ => null,
    };

    public static (string Verb, string? Session) Parse(string line)
    {
        var space = line.IndexOf(' ');
        return space < 0 ? (line, null) : (line[..space], line[(space + 1)..]);
    }

    /// <summary>A command naming a session acts only on that live session (the meeting_id in the live file);
    /// one without acts on whatever is live, as before.</summary>
    public static bool Accepts(string? session, string live) => session is null || session == live;
}
