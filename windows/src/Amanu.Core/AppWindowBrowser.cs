namespace Amanu.Core;

/// <summary>Which browser can show the assistant as an app window (<c>--app=</c>).</summary>
public static class AppWindowBrowser
{
    // Chromium browsers that honour --app. Same list as scripts/windows/meeting-copilot.ps1.
    private static readonly string[] Known = ["chrome.exe", "msedge.exe", "brave.exe", "vivaldi.exe", "chromium.exe"];

    /// <summary>
    /// The executable of a URL handler's <c>shell\open\command</c> when it is a Chromium browser,
    /// otherwise null (the caller then opens the plain URL with the default browser).
    /// </summary>
    public static string? FromOpenCommand(string? command)
    {
        command = command?.Trim();
        if (string.IsNullOrEmpty(command)) return null;
        int end;
        string exe;
        if (command[0] == '"')
        {
            end = command.IndexOf('"', 1);
            if (end < 0) return null;
            exe = command[1..end];
        }
        else
        {
            end = command.IndexOf(".exe", StringComparison.OrdinalIgnoreCase);
            if (end < 0) return null;
            exe = command[..(end + 4)];
        }
        var name = exe[(exe.LastIndexOfAny(['\\', '/']) + 1)..];
        return Known.Contains(name, StringComparer.OrdinalIgnoreCase) ? exe : null;
    }
}

/// <summary>
/// Where the assistant's local service answers: 43121 unless another program held that port
/// when it started (MEETONTRACK-131, as MEETONTRACK-130 on the Mac); then meeting-copilot.ps1
/// recorded the port it used in <c>server-port</c>.
/// </summary>
public static class AssistantAddress
{
    public const int DefaultPort = 43121;

    /// <summary>
    /// The recorded port when it is one and answers as MeetOnTrack, so a stale record never
    /// opens another program's page; otherwise 43121.
    /// </summary>
    public static string Url(string? recorded, Func<int, bool> answersAsAssistant) =>
        int.TryParse(recorded?.Trim(), out var port) && port is > 0 and < 65536 && port != DefaultPort && answersAsAssistant(port)
            ? $"http://127.0.0.1:{port}/"
            : $"http://127.0.0.1:{DefaultPort}/";
}
