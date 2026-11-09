# MeetOnTrack remaining work

Tracker: open items mirror the private `MEETONTRACK` project (migrated 2026-10-21);
each carries its `MEETONTRACK-N` number. Add and close work there first.

Audit updated 2026-10-19. Source tests, installed Mac hotfixes, candidate packages
and accepted public releases are different milestones. This file mirrors the
tracker; closed source fixes below are not proof of both-platform release.
Latest installed delivery/OAuth evidence:
[2026-10-19 acceptance](releases/2026-10-19-delivery-acceptance.md).
Public Mac/Windows 0.1.10 packages and remaining hardware gates:
[distribution acceptance](releases/2026-10-19-public-distribution.md).
2026-10-20: public 0.1.11 Mac/Windows pre-releases (per-task AI choice):
[0.1.11 distribution acceptance](releases/2026-10-20-0.1.11-distribution.md).
2026-10-21: public 0.1.12 Mac/Windows pre-releases (one AI choice, Mac speech choice):
[0.1.12 distribution acceptance](releases/2026-10-21-0.1.12-distribution.md).

- [ ] MEETONTRACK-1: `scripts/check-note-ui.cjs` fails at 0.1.11 and identically at the 0.1.10
  source (`ae27f2b`): `#note-help` shows `--:--` where the test expects the
  fixture's elapsed time `02:44`. Decide whether the hint must render the call
  time before the first state poll (product fix) or the test must wait for it
  (test fix); then run it in release checks. Not run in CI today.
  Test fix in release/0.1.15: the script now serves every page script (the
  state poll failed silently without `updates.js`), keeps the main screen up
  with recording audio, and drops the removed `#analysis-help` checks. Passes;
  close after release.
- [ ] MEETONTRACK-85: `copilot/web/test_meeting_boundary_ui.cjs` times out
  (`locator.waitFor` 3 s, line 45) at 0.1.12 and identically at 0.1.11 (`effb7a2`).
  Not in the release script set. Find whether the fixture or the UI changed,
  fix it, then add it to the release checks.

Scope: end-user software only. Website/domain, analytics, SEO, comparisons,
keyword/trademark research and promotion are tracked exclusively in
`AIAgentLbs/meetontrack-website`, root `SITE_TODO.md` (local sibling checkout:
`../meetontrack-website/SITE_TODO.md` from this repository root). See `AGENTS.md`.
The 2026-10-19 file migration is complete: 37 website files moved with verified
hashes, Pages removed, and the Windows installer relocated to
`scripts/windows/install.ps1` with packaging/CI references updated.

## One macOS recorder source (2026-10-20)

- [x] MEETONTRACK-2: One repository (owner decision 2026-11-04): the Windows
  recorder moved into `windows/` with its history (from `meetontrack-recorder`
  `50e7448`); `windows-candidate.yml` builds, packages and accepts it from here
  ([run 41826469696](https://github.com/AIAgentLbs/meetontrack/actions/runs/41826469696));
  `meetontrack-recorder` archived with a pointer. `capture/` remains the Mac source.
- [ ] MEETONTRACK-110: `windows/tests/test_workflow_safety.py:7` targets the upstream
  `windows-beta.yml`, which was not moved; both tests fail. Rewrite them for
  `windows-candidate.yml` and run them there, or delete them.
- [ ] MEETONTRACK-111: Pin the .NET SDK (`windows/global.json`). With `10.0.x` the
  rebuilt recorder bundles runtime 10.0.14 instead of 0.1.18's 10.0.13: same files,
  different bytes, so a rebuild of one commit is not reproducible.
- [ ] MEETONTRACK-112: `windows/BETA.md:94` links to a hardware checklist that exists
  only upstream; link gsamat/amanu's copy or our own.
- [ ] MEETONTRACK-113: Windows counterpart of MEETONTRACK-109: the recorder runs the
  local service itself and shows the UI in its own window.
- [x] MEETONTRACK-114 (shipped in v0.1.21, Mac, closed 2026-11-04): Processes the web service starts (AI CLIs, headless Chrome,
  helpers) survive when the app stops the service (`LocalServer.swift`, `server.py`).
  Start the service in its own process group and signal the group on stop.
  Fixed on main 2026-11-04; closes on release. (`server.py` leads its group and terminates it on shutdown; the app
  kills the group after stop, a hang or a crash; tests in `test_parent_watch.py`, `LocalServerTests`.)
- [ ] MEETONTRACK-115: `copilot/web/test_ai_providers.py` has 5 failures and 2 errors
  under the bundled Python 3.12 runtime (also on baseline). Fix them and run the web
  suite with the packaged runtime in the candidate check.
- [x] MEETONTRACK-116 (shipped in v0.1.21, Mac, closed 2026-11-04): `LocalServer.swift` adopts any server on port 43121 that
  reports the bundle's version (another user's, or one started by hand). Pass a
  per-launch nonce to the child and adopt only a server that echoes it.
  Fixed on main 2026-11-04; closes on release. (`MEETONTRACK_INSTANCE`, echoed as `instance` by `/api/health`.) A foreign
  server on the port is not adopted; the window then waits and `server.log` shows the
  bind failure, it does not name the conflict.
- [x] MEETONTRACK-124 (shipped in v0.1.22, Mac, closed 2026-11-08): AI sign-in CLIs run in their own session (`ai_providers.py` `_spawn`), so an open
  sign-in outlives the app-run service on quit. Track them and stop each group on server shutdown.
  Fixed on main 2026-11-05; closes on release.
- [x] MEETONTRACK-126 (shipped in v0.1.22, Mac, closed 2026-11-08): worker threads start before `own_process_group()` in `server.py` `main()`, so a helper
  (printing browser, AI CLI) spawned in that first moment escapes shutdown cleanup. Create the group right after
  bind, before any worker (with `--exit-with-parent`); extend `test_parent_watch.py`. Found by the 0.1.21 release review.
  Fixed on main 2026-11-05; closes on release.
- [x] MEETONTRACK-125 (shipped in v0.1.22, Mac, closed 2026-11-08): `install.sh` rewrites `config.json` to drop the retired analytics key before the
  new app is proven; a rolled-back install keeps the rewritten file. Move the migration after the commit
  point or add config.json to the rollback set.
  Fixed on main 2026-11-05; closes on release.
- [x] MEETONTRACK-130 (shipped in v0.1.22, Mac, closed 2026-11-08): a server on port 43121 that is not the app's own child left the Mac window waiting.
  The app now resolves it itself (`LocalServer.swift`): a stale MeetOnTrack service is stopped and the port
  taken over; any other program is left alone and the service runs on a free port, recorded in
  `~/.local/share/meeting-copilot/server-port` for `install.sh` and `meeting-copilot`, which check that it
  answers. A service of this user that will not stop is never run beside (it shares the archive); then, or
  if the service cannot start at all, the window asks to restart the Mac. The Windows runner and the operator deploy
  scripts still assume 43121. Fixed on main 2026-11-05; closes on release.
- [x] MEETONTRACK-130 follow-up (shipped in v0.1.22 with 130; Codex P2, 2026-11-07): a hung server started by hand from a checkout
  (`python3 web/server.py`, any folder name) was not recognised, so the app could run a second server beside it.
  `LocalServer.isAssistantServer` now resolves the script against the listener's working directory and accepts
  a `web/server.py` with `ai_providers.py` beside it. Fixed on main 2026-11-08; closes on release with 130.
- [ ] MEETONTRACK-131: Windows still binds the assistant to port 43121 only: another program on it stops the
  web assistant (`scripts/windows/meeting-copilot.ps1`), and the tray/settings links and operator deploy scripts
  (`scripts/deploy-*.py`) assume 43121. Resolve it like the Mac (`LocalServer.swift`, MEETONTRACK-130): stop a stale
  own service, leave a foreign program alone and use a free port recorded in `server-port`. Split out of 130 at the
  0.1.22 release.
- [x] MEETONTRACK-133 (shipped in windows-v0.1.23, closed 2026-11-09; fixed on main 4d98451): Windows opened a new browser tab without an icon on each
  launch. The launcher and tray now reuse one assistant window (Edge app window), the page has the website icon.
- [x] MEETONTRACK-134 (shipped in windows-v0.1.23, closed 2026-11-09; fixed on main 88f10ec): a terminal flashed on Windows every few minutes because
  console helpers (codex.cmd app-server) started from pythonw got their own window. `hidden_consoles.py` hides them in Popen.
- [x] MEETONTRACK-140 (shipped in v0.1.25 / windows-v0.1.25, closed 2026-11-09; fixed on main 36c1d53): since windows-v0.1.23 the assistant opened
  as an Edge app window, so Google sign-in and other links opened in Edge, not the default browser where the user is
  signed in. `AmanuRuntime.OpenAssistant` and `scripts/windows/meeting-copilot.ps1` now open an app window of the default
  https browser when it is Chromium (`AppWindowBrowser.FromOpenCommand`), a plain tab of any other default browser, and
  Edge only when the default can't be read.
- [ ] MEETONTRACK-132: when the Mac app quits, its server ends with "Fatal Python error: _enter_buffered_busy: could
  not acquire lock for <stdin> at interpreter shutdown" in `server.log` (seen on 0.1.21 quits on the owner's Mac,
  2026-11-08). `watch_parent()` reads `sys.stdin.buffer` in a daemon thread. Cleanup in `main()`'s `finally` runs
  first, but the process aborts. Read the raw fd or `os._exit` after cleanup; assert a clean exit in
  `test_parent_watch.py`.
