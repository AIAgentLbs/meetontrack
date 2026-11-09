using System.Buffers.Binary;

namespace Amanu.Core.Recording;

/// <summary>Whether a captured packet carries anything above a peak threshold.</summary>
public static class AudioPeak
{
    /// <summary>
    /// 32-bit float and 16-bit PCM are measured; any other layout counts as sound,
    /// because "can't measure" must never read as "silent" and end a meeting.
    /// </summary>
    public static bool Exceeds(ReadOnlySpan<byte> data, bool isFloat, int bitsPerSample, float threshold)
    {
        if (isFloat && bitsPerSample == 32)
        {
            for (var i = 0; i + 4 <= data.Length; i += 4)
                if (Math.Abs(BinaryPrimitives.ReadSingleLittleEndian(data[i..])) > threshold) return true;
            return false;
        }
        if (!isFloat && bitsPerSample == 16)
        {
            var limit = threshold * short.MaxValue;
            for (var i = 0; i + 2 <= data.Length; i += 2)
                if (Math.Abs((int)BinaryPrimitives.ReadInt16LittleEndian(data[i..])) > limit) return true;
            return false;
        }
        return true;
    }
}
