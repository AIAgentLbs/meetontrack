// Real UI files, synthetic API only. A question from the other side is waiting and the urgent
// analysis request lands inside the server's 15 s gap (skipped). Both sides then go quiet, so
// the transcript does not change: the page still asks again once the gap has passed, on its
// existing poll, and stops asking once the question is gone.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const root = path.resolve(__dirname, '../copilot/web');
  const asks = [];
  let heard = { text: 'What budget is set for the pilot this year?', speaker: 'Anna Petrova', at: '2026-10-22T10:01:00+00:00' };
  const state = () => ({
    preferences: { interface_language: 'en' }, journal: [], frames: [], project: {}, call_plan: null,
    transcript: { meeting_id: 't', meeting: 'Pilot review', status: 'recording', live: true,
      started_at: '2026-10-22T10:00:00Z', latest_at: '2026-10-22T10:01:00+00:00', speakers: [],
      segments: [{ source: 'system', speaker: 'Anna Petrova', text: heard?.text || 'Thanks.', timestamp: '2026-10-22T10:01:00+00:00' }] },
    recording_health: { capture: { audio_recording: true } }, meeting_chat: [],
    copilot: { busy: false, analysis: { state: 'idle' }, messages: [] },
    fact_checks: { web: true, items: [] }, heard_question: heard,
  });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.route('http://heard-retry.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/state') return route.fulfill({ json: state() });
      if (url.pathname === '/api/analyze') {
        asks.push(route.request().postDataJSON());
        // The first lands inside the server's gap (skipped); the later ones run.
        return route.fulfill({ json: asks.length === 1 ? { ok: true, skipped: true } : { ok: true, answer: '' } });
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill({ json: { ok: true } });
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (file.includes('/') || !/\.(html|js|css)$/.test(file)) return route.abort();
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({ contentType: type, body: await fs.readFile(path.join(root, file)) });
    });
    const page = await context.newPage();
    page.on('pageerror', error => /app\.js/.test(error.stack || '') && errors.push(String(error.stack)));
    await page.clock.install();
    await page.goto('http://heard-retry.test/');
    await page.waitForFunction(() => document.readyState === 'complete');
    const settle = async ms => { await page.clock.runFor(ms); await page.waitForTimeout(50); };

    await settle(3000);
    assert.equal(asks.length, 1, 'the new question asks at once');
    assert.deepEqual(asks[0], { force: false, urgent: true });

    await settle(10000);  // 13 s after the skip: the gap has not passed, the transcript is unchanged
    assert.equal(asks.length, 1, 'no request inside the gap');

    await settle(5000);  // 18 s: the gap has passed and the question still waits
    assert.equal(asks.length, 2, 'asks again once the gap has passed');
    assert.deepEqual(asks[1], { force: false, urgent: true });

    heard = null;  // the analysis took it up (or it aged out)
    await settle(40000);
    assert.equal(asks.length, 2, 'no retry without a waiting question');

    // B4: a provisional line became final with the same start time, so the transcript key did not change; the
    // server now offers it as heard, and the page asks at once.
    heard = { text: 'Who signs off the purchase?', speaker: 'Anna Petrova', at: '2026-10-22T10:01:00+00:00' };
    await settle(3000);
    assert.equal(asks.length, 3, 'a question that became final asks at once');
    assert.deepEqual(asks[2], { force: false, urgent: true });
    assert.deepEqual(errors, []);
    console.log('heard-retry: ok');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