- [x] MEETONTRACK-109 (shipped in v0.1.21, Mac, closed 2026-11-04): One MeetOnTrack app with its own window: Python and the web
  payload inside the bundle, the app runs the local service itself (no launchd
  agent) and shows the UI in a WKWebView window instead of a browser tab. Signed,
  notarized DMG is out of scope: no Apple Developer account for now (owner
  2026-11-04), revisit when users complain about installation.

## One settings store and vocabulary across Mac, Windows and web (owner rule 2026-10-20)

- [ ] MEETONTRACK-3: All components already share `~/.config/meeting-copilot/config.json`, but
  the vocabulary diverges: the Mac app writes `transcription.engine = "parakeet"`
  while `scripts/windows/install.ps1:67` and the C# recorder use
  `engine = "local"` + `local_engine = "parakeet"`; Python reads only
  `interface_language` and `live_transcription.enabled`. Define one schema
  (`docs/config.schema.json`), migrate both vocabularies to it, and make every
  writer preserve keys it does not own (verify Swift `Config.update` and C#
  `AppSettingsStore`). Settings UIs on all platforms show the same values.

## No hardcoded providers, models or modes: AI and speech-to-text (owner rule 2026-10-20)

- [x] Phase 1 (2026-10-20): Python provider layer `copilot/web/ai_providers.py`
  (Codex app-server, Claude Code initialize, Antigravity `agy models`, Ollama
  HTTP), per-purpose choice in the shared `config.json` `ai` section
  (`docs/config.schema.json`), settings panel and per-choice Check AI in Getting
  started, all five Codex call sites routed through the layer, model ids removed
  from Python/JS/HTML and the Windows launcher message. Spec:
  `docs/specs/2026-10-20-no-hardcoded-models.md`.
- [ ] MEETONTRACK-4: Release 0.1.11 with phase 1 (packaging, both platforms).
- [x] Review round 2 (2026-10-20): file boundary enforced (Claude Code
  `--restricted` + `--add-dir` per selected root, Read/Grep/Glob only, screenshot
  read from a folder holding only a copy; Codex permissions profile via
  `-c default_permissions` + `permissions.<id>.filesystem`, run from the realpath
  binary), per-invocation ticket (choice + executable identity), discovery cache
  keyed by binary and sign-in, hard deadlines and bounded buffers, structured
  needs_choice/unavailable for translation and screenshots, per-purpose Check AI.
- [x] Antigravity is listed with its models but unavailable for every purpose
  (`permission_mode: always-proceed`, read-only/no-tools not enforceable). Reopen
  when agy offers a read-only/no-tools mode and stdin input
  (`ai_providers.AntigravityAdapter`, `capture/.../Summary/AIChoice.swift`).
  2026-10-28: the web app runs agy with HOME set to its own folder holding strict
  settings (headless denies files and writes, commands denied, web pages only for
  web calls) and the prompt on stdin (`--input-format stream-json`). The Swift
  recorder still refuses it, so summaries and speaker names show unavailable.
- [x] Shared config writers (Python `ai_providers._file_lock`/`AISettings`,
  Swift `ConfigFile.swift`): `flock` on `config.json.lock` across
  read-modify-replace, malformed file blocks saves, 0600 temp + fsync + rename.
  Cross-process test in `test_ai_providers.py` (Python writer vs native-style
  `flock` writer).
- [x] Phase 2 (2026-10-20): Swift summary and speaker naming read
  `ai.purposes.summary` / `ai.purposes.speaker_names`; no model defaults, no
  fallback order; `--model` (+ effort/speed when chosen) passed to Codex, Claude
  and Ollama; one-time migration from `summary.backend/model/openai_model/
  ollama_model` only when present in the file (provider + model, effort and speed
  left for the person).
- [x] Single AI choice (owner decision 2026-10-21, supersedes the per-task
  choice of phases 1-2): `ai.choice` is the one choice for every task; Python
  writes it and carries `ai.purposes` (or the legacy summary backends) over once
  (`ai_providers.migrated_choice`, Swift mirror `AIChoice.stored`, shared cases
  in `copilot/web/fixture_ai_choice_migration.json`). Task capability checks
  stay per task; Check AI shares one probe per kind (text, image, files).
- [ ] MEETONTRACK-5: Codex 0.153.2 (Homebrew) ignores the `:slash_tmp` deny and lets writes land
  under the temp dir when cwd is there; reads outside the roots are denied. Our
  workdir lives in `~/.cache/meeting-copilot/ai-workdir`, so not reachable today.
  Re-verify on every new Codex version with `codex sandbox -P`.
- [ ] MEETONTRACK-6: The Claude Code boundary relies on `--restricted` (Claude Code 2.1.304).
  Add a version check or a Check AI escape probe so an older CLI without it is
  reported unavailable rather than run unrestricted.
