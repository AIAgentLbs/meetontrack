// Home rows against a fake API: every fixture at 1440, 1024 and 400 px, light and dark, Russian and English,
// with a screenshot of each. The fixtures are built relative to now. Within 40 minutes of midnight the
// next meeting falls on tomorrow: the check then expects it under the Tomorrow heading, not Today.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { states, open } = require('./home-fixtures.cjs');

const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'home-ui-'));
const scriptErrors = page => page.errors.filter(error => /(shell|home)\.js/.test(error));
const texts = (page, selector) => page.locator(selector).allInnerTexts();
const rowOf = (page, title) => page.locator('#home .row', { has: page.locator('.mtitle', { hasText: title }) });

// Rules for every fixture, width, scheme and language.
async function generic(page, lang, label) {
  const result = await page.evaluate(() => {
    const home = document.getElementById('home');
    const width = innerWidth;
    const spill = [...home.querySelectorAll('*')].filter(node => node.getClientRects().length
      && node.getBoundingClientRect().right > width + 0.5).map(node => node.className || node.tagName);
    const clipped = [...home.querySelectorAll('.mtitle, .goal, .asks li, .bg, .who, .state, .time, .soon')]
      .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className);
    // Link-style actions on one line share one size and line height.
    const sizes = new Set([...home.querySelectorAll('.actions :is(a.ql, button.ql, button.quiet)')]
      .map(node => `${getComputedStyle(node).fontSize}/${getComputedStyle(node).lineHeight}`));
    // An e-mail wraps only after @ or a dot: no text piece of it is split across lines.
    const range = document.createRange();
    const torn = [...home.querySelectorAll('.who b, .who span')].filter(node => node.textContent.includes('@'))
      .flatMap(node => [...node.childNodes].filter(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim()))
      .filter(child => { range.selectNodeContents(child); return range.getClientRects().length > 1; })
      .map(child => child.textContent);
    return { scroll: document.documentElement.scrollWidth <= width, spill, clipped, text: document.body.innerText, sizes: [...sizes], torn };
  });
  assert.ok(result.sizes.length <= 1, `${label}: link-style actions differ in size: ${result.sizes}`);
  assert.deepEqual(result.torn, [], `${label}: an e-mail broken inside a piece`);
  assert.equal(result.scroll, true, `${label}: horizontal scroll`);
  assert.deepEqual(result.spill, [], `${label}: content past the window edge`);
  assert.deepEqual(result.clipped, [], `${label}: clipped text`);
  if (lang === 'ru') assert.doesNotMatch(result.text, /[ёЁ]/, `${label}: the letter yo`);
  assert.doesNotMatch(result.text, /—/, `${label}: em-dash`);
}

