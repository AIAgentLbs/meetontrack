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
  const state = () => ({ preferences: { interface_language: 'ru' }, journal: [], frames: [], project: {},
    transcript: { meeting_id: 'm1', meeting: 'Pilot review', status: live ? 'recording' : 'idle', live, segments: [], speakers: [] },
    recording_health: { capture: { audio_recording: live } },
    copilot: { busy: false, analysis: { state: 'idle' }, messages: [] },
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('http://shell-ui.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/state') return route.fulfill({ json: state() });
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true } });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (file.includes('/') || !/\.(html|js|css)$/.test(file)) return route.abort();
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ contentType: type, body: await fs.readFile(path.join(root, file)) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => /(shell|home)\.js/.test(error.stack || '') && errors.push(String(error.stack)));
    await page.goto('http://shell-ui.test/');

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
      };
    });
    assert.deepEqual(views, {
      live: 'call', finished10m: 'after', finished3h: 'home', noTranscript: 'home', manualHome: 'home',
      manualAfterKeyChanged: 'call', exactly2h: 'after', justOver2h: 'home', finishedNoLatest: 'home',
      recordingNotLive: 'call', stalled: 'call', paused: 'call', crashed: 'home', keyHolds: true,
      manualAfter3h: 'home', manualAfter10m: 'after',
    });

    const shown = () => page.evaluate(() => ({
      view: document.body.dataset.view,
      workspace: getComputedStyle(document.querySelector('.workspace')).display !== 'none',
      boundaryBar: getComputedStyle(document.querySelector('.meeting-boundary-bar')).display !== 'none',
      home: !document.getElementById('home').hidden,
    }));
    await page.waitForFunction(() => window.appState && document.body.dataset.view === 'call');
    assert.deepEqual(await shown(), { view: 'call', workspace: true, boundaryBar: true, home: false });

    live = false;
    await page.waitForFunction(() => document.body.dataset.view === 'home');
    assert.deepEqual(await shown(), { view: 'home', workspace: false, boundaryBar: false, home: true });
    assert.equal(await page.locator('#home-heading').count(), 1);

    assert.deepEqual(errors, []);
    console.log('Shell UI: viewFor table, call and Home views switch with the state: OK');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error, errors); process.exitCode = 1; });