- [x] Review round 3 (2026-10-20): Setup summary cards and the legacy summary/
  naming entries in Settings > Advanced removed; Getting started is the only place
  the AI is chosen (`SettingsSchema.legacyAIKeys` stay known for the migration).
  Ollama summaries size `num_ctx` and chunks from the model's reported
  `<arch>.context_length` and refuse a prompt that does not fit; CLI install
  locations come from one list, `copilot/web/tool_locations.json`, mirrored by
  `Tooling.listedLocations` (equality test); Ollama thinking without levels is
  unavailable; the panel shows the check snapshot of the saved choice.
- [x] Review round 4 (2026-10-20): live analysis gets HEAD, status and diff stat
  of each selected repository from the app (`server.git_metadata`), since git
  cannot start inside the read-only Codex profile; the profile is not widened.
  Swift `Tooling` picks the newest `--version` with the `MEETING_COPILOT_<TOOL>`
  override first and re-picks when a candidate file changes (same rule as
  `first_run.pick_codex`). Python Ollama sends `num_ctx`, drops whole old turns
  of chat history to fit and rejects a prompt that cannot fit; models without
  `completion` or without a reported context length are unavailable. Summary
  merges are reduced in batches until they fit. Saving one purpose keeps the
  other purposes' drafts.
- [x] Review round 5 (2026-10-20): Codex isolation flags go on every call
  without repositories, resumed turns included. Claude identity (discovery,
  readiness and session keys) includes the signed-in account from
  `.claude.json` and a hash of env credentials. Ollama keeps a session's first
  prompt (the session rules) as a system message that trimming and the
  40-message cap never drop. A legacy `summary.backend: "none"` is migrated
  once to `summary.enabled: false`. The `ai` subtree is known to the Settings
  window, so it is not reported as unread.
- [ ] MEETONTRACK-7: Bring back the Anthropic and OpenAI API-key summary backends as discovered
  providers (owner decision 2026-10-20: left out of phase 2). They need an adapter
  in `copilot/web/ai_providers.py` and `capture/.../Summary/LLMBackend.swift` that
  lists models from the provider's models endpoint with the user's key, never a
  fixed model; `SummaryKeyProbe` in `Setup/SetupSelection.swift` already checks
  keys.
- [ ] MEETONTRACK-68: Groq as an optional cloud provider (FluidVoice parity, owner 2026-10-21):
  speech through Groq's hosted Whisper API next to the AssemblyAI/OpenAI engines, and AI tasks
  through a Groq key with the API-key providers of MEETONTRACK-7. Models are read from Groq's
  models endpoint, never hardcoded. The UI says what is sent to Groq.
- [ ] MEETONTRACK-8: Ollama context sizing counts one character as at least one token
  (`LLMBackend.ollamaInputLimit`, Python `OllamaAdapter.fit`; images are not
  counted) and keeps a fixed 4096-token reply allowance.
  Use the tokenizer (or `prompt_eval_count`) if CJK transcripts get cut or long
  answers are truncated.
- [ ] MEETONTRACK-9: Check AI for `summary` and `speaker_names` probes through the Python
  adapters, not the Swift invocation in `Summary/LLMBackend.swift`; the argv
  can drift. Add a shared argv fixture both sides test against.
- [x] MEETONTRACK-10, MEETONTRACK-12: Phase 3 (speech-to-text on the Mac, 2026-10-21,
  branch `feat/stt-user-choice`): one `stt.choice` {engine, model, language}
  chosen in Getting started (or adopted from the one model the installer
  downloaded); options discovered from FluidAudio,
  Hugging Face listings and the providers (`stt-options`), downloads only on
  request (`stt-download`), sessions deferred (no attempt consumed) until the
  choice is ready; live and final use the same model. Also covers
  MEETONTRACK-39 (labelled sizes), MEETONTRACK-40 (one active model) and
  MEETONTRACK-45 (reuse of models already on this Mac). Spec section "Phase 3".
- [ ] MEETONTRACK-69: Phase 4 (Windows speech): the C# recorder implements `meetontrack.stt-options/1`,
  `stt-download` and `stt-check` (spec "Phase 3"), reads `stt.choice`, and drops its
  built-in `gpt-4o-transcribe-diarize` default; `install.ps1` stops pinning speech
  models; the launcher check reads the same choice.
  Until then the web server never runs the recorder for speech on Windows
  (`stt.WINDOWS`, 0.1.12). Windows must implement `stt-options --json`, and the
  recorder must reject unknown arguments instead of launching the GUI: in
  `windows/src/Amanu.App/App.xaml.cs` `Main` only `record <x>` and `--live-worker`
  are handled, so any other arguments start the full WPF app (found 2026-10-21).
- [ ] MEETONTRACK-80: Windows recorder config.json save drops other writers' keys; fix in
  `windows/` (read-modify-write under config.json.lock).
- [ ] MEETONTRACK-81: Windows in-app updates do nothing: releases carry no Velopack update files.
- [ ] MEETONTRACK-82: Windows recorder hardcodes AI/speech providers and models (file:line list in tracker).
- [ ] MEETONTRACK-83: Windows recorder labels speakers Me/Participant 1; use You/Others, drop speaker_names.backend.
- [x] MEETONTRACK-84 (shipped; closed in Plane 2026-11-04): Windows AI check and questions fail with AI_FAILED, [WinError 5] Access is denied
  in the archive folder (0.1.11, owner check 2026-10-21); reproduce on 0.1.12 and fix.
  Fixed in main c65a93b (an elevated mkdir(0o700) left owner-only ACLs); ships in the next Windows build.
- [ ] MEETONTRACK-91: Zoom tile names mixing Cyrillic and Latin are misread by OCR ("Катя из Kumar&Solo" -> "ат umar&Sol" on 2026-10-22) and the garbled name reaches the transcript; re-OCR the highlighted label crop at higher scale with ru+en and snap to the full label seen in other frames (capture zoom-frame-inspector, copilot/web/server.py _speaker_from_frame).
- [x] MEETONTRACK-92 (shipped; closed in Plane 2026-11-04): An unreadable or undated report status said "Не читается состояние отчета. Проверьте локальный архив" with no action.
  Fixed in release/0.1.15 (`archive.py` `repair_report_states`): rebuilt from the report folder, or one "create the report again" button; close after release.
- [ ] MEETONTRACK-93: 0.1.15 review leftovers (P2): a repaired report whose PDF is older than the 3-day window and was never
  tracked is skipped as historical, so no Send again is offered (`archive.py` `repair_report_states`, exempt `state_repaired_at`);
  a resend still sending after the 5-minute poll shows "Could not send" (`app.js` `resendReport`, show "may not have arrived").
- [x] MEETONTRACK-99 (shipped; closed in Plane 2026-11-04): Rebuilt reports of old meetings showed old delivery failures as new problems (0.1.16, 9AE490BB:
  email failed 2026-10-16, Telegram sent; the MEETONTRACK-94 rebuild re-dated the report and raised a fresh "email failed").
  Fixed on fix/meetontrack-on-request-delivery: a rebuild that sends nothing keeps the earlier outcome and its dates; the
  retry window runs from the first send (`delivery_started_at`); on-request reports are judged as expired (`delivery_health.py`),
  so the polluted issue clears on the next check after start.