const checks = {
  async ready(page, lang) {
    const row = page.locator('#home .row.next');
    // The past-calls panel opens only by hand: a fresh Home does not show it.
    assert.equal(await page.locator('#archive-dialog').isVisible(), false);
    // Whole hours read without "0 min".
    assert.deepEqual(await page.evaluate(() => [120, 125].map(minutes =>
      homeTimeLeft({ start: new Date(Date.now() + minutes * 60000).toISOString() }, Date.now()))),
    lang === 'ru' ? ['через 2 ч', 'через 2 ч 5 мин'] : ['in 2 h', 'in 2 h 5 min']);
    // Reading order is time, title, people, digest; at desktop width the people still sit in the right column.
    assert.deepEqual(await row.evaluate(node => [...node.querySelectorAll('.time, .mtitle, .who, .goal, .actions')].map(item => item.className)),
      ['time', 'mtitle', 'who', 'goal', 'actions']);
    const [title, who] = await Promise.all([row.locator('.mtitle').boundingBox(), row.locator('.who').boundingBox()]);
    assert.ok(who.x >= title.x + title.width && Math.abs(who.y - title.y) < 8, `who beside the title: ${JSON.stringify({ title, who })}`);
    assert.match(await row.locator('.goal').innerText(), /^(Цель|Goal): Agree on the pilot scope/);
    assert.equal(await row.locator('.asks li').count(), 3);
    assert.match(await row.locator('.soon').innerText(), /через 40 мин|in 40 min/);
    assert.match(await row.locator('.bg').innerText(), /(Откуда это: 2 источника|Where this comes from: 2 sources)$/);
    // Day headings: the next meeting is today unless it crosses midnight; tomorrow's 10:00 meeting is tomorrow.
    const crosses = new Date(Date.now() + 40 * 60000).getDate() !== new Date().getDate();
    const headings = await texts(page, '#home h2');
    assert.match(headings[0], crosses ? /^(Завтра|Tomorrow), / : /^(Сегодня|Today), /);
    assert.match(headings.at(-1), /^(Завтра|Tomorrow), \S+ \d+ \S+$/);
    // Each meeting is an article titled by its heading, under a day heading.
    assert.equal(await page.locator('#home article.row > h3.mtitle').count(), 3);
    // The call link opens in a new tab and leaks nothing.
    const link = row.locator('a.ql');
    assert.deepEqual([await link.getAttribute('href'), await link.getAttribute('target'), await link.getAttribute('rel')],
      ['https://example.com/call/evt-ready', '_blank', 'noopener noreferrer']);
    // Keyboard: the row's controls follow one another in Tab order, as they read.
    const order = await row.evaluate(node => [...node.querySelectorAll('a, button')].filter(item => item.checkVisibility())
      .map(item => item.textContent.replace('↵', '').trim()));
    await row.locator('.bg button.ql').focus();
    const tabbed = [];
    for (let index = 1; index < order.length; index += 1) {
      await page.keyboard.press('Tab');
      tabbed.push(await page.evaluate(() => document.activeElement.textContent.replace('↵', '').trim()));
    }
    assert.deepEqual(tabbed, order.slice(1));
    assert.equal(order.length, 4);
    // Open memo: primary with the key label on the next row, plain on the others, toggles the full memo.
    const openMemo = row.locator('.actions button[aria-controls]');
    assert.match(await openMemo.innerText(), /^(Открыть мемо|Open memo)/);
    assert.equal(await openMemo.evaluate(node => node.classList.contains('primary') && node.querySelector('kbd').textContent), '↵');
    assert.equal(await openMemo.getAttribute('aria-expanded'), 'false');
    const panel = page.locator(`#${await openMemo.getAttribute('aria-controls')}`);
    assert.equal(await panel.isVisible(), false);
    await openMemo.click();
    assert.equal(await openMemo.getAttribute('aria-expanded'), 'true');
    assert.equal(await panel.evaluate(node => node.classList.contains('memo-details') && node.checkVisibility()), true);
    assert.match(await openMemo.innerText(), /Свернуть мемо|Hide memo/);
    // The page polls every 2.5 s: with unchanged data the same button keeps focus and the memo stays open.
    await openMemo.focus();
    await openMemo.evaluate(node => { node.dataset.marked = '1'; });
    await page.waitForTimeout(6000);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.marked), '1');
    assert.equal(await panel.isVisible(), true);
    // Where this comes from: opens the memo on its sources.
    await openMemo.click();
    await row.locator('.bg button.ql').click();
    assert.equal(await panel.isVisible(), true);
    assert.equal(await page.evaluate(() => document.activeElement.href), 'https://example.com/proposal');
    // Do not record: posts the choice; a 409 keeps the row as it was and says why.
    page.api.responses['/api/agenda/skip-recording'] = { status: 409, json: { ok: false, error: 'recorder_cannot_skip' } };
    await row.locator('button.quiet').click();
    await row.locator('.row-error').waitFor();
    assert.match(await row.locator('.row-error').innerText(),
      lang === 'ru' ? /^Программа записи не умеет пропускать звонок\. Обновите приложение\.$/ : /^The recorder cannot skip a call\. Update the app\.$/);
    assert.equal(await row.locator('button.quiet').count(), 1);
    const post = page.api.posts.find(item => item.path === '/api/agenda/skip-recording');
    assert.deepEqual(Object.keys(post.body).sort(), ['end', 'event_id', 'skip', 'start', 'title']);
    assert.equal(post.body.skip, true);
    assert.equal(post.body.event_id, 'evt-ready');
  },
  async preparing(page, lang) {
    const status = page.locator('#home .row.next [role="status"]');
    assert.match(await status.innerText(), lang === 'ru' ? /с \d\d:\d\d,/ : /since \d\d:\d\d,/);
    assert.equal(await page.locator('#home .row.next .actions button', { hasText: /Открыть мемо|Open memo/ }).count(), 0);
    // No start time known: one sentence-case line.
    assert.equal(await rowOf(page, 'Example LLC sync').locator('.state').innerText(),
      lang === 'ru' ? 'Мемо готовится, обычно 2-3 минуты.' : 'Memo in progress, usually 2-3 minutes.');
  },
  async nothing_found(page) {
    const button = page.locator('#home .row.next .actions button', { hasText: /почт.*пап|mail.*folder/i });
    assert.equal(await button.count(), 1);
    await button.click();
    await page.waitForFunction(() => document.querySelector('#project-dialog').open);
    assert.equal(await page.evaluate(() => document.querySelector('#google-context-settings').open), true);
  },
  async failed(page, lang) {
    const row = page.locator('#home .row.next');
    const line = await row.locator('.state').innerText();
    assert.match(line, lang === 'ru' ? /Мемо не получилось: ИИ не ответил\./ : /The memo could not be made: the AI did not answer\./);
    assert.match(line, lang === 'ru' ? /Ничего делать не нужно, попробуем снова в \d\d:\d\d\./ : /Nothing to do, we will try again at \d\d:\d\d\./);
    // No AI chosen: nothing will retry by itself, so no promise of a retry.
    const choice = await rowOf(page, 'Pilot follow-up').locator('.state').innerText();
    assert.match(choice, /не выбран ИИ|no AI is chosen/);
    assert.doesNotMatch(choice, /Ничего делать не нужно|Nothing to do/);
    // Retrying cannot help without a chosen AI: the only action is Check the AI.
    assert.deepEqual(await rowOf(page, 'Pilot follow-up').locator('.actions button').allInnerTexts(),
      [lang === 'ru' ? 'Проверить ИИ' : 'Check the AI']);
    // A second click while the POST is in flight posts nothing more.
    let release;
    page.api.responses['/api/memo/rebuild'] = new Promise(resolve => { release = resolve; });
    const retry = row.locator('button', { hasText: /Повторить|Retry/ });
    await retry.click();
    await page.waitForFunction(() => document.querySelector('#home .row.next .actions button:disabled'));
    assert.equal(await retry.isDisabled(), true);
    release();
    await page.waitForFunction(() => !document.querySelector('#home .row.next .actions button:disabled'));
    delete page.api.responses['/api/memo/rebuild'];
    page.api.posts.length = 0;
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/memo/rebuild')),
      row.locator('button', { hasText: /Повторить|Retry/ }).click()]);
    assert.deepEqual(page.api.posts.filter(item => item.path === '/api/memo/rebuild').map(item => item.body), [{ event_id: 'evt-failed' }]);
    // A failed retry is not success: the row keeps its state and says so.
    page.api.responses['/api/memo/rebuild'] = { status: 500, json: { ok: false, error: 'boom' } };
    await row.locator('button', { hasText: /Повторить|Retry/ }).click();
    await row.locator('.row-error').waitFor();
    assert.match(await row.locator('.row-error').innerText(), /^(Не получилось\. Попробуйте еще раз\.|That did not work\. Try again\.)$/);
    assert.match(await row.locator('.state').first().innerText(), /ИИ не ответил|the AI did not answer/);
    const check = row.locator('button.ql', { hasText: /^(Проверить ИИ|Check the AI)$/ });
    await check.click();
    await page.locator('#getting-started').waitFor({ state: 'visible' });
  },
  async skipped(page) {
    const row = page.locator('#home .row.next');
    assert.match(await row.locator('.status-text').innerText(), /^(Этот звонок не будет записан|This call will not be recorded)$/);
    assert.equal(await row.locator('button.quiet').count(), 0);
    // A dropped connection on Undo: the row stays skipped and says it did not work.
    let release;
    page.api.responses['/api/agenda/skip-recording'] = new Promise(resolve => { release = resolve; });
    await row.locator('button', { hasText: /^(Вернуть|Undo)$/ }).click();
    assert.equal(await row.locator('button', { hasText: /^(Вернуть|Undo)$/ }).isDisabled(), true);
    release('abort');
    await row.locator('.row-error').waitFor();
    assert.equal(await row.locator('.status-text').count(), 1);
    delete page.api.responses['/api/agenda/skip-recording'];
    await row.locator('button', { hasText: /^(Вернуть|Undo)$/ }).click();
    await page.waitForFunction(() => !document.querySelector('#home .row.next .row-error'));
    const bodies = page.api.posts.filter(item => item.path === '/api/agenda/skip-recording').map(item => item.body.skip);
    assert.deepEqual(bodies, [false, false]);
  },
  async adapter(page) {
    const row = page.locator('#home .row.next');
    assert.match(await row.locator('.goal').innerText(), /: Agree on the pilot scope and the start date with Example LLC\.$/);
    assert.deepEqual(await texts(page, '#home .row.next .asks li'), ['What budget is set for the pilot this year?',
      'Who signs off the purchase?', 'Which part of the proposal matters most now?']);
    assert.match(await row.locator('.bg').innerText(), /(2 источника|2 sources)$/);
    assert.match(await rowOf(page, 'Pilot follow-up').locator('.state').innerText(), /О собеседнике|Nothing about this contact/);
    assert.equal(await rowOf(page, 'Focus time').locator('.state, .goal').count(), 0);
    const unscheduled = rowOf(page, 'Contract draft review');
    assert.equal(await unscheduled.count(), 1);
    assert.match(await page.locator('#home h2').last().innerText(), /Подготовка без события|Preparation without/);
    const lefts = await Promise.all([unscheduled, row].map(item => item.locator('.mtitle').evaluate(node => node.getBoundingClientRect().left)));
    assert.equal(lefts[0], lefts[1], 'an unscheduled title sits in the title column');
    await unscheduled.locator('button', { hasText: /Открыть мемо|Open memo/ }).click();
    const panel = page.locator(`#${await unscheduled.locator('button').getAttribute('aria-controls')}`);
    assert.match(await panel.innerText(), /Check the draft before sending it\./);
    assert.ok((await panel.boundingBox()).width > 300, 'the opened memo is as wide as the title column');
  },
  async no_skip_support(page) {
    assert.equal(await page.locator('#home .row.next .goal').count(), 1);
    assert.equal(await page.locator('#home').getByText(/Не записывать|Do not record/).count(), 0);
  },
  async long(page, lang) {
    // Ten attendees: three by name, then one muted line with the rest, the whole list in its tooltip.
    const who = page.locator('#home .row.next .who');
    assert.equal(await who.locator('b').count(), 3);
    const more = who.locator('.more');
    assert.equal(await more.innerText(), lang === 'ru' ? 'и еще 7' : 'and 7 more');
    const title = (await more.getAttribute('title')).split(', ');
    assert.equal(title.length, 10);
    assert.equal(title[9], 'Participant Number10 Longsurname');
    // The goal and each question keep two lines in the digest; the full text stays in the DOM for the memo.
    for (const selector of ['.goal', '.asks li']) {
      const box = await page.locator(`#home .row.next ${selector}`).first().evaluate(node => ({
        lines: node.clientHeight / parseFloat(getComputedStyle(node).lineHeight), cut: node.scrollHeight > node.clientHeight + 1 }));
      assert.ok(box.lines <= 2.05 && box.cut, `${selector} clamped to two lines: ${JSON.stringify(box)}`);
    }
    assert.ok((await page.locator('#home .row.next .goal').textContent()).length > 300);
    // The background keeps two lines too; Where this comes from stays visible after it.
    const background = await page.locator('#home .row.next .bg').evaluate(node => {
      const text = node.querySelector('span');
      const button = node.querySelector('button');
      return { lines: text.clientHeight / parseFloat(getComputedStyle(text).lineHeight), cut: text.scrollHeight > text.clientHeight + 1,
        height: getComputedStyle(node).lineHeight, shown: button.checkVisibility() && button.getBoundingClientRect().bottom <= node.getBoundingClientRect().bottom + 1 };
    });
    assert.ok(background.lines <= 2.05 && background.cut && background.shown, `.bg clamped, sources shown: ${JSON.stringify(background)}`);
    assert.equal(parseFloat(background.height), 20.3);
  },
};

