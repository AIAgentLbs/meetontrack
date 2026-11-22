// Real UI, synthetic API only: interface language in Settings, saved in the shared preferences (config.json) and
// restored after a reload. The After view replaced the two panes (MEETONTRACK-163), so the side-by-side transcript and
// its Hide and Show have no screen left; their checks went with them.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async () => {
  const browser = await chromium.launch({headless: true});
  const root = path.resolve(__dirname, '../copilot/web');
  const errors = [], saved = [];
  let preferences = {interface_language: 'ru'};
  try {
    const context = await browser.newContext({viewport: {width: 1440, height: 900}});
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(String(error)));
    await context.route('http://preferences-ui.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/api/preferences') {
        const change = route.request().postDataJSON();
        saved.push(change);
        preferences = {...preferences, ...change};
        return route.fulfill({json: {ok: true, preferences: change}});
      }
      if (url.pathname === '/api/state') return route.fulfill({json: {preferences,
        // A call that just ended: the After view.
        transcript: {meeting_id: 'test', meeting: 'Test call', status: 'finished', live: false, ended_at: new Date().toISOString(),
          segments: [], speakers: []},
        copilot: {messages: [], busy: false, analysis: {state: 'idle'}}, journal: [], frames: [], meeting_chat: [], project: {}}});
      if (url.pathname.startsWith('/api/')) return route.fulfill({json: {ok: true}});
      const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!['index.html', 'app.js', 'styles.css', 'screens.css', 'home.js', 'call.js', 'after.js', 'shell.js'].includes(file)) return route.abort();
      const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
      return route.fulfill({contentType: type, body: await fs.readFile(path.join(root, file))});
    });
    await page.goto('http://preferences-ui.test/');
    await page.waitForFunction(() => document.documentElement.lang === 'ru');

    // Main screen: no language switch, no helper lines the owner removed.
    assert.equal(await page.locator('header select, header [data-language], header .language-switch').count(), 0,
      'the interface language lives in Settings only, not in the header');
    assert.equal(await page.locator('#new-meeting-help, #copilot-meta, #analysis-status').count(), 0,
      'main screen carries no new-meeting help, AI-context subtitle or analysis status line');

    // Language: one labelled control in Settings, saved to the shared preferences.
    await page.locator('#menu-button').click();
    await page.locator('#settings-open').click();
    const language = page.getByRole('combobox', {name: 'Язык интерфейса', exact: true});
    assert.equal(await language.count(), 1, 'Settings has one labelled interface language control');
    assert.equal(await language.inputValue(), 'ru');
    await language.selectOption('en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.deepEqual(saved, [{interface_language: 'en'}]);
    await page.locator('#settings-close').click();

    // After shows its own view; the old panes and their Show transcript are gone from it.
    assert.equal(await page.locator('#after').isVisible(), true);
    assert.equal(await page.locator('.workspace').isVisible(), false);
    await page.locator('#menu-button').click();
    assert.equal(await page.locator('#transcript-show').isVisible(), false, 'Show transcript has nothing to show in After');
    await page.keyboard.press('Escape');

    // The choice comes back from config.json, even in a browser with no local copy.
    const fresh = await context.newPage();
    fresh.on('pageerror', error => errors.push(String(error)));
    await page.close();
    await fresh.goto('http://preferences-ui.test/');
    await fresh.evaluate(() => localStorage.clear());
    await fresh.reload();
    await fresh.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await fresh.locator('#interface-language').inputValue(), 'en');

    // Another browser changing config.json wins over this browser's earlier choice.
    preferences = {...preferences, interface_language: 'ru'};
    await fresh.reload();
    await fresh.waitForFunction(() => document.documentElement.lang === 'ru');

    // Narrow screen: nothing scrolls sideways.
    await fresh.setViewportSize({width: 390, height: 844});
    assert.equal(await fresh.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    console.log('PASS: no header language switch, no removed helper lines, language in Settings saved and restored, narrow width');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
