using System.IO;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Amanu.Core.Recording;

namespace Amanu.App;

/// <summary>Same-user named pipe. Contains commands and health metadata, never credentials.</summary>
public static class CopilotControl
{
    private const string SessionMismatch = "session_mismatch";

    private static string PipeName => "MeetingCopilot-" + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(WindowsIdentity.GetCurrent().User!.Value)))[..16] + App.Scope;

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
                var (command, session) = RecordVerbs.Parse(await reader.ReadLineAsync(timeout.Token) ?? "");
                object result;
                try
                {
                    // J1: a command for a session that is no longer the live one (the next call began) does nothing.
                    if (!RecordVerbs.Accepts(session, runtime.State.IsRecording ? runtime.LiveSessionId : ""))
                    {
                        await writer.WriteLineAsync(JsonSerializer.Serialize(new { ok=false, error=SessionMismatch }));
                        continue;
                    }
                    switch (command)
                    {
                        case "status": break;
                        case "start":
                            if (runtime.State.IsRecording) throw new InvalidOperationException("A meeting is already recording");
                            await runtime.StartManualAsync(); break;
                        case "stop":
                            if (!runtime.State.IsRecording) throw new InvalidOperationException("No active recording");
                            await runtime.StopManualAsync(); break;
                        case "pause":
                        case "resume":
                        case "relisten":
                            if (!runtime.State.IsRecording) throw new InvalidOperationException("No active recording");
                            var (togglePause, relisten) = RecordVerbs.Effects(command!, runtime.State.IsPaused);
                            if (togglePause) await runtime.TogglePauseAsync();
                            if (relisten) await runtime.ResumeRecognitionAsync();
                            break;
                        case "quit-when-idle":
                            _ = System.Windows.Application.Current.Dispatcher.InvokeAsync(App.QuitWhenIdleAsync); break;
                        default: throw new InvalidOperationException("Unknown capture command");
                    }
                    result = new { ok=true, recording=runtime.State.IsRecording, paused=runtime.State.IsPaused,
                        live_model_ready=runtime.IsLocalModelReady("nemotron-live"), final_model_ready=runtime.IsLocalModelReady("parakeet"),
                        local_runtime_ready=runtime.LocalRuntimePresent, live_status=runtime.LiveStatus,
                        skip_recording=true };
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
            if (json.RootElement.GetProperty("ok").GetBoolean()) return 0;
            // Exit 3: the recorder is live with another session; the server reads it as "that recording ended".
            return json.RootElement.TryGetProperty("error", out var error) && error.GetString() == SessionMismatch ? 3 : 1;
        }
        catch (Exception) { Console.WriteLine("{\"ok\":false,\"error\":\"Capture is not running or did not respond\"}"); return 1; }
    }
}
