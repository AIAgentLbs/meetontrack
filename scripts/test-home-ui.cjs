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
const EMPTY = ['calendar_off', 'calendar_off_with_plans', 'tool_missing', 'no_meetings', 'load_failed'];
const MENU = ['menu_open', 'menu_narrow'];
const START = /^(Начать запись|Start recording)/;
const recordKey = page => page.evaluate(() => (/Mac/.test(navigator.platform) ? 'Meta+Shift+R' : 'Alt+Shift+R'));
const nextClock = page => page.evaluate(() => homeClock(window.agendaData.meetings[0].start));
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const failing = (page, timeout) => page.waitForFunction(() => document.querySelector('#call-status-text').classList.contains('fail'), null, { timeout });
const visibleKbd = locator => locator.evaluate(node => Boolean(node.querySelector('kbd')?.checkVisibility()));
const rowOf = (page, title) => page.locator('#home .row', { has: page.locator('.mtitle', { hasText: title }) });

// Rules for every fixture, width, scheme and language.
async function generic(page, lang, label) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
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
    // The call status stays readable: inside the window, and a line cut short carries the full text in its title.
    const status = document.getElementById('call-status-text');
    const action = document.getElementById('call-status-action');
    const cut = status.scrollWidth > status.clientWidth + 1 || status.scrollHeight > status.clientHeight + 1;
    const bar = { text: status.textContent, inside: [status, action].filter(node => node.checkVisibility())
      .every(node => node.getBoundingClientRect().left >= 0 && node.getBoundingClientRect().right <= width + 0.5),
    titled: !cut || status.title === status.textContent };
    return { scroll: document.documentElement.scrollWidth <= width, spill, clipped, text: document.body.innerText, sizes: [...sizes], torn, bar };
  });
  assert.doesNotMatch(result.bar.text, /Нет свежих реплик|No recent utterances|^$/, `${label}: the bar shows the call status`);
  assert.equal(result.bar.inside, true, `${label}: the call status inside the window`);
  assert.equal(result.bar.titled, true, `${label}: a cut call status has its full text in the title`);
  assert.ok(result.sizes.length <= 1, `${label}: link-style actions differ in size: ${result.sizes}`);
  assert.deepEqual(result.torn, [], `${label}: an e-mail broken inside a piece`);
  assert.equal(result.scroll, true, `${label}: horizontal scroll`);
  assert.deepEqual(result.spill, [], `${label}: content past the window edge`);
  assert.deepEqual(result.clipped, [], `${label}: clipped text`);
  if (lang === 'ru') assert.doesNotMatch(result.text, /[ёЁ]/, `${label}: the letter yo`);
  assert.doesNotMatch(result.text, /—/, `${label}: em-dash`);
}

// At 400 px a row is one column, and the next call's title and time left are on screen without scrolling.
async function narrow(page, label) {
  const columns = await page.locator('#home .row').evaluateAll(rows => rows.map(row => getComputedStyle(row).gridTemplateColumns));
  assert.ok(columns.length && columns.every(value => value.trim().split(/\s+/).length === 1), `${label}: rows in one column: ${columns}`);
  for (const selector of ['.mtitle', '.soon']) {
    const box = await page.locator(`#home .row.next ${selector}`).boundingBox();
    const size = page.viewportSize();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height,
      `${label}: next ${selector} inside the window: ${JSON.stringify(box)}`);
  }
}

