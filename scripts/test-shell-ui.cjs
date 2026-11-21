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
      const manual = { view: 'home', key: callKey(finished(ago(10))) };
      return [
        viewFor(liveState, null, now),
        viewFor(finished(ago(10)), null, now),
        viewFor(finished(ago(180)), null, now),
        viewFor({}, null, now),
        viewFor(finished(ago(10)), manual, now),
        viewFor(liveState, manual, now),
      ];
    });
    assert.deepEqual(views, ['call', 'after', 'home', 'home', 'home', 'call']);

    const shown = () => page.evaluate(() => ({
      view: document.body.dataset.view,
      workspace: getComputedStyle(document.querySelector('.workspace')).display !== 'none',
      home: !document.getElementById('home').hidden,
    }));
    await page.waitForFunction(() => window.appState && document.body.dataset.view === 'call');
    assert.deepEqual(await shown(), { view: 'call', workspace: true, home: false });

    live = false;
    await page.waitForFunction(() => document.body.dataset.view === 'home');
    assert.deepEqual(await shown(), { view: 'home', workspace: false, home: true });
    assert.equal(await page.locator('#home-heading').count(), 1);

    assert.deepEqual(errors, []);
    console.log('Shell UI: viewFor table, call and Home views switch with the state: OK');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error, errors); process.exitCode = 1; });
