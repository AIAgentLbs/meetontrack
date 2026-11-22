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
}