(async () => {
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  try {
    // Not loaded yet is not empty: while /api/agenda is pending, Home shows no rows and no empty-state text.
    let release;
    const pending = await open(browser, { fixture: 'ready', gate: new Promise(resolve => { release = resolve; }) });
    await pending.waitForFunction(() => window.appState && document.body.dataset.view === 'home');
    assert.equal(await pending.locator('#home :is(.row, h2, p, li, button)').count(), 0);
    release();
    await pending.locator('#home .row').first().waitFor();
    await pending.context().close();

    for (const fixture of Object.keys(states)) {
      for (const lang of ['ru', 'en']) {
        const page = await open(browser, { fixture, lang });
        await page.waitForFunction(lang => document.documentElement.lang === lang, lang);
        await page.locator('#home .row').first().waitFor();
        try {
          for (const width of [1440, 1024, 400]) {
            for (const scheme of ['light', 'dark']) {
              const label = `${fixture}-${width}-${scheme}-${lang}`;
              await page.setViewportSize({ width, height: 900 });
              await page.emulateMedia({ colorScheme: scheme });
              await generic(page, lang, label);
              await page.screenshot({ path: path.join(shots, `${label}.png`), fullPage: true });
            }
          }
          await page.setViewportSize({ width: 1440, height: 900 });
          await page.emulateMedia({ colorScheme: 'light' });
          await checks[fixture](page, lang);
          assert.deepEqual(scriptErrors(page), []);
        } catch (error) {
          failures.push(`${fixture} ${lang}: ${error.message}`);
        }
        await page.context().close();
      }
    }
    // The time left moves on every 30 s without a poll changing anything, and focus stays put.
    // Page time starts 10 min 15 s before the next call, so 30 s later "11 min" becomes "10 min".
    const timed = await open(browser, { fixture: 'ready', clock: 29 * 60000 + 45000 });
    try {
      const soon = timed.locator('#home .row.next .soon');
      await soon.waitFor();
      assert.equal(await soon.innerText(), 'через 11 мин');
      const button = timed.locator('#home .row.next .actions button[aria-controls]');
      await button.focus();
      await button.evaluate(node => { node.dataset.marked = '1'; });
      await timed.clock.runFor(30000);
      await timed.waitForFunction(() => document.querySelector('#home .row.next .soon').textContent === 'через 10 мин');
      assert.equal(await timed.evaluate(() => document.activeElement.dataset.marked), '1');
    } catch (error) {
      failures.push(`clock: ${error.message}`);
    }
    await timed.context().close();
    assert.deepEqual(failures, []);
    console.log(`Screenshots: ${shots}`);
    console.log('Home UI: rows, memo states, actions, failures, polling keeps focus, 1440/1024/400, light/dark, RU/EN: OK');
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); console.error(`Screenshots: ${shots}`); process.exitCode = 1; });
