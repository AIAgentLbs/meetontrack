using System.IO;
using Amanu.App;
using NAudio.Wave;
using Xunit;

namespace Amanu.Live.Tests;

public sealed class TrackWriterTests
{
    /// <summary>
    /// MEETONTRACK-139: NAudio refuses to grow a WAV past 4 GB with an
    /// ArgumentException. That killed the drain, Dispose rethrew it before closing
    /// the file, and the transcriber found mic.wav locked until the app quit.
    /// </summary>
    [Fact]
    public void A_writer_that_fails_mid_recording_still_releases_the_file()
    {
        var path = Path.Combine(Path.GetTempPath(), "amanu-track-" + Guid.NewGuid().ToString("N") + ".wav");
        try
        {
            var file = new TooLarge(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read));
            var track = new TrackWriter(file, new WaveFormat(16000, 16, 1), TrackWriter.Now100ns());
            track.Write(new byte[3200], false, TrackWriter.Now100ns(), false);
            track.Dispose();
            using (File.OpenRead(path)) { }
        }
        finally
        {
            File.Delete(path);
        }
    }

    /// <summary>Takes the header, then refuses audio the way NAudio does at 4 GB.</summary>
    private sealed class TooLarge(Stream inner) : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => true;
        public override bool CanWrite => true;
        public override long Length => inner.Length;
        public override long Position { get => inner.Position; set => inner.Position = value; }
        public override void Flush() => inner.Flush();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => inner.Seek(offset, origin);
        public override void SetLength(long value) => inner.SetLength(value);
        public override void Write(byte[] buffer, int offset, int count)
        {
            if (count >= 64) throw new ArgumentException("WAV file too large", nameof(count));
            inner.Write(buffer, offset, count);
        }
        protected override void Dispose(bool disposing)
        {
            if (disposing) inner.Dispose();
            base.Dispose(disposing);
        }
    }
}