- [x] MEETONTRACK-98 (shipped; closed in Plane 2026-11-04): Report PDFs of long meetings failed on 0.1.16: Chrome got a fixed 20 s to print (`archive.py` `_print_pdf`)
  and `finalize_history` retried every minute. Fixed on fix/meetontrack-pdf-print-timeout: wait for Chrome to exit (180 s cap);
  print outside the archive lock (one job per report folder, chunks of one call share it; re-print if the meeting changed); a
  failed report shows in the library and the delivery pill with "Create the report again" and retries itself every 30 minutes;
  Chrome profiles removed after exit and on start. Left (P2): sending (mail, Telegram, Drive upload) still holds the archive
  lock on purpose so settings and the Google profile cannot change mid-send; a slow Drive upload still stalls the library.
- [x] MEETONTRACK-94 (shipped in v0.1.19 / windows-v0.1.19, closed 2026-11-04): A meeting followed right away by another call kept its 44 live segments instead of the recorder's
  406-segment final transcript, got no report and showed only "Recording needs attention" (2026-10-22, 0.1.14):
  the final transcript was read only while that meeting owned the single live file (`archive.py` `finalize_history`).
  Owner rule 2026-11-04, fixed on main (closes when released): a report is built and sent only from the recorder's
  final transcript of every chunk of the call (`archive.py` `_ready_for_delivery`, the one gate of the automatic send,
  the 15-minute retry and "Send again"), after a rebuild of lost analysis (max 2 h). No timeout falls back to live
  text: a call without its final transcript an hour after it ended shows "waiting for the final transcript" in the
  library and the delivery header and is sent once the transcript arrives. Split meetings now import their part of
  the final transcript; speakers corrected on live text carry over to it (MEETONTRACK-117).
- [x] MEETONTRACK-117 (shipped in v0.1.19 / windows-v0.1.19, closed 2026-11-04): speakers corrected on the preliminary transcript before `transcript.json` arrives kept the final
  transcript from being applied, so that report was never sent (`archive.py` `import_final_transcript`).
  Fixed on main 2026-11-04 (closes when released): the final transcript is always imported and the corrections carry
  over by time overlap on the same channel, per line and then per final voice (`speaker_edits.py` `carry_corrections`);
  a correction the final cannot place keeps the final's own label and the meeting shows "check the speakers"
  (`speaker_review`). The report is then sent once, from the final transcript.
- [x] MEETONTRACK-119 (shipped in v0.1.20 / windows-v0.1.20, closed 2026-11-04): remaining edge cases of carrying speaker corrections to the final transcript (MEETONTRACK-117
  review P2s): a final line with the same start but a longer span keeps a correction by timestamp
  (`archive.py` `_drops_corrections`); split meetings are not guarded before import; a small corrected overlap that loses
  to uncorrected text is not flagged; `speaker_review` names are dropped by `SpeakerEdits._write` or a revised final;
  the corrected import skips `translation_en` preservation. Approach: keep corrected spans until the import consumes them.
  Fixed on main 2026-11-04 (tests in `test_speaker_carry_edges.py`); closes on release.
- [x] MEETONTRACK-121 (shipped in v0.1.21 / windows-v0.1.21, closed 2026-11-04): two P2s left by the MEETONTRACK-119 review: a split meeting whose boundary moved can still
  copy a correction by start time onto a merged line (`archive.py` `sync_transcript` annotation), and a flagged line
  whose start shifts in a revised final loses its review entry (`_still_to_review`). Approach: move such corrections
  into `corrected_live`; remap flagged spans by overlap. Fixed on main 2026-11-04; closes on release.
- [x] MEETONTRACK-122 (shipped in v0.1.21 / windows-v0.1.21, closed 2026-11-04): a restart between the email and the Telegram send can send the email again
  (`archive.py` `deliver` writes `delivery-receipts.json` only at the end; pre-existing). Approach: persist each
  channel as "unknown" before its send and its receipt right after it, as `delivery_retry.py` does.
  Fixed on main 2026-11-04; closes on release.
- [x] MEETONTRACK-123 (shipped in v0.1.21 / windows-v0.1.21, closed 2026-11-04): the report PDF used only the first browser found; Chrome that cannot print
  sent the HTML fallback although Edge or Chromium could print (`archive.py` `_print_pdf`). Now every
  installed browser is tried in order before the HTML fallback. Fixed on main 2026-11-04; closes on release.
- [ ] MEETONTRACK-135: Telegram delivery has no in-app setup and cannot work on Windows (no telethon in the
  bundled Python; it relies on a Telethon env file from a developer checkout). Proposed: in-app "Connect Telegram" via a bot.
- [x] MEETONTRACK-136 (shipped in v0.1.24 / windows-v0.1.24, closed 2026-11-09; fixed on main 8f1587a): Windows calls never got their final transcript or report: the recorder writes `transcript.json`
  with a UTF-8 byte order mark (.NET `Encoding.UTF8`, `TranscriptDocument.cs`) and `canonical_transcript.py` failed on it
  silently. The web service now reads `utf-8-sig`; the recorder writes no BOM; existing meetings import on the first
  pass after start. Fixed on main 2026-11-09; closes on the Windows release.
- [x] MEETONTRACK-137 (shipped in v0.1.24 / windows-v0.1.24, closed 2026-11-09; fixed on main d3ab7fb, c6882e2): an automatic recording ran 4.8 h on Windows (2026-11-08): Chrome kept the mic after the call and room
  noise defeated the both-tracks silence stop. Now an automatic recording stops after `silence_stop_minutes` with no call
  audio (`stop_reason` "no-call-audio"; `AutoRecordPolicy.cs`, `AutoRecordController.swift`), and backstop stops stand down
  until the call app lets go of the mic on Mac too. Fixed on main 2026-11-09; closes on the Mac and Windows release.
- [ ] MEETONTRACK-138: Mac treats a call app's open output stream as a possible capture failure (`RecordingSession.swift`
  `callCaptureSuspect`), so a browser holding a silent output stream after the call blocks the no-call-audio stop and the
  recording runs to the duration ceiling. Bound the suppression or require a stalled file; check with a Meet tab left open.
- [ ] MEETONTRACK-139: Windows final transcription of 2026.11.08-1734 found `mic.wav` locked by another process
  (`transcribe.log`); find the holder after recording ends and make the transcriber wait or retry.
- [ ] MEETONTRACK-118: a final transcript that never arrives stops being flagged after the 3-day delivery window
  (`archive.py` `_final_wait`, `delivery_health`), and a late final makes the report on request only.
- [ ] MEETONTRACK-89: Mac call-audio capture fades to silence during Chrome calls (39 of 53 min lost on 2026-10-21);
  watchdog fix ee2e6cf limits it; live A/B against an output-clocked aggregate on the next real call.