// One empty-state block instead of the rows: its title, its line and the given number of actions.
async function emptyState(page, lang, [title, text], actions) {
  const block = page.locator('#home .empty');
  assert.equal(await block.count(), 1);
  assert.equal(await page.locator('#home .row').count(), 0);
  assert.equal(await block.locator('h2').innerText(), title[lang]);
  assert.equal(await block.locator('.state').innerText(), text[lang]);
  assert.equal(await page.locator('#home .empty button, #home .empty a').count(), actions);
  return block;
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
    // The button stays disabled until the agenda is fetched again: a fast second click cannot post twice.
    let reopen;
    page.api.gate = new Promise(resolve => { reopen = resolve; });
    await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/agenda')),
      row.locator('button', { hasText: /Повторить|Retry/ }).click()]);
    assert.equal(await row.locator('button', { hasText: /Повторить|Retry/ }).isDisabled(), true);
    page.api.gate = null;
    reopen();
    await page.waitForFunction(() => !document.querySelector('#home .row.next .actions button:disabled'));
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
  async calendar_off(page, lang) {
    const block = await emptyState(page, lang, [{ ru: 'Календарь не подключен', en: 'The calendar is not connected' },
      { ru: 'Звонки и мемо появятся после подключения.', en: 'Calls and memos appear once it is connected.' }], 1);
    const button = block.locator('button.primary');
    assert.equal(await button.innerText(), lang === 'ru' ? 'Подключить календарь' : 'Connect the calendar');
    await button.click();
    await page.waitForFunction(() => document.querySelector('#project-dialog').open);
    assert.equal(await page.evaluate(() => document.querySelector('#google-context-settings').open), true);
  },
  async calendar_off_with_plans(page, lang) {
    // One calendar block, then the plans without an event under their own heading.
    assert.deepEqual(await page.locator('#home .col > *').evaluateAll(nodes => nodes.map(node => node.className)), ['empty', 'day', 'row']);
    assert.match(await page.locator('#home h2.day').innerText(), /^(Подготовка без события|Preparation without)/);
    assert.equal(await rowOf(page, 'Contract draft review').count(), 1);
    assert.equal(await page.locator('#home .empty button, #home .empty a').count(), 1);
  },
  async tool_missing(page, lang) {
    const block = await emptyState(page, lang, [
      { ru: 'Нет программы для чтения календаря', en: 'The calendar reader is not installed' },
      { ru: 'MeetOnTrack читает Google Календарь через программу gws.', en: 'MeetOnTrack reads Google Calendar through the gws tool.' }], 1);
    const link = block.locator('a.ql');
    assert.deepEqual([await link.innerText(), await link.getAttribute('href'), await link.getAttribute('target'), await link.getAttribute('rel')],
      [lang === 'ru' ? 'Как ее установить' : 'How to install it',
        'https://github.com/AIAgentLbs/meetontrack/blob/main/docs/CONTEXT_SOURCES.md#install-the-calendar-reader-gws', '_blank', 'noopener noreferrer']);
  },
  async no_meetings(page, lang) {
    await emptyState(page, lang, [{ ru: 'Больше звонков сегодня и завтра нет', en: 'No more calls today or tomorrow' },
      { ru: 'Прошедшие звонки - сверху или в меню.', en: 'Past calls are in the top bar and the menu.' }], 0);
  },
  async load_failed(page, lang) {
    const block = await emptyState(page, lang, [{ ru: 'Не удалось загрузить звонки', en: 'Could not load your calls' },
      { ru: 'Попробуем снова сами, или нажмите Повторить.', en: 'We will keep trying, or press Retry.' }], 1);
    // Retry is disabled while it fetches; a failed fetch gives it back, focused.
    const retry = block.locator('button', { hasText: /^(Повторить|Retry)$/ });
    let reopen;
    page.api.gate = new Promise(resolve => { reopen = resolve; });
    await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/agenda')), retry.click()]);
    assert.equal(await retry.isDisabled(), true);
    page.api.gate = null;
    reopen();
    await page.waitForFunction(() => !document.querySelector('#home .empty button:disabled'));
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'empty|reload');
    // A good answer replaces the block with the rows.
    page.api.fixture.agenda = states.ready.agenda;
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/agenda')), retry.click()]);
    await page.locator('#home .row.next').waitFor();
    assert.equal(await page.locator('#home .empty').count(), 0);
  },
  async mic_missing(page, lang) {
    await failing(page);
    const time = await nextClock(page);
    const text = lang === 'ru' ? `Нет доступа к микрофону: запись в ${time} не включится` : `No microphone access: the ${time} call will not be recorded`;
    assert.equal(await page.locator('#call-status-text').innerText(), text);
    const action = page.locator('#call-status-action');
    assert.equal(await action.innerText(), lang === 'ru' ? 'Открыть настройки микрофона' : 'Open microphone settings');
    assert.equal(await action.evaluate(node => node.classList.contains('primary')), true);
    // Start recording is nowhere: not in the bar, the rows, the menu or the getting-started guide.
    assert.equal(await page.getByText(START).filter({ visible: true }).count(), 0);
    assert.equal(await page.locator('#menu-shortcuts').getByText(START).count(), 0);
    await page.locator('#menu-button').click();
    await page.locator('#getting-started-open').click();
    await page.locator('#startup-audio-status').waitFor();
    assert.equal(await page.getByText(START).filter({ visible: true }).count(), 0);
    await page.locator('#getting-started-close').click();
    // The record shortcut posts nothing.
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press(await recordKey(page));
    await page.waitForTimeout(300);
    assert.deepEqual(page.api.posts, []);
    // The action is disabled until its POST and the refresh after it are done: a double click posts once.
    let release;
    page.api.responses['/api/permissions/open'] = new Promise(resolve => { release = resolve; });
    await action.click();
    assert.equal(await action.isDisabled(), true);
    release();
    await page.waitForFunction(() => !document.querySelector('#call-status-action').disabled);
    assert.deepEqual(page.api.posts.map(item => [item.path, item.body]), [['/api/permissions/open', { which: 'microphone' }]]);
    // A failure shows one plain line in the bar until the next poll.
    page.api.responses['/api/permissions/open'] = { status: 500, json: { ok: false, error: 'open_failed' } };
    await action.click();
    const generic = await page.evaluate(() => t('error.generic'));
    await page.waitForFunction(text => document.querySelector('#call-status-text').textContent === text, generic);
    await page.waitForFunction(text => document.querySelector('#call-status-text').textContent === text, text, { timeout: 4000 });
  },
  async mic_missing_delivery(page, lang) {
    // 1024 px: the problem has priority over the delivery pill, the pill shrinks first.
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.locator('#delivery-alert').waitFor();
    await frames(page);
    const wide = await page.evaluate(() => {
      const text = document.getElementById('call-status-text');
      return { cut: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1,
        pill: document.getElementById('delivery-alert').getBoundingClientRect().width < text.getBoundingClientRect().width };
    });
    assert.deepEqual(wide, { cut: false, pill: true }, 'at 1024 the status is whole, the pill narrower');
    // 400 px with the delivery pill: the status reads, its action and Menu stay in the window.
    await page.setViewportSize({ width: 400, height: 900 });
    await page.locator('#delivery-alert').waitFor();
    const fit = await page.evaluate(() => {
      const inside = id => { const box = document.getElementById(id).getBoundingClientRect(); return box.width > 0 && box.left >= 0 && box.right <= innerWidth; };
      const text = document.getElementById('call-status-text');
      return { scroll: document.documentElement.scrollWidth <= innerWidth, text: inside('call-status-text'),
        action: inside('call-status-action'), menu: inside('menu-button'), alert: inside('delivery-alert'),
        wide: text.getBoundingClientRect().width >= 240,
        lines: Math.round(text.getBoundingClientRect().height / parseFloat(getComputedStyle(text).lineHeight)) };
    });
    // The pill does not take the status's room: the status keeps most of the first row.
    assert.deepEqual(fit, { scroll: true, text: true, action: true, menu: true, alert: true, wide: true, lines: fit.lines });
    assert.ok(fit.lines >= 1 && fit.lines <= 2, `status on one or two lines: ${fit.lines}`);
    // Settings open under the taller bar: their header is not covered.
    await page.locator('#menu-button').click();
    await page.locator('#settings-open').click();
    const [bar, heading] = await Promise.all(['.topbar', '#settings-close'].map(selector => page.locator(selector).boundingBox()));
    assert.ok(heading.y >= bar.y + bar.height, `settings below the bar: ${JSON.stringify({ bar, heading })}`);
    await page.locator('#settings-close').click();
    // Back to 1440: the bar shrinks to the height of a fresh 1440 page, and overlays follow it.
    await page.setViewportSize({ width: 1440, height: 900 });
    await frames(page);
    const fresh = await page.context().newPage();
    await fresh.goto(page.url());
    await fresh.locator('#delivery-alert').waitFor();
    await fresh.locator('#call-status-text.fail').waitFor();
    await frames(fresh);
    const height = target => target.evaluate(() => [document.querySelector('.topbar').offsetHeight,
      getComputedStyle(document.querySelector('.settings-panel')).top]);
    assert.deepEqual(await height(page), await height(fresh), 'bar after 400 -> 1440 vs fresh 1440');
    await fresh.close();
  },
  async not_recording(page, lang) {
    await failing(page);
    assert.equal(await page.locator('#call-status-text').innerText(),
      lang === 'ru' ? 'Запись не идет: программа записи не запущена' : 'Not recording: the recorder is not running');
    const fix = lang === 'ru' ? 'Открыть программу записи' : 'Open the recorder';
    assert.equal(await page.locator('#call-status-action').innerText(), fix);
    // The next row puts the fix first, then Start recording, then How to fix; one primary action.
    const row = page.locator('#home .row.next');
    const actions = await row.locator('.actions > *').evaluateAll(nodes => nodes.map(node => [node.textContent, node.className]));
    assert.deepEqual(actions.slice(0, 3), [[fix, 'primary'], [lang === 'ru' ? 'Начать запись' : 'Start recording', ''],
      [lang === 'ru' ? 'Как исправить' : 'How to fix', 'ql']]);
    assert.equal(await row.locator('.actions .primary').count(), 1);
    // The row's fix posts once and disables the bar's copy too.
    let release;
    page.api.responses['/api/getting-started/open-recorder'] = new Promise(resolve => { release = resolve; });
    await row.locator('.actions button.primary').click();
    assert.equal(await page.locator('#call-status-action').isDisabled(), true);
    release();
    await page.waitForFunction(() => !document.querySelector('#call-status-action').disabled);
    assert.deepEqual(page.api.posts.map(item => item.path), ['/api/getting-started/open-recorder']);
    await row.locator('.actions button', { hasText: START }).click();
    await page.waitForFunction(() => !document.querySelector('#home .row.next .actions button:disabled'));
    assert.deepEqual(page.api.posts.map(item => item.path), ['/api/getting-started/open-recorder', '/api/getting-started/start-recording']);
    await row.locator('.actions button.ql', { hasText: /^(Как исправить|How to fix)$/ }).click();
    await page.locator('#getting-started').waitFor({ state: 'visible' });
  },
  async menu_open(page, lang) {
    assert.equal(await page.locator('#app-menu').isVisible(), true);
    assert.equal(await page.locator('#menu-notes').isVisible(), false, 'notes belong to a call');
    const shortcuts = await page.locator('#menu-shortcuts [role="menuitem"]').evaluateAll(nodes =>
      nodes.filter(node => node.checkVisibility()).map(node => [node.querySelector('.mi').textContent, node.querySelector('kbd').textContent]));
    const key = await page.evaluate(() => (/Mac/.test(navigator.platform) ? '⌘⇧R' : 'Alt+Shift+R'));
    assert.deepEqual(shortcuts, lang === 'ru'
      ? [['Открыть мемо следующего звонка', '↵'], ['Начать запись', key], ['Открыть ссылку на звонок', 'J'], ['Не записывать следующий звонок', 'N']]
      : [["Open the next call's memo", '↵'], ['Start recording', key], ['Open the call link', 'J'], ['Do not record the next call', 'N']]);
    assert.equal(await page.locator('#menu-shortcuts').getAttribute('aria-label'), lang === 'ru' ? 'Клавиши' : 'Keys');
    // A change while the menu is open does not rebuild the list under the focused item.
    const link = page.locator('#menu-shortcuts [role="menuitem"]', { hasText: /ссылку|link/ });
    await link.focus();
    await link.evaluate(node => { node.dataset.marked = '1'; });
    page.api.fixture.permissions.microphone = 'denied';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await failing(page, 2000);
    await frames(page);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.marked), '1');
    page.api.fixture.permissions.microphone = 'granted';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => !document.querySelector('#call-status-text').classList.contains('fail'));
    // The items are the shortcuts' actions too: the first opens the next call's memo.
    await page.locator('#menu-shortcuts [role="menuitem"]').first().click();
    assert.equal(await page.locator('#app-menu').isVisible(), false);
    assert.equal(await page.locator('#home .row.next .actions button[aria-controls]').getAttribute('aria-expanded'), 'true');
  },
  async menu_narrow(page) {
    await page.setViewportSize({ width: 400, height: 900 });
    // The menu keeps its key labels in a narrow window.
    assert.equal(await visibleKbd(page.locator('#menu-shortcuts [role="menuitem"]').first()), true);
    assert.equal(await page.locator('.navs').isVisible(), false);
    assert.equal(await page.locator('#app-menu').isVisible(), true);
    for (const id of ['menu-nav-home', 'menu-past-calls']) assert.equal(await page.locator(`#${id}`).isVisible(), true, id);
    const box = await page.locator('#app-menu').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 400 && box.y + box.height <= 900, `the menu fits the window: ${JSON.stringify(box)}`);
  },
  async keys(page, lang) {
    const row = page.locator('#home .row.next');
    const memo = row.locator('.actions button[aria-controls]');
    // Enter on the page opens the next call's memo; Enter in a field or on a button does not.
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Enter');
    assert.equal(await memo.getAttribute('aria-expanded'), 'true');
    // The menu lists only what works now: with the memo open, not Open the next call's memo.
    await page.locator('#menu-button').click();
    assert.equal(await page.locator('#menu-shortcuts').getByText(/мемо|memo/).count(), 0);
    await page.keyboard.press('Escape');
    await memo.click();
    for (const id of ['interface-language', 'question']) {
      await page.evaluate(id => document.getElementById(id).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), id);
    }
    // Nor on a summary or anything that acts as a button.
    await page.evaluate(() => {
      const extra = Object.assign(document.createElement('span'), { tabIndex: 0 });
      extra.setAttribute('role', 'button');
      document.getElementById('home').append(extra);
      for (const node of [document.querySelector('#home .row.next .memo-details summary'), extra]) {
        node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      extra.remove();
    });
    assert.equal(await memo.getAttribute('aria-expanded'), 'false');
    // The record combo never reloads the page: in a field it is swallowed and does nothing else.
    const combo = await page.evaluate(() => {
      const mac = /Mac/.test(navigator.platform);
      const press = node => !node.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'R', shiftKey: true,
        metaKey: mac, altKey: !mac, bubbles: true, cancelable: true }));
      return press(document.getElementById('question'));
    });
    assert.equal(combo, true, 'the record combo in a field is prevented');
    // The record shortcut posts Start recording while waiting.
    page.api.posts.length = 0;
    await page.evaluate(() => document.activeElement.blur());
    await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/getting-started/start-recording')),
      page.keyboard.press(await recordKey(page))]);
    await page.waitForFunction(() => !document.querySelector('#call-status-action').disabled);
    assert.deepEqual(page.api.posts.map(item => item.path), ['/api/getting-started/start-recording']);
    // Not inside an overlay: with settings open nothing fires.
    await page.locator('#menu-button').click();
    await page.locator('#settings-open').click();
    await page.keyboard.press(await recordKey(page));
    await page.keyboard.press('n');
    assert.equal(await page.evaluate(() => {
      const mac = /Mac/.test(navigator.platform);
      return !document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR', key: 'R', shiftKey: true,
        metaKey: mac, altKey: !mac, bubbles: true, cancelable: true }));
    }), true, 'the record combo under an overlay is prevented');
    await page.waitForTimeout(300);
    assert.equal(page.api.posts.length, 1);
    await page.locator('#settings-close').click();
    // The guide's own Start recording follows a permission change while the guide is open.
    await page.locator('#menu-button').click();
    await page.locator('#getting-started-open').click();
    await page.locator('#startup-record').waitFor();
    page.api.fixture.permissions.microphone = 'denied';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#startup-record').waitFor({ state: 'hidden', timeout: 2000 });
    page.api.fixture.permissions.microphone = 'granted';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.locator('#startup-record').waitFor({ timeout: 2000 });
    await page.locator('#getting-started-close').click();
    await page.waitForFunction(() => !document.querySelector('#call-status-text').classList.contains('fail'));
    // J opens the call link in a new tab, N skips the next call.
    await page.context().route('https://example.com/**', route => route.fulfill({ body: 'call' }));
    await page.evaluate(() => document.activeElement.blur());
    const [tab] = await Promise.all([page.context().waitForEvent('page'), page.keyboard.press('j')]);
    assert.equal(tab.url(), 'https://example.com/call/evt-ready');
    await tab.close();
    await page.evaluate(() => document.activeElement.blur());
    await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/agenda/skip-recording')), page.keyboard.press('n')]);
    assert.equal(page.api.posts.at(-1).body.skip, true);
    // Key labels: the bar's Start recording shows its key at 1440, not at 1024; Open memo (primary) keeps it at 1024.
    const start = page.locator('#call-status-action');
    assert.match(await start.innerText(), START);
    assert.equal(await visibleKbd(start), true);
    await page.setViewportSize({ width: 1024, height: 900 });
    assert.equal(await visibleKbd(start), false);
    assert.equal(await visibleKbd(memo), true);
    // Back from System Settings: the permissions are read again at once, not at the next minute's poll.
    page.api.fixture.permissions.microphone = 'denied';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await failing(page, 2000);
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
        try {
          await page.locator('#home :is(.row, .empty)').first().waitFor({ timeout: 5000 });
          if (MENU.includes(fixture)) await page.locator('#menu-button').click();
          for (const width of [1440, 1024, 400]) {
            for (const scheme of ['light', 'dark']) {
              const label = `${fixture}-${width}-${scheme}-${lang}`;
              await page.setViewportSize({ width, height: 900 });
              await page.emulateMedia({ colorScheme: scheme });
              await generic(page, lang, label);
              if (width === 400 && !EMPTY.includes(fixture)) {
                await narrow(page, label);
                // The smallest window the Mac app allows.
                await page.setViewportSize({ width, height: 480 });
                await narrow(page, `${label}-480`);
                await page.setViewportSize({ width, height: 900 });
              }
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
