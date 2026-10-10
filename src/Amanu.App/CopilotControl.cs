using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace Amanu.App;

/// <summary>Same-user named pipe. Contains commands and health metadata, never credentials.</summary>
public static class CopilotControl
{
    private static string PipeName => "MeetingCopilot-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(WindowsIdentity.GetCurrent().User!.Value)))[..16];

    public static async Task ServeAsync(AmanuRuntime runtime, CancellationToken lifetime)
    {
        while (!lifetime.IsCancellationRequested)
        {
            try
            {
                await using var pipe = new NamedPipeServerStream(PipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(lifetime);
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime);
                timeout.CancelAfter(TimeSpan.FromSeconds(8));
                using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen:true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen:true) { AutoFlush=true };
                var command = await reader.ReadLineAsync(timeout.Token);
                object result;
                try
                {
                    switch (command)
                    {
                        case "status": break;
                        case "start":
                            if (runtime.State.IsRecording) throw new InvalidOperationException("A meeting is already recording");
                            await runtime.StartManualAsync(); break;
                        case "stop":
                            if (!runtime.State.IsRecording) throw new InvalidOperationException("No active recording");
                            await runtime.StopManualAsync(); break;
                        case "resume":
                            if (!runtime.State.IsRecording) throw new InvalidOperationException("No active recording");
                            await runtime.ResumeRecognitionAsync(); break;
                        default: throw new InvalidOperationException("Unknown capture command");
                    }
                    result = new { ok=true, recording=runtime.State.IsRecording, paused=runtime.State.IsPaused,
                        live_model_ready=runtime.IsLocalModelReady("nemotron-live"), final_model_ready=runtime.IsLocalModelReady("parakeet"),
                        local_runtime_ready=runtime.LocalRuntimePresent, live_status=runtime.LiveStatus };
                }
                catch (Exception) { result = new { ok=false, error="Capture command failed; inspect the Capture window" }; }
                await writer.WriteLineAsync(JsonSerializer.Serialize(result));
            }
            catch (OperationCanceledException) { }
            catch (IOException) { }
        }
    }

    public static async Task<int> SendAsync(string command)
    {
        try
        {
            await using var pipe = new NamedPipeClientStream(".",PipeName,PipeDirection.InOut,PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.ConnectAsync(4000);
            using var reader = new StreamReader(pipe,Encoding.UTF8,leaveOpen:true);
            using var writer = new StreamWriter(pipe,new UTF8Encoding(false),leaveOpen:true) {AutoFlush=true};
            await writer.WriteLineAsync(command);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
            var result = await reader.ReadLineAsync(timeout.Token);
            Console.WriteLine(result);
            using var json=JsonDocument.Parse(result!);
            return json.RootElement.GetProperty("ok").GetBoolean() ? 0 : 1;
        }
        catch (Exception) { Console.WriteLine("{\"ok\":false,\"error\":\"Capture is not running or did not respond\"}"); return 1; }
    }
}
