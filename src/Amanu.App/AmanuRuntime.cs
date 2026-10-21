using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Text.Json;
using System.Text.Json.Nodes;
using Amanu.Core.Configuration;
using Amanu.Core.Localization;
using Amanu.Core.Processing;
using Amanu.Core.Recording;
using Amanu.Core.Sessions;
using Microsoft.Win32;
using static Amanu.Core.Localization.Localized;

namespace Amanu.App;

/// <summary>
/// Everything that runs whether or not a window is open: the recorder, the call
/// monitor, the processing queue, and the settings they all read.
/// </summary>
/// <remarks>
/// Settings change in one place, <see cref="Update"/>, which writes the file and
/// then applies the change to every part that depends on it — the auto-record
/// switch, the recordings folder, the call-app lists, the tray icon — so a
/// switch flipped in any window or in the tray takes effect at once and every
/// other surface shows the same answer.
/// </remarks>
public sealed class AmanuRuntime : IAsyncDisposable
{
    private readonly AppSettingsStore store;
    private readonly SessionStore sessions;
    private readonly RecordingCoordinator coordinator;
    private readonly CallActivityMonitor activityMonitor;
    private readonly HttpClient httpClient;
    private readonly SecretStore secrets;
    private readonly ModelManager models;
    private readonly ProcessingCoordinator processing;
    private readonly WindowsAudioCapture capture;
    private readonly LiveTranscriptionCoordinator liveTranscription;
    private readonly CopilotExporter copilotExporter;
    private readonly CancellationTokenSource lifetime = new();
    private readonly FileSystemWatcher? configWatcher;
    private readonly Lock settingsLock = new();
    private AppSettings settings;
    private IReadOnlyList<ConfigProblem> problems;
    private CancellationTokenSource? reloadDebounce;
    private bool disposed;

    private AmanuRuntime(AppSettingsStore store, SettingsLoad load, string dataDirectory)
    {
        this.store = store;
        settings = load.Settings;
        problems = load.Problems;
        DataDirectory = dataDirectory;
        copilotExporter = new CopilotExporter(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "share", "meeting-copilot", "meeting-copilot-live.json"));
        SetupPath = Path.Combine(dataDirectory, "setup.json");

        TryCreateDirectory(settings.RecordingsDirectory);
        sessions = new SessionStore(settings.RecordingsDirectory, Environment.ProcessId);
        var recovered = sessions.RecoverInterrupted(DateTimeOffset.Now, ProcessIsAlive);
        foreach (var directory in recovered)
        {
            AudioPreprocessor.RepairHeader(Path.Combine(directory, "mic.wav"));
            AudioPreprocessor.RepairHeader(Path.Combine(directory, "system.wav"));
        }
        RecoveredSessionCount = recovered.Count;

        capture = new WindowsAudioCapture();
        coordinator = new RecordingCoordinator(sessions, new AutoRecordPolicy(Options(settings)), capture,
            () => Settings.SystemAudio == "all");
        activityMonitor = new CallActivityMonitor(Matcher(settings));
        httpClient = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
        httpClient.DefaultRequestHeaders.UserAgent.ParseAdd($"MeetOnTrack-Windows/{AppVersion}");
        secrets = new SecretStore();
        models = new ModelManager(dataDirectory, httpClient);
        processing = new ProcessingCoordinator(() => Settings, () => !ConfigUnreadable, secrets, models, httpClient);
        liveTranscription = new LiveTranscriptionCoordinator(capture, models, () => Settings);

