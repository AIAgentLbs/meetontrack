namespace Amanu.Core.Processing;

/// <summary>
/// The speaker labels a transcript carries, in the macOS vocabulary: <c>me</c>
/// for the microphone, <c>them</c> for the call, and a letter after either when
/// diarization heard more than one voice on that side — "them A", "them B". A
/// side with one voice keeps the bare word: "them" beats "them A" when there is
/// nobody else it could be.
/// </summary>
public static class SpeakerLabels
{
    public const string Me = "me";
    public const string Them = "them";

    /// <summary>A label an engine hands over before the sides are counted.</summary>
    public static string Raw(string? side, string? voice) => $"{side}\u001F{voice}";

    /// <summary>Turns every <see cref="Raw"/> label into its final form.</summary>
    public static IReadOnlyList<TranscriptSegment> Assign(IReadOnlyList<TranscriptSegment> segments)
    {
        var voices = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (var segment in segments)
        {
            if (!TrySplit(segment.Speaker, out var side, out var voice)) continue;
            if (!voices.TryGetValue(side, out var list)) voices[side] = list = [];
            if (!list.Contains(voice)) list.Add(voice);
        }
        return segments.Select(segment =>
        {
            if (!TrySplit(segment.Speaker, out var side, out var voice)) return segment;
            var list = voices[side];
            var letter = Letter(list.IndexOf(voice));
            var label = side.Length == 0 ? letter
                : list.Count == 1 ? side
                : $"{side} {letter}";
            return segment with { Speaker = label };
        }).ToArray();
    }

    /// <summary>
    /// How a label reads in the window: the microphone is "You", the call is
    /// "Others", in the interface language, as on the Mac. The file keeps "me"
    /// and "them"; the letter after either stays, since it tells voices apart.
    /// </summary>
    public static string Display(string label) => label switch
    {
        Me => You,
        Them => Others,
        _ when label.StartsWith("them ", StringComparison.Ordinal) => Others + label[4..],
        _ when label.StartsWith("me ", StringComparison.Ordinal) => You + label[2..],
        _ => label,
    };

    private static string You => Localization.Localized.T("You", "Вы");
    private static string Others => Localization.Localized.T("Others", "Остальные");

    private static bool TrySplit(string? label, out string side, out string voice)
    {
        side = voice = "";
        var separator = label?.IndexOf('\u001F') ?? -1;
        if (separator < 0) return false;
        side = label![..separator];
        voice = label[(separator + 1)..];
        return true;
    }

    private static string Letter(int index) =>
        index < 26 ? ((char)('A' + index)).ToString() : "A" + (char)('A' + index - 26);
}
