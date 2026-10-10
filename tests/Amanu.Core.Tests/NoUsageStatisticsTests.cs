using System.Text.Json;
using Amanu.Core.Configuration;

namespace Amanu.Core.Tests;

public sealed class NoUsageStatisticsTests
{
    [Fact]
    public void NewSettingsNeverOfferOrEnableUsageReporting()
    {
        var settings = AppSettings.CreateDefault(Path.GetTempPath());
        Assert.Null(typeof(AppSettings).GetProperty("Analytics"));
        Assert.DoesNotContain("\"analytics\"", JsonSerializer.Serialize(settings));
    }
}