- [x] MEETONTRACK-86 (shipped; closed in Plane 2026-11-04): Windows: Codex sandbox refusal shows only as a generic AI failure.
- [x] MEETONTRACK-87 (shipped; closed in Plane 2026-11-04): Windows: frame relevance check fails with "model answered, but not as asked".
- [x] MEETONTRACK-88 (shipped; closed in Plane 2026-11-04): Recorder quit-when-idle command, so an upgrade can replace an old capture at once.
- [x] MEETONTRACK-90 (shipped; closed in Plane 2026-11-04): Live fact-check strip on the dashboard (branch feat/live-fact-check): claims ride the
  live analysis, verdicts need a source the app itself opened, else yellow; web search only via ai.choice.
  Codex P2 follow-ups fixed on the branch (2026-10-22): rows show the speaker the annotated transcript shows now
  (corrections included), and one wall-clock deadline per fetch shuts down a source that trickles headers or body.
  Open until the branch is merged and released.
  2026-10-22 owner request: moved into Call overview as a fourth column (strip and its grid row removed).
- [x] MEETONTRACK-96 (shipped; closed in Plane 2026-11-04): Chat tab shows only the owner's questions, notes and the answers to him; auto-analysis
  (and raw SIGNAL_UPDATE/protocol lines) never reach it, also for stored meetings (filtered on read, data kept).
  The separate Meeting chat tab is removed; call-chat capture still feeds Call overview and Links and services.
  Done on branch worktree-agent-a427cf01f1e72ae19; open until merged and released.
- [x] MEETONTRACK-97 (shipped; closed in Plane 2026-11-04): Call overview status counters are filter toggles saved as `call_overview_statuses` in the
  shared config.json. Done on branch worktree-agent-a427cf01f1e72ae19; open until merged and released.
- [ ] MEETONTRACK-70: LocalVQE echo-cancellation model (`liblocalvqe`, echo removal before
  transcription) is still a fixed model; offer it through discovery like the speech
  models or record why it is an adapter constant.
- [ ] MEETONTRACK-71: transcribe.cpp (whisper.cpp family) as a second local Mac adapter in
  `stt-options`, so local choices are not FluidAudio-only.
- [ ] MEETONTRACK-72: Cloud speech pricing: no prices in the UI; link each cloud engine to the
  provider's own pricing page (`source_url`-style field in `stt-options`).
- [ ] MEETONTRACK-73: Speech engines offered by FluidAudio but not yet adapted: Sortformer speaker
  models, `StreamingModelVariant` (Parakeet EOU) streaming, Parakeet int4 encoder
  precision; cloud live adapters (AssemblyAI streaming, OpenAI realtime). Each is
  missing from `stt-options` until an adapter exists.
- [ ] MEETONTRACK-74: Model reuse scans only `~/Library/Application Support/FluidAudio/Models` and
  `~/.cache/fluidaudio/Models` (`STTReuse.roots`); sandboxed FluidAudio apps keep
  models in their own containers, which are not read. Add a container root only
  with a user-granted folder.
- [ ] MEETONTRACK-75: Verify against the real services once: AssemblyAI `speech_models` +
  `speech_model_used` and OpenAI transcription models through `stt-check` with a
  real key (not exercised in tests).
- [ ] MEETONTRACK-76: Live transcription follows a speech choice changed during a recording
  (codex 2026-10-21, P2): `MeetingCopilot.resumeAfterConfigChange` resumes only
  final transcription; `LiveTranscriptionCoordinator` resolves the choice at
  recording start or a toggle, and its watchdog does not retry `unavailable`.
  Restart the enabled live pipeline when the choice or its readiness changes.
- [ ] MEETONTRACK-77: Parakeet live backpressure (codex 2026-10-21, P2):
  `ParakeetLiveRecognizer.process` only enqueues into FluidAudio's unbounded
  `streamAudio` queue, so the coordinator's backlog limit and stalled-decoder
  recovery never see a slow decoder. Await decoding or bound the queue and
  report real progress (`LiveRecognizer.swift`, `ponytail:` comment).
- [ ] MEETONTRACK-78: Replace a rejected cloud API key (codex 2026-10-21, P2): `speech.js`
  hides the key field once a key file exists (`has_key: true`), so a mistyped
  key that the provider rejects (OpenAI 401 listing error) cannot be replaced.
  Keep the field when the listing reports an authentication error, or validate
  the key on save.
- [ ] MEETONTRACK-79: Keep typed API key during polling (codex 2026-10-21, P2): while a download
  or re-transcription runs, `speech.js` `refreshState()` rebuilds the whole
  choice form every 1.5 s and drops the key being typed. Update progress
  separately or keep the mounted form.
- [ ] MEETONTRACK-11: Phase 4 (Windows): `scripts/windows/install.ps1:67-68` writes a new
  `config.json` with pinned engine/backends and no lock or ACL; `:80-85` does a
  read-modify-write without `config.json.lock`; `:96-98` pins speech models.
  `scripts/windows/meeting-copilot.ps1:16-26` looks only for Codex. C#
  `AppSettingsStore` (not in this repository) must take `config.json.lock` with
  `FileStream.Lock(0,1)` (same byte as Python `msvcrt.locking`), refuse
  malformed files and restrict the file ACL to the user (the Windows equivalent of
  0600, open on the Python side too).

## Friendly-user release gate — 2026-10-19

- [x] Corrected first-install entry: installer waits for the local assistant's
  health response and opens the browser automatically; no second terminal command.
  13 installer tests and 370 Swift tests passed. Native assistant action remains
  available idle/recording/paused; clicked successfully in the installed Mac UI.
- [x] Public 0.1.10 Mac/Windows packages passed exact archive and fresh/repeat
  installation checks. Both public archives were downloaded without credentials
  and match the pinned SHA-256 values. See the distribution acceptance above.
- [ ] MEETONTRACK-13: Complete real-device two-sided audio/permissions/reconnect testing on both
  platforms and a clean Mac. The physical Windows host was offline at the final
  release check. Local Office retrieval and new-account Google onboarding remain
  distinct open requirements; do not call the technical beta a stable release.

## Meeting library follow-up

- MEETONTRACK-14: Verify the new history drawer, filesystem-opening actions and explicit summary
  editor on packaged Windows and physical mobile devices. Current browser
  acceptance uses Chromium emulated viewports on macOS, not those devices.
- MEETONTRACK-15: Add explicitly opt-in, reviewable account-wide summary preferences separately
  from one-meeting correction requests. Current correction instructions apply
  only to the selected meeting; never silently promote them to a global rule.
- MEETONTRACK-16: Migrate legacy report branding to MeetOnTrack without changing automatic report
  delivery signatures or resending previously delivered reports. Existing PDF/HTML
  exports retain their original branding until an intentional migration/rebuild.
- [x] MEETONTRACK-95 (shipped; closed in Plane 2026-11-04): Links and services: one card per URL (SERVICE and LINK merged, OCR
  one-character variants such as forms/torms merged) and no links to the call itself
  (Zoom, Meet, Teams, Telemost and similar). Source fix 2026-10-22 in
  `copilot/web/journal_links.py`, applied on create and on read without rewriting
  stored data; close after release.

## MeetOnTrack updates and distribution

