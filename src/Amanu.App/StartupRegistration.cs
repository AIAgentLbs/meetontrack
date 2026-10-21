using Microsoft.Win32;

namespace Amanu.App;

/// <summary>
/// MeetOnTrack's launcher starts the recorder at sign-in (its Startup shortcut names the current
/// version). Earlier recorders also registered their own versioned path under HKCU Run, which
/// outlived updates and raced the launcher; that value is removed and never written again.
/// </summary>
public static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ValueName = "MeetingCopilotCapture";

    public static void RemoveLegacyEntry()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        key?.DeleteValue(ValueName, throwOnMissingValue: false);
    }
}
