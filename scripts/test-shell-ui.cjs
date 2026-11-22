// Real UI files, synthetic API only: viewFor picks Home, the call or After from the state,
// a view opened by hand holds until the call changes, and the page shows only the chosen view.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

const errors = [];
(async () => {
  const browser = await chromium.launch({ headless: true });
  const root = path.resolve(__dirname, '../copilot/web');
  let live = true;
  const healthy = { channels: { gmail: { configured: true, state: 'sent', issues: [] } }, undelivered: [], notifications: [] };
  const problem = { ...healthy, undelivered: [{ meeting_id: 'm9', channels: ['email'], title: 'Pilot review', started_at: '2026-11-20T10:00:00+00:00' }] };
  let delivery = healthy, language = 'ru', updates = {}, title = 'Pilot review';
  // The first state answer is held back: until it comes, no view is shown, not even Home.
  let releaseState;
  const firstState = new Promise(resolve => { releaseState = resolve; });
  const state = () => ({ preferences: { interface_language: language }, journal: [], frames: [], project: {}, delivery, updates,
    transcript: { meeting_id: 'm1', meeting: title, status: live ? 'recording' : 'idle', live, segments: [], speakers: [] },
    recording_health: { capture: { audio_recording: live } },
    copilot: { busy: false, analysis: { state: 'idle' }, messages: [] },
  });
  const serveFile = async route => {
    const file = new URL(route.request().url()).pathname.slice(1) || 'index.html';
    if (file.includes('/') || !/\.(html|js|css)$/.test(file)) return route.abort();
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    return route.fulfill({ contentType: type, body: await fs.readFile(path.join(root, file)) });
  };
  try {
    // The first state never comes: once the poll calls the connection failed, Home shows and the bar says so.
    const lost = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await lost.route('http://shell-ui.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/state') return route.fulfill({ status: 500, json: { ok: false, error: 'down' } });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true } });
      return serveFile(route);
    });
    await lost.addInitScript(() => { localStorage.setItem('meetontrack-started', '1'); localStorage.setItem('meeting-copilot-language', 'ru'); });
    const lostPage = await lost.newPage();
    await lostPage.goto('http://shell-ui.test/');
    await lostPage.waitForFunction(() => document.body.dataset.view === 'home', null, { timeout: 15000 });
    assert.deepEqual(await lostPage.evaluate(() => ({ home: document.getElementById('home').checkVisibility(),
      status: document.getElementById('call-status-text').textContent, fail: document.getElementById('call-status-text').classList.contains('fail') })),
    { home: true, status: 'Нет связи с MeetOnTrack, пробуем снова', fail: true }, 'a state that never comes is not a blank page');
    await lost.close();

    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('http://shell-ui.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/state') {
        await firstState;
        return route.fulfill({ json: state() });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true } });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (file.includes('/') || !/\.(html|js|css)$/.test(file)) return route.abort();
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ contentType: type, body: await fs.readFile(path.join(root, file)) });
    });
    // The first-run guide has been seen: it opens over the call and would cover it.
    await context.addInitScript(() => localStorage.setItem('meetontrack-started', '1'));
    const page = await context.newPage();
    page.on('pageerror', error => /(shell|home)\.js/.test(error.stack || '') && errors.push(String(error.stack)));
    await page.goto('http://shell-ui.test/');
    await page.waitForFunction(() => typeof viewFor === 'function');
    assert.deepEqual(await page.evaluate(() => ({ view: document.body.dataset.view, home: !document.getElementById('home').hidden,
      workspace: getComputedStyle(document.querySelector('.workspace')).display !== 'none' })),
    { view: undefined, home: false, workspace: false }, 'nothing view-specific before the first state');
    releaseState();

    const views = await page.evaluate(() => {
      const now = Date.parse('2026-11-21T12:00:00Z');
      const ago = minutes => new Date(now - minutes * 60000).toISOString();
      const finished = latest => ({ transcript: { meeting_id: 'm1', status: 'finished', latest_at: latest } });
      const liveState = { transcript: { meeting_id: 'm2', status: 'recording', live: true } };
      const capture = state => ({ recording_health: { capture: { state, audio_recording: state === 'recording' } },
        transcript: { meeting_id: 'm3', status: state === 'paused' ? 'paused' : 'recording', live: false, updated_at: ago(20) } });
      const manual = { view: 'home', key: callKey(finished(ago(10)), now), at: now - 60000 };
      const manualAfter = minutes => ({ view: 'after', key: callKey(finished(ago(180)), now), at: now - minutes * 60000 });
      return {
        live: viewFor(liveState, null, now),
        finished10m: viewFor(finished(ago(10)), null, now),
        finished3h: viewFor(finished(ago(180)), null, now),
        noTranscript: viewFor({}, null, now),
        manualHome: viewFor(finished(ago(10)), manual, now),
        manualAfterKeyChanged: viewFor(liveState, manual, now),
        exactly2h: viewFor(finished(ago(120)), null, now),
        justOver2h: viewFor(finished(new Date(now - 2 * 3600000 - 1).toISOString()), null, now),
        finishedNoLatest: viewFor({ transcript: { meeting_id: 'm1', status: 'finished' } }, null, now),
        // Silence or no live transcription: the recorder's fresh status still means a call.
        recordingNotLive: viewFor({ transcript: { meeting_id: 'm4', status: 'recording', live: false, updated_at: ago(1) } }, null, now),
        stalled: viewFor(capture('stalled'), null, now),
        paused: viewFor(capture('paused'), null, now),
        // A recorder that crashed: no capture marker, its last "recording" status not rewritten for 10 min.
        crashed: viewFor({ recording_health: { capture: { state: 'inactive' } },
          transcript: { meeting_id: 'm5', status: 'recording', live: false, updated_at: ago(10) } }, null, now),
        // One call keeps one key: speech stopping does not change it.
        keyHolds: callKey(capture('recording'), now) === callKey({ ...capture('recording'),
          transcript: { meeting_id: 'm3', status: 'recording', live: true } }, now),
        manualAfter3h: viewFor(finished(ago(180)), manualAfter(180), now),
        manualAfter10m: viewFor(finished(ago(180)), manualAfter(10), now),
        // After counts from when the recording ended, not from the last transcript line: a call with live
        // transcription off has no latest_at, and a quiet ending leaves latest_at early.
        endedNoLatest: viewFor({ transcript: { meeting_id: 'm1', status: 'finished', ended_at: ago(10) } }, null, now),
        endedAfterQuietEnd: viewFor({ transcript: { meeting_id: 'm1', status: 'finished', latest_at: ago(150), ended_at: ago(10) } }, null, now),
        finishedExport: viewFor({ transcript: { meeting_id: 'm1', status: 'finished', updated_at: ago(10) } }, null, now),
        endedLongAgo: viewFor({ transcript: { meeting_id: 'm1', status: 'finished', latest_at: ago(10), ended_at: ago(130) } }, null, now),
      };
    });
    assert.deepEqual(views, {
      live: 'call', finished10m: 'after', finished3h: 'home', noTranscript: 'home', manualHome: 'home',
      manualAfterKeyChanged: 'call', exactly2h: 'after', justOver2h: 'home', finishedNoLatest: 'home',
      recordingNotLive: 'call', stalled: 'call', paused: 'call', crashed: 'home', keyHolds: true,
      manualAfter3h: 'home', manualAfter10m: 'after',
      endedNoLatest: 'after', endedAfterQuietEnd: 'after', finishedExport: 'after', endedLongAgo: 'home',
    });

    // One call status, first rule that matches: live, a call running without a recording, a missing
    // permission before the next call, else waiting. Start recording is never offered without a microphone.
    const statuses = await page.evaluate(() => {
      const now = Date.parse('2026-11-21T12:00:00Z');
      const at = minutes => new Date(now + minutes * 60000).toISOString();
      const me = { email: 'me@example.com', self: true };
      const call = (start, minutes = 30, extra = {}) => ({ event_id: `e${start}`, title: 'Pilot review', start: at(start), end: at(start + minutes),
        attendees: [me, { name: 'Anna Petrova', email: 'anna@example.com', self: false }], link: '', ...extra });
      // A calendar block with nobody else and no call link (focus time, lunch) is not a call.
      const solo = (start, extra = {}) => call(start, 30, { attendees: [me], ...extra });
      const agenda = (...meetings) => ({ meetings });
      const perms = (microphone = 'granted', call_audio = 'granted', recorder = 'running') => ({ microphone, call_audio, recorder });
      const live = { transcript: { meeting_id: 'm2', status: 'recording', live: true } };
      // The capture marker in a snapshot checked `age` seconds ago.
      const captured = (state, age = 5) => ({ recording_health: { checked_at: now / 1000 - age,
        capture: { state, audio_recording: state === 'recording' } },
      transcript: { meeting_id: 'm3', status: state === 'paused' ? 'paused' : 'recording', live: false, updated_at: at(-1) } });
      const short = status => [status.kind, status.text, status.action && `${status.action.id}${status.action.primary ? '!' : ''}`];
      const cases = {
        live: [live, agenda(call(40)), perms('denied')],
        liveRunning: [live, agenda(call(-5)), perms('granted', 'granted', 'stopped')],
        runningMic: [{}, agenda(call(-3)), perms('denied', 'denied', 'stopped')],
        runningRecorder: [{}, agenda(call(-3)), perms('granted', 'denied', 'stopped')],
        runningNotDetected: [{}, agenda(call(-3)), perms()],
        runningUnknown: [{}, agenda(call(-3)), perms('unknown', 'unknown', 'unknown')],
        startedOneMinuteAgo: [{}, agenda(call(-1)), perms()],
        runningSkipped: [{}, agenda(call(-3, 30, { skip_recording: true })), perms()],
        skippedThenNext: [{}, agenda(call(-3, 30, { skip_recording: true }), call(60)), perms('denied')],
        ended: [{}, agenda(call(-40)), perms('denied', 'denied', 'stopped')],
        micMissing: [{}, agenda(call(40)), perms('denied', 'denied')],
        // On macOS a denied microphone still records the call audio (only the owner's voice is lost); Windows does not start.
        micMissingMac: [{}, agenda(call(40)), { ...perms('denied'), platform: 'macos' }],
        micMissingWindows: [{}, agenda(call(40)), { ...perms('denied'), platform: 'windows' }],
        callAudioMissing: [{}, agenda(call(40)), perms('granted', 'denied')],
        micDeniedNoCall: [{}, agenda(), perms('denied', 'denied', 'stopped')],
        unknownEverywhere: [{}, agenda(call(40)), perms('unknown', 'unknown', 'unknown')],
        notLoaded: [{}, null, null],
        waiting: [{}, agenda(call(40)), perms()],
        soloRunning: [{}, agenda(solo(-3)), perms()],
        soloThenCall: [{}, agenda(solo(-3), call(40)), perms('denied')],
        linkOnlyRunning: [{}, agenda(solo(-3, { link: 'https://example.com/call/1' })), perms()],
        // Auto-record off, or the recorder known stopped before the call: no promise that it starts by itself.
        autoOff: [{}, agenda(call(40)), { ...perms(), auto_record: false }],
        autoOffNoCall: [{}, agenda(), { ...perms(), auto_record: false }],
        recorderStoppedBefore: [{}, agenda(call(40)), perms('granted', 'granted', 'stopped')],
        captureRecording: [captured('recording'), agenda(), perms()],
        captureVerifying: [captured('verifying'), agenda(), perms()],
        capturePaused: [captured('paused'), agenda(), perms()],
        captureStalled: [captured('stalled'), agenda(), perms()],
        captureStale: [captured('recording', 25), agenda(), perms()],
        transcriptPaused: [{ transcript: { meeting_id: 'm4', status: 'paused', live: false, updated_at: at(-1) } }, agenda(), perms()],
      };
      const result = Object.fromEntries(Object.entries(cases).map(([name, args]) => [name, short(callStatus(...args, now))]));
      result.homeNext = nextMeeting(agenda(solo(10), call(40)), now)?.event_id;
      result.time = homeClock(at(40));
      result.later = homeClock(at(60));
      result.started = homeClock(at(-1));
      // The next call is tomorrow: the status says so; up to 480 px the bar shows the short form.
      const tomorrow = callStatus({}, agenda(call(24 * 60 + 40)), perms(), now);
      result.tomorrow = [tomorrow.text, tomorrow.short, homeClock(at(24 * 60 + 40)) === result.time];
      result.waitingShort = callStatus(...cases.waiting, now).short;
      // Just after local midnight a call that began a minute ago is still waiting: it is not tomorrow's.
      const midnight = new Date(now);
      midnight.setHours(24, 0, 0, 0);
      const underway = { ...call(0), start: new Date(midnight.getTime() - 30000).toISOString(), end: new Date(midnight.getTime() + 1800000).toISOString() };
      result.underway = [callStatus({}, agenda(underway), perms(), midnight.getTime() + 30000).text, homeClock(underway.start)];
      // Never Start recording with the microphone denied, whatever else holds.
      // The page lost the server: a capture seen a moment ago is no longer a recording claim.
      stateConnectionFailed = true;
      result.disconnected = short(callStatus(...cases.captureRecording, now));
      result.disconnectedLive = short(callStatus(...cases.live, now));
      stateConnectionFailed = false;
      result.startWithoutMic = Object.values(cases).filter(([, , permissions]) => permissions?.microphone === 'denied')
        .some(args => callStatus(...args, now).action?.id === 'start');
      return result;
    });
    const { time, later, started } = statuses;
    assert.deepEqual(statuses, {
      time, later, started, startWithoutMic: false,
      live: ['recording', 'Запись', null],
      liveRunning: ['recording', 'Запись', null],
      runningMic: ['not_recording', 'Запись не идет: нет доступа к микрофону', 'open_mic!'],
      runningRecorder: ['not_recording', 'Запись не идет: программа записи не запущена', 'open_recorder!'],
      runningNotDetected: ['not_recording', 'Запись не идет: звонок не замечен', 'start!'],
      runningUnknown: ['not_recording', 'Запись не идет: звонок не замечен', 'start!'],
      startedOneMinuteAgo: ['waiting', `Ждет звонка в ${started}, запись включится сама`, 'start'],
      runningSkipped: ['waiting', 'Запись включится сама, когда начнется звонок', 'start'],
      skippedThenNext: ['mic_missing', `Нет доступа к микрофону: запись в ${later} не включится`, 'open_mic!'],
      ended: ['waiting', 'Ждет звонка', null],
      micMissing: ['mic_missing', `Нет доступа к микрофону: запись в ${time} не включится`, 'open_mic!'],
      micMissingMac: ['mic_missing', `Нет доступа к микрофону: ваш голос в звонке в ${time} не запишется`, 'open_mic!'],
      micMissingWindows: ['mic_missing', `Нет доступа к микрофону: запись в ${time} не включится`, 'open_mic!'],
      callAudioMissing: ['mic_missing', `Нет доступа к звуку звонка: запись в ${time} будет без собеседника`, 'open_call_audio!'],
      micDeniedNoCall: ['waiting', 'Ждет звонка', null],
      unknownEverywhere: ['waiting', `Ждет звонка в ${time}, запись включится сама`, 'start'],
      notLoaded: ['waiting', 'Запись включится сама, когда начнется звонок', 'start'],
      waiting: ['waiting', `Ждет звонка в ${time}, запись включится сама`, 'start'],
      soloRunning: ['waiting', 'Запись включится сама, когда начнется звонок', 'start'],
      soloThenCall: ['mic_missing', `Нет доступа к микрофону: запись в ${time} не включится`, 'open_mic!'],
      linkOnlyRunning: ['not_recording', 'Запись не идет: звонок не замечен', 'start!'],
      autoOff: ['waiting', `Ждет звонка в ${time}`, 'start'],
      autoOffNoCall: ['waiting', 'Ждет звонка', 'start'],
      recorderStoppedBefore: ['waiting', `Ждет звонка в ${time}`, 'start'],
      tomorrow: [`Ждет звонка завтра в ${time}, запись включится сама`, `Ждет звонка завтра в ${time}`, true],
      waitingShort: `Ждет звонка в ${time}`,
      underway: [`Ждет звонка в ${statuses.underway[1]}, запись включится сама`, statuses.underway[1]],
      homeNext: 'e40',
      captureRecording: ['recording', 'Запись', null],
      captureVerifying: ['recording', 'Запись', null],
      capturePaused: ['not_recording', 'Запись не идет: запись на паузе', null],
      captureStalled: ['not_recording', 'Запись не идет: звук перестал записываться', null],
      captureStale: ['not_recording', 'Запись не идет: нет свежих данных от программы записи', null],
      transcriptPaused: ['not_recording', 'Запись не идет: запись на паузе', null],
      disconnected: ['not_recording', 'Запись не идет: нет свежих данных от программы записи', null],
      disconnectedLive: ['not_recording', 'Запись не идет: нет свежих данных от программы записи', null],
    });
    // Stop recording (plan 3): the undo window, then the final stop; another call's stop never shows. One stalled
    // side keeps Recording (its beat and the feed say which side); every track stalled is not recording (F19).
    const stops = await page.evaluate(() => {
      const now = Date.parse('2026-11-21T12:00:00Z');
      const at = seconds => new Date(now + seconds * 1000).toISOString();
      const call = (control, extra = {}) => ({ transcript: { meeting_id: 'm1', status: 'recording', live: true, started_at: at(-900) },
        recording_control: { stopping: null, last_stop: null, ...control }, ...extra });
      const tracks = (...states) => ({ recording_health: { checked_at: now / 1000 - 2, capture: { state: 'stalled', audio_recording: false,
        tracks: states.map((state, index) => ({ source: index ? 'system' : 'mic', state, last_growth_age_seconds: 40 })) } } });
      const short = status => [status.kind, status.text, status.action && `${status.action.id}${status.action.primary ? '!' : ''}`];
      const cases = {
        stopping: call({ stopping: { meeting_id: 'm1', stopped_at: at(-10), until: at(20) } }),
        final: call({ last_stop: { meeting_id: 'm1', stopped_at: at(-4) } }),
        otherLastStop: call({ last_stop: { meeting_id: 'm0', stopped_at: at(-4) } }),
        otherStopping: call({ stopping: { meeting_id: 'm0', stopped_at: at(-10), until: at(20) } }),
        // The same id recording again after its final stop (not seen from today's recorders, guarded anyway).
        startedAfterStop: call({ last_stop: { meeting_id: 'm1', stopped_at: at(-60) } }),
        startedBeforeStop: call({ last_stop: { meeting_id: 'm1', stopped_at: at(-60) } }),
        oneStalled: call({}, tracks('recording', 'stalled')),
        bothStalled: call({}, tracks('stalled', 'stalled')),
      };
      cases.startedAfterStop.transcript.started_at = at(-10);
      cases.startedBeforeStop.transcript.started_at = at(-600);
      return {
        ...Object.fromEntries(Object.entries(cases).map(([name, state]) => [name, short(callStatus(state, { meetings: [] }, {}, now))])) };
    });
    assert.deepEqual(stops, {
      startedAfterStop: ['recording', 'Запись', null],
      // No time of day (G1): the bar's one clock is the call's, frozen at the stop; Resume is the Stop button (N2, N3).
      startedBeforeStop: ['stopped', 'Запись остановлена.', null],
      stopping: ['stopped', 'Остановлено 14:50', null],
      final: ['stopped', 'Запись остановлена.', null],
      otherLastStop: ['recording', 'Запись', null],
      otherStopping: ['recording', 'Запись', null],
      oneStalled: ['recording', 'Запись', null],
      bothStalled: ['not_recording', 'Запись не идет: звук перестал записываться', null],
    });
    assert.deepEqual(await page.evaluate(() => ['status.stopped', 'status.stopped_final', 'action.resume', 'action.stop', 'action.stop_short']
      .map(key => translations.en[key])), ['Stopped {time}', 'Recording stopped.',
      'Resume recording', 'Stop recording', 'Stop']);
    assert.deepEqual(await page.evaluate(() => ['meeting_changed', 'too_late', 'stop_failed', 'resume_failed']
      .map(code => translations.ru[`status.error.${code}`])), ['Звонок уже сменился, обновите страницу', 'Запись уже остановлена',
      'Запись не остановилась, откройте программу записи', 'Запись не продолжилась, откройте программу записи']);

    assert.deepEqual(await page.evaluate(() => ['status.waiting_manual', 'status.waiting_at_manual'].map(key => translations.en[key])),
      ['Waiting for a call', 'Waiting for the {time} call']);
    // The same reasons exist in English.
    assert.deepEqual(await page.evaluate(() => ['paused', 'stalled', 'stale'].map(reason => translations.en[`status.reason.${reason}`])),
      ['recording is paused', 'audio stopped being saved', 'no fresh data from the recorder']);

    const shown = () => page.evaluate(() => ({
      view: document.body.dataset.view,
      workspace: getComputedStyle(document.querySelector('.workspace')).display !== 'none',
      boundaryBar: getComputedStyle(document.querySelector('.meeting-boundary-bar')).display !== 'none',
      home: !document.getElementById('home').hidden,
      call: !document.getElementById('call').hidden,
    }));
    await page.waitForFunction(() => window.appState && document.body.dataset.view === 'call');
    assert.deepEqual(await shown(), { view: 'call', workspace: false, boundaryBar: true, home: false, call: true });
    // In a call the bar says Recording with the accent dot, and has no action in this plan.
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#call-status-text').textContent,
      document.querySelector('#call-status-text').classList.contains('rec'), document.querySelector('#call-status-action').hidden]),
    ['Запись', true, true]);
    // Home during a call: the status offers the way back to the call, which clears the choice.
    await page.locator('#nav-home').click();
    await page.waitForFunction(() => document.body.dataset.view === 'home');
    const back = page.locator('#call-status-action');
    assert.deepEqual(await back.evaluate(node => [node.hidden, node.textContent, node.classList.contains('primary')]),
      [false, 'Вернуться к текущему звонку', true]);
    assert.equal(await page.evaluate(() => translations.en['action.back_to_call']), 'Back to the current call');
    await back.click();
    await page.waitForFunction(() => document.body.dataset.view === 'call');
    assert.deepEqual(await page.evaluate(() => [document.querySelector('#call-status-action').hidden,
      localStorage.getItem('meetontrack-view')]), [true, null]);
    // The menu's Home does the same as the bar's, and the way back is there again.
    await page.locator('#menu-button').click();
    await page.locator('#menu-nav-home').evaluate(node => node.click());
    await page.waitForFunction(() => document.body.dataset.view === 'home' && !document.querySelector('#call-status-action').hidden);
    await page.locator('#call-status-action').click();
    await page.waitForFunction(() => document.body.dataset.view === 'call');

    // Top bar: Home, Past calls, one call status, Stop recording during a call, and Menu. The delivery pill joins
    // them only with a problem.
    const barControls = () => page.evaluate(() => [...document.querySelectorAll('.topbar button, .topbar .status')]
      .filter(node => !node.closest('#app-menu') && !node.parentElement.closest('.status') && node.checkVisibility())
      .map(node => node.id));
    assert.deepEqual(await barControls(), ['nav-home', 'archive-button', 'call-status', 'call-stop', 'menu-button']);
    delivery = problem;
    await page.waitForFunction(() => document.querySelector('#delivery-alert').checkVisibility());
    assert.deepEqual(await barControls(), ['nav-home', 'archive-button', 'call-status', 'delivery-alert', 'call-stop', 'menu-button']);
    delivery = healthy;
    await page.waitForFunction(() => !document.querySelector('#delivery-alert').checkVisibility());
    assert.equal(await page.locator('#refresh-button').count(), 0);

    // The menu opens on its first item, arrows move, Escape closes it and gives focus back to Menu.
    const focused = () => page.evaluate(() => document.activeElement.id);
    await page.locator('#menu-button').click();
    assert.equal(await page.locator('#app-menu').isVisible(), true);
    assert.equal(await page.locator('#menu-button').getAttribute('aria-expanded'), 'true');
    const items = await page.evaluate(() => [...document.querySelectorAll('#app-menu [role="menuitem"]')]
      .filter(node => node.checkVisibility() && !node.disabled).map(node => node.id));
    assert.equal(await focused(), items[0]);
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), items[1]);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    assert.equal(await focused(), items.at(-1));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#app-menu').isVisible(), false);
    assert.equal(await page.locator('#menu-button').getAttribute('aria-expanded'), 'false');
    assert.equal(await focused(), 'menu-button');
    // With focus outside the items: ArrowUp goes to the last, ArrowDown to the first, Escape still closes.
    const blur = () => page.evaluate(() => document.activeElement.blur());
    await page.locator('#menu-button').click();
    await blur(); await page.keyboard.press('ArrowUp');
    assert.equal(await focused(), items.at(-1));
    await blur(); await page.keyboard.press('ArrowDown');
    assert.equal(await focused(), items[0]);
    await blur(); await page.keyboard.press('Escape');
    assert.equal(await page.locator('#app-menu').isVisible(), false);
    assert.equal(await focused(), 'menu-button');
    await page.locator('#menu-button').click();
    await page.mouse.click(700, 600);
    assert.equal(await page.locator('#app-menu').isVisible(), false, 'a click outside closes the menu');

    // Settings open over the call: the call view does not move.
    const box = selector => page.locator(selector).boundingBox();
    const before = await box('#call');
    await page.locator('#menu-button').click();
    await page.locator('#settings-open').click();
    await page.locator('#settings-panel').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#app-menu').isVisible(), false, 'choosing an item closes the menu');
    const [panel, after] = [await box('#settings-panel'), await box('#call')];
    assert.equal(after.y, before.y, 'the call view top does not move');
    assert.ok(panel.x < after.x + after.width && panel.x + panel.width > after.x
      && panel.y < after.y + after.height && panel.y + panel.height > after.y, 'settings overlap the call view');
    await page.locator('#settings-close').click();
    assert.equal(await focused(), 'menu-button');

    // A dialog opened from the menu gives focus back to Menu when it closes.
    await page.locator('#menu-button').click();
    await page.locator('#repo-button').click();
    await page.waitForFunction(() => document.querySelector('#project-dialog').open);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('#project-dialog').open);
    await page.waitForFunction(() => document.activeElement.id === 'menu-button', null, { timeout: 2000 });

    // One update entry: the notice when there is an update, plain Updates otherwise.
    const updateItems = () => page.evaluate(() => ['updates-notice', 'menu-updates'].map(id => document.getElementById(id).checkVisibility()));
    updates = { version: '0.1.9', platform: 'macos', enabled: true, notify: true,
      latest: { version: '0.1.10', url: 'https://github.com/AIAgentLbs/meetontrack/releases/tag/v0.1.10', notes: '' } };
    await page.waitForFunction(() => !document.querySelector('#updates-notice').hidden);
    await page.locator('#menu-button').click();
    assert.deepEqual(await updateItems(), [true, false]);
    await page.keyboard.press('Escape');
    updates = { version: '0.1.9', platform: 'macos', enabled: true, notify: false, latest: null };
    await page.waitForFunction(() => document.querySelector('#updates-notice').hidden);
    await page.locator('#menu-button').click();
    assert.deepEqual(await updateItems(), [false, true]);
    // In a call the call's own controls are in the menu. Swap panels and Show transcript are not: the Call view
    // shows one pane at a time, so they would do nothing there (Task 8).
    assert.equal(await page.evaluate(() => document.body.dataset.view), 'call');
    assert.equal(await page.locator('#swap-panels').isVisible(), false);
    assert.equal(await page.locator('#new-meeting-button').isVisible(), true);
    // Notes for the call name it and switch the workspace to the notes tab.
    const notes = page.locator('#menu-notes');
    assert.equal(await notes.isVisible(), true);
    assert.equal(await notes.innerText(), 'Заметки к звонку «Pilot review»\nваш текст, который учтут подсказки');
    // A call without a title: no empty quotes, the notes tab's own name.
    title = '';
    await page.waitForFunction(() => document.querySelector('#menu-notes-title').textContent === 'Мои заметки');
    title = 'Pilot review';
    await page.waitForFunction(() => document.querySelector('#menu-notes-title').textContent === 'Заметки к звонку «Pilot review»');
    await notes.click();
    assert.equal(await page.locator('[data-content-view="notes"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#app-menu').isVisible(), false);

    // Speaker names come after the transcript in tab order.
    assert.ok(await page.evaluate(() => document.querySelector('#transcript')
      .compareDocumentPosition(document.querySelector('#speaker-edit')) & Node.DOCUMENT_POSITION_FOLLOWING));

    // 400 px: navigation moves into the menu, nothing spills sideways.
    await page.setViewportSize({ width: 400, height: 800 });
    assert.equal(await page.locator('.navs').isVisible(), false);
    await page.locator('#menu-button').click();
    assert.equal(await page.locator('#menu-nav-home').isVisible(), true);
    assert.equal(await page.locator('#menu-past-calls').isVisible(), true);
    const menu = await box('#app-menu');
    assert.ok(menu.x >= 0 && menu.x + menu.width <= 400, 'the menu fits the window');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.keyboard.press('Escape');
    // Past calls opened from the menu: closing it gives focus back to Menu, not to the hidden link.
    await page.locator('#menu-button').click();
    await page.locator('#menu-past-calls').click();
    await page.locator('#archive-dialog').waitFor({ state: 'visible' });
    await page.locator('#archive-close').click();
    assert.equal(await focused(), 'menu-button');
    // A delivery problem at 400 px, in both languages: Menu stays in the window, the status keeps some width.
    delivery = problem;
    for (const lang of ['ru', 'en']) {
      language = lang;
      await page.waitForFunction(lang => document.documentElement.lang === lang
        && document.querySelector('#delivery-alert').checkVisibility(), lang);
      const fit = await page.evaluate(() => {
        const menuButton = document.querySelector('#menu-button').getBoundingClientRect();
        return { scroll: document.documentElement.scrollWidth <= innerWidth,
          menu: menuButton.left >= 0 && menuButton.right <= innerWidth,
          status: document.querySelector('#call-status-text').getBoundingClientRect().width > 0 };
      });
      assert.deepEqual(fit, { scroll: true, menu: true, status: true }, lang);
    }
    language = 'ru'; delivery = healthy;
    await page.waitForFunction(() => document.documentElement.lang === 'ru'
      && !document.querySelector('#delivery-alert').checkVisibility());
    await page.setViewportSize({ width: 1440, height: 900 });

    live = false;
    await page.waitForFunction(() => document.body.dataset.view === 'home');
    assert.deepEqual(await shown(), { view: 'home', workspace: false, boundaryBar: false, home: true, call: false });
    assert.equal(await page.locator('#home-heading').count(), 1);
    // On Home the bar shows the call status, never the transcript's old idle line.
    await page.waitForFunction(() => document.querySelector('#call-status-text').textContent === 'Запись включится сама, когда начнется звонок');
    // Home has no call: no transcript, panel, new-meeting or notes controls in the menu.
    await page.locator('#menu-button').click();
    assert.deepEqual(await page.evaluate(() => ['transcript-show', 'swap-panels', 'new-meeting-button', 'menu-notes']
      .map(id => document.getElementById(id).checkVisibility())), [false, false, false, false]);
    await page.keyboard.press('Escape');

    assert.deepEqual(errors, []);
    console.log('Shell UI: viewFor table, call and Home views switch with the state, top bar and menu: OK');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error, errors); process.exitCode = 1; });
