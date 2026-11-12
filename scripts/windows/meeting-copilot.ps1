$ErrorActionPreference='Stop'
$check=$args -contains '--check'
if(@($args|Where-Object {$_ -notin @('--check','--no-open','--refresh')}).Count){throw 'Usage: meeting-copilot.ps1 [--check|--no-open|--refresh]'}
$root=$PSScriptRoot
$capture=Join-Path $root 'capture\MeetingCopilotCapture.exe'
$python=Join-Path $root 'python\python.exe'
$pythonw=Join-Path $root 'python\pythonw.exe'
$server=Join-Path $root 'web\server.py'
$config=Join-Path $env:USERPROFILE '.config\meeting-copilot'
$data=Join-Path $env:USERPROFILE '.local\share\meeting-copilot'
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
function Stop-OtherVersions([string]$Root,[int[]]$Port=@(43121),[switch]$KeepCapture){
    # MEETONTRACK-65: after an update the previous version's web server keeps the port, so the
    # new version never serves. Stop only the process listening on it, and only when it is our
    # own Python from another versions\<v> folder; other jobs on that Python are left alone.
    # A capture is never stopped (MEETONTRACK-88): an old one is asked to quit once idle, so a
    # recording in progress finishes first, and a hidden waiter starts this version's capture
    # after it has quit: the version current.json names then, so a later update wins. A capture
    # too old for that command answers no and is replaced at next sign-in by the Startup
    # shortcut. -KeepCapture (install without launch) leaves the capture alone. Same text in install.ps1 and meeting-copilot.ps1: the
    # installer may unpack a package whose launcher predates this.
    $versions=(Split-Path $Root -Parent).TrimEnd('\')+'\'
    $own=$Root.TrimEnd('\')+'\'
    $listeners=@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess
    $old=@(Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" | Where-Object {
        $_.ProcessId -in $listeners -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($versions,'OrdinalIgnoreCase') -and -not $_.ExecutablePath.StartsWith($own,'OrdinalIgnoreCase')})
    foreach($process in $old){Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue}
    if($old.Count){
        Wait-Process -Id $old.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
        for($i=0;$i -lt 40 -and @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count;$i++){Start-Sleep -Milliseconds 250}
    }
    $capture=Join-Path $Root 'capture\MeetingCopilotCapture.exe'
    $session=(Get-Process -Id $PID).SessionId  # one capture per sign-in session
    $oldCapture=@(Get-CimInstance Win32_Process -Filter "Name='MeetingCopilotCapture.exe' AND SessionId=$session" | Where-Object {
        $_.CommandLine -notmatch '--live-worker' -and $_.ExecutablePath -and $_.ExecutablePath.StartsWith($versions,'OrdinalIgnoreCase') -and -not $_.ExecutablePath.StartsWith($own,'OrdinalIgnoreCase')})
    if($KeepCapture -or -not $oldCapture.Count -or -not(Test-Path $capture -PathType Leaf)){return}
    $asked=Start-Process $capture -ArgumentList 'record','quit-when-idle' -WindowStyle Hidden -Wait -PassThru
    if($asked.ExitCode -ne 0){return}
    $current=Join-Path (Split-Path $versions -Parent) 'current.json'
    $waiter="Wait-Process -Id $($oldCapture.ProcessId -join ','); `$c=try{(Get-Content -ErrorAction Stop -LiteralPath '$($current -replace "'","''")' -Raw | ConvertFrom-Json).directory+'\capture\MeetingCopilotCapture.exe'}catch{'$($capture -replace "'","''")'}; if((Test-Path -LiteralPath `$c) -and -not @(Get-CimInstance Win32_Process -Filter `"Name='MeetingCopilotCapture.exe' AND SessionId=$session`" | Where-Object {`$_.CommandLine -notmatch '--live-worker'}).Count){Start-Process -FilePath `$c -ArgumentList '--background'}"
    Start-Process "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand',([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($waiter)))
}
$release=[string](Get-Content (Join-Path $root 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
function Test-Ready([int]$Port){
    try {$h=Invoke-RestMethod "http://127.0.0.1:$Port/api/health" -TimeoutSec 2; return $h.service -eq 'meeting-copilot' -and [string]$h.version -eq $release} catch {return $false}
}
function Test-PortFree([int]$Port){
    $listener=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,$Port)
    try {$listener.Start(); return $true} catch {return $false} finally {$listener.Stop()}
}
# MEETONTRACK-131, as on the Mac (MEETONTRACK-130): the port is 43121 unless another program holds it;
# that program is left alone and the service runs on a free port, recorded in server-port for the tray,
# the installer and this launcher. A stale record is harmless: only a service answering as this version counts.
$portFile=Join-Path $data 'server-port'
$recorded=try{[int](Get-Content -LiteralPath $portFile -Raw -ErrorAction Stop).Trim()}catch{0}
$ports=@(@(43121,$recorded) | Where-Object {$_ -gt 0 -and $_ -lt 65536} | Select-Object -Unique)
foreach($file in @($capture,$python,$server,"$config\config.json","$config\SESSION.md")){
    if(-not(Test-Path $file -PathType Leaf)){throw "Missing installation component: $file"}
}
$cmd=Get-Command codex.exe,codex.cmd -ErrorAction SilentlyContinue | Select-Object -First 1
$codexPath=$cmd.Source
if(-not $codexPath){
    $native=Get-ChildItem "$env:LOCALAPPDATA\MeetingCopilot\tools\node_modules" -Filter codex.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    $codexPath=$native.FullName
}
if($codexPath){
    $env:MEETING_COPILOT_CODEX=$codexPath
    $codexTools=Join-Path (Split-Path (Split-Path $codexPath)) 'codex-path'
    if(Test-Path "$codexTools\rg.exe"){$env:PATH="$codexTools;$env:PATH"}
} else {Write-Host 'AI is optional. Choose an AI tool and model once in Getting started; recording remains available.'}
if($args -contains '--refresh'){
    & $python "$root\refresh-repos.py" --config-root $config
    if($LASTEXITCODE -ne 0){throw 'Read-only repository inventory failed'}
    exit 0
}
if($check){
    & $python $server --self-test
    if($LASTEXITCODE -ne 0){throw 'Web self-test failed'}
    foreach($model in @('nemotron-3.5-asr-streaming-0.6b-Q8_0.gguf','parakeet-tdt-0.6b-v3-Q8_0.gguf')){
        if(-not(Test-Path "$data\capture-data\models\$model")){throw "Missing speech model: $model"}
    }
    Write-Host '[OK] Capture, bundled Python and speech models. AI tool, model and account access are chosen and checked in Getting started.'
    exit 0
}
Stop-OtherVersions $root -Port $ports
# Once set up, the recorder starts in the tray: an update or sign-in shows the assistant, not the recorder
# window too. Before setup it opens its setup window.
if(-not(Get-Process MeetingCopilotCapture -ErrorAction SilentlyContinue)){
    if(Test-Path "$data\capture-data\setup.json" -PathType Leaf){Start-Process -FilePath $capture -ArgumentList '--background'}else{Start-Process -FilePath $capture}
}
$port=$ports | Where-Object {Test-Ready $_} | Select-Object -First 1
$ready=[bool]$port
if(-not $ready){
    $port=43121
    if(-not(Test-PortFree $port)){
        $free=[Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0); $free.Start(); $port=$free.LocalEndpoint.Port; $free.Stop()
        Write-Host "MeetOnTrack: port 43121 is held by another program; using $port"
    }
    Start-Process -FilePath $pythonw -ArgumentList @('-X','utf8',"`"$server`"",'--no-open','--port',$port) -WorkingDirectory $root
    for($i=0;$i -lt 40 -and -not $ready;$i++){Start-Sleep -Milliseconds 250; $ready=Test-Ready $port}
}
if(-not $ready){throw "MeetOnTrack $release web service did not start on port $port"}
try {[IO.File]::WriteAllText("$portFile.tmp","$port`n"); Move-Item -LiteralPath "$portFile.tmp" -Destination $portFile -Force} catch {Write-Host "MeetOnTrack: could not record the port: $_"}
$url="http://127.0.0.1:$port/"
# One assistant window, not a new tab per launch: bring an open one forward, else an app window (no tab
# strip, the page's icon) of the default browser when it is Chromium, so links such as Google sign-in open
# where the user is signed in; another default browser gets a plain tab, Edge only when the default can't
# be read. Same rule as AmanuRuntime.OpenAssistant and AppWindowBrowser.cs (same browser list).
function Get-AppBrowser{
    $progId=(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice' -ErrorAction SilentlyContinue).ProgId
    $command=if($progId){(Get-ItemProperty -LiteralPath "Registry::HKEY_CLASSES_ROOT\$progId\shell\open\command" -ErrorAction SilentlyContinue).'(default)'}
    if(-not "$command".Trim()){return 'msedge'}
    if("$command".Trim() -match '^"([^"]+)"' -or "$command".Trim() -match '^([^"]*?\.exe)'){$exe=$Matches[1]}else{return $null}
    if(@('chrome.exe','msedge.exe','brave.exe','vivaldi.exe','chromium.exe') -contains ($exe -split '[\\/]')[-1]){$exe}else{$null}
}
if($args -notcontains '--no-open'){
    # An open window is reused, also after an update: the page reloads itself into the new version
    # (app.js, since 0.1.23), so a new window would only be a second copy. Found by title, not by
    # AppActivate's answer: the updater's hidden launcher may not be allowed to bring it forward.
    Add-Type -Namespace MeetOnTrack -Name Win -UsingNamespace System.Text -MemberDefinition @'
delegate bool Each(IntPtr w, IntPtr l);
[DllImport("user32.dll")] static extern bool EnumWindows(Each e, IntPtr l);
[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr w);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr w, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr w);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr w, int c);
public static IntPtr Find(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((w, l) => { var s = new StringBuilder(256); GetWindowText(w, s, 256);
        if (IsWindowVisible(w) && s.ToString().StartsWith(title, StringComparison.Ordinal)) { found = w; return false; } return true; }, IntPtr.Zero);
    return found;
}
'@
    $title='MeetOnTrack by aiagentlbs.com'
    $window=[MeetOnTrack.Win]::Find($title)
    if($window -ne [IntPtr]::Zero){
        if([MeetOnTrack.Win]::IsIconic($window)){[void][MeetOnTrack.Win]::ShowWindow($window,9)}  # activation leaves a minimized window minimized
        [void](New-Object -ComObject WScript.Shell).AppActivate($title)
    }else{try{$browser=Get-AppBrowser; if(-not $browser){throw 'no app-window browser'}; Start-Process $browser -ArgumentList "--app=$url" -ErrorAction Stop}catch{Start-Process $url}}
}
Write-Host "MeetOnTrack: $url"