        coordinator.StateChanged += (_, state) =>
        {
            copilotExporter.SetState(state);
            StateChanged?.Invoke(this, state);
        };
        coordinator.RecordingCompleted += (_, recording) =>
        {
            if (!recording.Discarded && recording.Settled) processing.Enqueue(recording.Session.Directory);
            SessionsChanged?.Invoke(this, EventArgs.Empty);
        };
        coordinator.AutomaticStartFailed += (_, failure) =>
        {
            Notify(T("Couldn't start recording", "Не удалось начать запись"),
                failure.Error.Message + " " + T($"Trying again in {(int)failure.RetryIn.TotalSeconds} s.", $"Повторю через {(int)failure.RetryIn.TotalSeconds} с."),
                NotificationKind.Error);
        };
        processing.StatusChanged += (_, status) =>
        {
            ProcessingStatusChanged?.Invoke(this, status);
            if (status.Stage == "complete" && status.SessionDirectory is not null)
                Notify("MeetOnTrack", status.Message, NotificationKind.Information);
            else if (status.Stage == "failed")
                Notify(T("MeetOnTrack — processing failed", "MeetOnTrack — обработка не удалась"), status.Message, NotificationKind.Error);
        };
        processing.SessionsChanged += (_, _) => SessionsChanged?.Invoke(this, EventArgs.Empty);
        models.Progress += (_, progress) => DownloadProgressChanged?.Invoke(this, progress);
        models.DownloadFinished += (_, item) =>
        {
            Task.Run(processing.Rescan);
            if (item.Equals("Model nemotron-live", StringComparison.OrdinalIgnoreCase)) _ = liveTranscription.RefreshAsync();
        };
        liveTranscription.LineReady += (_, line) => { copilotExporter.AddLine(line); LiveLineReady?.Invoke(this, line); };
        capture.TrackLost += (_, track) => Notify(
            T("A recording device went away", "Устройство записи пропало"),
            track == "mic"
                ? T("The microphone stopped delivering sound; the recording goes on with the call audio.",
                    "Микрофон перестал давать звук; запись продолжается со звуком звонка.")
                : T("The call audio stopped; the recording goes on with the microphone. Start a new recording to pick up the new device.",
                    "Звук звонка пропал; запись продолжается с микрофоном. Чтобы подхватить новое устройство, начните запись заново."),
            NotificationKind.Warning);
        liveTranscription.StatusChanged += (_, status) => LiveStatusChanged?.Invoke(this, status);

