namespace Amanu.Core.Tests;

public sealed class AppWindowBrowserTests
{
    [Theory]
    [InlineData(@"""C:\Program Files\Google\Chrome\Application\chrome.exe"" --single-argv -- ""%1""", @"C:\Program Files\Google\Chrome\Application\chrome.exe")]
    [InlineData(@"""C:\Program Files (x86)\Microsoft\Edge\Application\MSEDGE.EXE"" --single-argv -- ""%1""", @"C:\Program Files (x86)\Microsoft\Edge\Application\MSEDGE.EXE")]
    [InlineData(@"C:\Users\u\AppData\Local\BraveSoftware\Brave-Browser\Application\brave.exe -- %1", @"C:\Users\u\AppData\Local\BraveSoftware\Brave-Browser\Application\brave.exe")]
    [InlineData(@"""C:\Program Files\Mozilla Firefox\firefox.exe"" -osint -url ""%1""", null)]
    [InlineData(@"""C:\Program Files\Google\Chrome\Application\chrome.exe", null)]
    [InlineData("", null)]
    [InlineData(null, null)]
    public void Only_a_chromium_handler_opens_an_app_window(string? command, string? expected) =>
        Assert.Equal(expected, AppWindowBrowser.FromOpenCommand(command));
}