- [x] MEETONTRACK-100 (shipped; closed in Plane 2026-11-04): Every Mac `install.sh` run left `Meeting Copilot Capture.backup-*.app`
  in /Applications (10 extra "Meeting Copilot" in Launchpad on the owner's Mac) plus
  `{python,web}.backup-*` in the share dir. Source fix 2026-10-26: backups live only in the
  installer temp dir until commit, and the next install moves old leftovers to the Trash.
  Close after the next public Mac package ships it.
- [x] MEETONTRACK-101 (shipped; closed in Plane 2026-11-04): A provider 429 (Codex "exceeded retry limit, last status: 429") was shown
  as "The AI account limit is reached" while the weekly limit was about 1% used. Source fix
  2026-10-26: throttling maps to AI_BUSY ("busy, not your plan limit"), AI_LIMIT only for real
  usage-limit/quota text (`copilot/web/first_run.py`). Close after the next release ships it.
- [x] MEETONTRACK-102 (shipped; closed in Plane 2026-11-04): Report utterance and frame times were UTC while the header was local
  (12:59 vs 11:59 on 2026-10-26). Source fix 2026-10-26 in `archive.py` and
  `meeting_boundaries.py`. Close after the next release ships it.
- [x] MEETONTRACK-103 (shipped; closed in Plane 2026-11-04): Two consecutive Telemost calls (goodbyes, 86 s audio gap, new person)
  were recorded as one meeting, one report and one email. Source fix 2026-10-26: while recording,
  the server starts a new logical meeting at the end of a far-end audio gap of at least 75 s
  with no transcribed speech in it, RU/EN goodbyes in the 60 s before it and speech after it
  (`call_change_gap` in `meeting_boundaries.py`). Close after the next release ships it.
- [x] MEETONTRACK-104 (shipped; closed in Plane 2026-11-04): Speaker roster named a participant "Sure" from the English word when AI
  naming was unavailable. Common words must never become names. Source fix 2026-10-26:
  "I am X"/"I'm X" counts as a self-introduction only when X is written capitalised
  (`spoken_name` in `server.py`), and the roster's "имя звучит в разговоре" hint matches
  the name case-sensitively (`archive.py`). Close after the next release ships it.
- [x] MEETONTRACK-105 (shipped; closed in Plane 2026-11-04): Codex lost its sign-in (`token_revoked`, 2026-10-28) and the banner
  showed raw "workspace routing discovery unauthorized (401)". Source fix: "Sign in to
  <tool>" buttons for Codex, Claude Code and Antigravity (`POST /api/ai/sign-in`) and
  Antigravity enabled with an isolated strict agy home (commits c54397b, 337ebd9).
  Close after the next release ships it.
- [x] MEETONTRACK-107 (shipped; closed in Plane 2026-11-04): analysis lost when the AI fails mid-meeting; rebuild endpoint + auto-retry
  (commit c499d54; review fixes d44c72e, 842c84d, aa861a7). Close after release.
  Open P2s from the 2026-11-02 re-review: a rebuild started with the button does not pause
  when a recording starts (`analysis_rebuild.py` `start()` passes no busy predicate), and
  `done` records saved before aa861a7 carry no transcript signature, so a later transcript
  change does not reoffer the rebuild. Pass the recording predicate through `start()`;
  treat a missing signature as stale once a current one is available.
- [ ] MEETONTRACK-106: The Mac recorder still refuses Antigravity
  (`capture/.../Summary/AIChoice.swift`), so summaries and speaker names are unavailable
  with that choice. Add a Swift backend with the same isolation; check the Windows recorder.
- [ ] MEETONTRACK-108: On macOS the Antigravity sign-in runs as `open -a Terminal agy`;
  `SignIns` tracks `open`, so an abandoned sign-in leaves agy waiting in Terminal
  (`AntigravityAdapter.sign_in_command`, `ai_providers.py`). Launch agy through a wrapper that
  records its own PID and stop only that PID after the window; never touch other Terminal sessions.
- Deferred by owner (2026-10-19): automatic installation is not required for the
  current release. Current acceptance is a working newer-version indicator,
  release notes and a copyable platform-specific update command. No automatic
  execution or interruption of a call. See `docs/UPDATES.md`.
- MEETONTRACK-18: Future work, not a current release blocker: automatic installation of
  the complete Capture + web + Python product, not just release notifications.
  Migrate Mac's split payload into the Sparkle update unit and Windows ZIP installs
  into the owned Velopack channel; retain recordings/settings and provide rollback.
  Validate exact N-to-N+1 packages, busy-call deferral and interrupted updates on
  both OSes before changing the public website promise. See `docs/UPDATES.md`.
  Current gaps: complete-product updater packaging/signature verification and
  cross-version acceptance are unfinished; Windows SSH returned no host key
  despite Tailscale online. No valid Mac Developer ID identity was found, but
  Apple enrollment is not a prerequisite for Ed25519-signed update archives.
- [x] 0.1.10 public Mac archive contains release identity and embedded runtime;
  anonymous downloaded bytes passed exact manifest/fresh/repeat acceptance.
- [x] Published Mac/Windows packages contain the M icon and release checker.
  Both platform/channel choices recognize the actual public 0.1.10 release feed.
  Existing old installs without the checker require one manual update first.
  Signing/appcast validation belongs to deferred automatic-installer work.

## Multilingual recognition acceptance

- MEETONTRACK-19: Validate multilingual switching on real, consented test audio with accents,
  background noise and overlap, beyond the synthetic EN/RU/ES acceptance.
  See `docs/ASR_LANGUAGES.md`; do not promise universal code-switch accuracy.
- MEETONTRACK-20: Reconcile AI-generated call-map items when a final transcript replaces an
  erroneous live version: supersede unsupported generated items with provenance,
  preserve manual notes/status edits and retain an audit trail. Do not blindly
  delete the journal or infer that refreshing the transcript fixes old analysis.
- MEETONTRACK-21: Repair or document the local CLT 6.3.2 test-toolchain discovery failure
  (`cmath`, Testing framework and TestingInterop paths). The language acceptance
  script provides explicit process-local paths; do not change the system SDK
  or install another toolchain as part of an active-call repair.

## Existing UI accessibility warnings

- MEETONTRACK-22: Verify the existing muted-text contrast and dialog content padding in
  `copilot/web/styles.css` with actual light/dark UI screenshots and computed
  styles. The Impeccable scan during removal of AI chat reset flagged these
  unrelated areas; they were not changed in that scoped task. Adjust verified
  failures without altering the recording or meeting-context workflows.
  The 2026-10-19 bounded detector pass also flagged 10px company/language controls
  and small functional labels. Include these in the same accessibility acceptance.

## Continuous recording meeting boundaries

- Completed and installed on Mac 2026-10-13: Start new meeting from now without
  restarting Capture. Persist independent logical meeting intervals over the
  original audio; isolate transcript, AI jobs/context, journal, screenshots,
  chat, reports and history. Prevent archive continuous-chain merging across
  explicit boundaries and keep recovery targeting the physical recording ID.
  Reviewed implementation and synthetic restart/routing tests:
  [2026-10-13 continuous meeting boundary specification](superpowers/specs/2026-10-13-continuous-meeting-boundary-design.md).
  [Implementation plan](superpowers/plans/2026-10-13-continuous-meeting-boundary.md).
  161 Python tests and browser cancellation/retry/conflict/history checks pass.
  Capture was not restarted. No actual boundary was applied to the owner's call.
- MEETONTRACK-24: Add bounded audio export for logical meeting intervals. Current history shows
  the original recording range; split-meeting external reports omit whole audio
  intentionally to prevent disclosure of adjacent meetings. Implement range
  export from original tracks, test exact bounds and report attachment isolation.

## Windows beta acceptance gaps

- [x] MEETONTRACK-120 (shipped in v0.1.20 / windows-v0.1.20, closed 2026-11-04): Windows never makes the PDF meeting report, so no report is emailed,
  uploaded or sent to Telegram (found by the 0.1.19 notes review). `archive.py` `_print_pdf`
  looks for Chrome only at its macOS path. Find Chrome or Edge on Windows (Program Files,
  LocalAppData, App Paths), print with the same headless flags, add a path-lookup test.
  The windows-v0.1.19 notes state the limit.
  Fixed on main 2026-11-04: Chrome then Edge at standard places and App Paths; without a PDF the report goes out
  as one HTML file with a visible, retried problem; Windows CI prints with Chrome and with Edge. Closes on release.
- MEETONTRACK-25: Keep the full Python suite platform-aware: three security tests currently
  assume POSIX mode 0600, and a recorder test assumes POSIX path spelling.
  Windows ACL checks must replace, not silently skip, the security assertions.
- MEETONTRACK-26: Optional screen OCR/active-tile detection requires Pillow and NumPy, not
  shipped in the minimal embedded Python package. Do not claim that feature
  works on Windows until dependencies and an actual UI test are included.
- MEETONTRACK-27: Add packaged-application audio and recognition-resume smoke testing to the
  release gate, in addition to native unit tests and installer fixture tests.
- MEETONTRACK-28: Verify extended real-call reconnects and report/PDF/delivery parity before
  promoting the unsigned Windows technical beta to a stable release.
- MEETONTRACK-29: Windows signed distribution and automatic-install acceptance remain future
  work; verify release notifications and manual update instructions now.
- [x] MEETONTRACK-65 (shipped; closed in Plane 2026-11-04): Upgrade can keep serving the previous version (found 2026-10-21 while fixing
  the macOS LaunchAgent restart race). `scripts/windows/install.ps1` never stops
  the running web server, and `meeting-copilot.ps1` reuses any healthy server on
  port 43121, so the old `versions\<old>\web\server.py` keeps running after an
  update until logoff. Its health check also accepts `ok: true` from an
  unrelated service. Proposed: stop only our own server (match the process
  command line to `MeetingCopilot\versions\*\web\server.py`), wait for the port
  to be free, start the new one, and require `service == 'meeting-copilot'`.

## Repository meeting history

Requested: after a meeting ends, identify the relevant selected GitHub/GitLab
repository and save a concise meeting history there.

Do not copy the same meeting to every active repository. The current fallback
scope means "search all selected repositories", not "publish to all". Some
meetings have no matching project alias; some projects map to multiple repos.

Acceptance criteria:

- MEETONTRACK-30: Use the meeting's explicit project/repository choice first. Automatic routing
  is allowed only for one unambiguous project and explicitly permitted private
  destination repositories. Otherwise show a pending routing choice.
- MEETONTRACK-31: Save a reviewed, project-specific brief under `docs/meetings/` with meeting ID,
  date, decisions, actions and links to the local full report. Never publish raw
  audio, screenshots, transcripts, chat, credentials or a report containing
  unrelated client details.
- Keep private deal economics out of repositories other than the allowlisted
  financial repositories. Do not infer or distribute private amounts.
- MEETONTRACK-33: Make writes idempotent by meeting ID, show per-repository status in meeting
  history, and verify the remote GitHub/GitLab revision after push. Never claim
  completion from local Git state alone.
- Owner confirmed on 2026-09-25: automatic writes are permitted only to
  verified private repositories for an unambiguous project; ambiguous meetings
  stay pending for selection. Recheck current GitHub/GitLab authentication rather
  than relying on the historical missing-credentials observation. Unattended
  publication remains off until private visibility and real push/readback pass.
- MEETONTRACK-35: Evaluate [Laya](https://github.com/NandhaKishorM/laya) as an optional local
  candidate scorer for one or more repos. It must not independently authorize
  publication: validate on labelled meeting-to-repo examples, calibrate the
  multilingual model, then apply the private-repo and ambiguity gates above.

## Google delivery

- [x] 2026-10-19: diagnosed the rejected attachment outside the Google CLI cwd;
  fixed attachment/upload subprocess cwd, installed the fix on Mac, and verified
  the owner-authorized resend through Gmail Sent and Inbox. Safe reason codes,
  durable delivery receipts and explicit per-channel retry controls are added.
  Do not backfill other historical reports without duplicate checks and approval.

- [x] 2026-10-19: added delivery settings, independent channel consent, named
  Google profile selection/connect/disconnect/check, SMTP/TLS, recipient and
  Drive folder controls. SMTP draft checks do not save consent or routing;
  account checks retain drafts. Local reports work without integrations. See
  [DELIVERY.md](DELIVERY.md) for tests and exact acceptance boundaries.

- [x] 2026-10-19 source implementation: import the user's Desktop OAuth JSON in
  Settings; protected OS store, native PKCE/loopback login, expected-account check,
  refresh, disconnect, Gmail/Drive delivery and read-only context adapters.
  No shared product Cloud project, external connector or profile registry required.
  Import/connect do not opt in to delivery or context search. See DELIVERY.md.
  Installed and read back on Mac; native Keychain JSON roundtrip passed with a
  disposable item. Settings reads no longer wait behind the archive delivery
  lock; edits return an actionable busy response. Concurrency regressions added.
- [ ] MEETONTRACK-36: Finish real new-account OAuth acceptance: use a user's own Desktop client
  to consent, check identity/scopes, refresh, send an authorized test report, upload
  to the chosen folder, search enabled sources and disconnect on clean Mac and
  Windows. Automated protocol tests and synthetic Chrome/API import do not prove
  provider consent or Windows DPAPI. Never bundle owner credentials.
- [ ] MEETONTRACK-37: Verify SMTP against an owner-approved test account and exercise native
  Keychain/Windows DPAPI credential roundtrips on both OSes. Current SMTP protocol
  and consent checks are automated; real SMTP delivery and Windows runtime are
  not established by those tests.
- [x] 2026-10-19: repaired Telegram interpreter selection and bundled hash-locked
  pure-Python Telethon dependencies for both packagers; Mac authorization checked
  without sending. Unknown outcomes no longer trigger an automatic duplicate.
- [ ] MEETONTRACK-38: Verify Telegram from both exact installed packages with explicit test-send
  authorization, including Windows dependency loading. Do not silently use another
  account/session or mark an unacknowledged report as sent.

The application retries unsent reports and shows recent failures in the UI.
Gmail/Drive use either the selected native own-client OAuth connection or a named,
identity-checked legacy wrapper; missing `gog` authorization is not a failure.
A completed report from 2026-09-25
was uploaded and delivered through this path, including Telegram and Drive
links. Automatic retries are limited to the most recent three days; older
pending reports need a duplicate check against Sent mail before any backfill.

## First-run acceptance gaps (feedback reviewed 2026-10-16)

These are product requirements derived from installation feedback and screenshots,
not reproduced runtime failures. Private chat messages and screenshots are not
stored in this repository. Verify the public installed package as well as source.

- [ ] MEETONTRACK-39: Simplify the first-run path in the native setup: explain the outcome,
  show only missing required steps, and move optional
  cloud providers, file locations and advanced choices into settings. Distinguish
  local transcription costs from optional AI-provider charges. Validate with a
  first-time user who has not received instructions from the developer.
  Owner rule 2026-10-21: the fewest clicks, no confirmations. A speech model the
  installer downloaded counts as chosen. Auto-record is on by default and lives in
  Settings. Interface language: confirmed at first launch, preselected Russian when macOS's
  first language is Russian and English otherwise, changeable in Settings (owner
  correction 2026-11-04; the web UI uses the same default until config.json has one). Never ask how to split speakers:
  label by channel, then use the existing live diarizer and post-call speaker naming.
- [ ] MEETONTRACK-67: One-time in-app showcase at first launch, before setup: what
  MeetOnTrack does differently (live answers from your files with sources, both sides
  recorded locally, your own AI). Scripted, synthetic, skippable, replayable from
  Settings. Separate from the short real test recording at the end of setup.
- [ ] MEETONTRACK-40: Make live meeting assistance reachable after setup. The reviewed capture
  screen has live transcription disabled and a separate final transcription model;
  explain this distinction and make the required live path explicit. After either
  completion or "Later", open a clear status/start screen with the exact remaining
  prerequisite and a working action, rather than leaving the app undiscoverable.
- [ ] MEETONTRACK-41: Unify MeetOnTrack branding across the shipped native app, menu-bar icon,
  language picker, menu actions, settings and web assistant. Review all installed
  entry points. On 2026-10-19 Swift UI/branding tests and Windows UI source use
  MeetOnTrack; the installed Mac display name was verified. Old upstream names
  remain only in compatibility identifiers/paths and mandatory attribution, not
  product labels. Windows installed UI/icon acceptance is still unverified.
  Use plain location labels such as "top menu bar on your Mac" and expose a clear
  action to open the assistant, including when the menu bar is crowded.
  2026-10-19: M-and-dot icon built and installed on Mac; owner confirmed Dock
  and menu-bar icons changed. Mac bundle and native views share one renderer;
  legacy icon entry point delegates to it. Windows generator changed in the
  native capture repository, but real Windows build/tray/taskbar acceptance and
  both updated public packages are distributed as 0.1.10. Real Windows
  tray/taskbar acceptance is still open; hosted native/package checks passed.
- [ ] MEETONTRACK-42: Add a discoverable context-connection walkthrough: show supported sources,
  connected/searchable status and a sample grounded answer. Explain repositories,
  local documents and Google sources individually; do not imply that spreadsheet
  or document ingestion exists merely because repository search works.
- [ ] MEETONTRACK-43: Complete release acceptance for connected sources (`docs/CONTEXT_SOURCES.md`):
  folder/Drive implementation and synthetic API/LLM/handler regressions are in source;
  verify native folder selection on Windows and rendered controls in Mike's Chrome,
  then include them in the tested public package. Later Mac Chrome checks do not
  substitute for Windows selection or clean installed-package acceptance.
- [ ] MEETONTRACK-44: Extend folder retrieval beyond UTF-8 text/CSV/code to PDF and Office documents
  with bounded, read-only extractors (OfficeCLI for supported Office operations).
  Keep formats explicit in `getting-started.js`; never imply binary ingestion works
  because a directory can be connected. Add cancellation for slow network mounts
  before claiming the cooperative search time budget is a hard deadline.
- [ ] MEETONTRACK-45: Check installed models and actual provider readiness before requesting
  downloads or reporting "ready". An executable/version response alone does not
  prove successful authenticated inference or available quota. Show download size,
  disk use and reusable-model compatibility; offer a short functional check.
- [ ] MEETONTRACK-46: Expose AI authentication, quota and provider failures in the main assistant
  with a recovery action, while keeping capture state independent. Test missing
  subscription, expired authentication, exhausted quota and network failures;
  preserve queued work and prevent a silently empty assistant.
- [ ] MEETONTRACK-47: Add packaged recording-state regression tests for repeated Start clicks,
  actual audio progress, prolonged silence and end-of-call detection. Feedback
  describes an older upstream recording-silence incident, not a verified failure
  of this build. Require idempotent Start, visible failure/health feedback, bounded
  resource growth and recovery without discarding valid quiet meeting intervals.
- [ ] MEETONTRACK-48: Test packaged Mac and Windows capture with wired/Bluetooth headphones,
  reconnects, and input/output device switching during a call. Verify both local
  and remote audio tracks plus transcription continuity; one successful personal
  call is not evidence for every supported device transition.
- [ ] MEETONTRACK-49: Verify the end-user installer and documented first-run path from launch
  through context selection, recording and a useful answer. Evaluate a direct
  downloadable installer after packaging/signing acceptance. Website placement
  and promotional demos belong to the website backlog, not this release gate.

## AI provider layer: Codex review round 5 leftovers (2026-10-20, P2)

- [ ] MEETONTRACK-50: Ollama live chat pins the whole first prompt (transcript, question,
  excerpts) as the system message, so trimming cannot reclaim it and valid
  continuations are rejected on small contexts (`copilot/web/ai_providers.py`
  ~603). Split immutable session rules from meeting content; let old
  snapshots be trimmed.
- [ ] MEETONTRACK-51: `live_translation.py` ~84: a status change to `needs_choice` /
  `unavailable` does not bump `revision`, so `AnnotationCache.snapshot()`
  keeps serving the old empty `translation_state`. Bump revision on status
  change.
- [ ] MEETONTRACK-52: `live_translation.py` ~77: an English/Russian/undetected segment clears
  `needs_choice` while foreign segments still wait for a translation choice.
  Keep the status while unresolved jobs need a choice.

## Live translation: no-op "EN:" lines on Russian speech (found 2026-10-21)

- [ ] MEETONTRACK-64: Short Russian phrases are misdetected by `detect-speech-language` as
  `bg`/`kk` with confidence 1.0, so `live_translation.py` `_work` sends them for
  translation; the prompt says "keep Russian words as Russian", the model returns
  the Russian text unchanged, and the segment gets `translation_en` equal to its
  own text. The UI and the report (`archive.py` ~1751) then show a duplicate
  "EN:" line. Seen on meeting 51FE8DC8 (2026-10-20): 4 such segments. Proposed:
  store no translation when the result equals the source text (case/space
  normalized), and consider skipping Cyrillic-only text detected as bg/kk/uk
  when the meeting language is Russian. Since 2026-10-21 `sync_transcript` keeps
  archived translations across restarts, so previously stored no-op lines stay
  until the text changes or a cleanup pass drops them.