        try
        {
            configWatcher = new FileSystemWatcher(Path.GetDirectoryName(store.ConfigPath)!, Path.GetFileName(store.ConfigPath))
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName | NotifyFilters.Size | NotifyFilters.CreationTime,
                EnableRaisingEvents = true,
            };
            configWatcher.Changed += (_, _) => ScheduleReload();
            configWatcher.Created += (_, _) => ScheduleReload();
            configWatcher.Renamed += (_, _) => ScheduleReload();
            configWatcher.Deleted += (_, _) => ScheduleReload();
        }
        catch (Exception exception) when (exception is ArgumentException or IOException)
        {
            configWatcher = null;
        }
    }

    public static string AppVersion =>
        typeof(AmanuRuntime).Assembly.GetCustomAttributes(typeof(System.Reflection.AssemblyInformationalVersionAttribute), false)
            .OfType<System.Reflection.AssemblyInformationalVersionAttribute>().FirstOrDefault()?.InformationalVersion.Split('+')[0]
        ?? "0.0.0";

    public string DataDirectory { get; }
    public string ConfigPath => store.ConfigPath;
    public string SetupPath { get; }
    public bool IsSetupComplete => File.Exists(SetupPath);
    public int RecoveredSessionCount { get; }

    /// <summary>The settings in force. A snapshot: change them through <see cref="Update"/>.</summary>
    public AppSettings Settings
    {
        get { lock (settingsLock) return settings; }
    }

    public IReadOnlyList<ConfigProblem> ConfigProblems
    {
        get { lock (settingsLock) return problems; }
    }

    public bool ConfigUnreadable => ConfigProblems.Any(problem => problem.Unreadable);

    public RecordingState State => coordinator.State;
    public AutoRecordPolicy AutoRecord => coordinator.Policy;
    public bool IsProcessing => processing.IsBusy;
    /// <summary>
    /// True once nothing records, settles a recording, imports or transcribes; recording then stays
    /// closed, so it is safe to quit for an update. An import is queued before it stops counting.
    /// </summary>
    public Task<bool> TryCloseWhenIdleAsync() =>
        coordinator.TryCloseWhenIdleAsync(() => Volatile.Read(ref imports) == 0 && !IsProcessing);
    private int imports;
    public string LiveStatus => liveTranscription.Status;
    public LanguageModels LanguageModels => processing.LanguageModels;
    public HttpClient Http => httpClient;

    public event EventHandler<RecordingState>? StateChanged;
    public event EventHandler<ProcessingStatus>? ProcessingStatusChanged;
    public event EventHandler<DownloadProgress>? DownloadProgressChanged;
    public event EventHandler? SessionsChanged;
    public event EventHandler<LiveLine>? LiveLineReady;
    public event EventHandler<string>? LiveStatusChanged;
    /// <summary>Settings or their problems changed — here or in the file.</summary>
    public event EventHandler? SettingsChanged;
    public event EventHandler<(string Title, string Message, NotificationKind Kind)>? NotificationRequested;

    /// <summary>
    /// Reads the config and settles the interface language before anything shows
    /// a word: every window reads its words once, when it is built.
    /// </summary>
    public static AmanuRuntime Create()
    {
        var localData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        // Not %LOCALAPPDATA%\Amanu: that is where Velopack installs the program,
        // and uninstalling removes the folder with everything in it.
        var dataDirectory = Path.Combine(home, ".local", "share", "meeting-copilot", "capture-data");
        var configDirectory = Path.Combine(home, ".config", "meeting-copilot");
        var settingsHome = home;
#if DEBUG
        // A live test instance never reads or writes the real settings, and its default
        // recordings folder is inside the test folder too.
        if (Environment.GetEnvironmentVariable("AMANU_TEST_DATA") is { Length: > 0 } testDirectory)
        {
            settingsHome = dataDirectory = Path.GetFullPath(testDirectory);
            configDirectory = Path.Combine(dataDirectory, "config");
            // A fresh test folder starts with nothing automatic and nothing sent to a cloud
            // engine: the test instance still sees this account's saved credentials.
            var testConfig = Path.Combine(configDirectory, "config.json");
            if (!File.Exists(testConfig))
            {
                Directory.CreateDirectory(configDirectory);
                File.WriteAllText(testConfig, """{"auto_record":{"enabled":false},"live_transcription":{"enabled":false},"transcription":{"enabled":false}}""");
            }
        }
#endif
        Directory.CreateDirectory(dataDirectory);
        Directory.CreateDirectory(configDirectory);
        var store = new AppSettingsStore(Path.Combine(configDirectory, "config.json"), settingsHome);
        Current = Choose(store.Load().Settings.InterfaceLanguage, CultureInfo.CurrentUICulture.Name);
        // Read again now the language is settled, so what the file's problems
        // say is said in it.
        var load = store.Load();
        return new AmanuRuntime(store, load, dataDirectory);
    }

    /// <summary>
    /// The first betas kept their settings, keys' companions and models in the
    /// install folder; they move out once, before anything reads them.
    /// </summary>
    private static void MoveOutOfInstallFolder(string installFolder, string dataDirectory)
    {
        if (Directory.Exists(dataDirectory) || !File.Exists(Path.Combine(installFolder, "config.json"))
            && !File.Exists(Path.Combine(installFolder, "setup.json")) && !Directory.Exists(Path.Combine(installFolder, "models")))
            return;
        try
        {
            Directory.CreateDirectory(dataDirectory);
            foreach (var name in new[] { "config.json", "setup.json" })
            {
                var source = Path.Combine(installFolder, name);
                if (File.Exists(source)) File.Move(source, Path.Combine(dataDirectory, name));
            }
            var models = Path.Combine(installFolder, "models");
            if (Directory.Exists(models)) Directory.Move(models, Path.Combine(dataDirectory, "models"));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Left where it was, the old settings are simply not found; nothing is lost.
        }
    }

    public async Task StartAsync()
    {
        _ = CopilotControl.ServeAsync(this, lifetime.Token);
        _ = liveTranscription.RefreshAsync();
        if (!IsTestInstance)
        {
            try { StartupRegistration.RemoveLegacyEntry(); }
            catch (Exception exception) when (exception is UnauthorizedAccessException or IOException or System.Security.SecurityException) { }
        }
        processing.Start();
        SystemEvents.PowerModeChanged += PowerModeChanged;
        NetworkChange.NetworkAvailabilityChanged += NetworkAvailabilityChanged;
        // On the thread pool: a look at every audio session and process each
        // second is no work for the thread that draws the windows.
        _ = Task.Run(() => ObserveCallsAsync(lifetime.Token));
        _ = Task.Run(() => RescanPeriodicallyAsync(lifetime.Token));
        // This distribution is updated by MeetOnTrack's checksum-pinned installer.
        if (ConfigUnreadable)
            Notify("MeetOnTrack", ConfigProblems.First(problem => problem.Unreadable).Headline, NotificationKind.Warning);
    }

    // MARK: settings

    /// <summary>Changes settings, writes them, and applies them everywhere.</summary>
    /// <exception cref="ConfigUnreadableException">config.json cannot be read; nothing is written over it.</exception>
    public void Update(Action<AppSettings> change)
    {
        AppSettings previous, next;
        lock (settingsLock)
        {
            if (problems.FirstOrDefault(problem => problem.Unreadable) is { } problem) throw new ConfigUnreadableException(problem);
            previous = settings;
            next = settings.Clone();
            change(next);
            store.Save(next);
            settings = next;
        }
        Apply(previous, next);
    }

    /// <summary>One setting by its path in the file; null puts its default back.</summary>
    public void SetValue(string path, JsonNode? value) =>
        Update(target => Replace(target, SettingsDocument.With(target, path, value, store.HomeDirectory)));

    public JsonNode? GetValue(string path) => SettingsDocument.Get(SettingsDocument.ToNode(Settings), path);

    public JsonNode? DefaultFor(string path) => SettingsSchema.DefaultFor(path, store.HomeDirectory);

    public string DescribeDefault(SettingEntry entry) => SettingsSchema.DescribeDefault(entry, store.HomeDirectory);

    private static void Replace(AppSettings target, AppSettings source)
    {
        foreach (var property in typeof(AppSettings).GetProperties().Where(property => property.CanWrite))
            property.SetValue(target, property.GetValue(source));
    }

    private void ScheduleReload()
    {
        var debounce = new CancellationTokenSource();
        Interlocked.Exchange(ref reloadDebounce, debounce)?.Cancel();
        _ = Task.Run(async () =>
        {
            try
            {
                await Task.Delay(300, debounce.Token);
                Reload();
            }
            catch (OperationCanceledException) { }
            catch (IOException) { ScheduleReload(); }
        });
    }

    /// <summary>
    /// Takes up what the file says now. While it cannot be read the settings last
    /// read stay in force; the moment it can, it is obeyed again and the work that
    /// waited for it resumes.
    /// </summary>
    private void Reload()
    {
        AppSettings previous;
        bool wasUnreadable;
        lock (settingsLock)
        {
            previous = settings;
            wasUnreadable = problems.Any(problem => problem.Unreadable);
            var load = store.Load(settings);
            if (JsonNode.DeepEquals(SettingsDocument.ToNode(load.Settings), SettingsDocument.ToNode(settings))
                && load.Problems.Select(problem => problem.Explanation).SequenceEqual(problems.Select(problem => problem.Explanation)))
                return;
            settings = load.Settings;
            problems = load.Problems;
        }
        Apply(previous, Settings);
        if (wasUnreadable && !ConfigUnreadable) processing.Rescan();
        if (!wasUnreadable && ConfigUnreadable)
            Notify("MeetOnTrack", ConfigProblems.First(problem => problem.Unreadable).Headline, NotificationKind.Warning);
    }

    private void Apply(AppSettings previous, AppSettings next)
    {
        coordinator.Policy.Update(Options(next));
        if (!string.Equals(previous.RecordingsDirectory, next.RecordingsDirectory, StringComparison.OrdinalIgnoreCase))
        {
            TryCreateDirectory(next.RecordingsDirectory);
            coordinator.SetSessionsRoot(next.RecordingsDirectory);
        }
        if (previous.LiveTranscription.Enabled != next.LiveTranscription.Enabled
            || previous.Transcription.Enabled != next.Transcription.Enabled
            || previous.Transcription.Language != next.Transcription.Language)
            _ = liveTranscription.RefreshAsync();
        activityMonitor.Matcher = Matcher(next);
        Task.Run(processing.Rescan);
        SettingsChanged?.Invoke(this, EventArgs.Empty);
    }

    private static AutoRecordOptions Options(AppSettings settings) => new(
        settings.AutoRecord.Enabled && settings.AutoRecord.MicrophoneActivity,
        TimeSpan.FromSeconds(Math.Max(0, settings.AutoRecord.StartDelaySeconds)),
        TimeSpan.FromSeconds(Math.Max(0, settings.AutoRecord.StopDelaySeconds)),
        TimeSpan.FromSeconds(Math.Max(0, settings.AutoRecord.MinimumDurationSeconds)),
        TimeSpan.FromMinutes(Math.Max(1, settings.AutoRecord.SilenceStopMinutes)),
        TimeSpan.FromMinutes(Math.Max(1, settings.AutoRecord.MaximumDurationMinutes)));

    private static CallProcessMatcher Matcher(AppSettings settings) =>
        new(settings.AutoRecord.CallProcesses, settings.AutoRecord.IgnoreProcesses);

    public string? GetSecret(string name) => secrets.Get(name);

    public void SetSecret(string name, string? value)
    {
        secrets.Set(name, value);
        Task.Run(processing.Rescan);
        SettingsChanged?.Invoke(this, EventArgs.Empty);
    }

    // MARK: recording

    public Task StartManualAsync() => coordinator.StartManualAsync(DateTimeOffset.Now);

    public Task StopManualAsync() => coordinator.StopAsync(DateTimeOffset.Now, "manual");

    public async Task ResumeRecognitionAsync()
    {
        await liveTranscription.StopAsync();
        await liveTranscription.RefreshAsync();
    }

    public Task TogglePauseAsync() => coordinator.TogglePauseAsync();

    public async Task StopForExitAsync()
    {
        if (State.IsRecording) await coordinator.StopAsync(DateTimeOffset.Now, "quit");
    }

    public void SetAutoRecord(bool enabled) => Update(settings => settings.AutoRecord.Enabled = enabled);

    /// <summary>Sleep ends a recording cleanly: the devices go away under it, and a meeting does not survive a closed lid anyway.</summary>
    private void PowerModeChanged(object sender, PowerModeChangedEventArgs e)
    {
        if (e.Mode == PowerModes.Suspend && State.IsRecording)
            Task.Run(() => coordinator.StopAsync(DateTimeOffset.Now, "sleep")).Wait(TimeSpan.FromSeconds(10));
        else if (e.Mode == PowerModes.Resume)
            Task.Run(processing.Rescan);
    }

    private void NetworkAvailabilityChanged(object? sender, NetworkAvailabilityEventArgs e)
    {
        if (e.IsAvailable) Task.Run(processing.Rescan);
    }

    private async Task ObserveCallsAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        var monitorFailing = false;
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                var now = DateTimeOffset.Now;
                try
                {
                    await coordinator.EnforceCeilingAsync(now, cancellationToken);
                    if (!coordinator.Policy.Enabled && !State.IsRecording && coordinator.Policy.Phase == AutoRecordPhase.Watching) continue;
                    var observation = activityMonitor.Observe(now);
                    await coordinator.ObserveAsync(observation, cancellationToken);
                    monitorFailing = false;
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    if (monitorFailing) continue;
                    monitorFailing = true;
                    Notify(T("Can't see which app uses the microphone", "Не вижу, какое приложение занимает микрофон"),
                        exception.Message, NotificationKind.Warning);
                }
            }
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    private async Task RescanPeriodicallyAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(10));
        try
        {
            while (await timer.WaitForNextTickAsync(cancellationToken)) processing.Rescan();
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { }
    }

    // MARK: sessions

    public Task<IReadOnlyList<SessionListItem>> LoadSessionsAsync(CancellationToken cancellationToken = default) =>
        SessionInventory.ScanAsync(Settings.RecordingsDirectory, cancellationToken);

    public async Task<string> ImportAsync(string source, CancellationToken cancellationToken = default)
    {
        // Counted until queued: quit-when-idle must not exit mid-copy.
        Interlocked.Increment(ref imports);
        try { return await processing.ImportAsync(source, cancellationToken); }
        finally { Interlocked.Decrement(ref imports); }
    }

    public void FinishProcessing(string directory) => processing.Finish(directory);

    public Task RetranscribeAsync(string directory, string? engine) => processing.RetranscribeAsync(directory, engine);

    public ProcessingStatus? ProcessingStatusFor(string directory) => processing.StatusFor(directory);

    public Task SetSpeakerNameAsync(string directory, string label, string name, CancellationToken cancellationToken = default, string? title = null) =>
        processing.SetSpeakerNameAsync(directory, label, name, cancellationToken, title);

    /// <summary>Moves a session to the Recycle Bin, where it can still be got back.</summary>
    public void DeleteSession(string directory)
    {
        if (State.SessionDirectory is { } recording && string.Equals(recording, directory, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException(T("This session is still recording.", "Эта встреча ещё записывается."));
        if (!processing.TryUseIdleSession(directory, () => Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(directory,
            Microsoft.VisualBasic.FileIO.UIOption.OnlyErrorDialogs, Microsoft.VisualBasic.FileIO.RecycleOption.SendToRecycleBin)))
            throw new InvalidOperationException(T("This recording is queued or being processed.", "Эта запись в очереди или обрабатывается."));
        SessionsChanged?.Invoke(this, EventArgs.Empty);
    }

    public Task EnsureLocalModelAsync(string model, CancellationToken cancellationToken = default) =>
        processing.EnsureLocalModelAsync(model, cancellationToken);

    public bool IsLocalModelReady(string model) => models.IsReady(model);
    public bool IsLocalModelDownloading(string model) => models.IsDownloading(model);
    public bool LocalRuntimePresent => models.CliPath is not null;
    public long? LocalModelBytes(string model) => models.DownloadedBytes(model);

    public Task CompleteSetupAsync(CancellationToken cancellationToken = default) =>
        AtomicFiles.WriteJsonAsync(SetupPath, new { version = 1, completed_at = DateTimeOffset.UtcNow }, cancellationToken);

    public void Notify(string title, string message, NotificationKind kind) =>
        NotificationRequested?.Invoke(this, (title, message, kind));

    /// <summary>Opens a file, folder or link the way Explorer would, and says so when Windows can't.</summary>
    public static void Open(string target)
    {
        try
        {
            Process.Start(new ProcessStartInfo(target) { UseShellExecute = true });
        }
        catch (Exception exception) when (exception is System.ComponentModel.Win32Exception or InvalidOperationException or FileNotFoundException)
        {
            Ui.ShowError(null, T("Couldn’t open it", "Не удалось открыть"), $"{target}\n{exception.Message}");
        }
    }

    private static void TryCreateDirectory(string path)
    {
        try { Directory.CreateDirectory(path); }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or ArgumentException) { }
    }

    private static bool ProcessIsAlive(int processId)
    {
        try { return !Process.GetProcessById(processId).HasExited; }
        catch (ArgumentException) { return false; }
    }

    private static bool IsTestInstance
    {
        get
        {
#if DEBUG
            return !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("AMANU_TEST_DATA"));
#else
            return false;
#endif
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (disposed) return;
        disposed = true;
        SystemEvents.PowerModeChanged -= PowerModeChanged;
        NetworkChange.NetworkAvailabilityChanged -= NetworkAvailabilityChanged;
        await lifetime.CancelAsync();
        configWatcher?.Dispose();
        activityMonitor.Dispose();
        await liveTranscription.DisposeAsync();
        await processing.DisposeAsync();
        await coordinator.DisposeAsync();
        copilotExporter.Flush();
        copilotExporter.Dispose();
        httpClient.Dispose();
        lifetime.Dispose();
    }
}

public enum NotificationKind
{
    Information,
    Warning,
    Error,
}
