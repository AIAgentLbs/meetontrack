// Home rows against a fake API: every fixture at 1440, 1024 and 400 px, light and dark, Russian and English,
// with a screenshot of each. The fixtures are built relative to now. Within 40 minutes of midnight the
// next meeting falls on tomorrow: the check then expects it under the Tomorrow heading, not Today.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { states, open, SEAMS, goStale } = require('./home-fixtures.cjs');

const shots = fs.mkdtempSync(path.join(os.tmpdir(), 'home-ui-'));
const scriptErrors = page => page.errors.filter(error => /(shell|home)\.js/.test(error));
const texts = (page, selector) => page.locator(selector).allInnerTexts();
const EMPTY = ['calendar_off', 'calendar_off_with_plans', 'tool_missing', 'no_meetings', 'load_failed'];
const MENU = ['menu_open', 'menu_narrow'];
const OPEN_MEMO = ['ready_memo_open'];
const pressOpenMemo = page => page.locator('#home .row.next .actions button[aria-controls]').click();
const START = /^(Начать запись|Start recording)/;
const recordKey = page => page.evaluate(() => (/Mac/.test(navigator.platform) ? 'Meta+Shift+R' : 'Alt+Shift+R'));
const nextClock = page => page.evaluate(() => homeClock(window.agendaData.meetings[0].start));
const frames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const failing = (page, timeout) => page.waitForFunction(() => document.querySelector('#call-status-text').classList.contains('fail'), null, { timeout });
const visibleKbd = locator => locator.evaluate(node => Boolean(node.querySelector('kbd')?.checkVisibility()));
// The status between 701 and 1200 px: its own row where the bar is squeezed, never cut, never a sideways scroll.
async function readableStatus(page, widths, label) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await frames(page);
    const box = await page.evaluate(() => {
      const text = document.getElementById('call-status-text');
      return { wide: text.getBoundingClientRect().width >= 160, whole: text.scrollWidth <= text.clientWidth + 1 && text.scrollHeight <= text.clientHeight + 1,
        scroll: document.documentElement.scrollWidth <= innerWidth };
    });
    assert.deepEqual(box, { wide: true, whole: true, scroll: true }, `${label} at ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
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
  // R35: "Do not record" is off; the bar, Home and the menu never mention skipping unless a seam switched it on.
  if (!page.api.fixture.agenda?.skip_recording_supported) {
    const skipping = await page.evaluate(() => ['home.skip', 'home.skipped', 'shell.key.skip', 'home.cannot_skip', 'home.recording_active']
      .map(key => t(key)).filter(text => document.body.innerText.includes(text) || document.getElementById('app-menu').textContent.includes(text)));
    assert.deepEqual(skipping, [], `${label}: skipping mentioned`);
    assert.equal(await page.locator('[data-key$="|skip"]').count(), 0, `${label}: a skip control`);
  }
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
    // The title carries the row: the goal reads at regular weight, only its label is bold.
    assert.deepEqual(await row.locator('.goal').evaluate(node => [getComputedStyle(node).fontWeight,
      getComputedStyle(node.firstElementChild).fontWeight, node.firstElementChild.textContent]), ['400', '600', lang === 'ru' ? 'Цель:' : 'Goal:']);
    // Tabs, not links: no underline; the bar under the current one only.
    assert.deepEqual(await page.evaluate(() => ['nav-home', 'archive-button'].map(id => {
      const style = getComputedStyle(document.getElementById(id));
      return [style.textDecorationLine, style.boxShadow !== 'none'];
    })), [['none', true], ['none', false]]);
    assert.equal(await row.locator('.asks li').count(), 3);
    assert.match(await row.locator('.soon').innerText(), /через 40 мин|in 40 min/);
    // The bar: the whole status in a wide window; up to 480 px the short one, so the bar keeps to two rows.
    const time = await nextClock(page);
    const status = page.locator('#call-status-text');
    assert.equal(await status.innerText(), lang === 'ru' ? `Ждет звонка в ${time}, запись включится сама`
      : `Waiting for the ${time} call, recording starts by itself`);
    await page.setViewportSize({ width: 400, height: 900 });
    await page.waitForFunction(text => document.querySelector('#call-status-text').textContent === text,
      lang === 'ru' ? `Ждет звонка в ${time}` : `Waiting for the ${time} call`);
    assert.equal(await status.evaluate(node => Math.round(node.getBoundingClientRect().height / parseFloat(getComputedStyle(node).lineHeight))), 1);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForFunction(() => /,/.test(document.querySelector('#call-status-text').textContent));
    assert.match(await row.locator('.bg').innerText(), /(Откуда это: 2 источника|Where this comes from: 2 sources)$/);
    // Day headings: the next meeting is today unless it crosses midnight; tomorrow's 10:00 meeting is tomorrow.
    const crosses = await page.evaluate(() => new Date(Date.now() + 40 * 60000).getDate() !== new Date().getDate());
    const headings = await texts(page, '#home h2');
    assert.match(headings[0], crosses ? /^(Завтра|Tomorrow), / : /^(Сегодня|Today), /);
    assert.match(headings.at(-1), /^(Завтра|Tomorrow), \S+ \d+ \S+$/);
    // Each meeting is an article titled by its heading, under a day heading.
    assert.equal(await page.locator('#home article.row > h3.mtitle').count(), 3);
    // The call link opens in a new tab and leaks nothing.
    const link = row.locator('.actions a.ql');
    assert.deepEqual([await link.innerText(), await link.getAttribute('href'), await link.getAttribute('target'), await link.getAttribute('rel')],
      [lang === 'ru' ? 'Перейти в звонок' : 'Join the call', 'https://example.com/call/evt-ready', '_blank', 'noopener noreferrer']);
    // An e-mail shows only for someone with neither a name nor a company.
    assert.deepEqual(await texts(page, '#home .row .who'), ['Anna Petrova\nExample LLC', 'Oleg Ivanov', 'nina@example.org']);
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
    assert.equal(order.length, 3, 'sources, Open memo, call link: no Do not record (R35)');
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
    // One sources control at a time: with the memo open its sources list is there, and the digest's link goes.
    assert.equal(await row.locator('.bg button.ql').isVisible(), false);
    await openMemo.click();
    assert.equal(await row.locator('.bg button.ql').isVisible(), true);
  },
  // The opened memo is part of the row: one toggle, real section headings, no repeat of the digest above it,
  // links by their labels only, the materials as plain underlined links.
  async ready_memo_open(page, lang) {
    const row = page.locator('#home .row.next');
    const toggle = row.locator('.actions button[aria-controls]');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    assert.match(await toggle.innerText(), lang === 'ru' ? /^Свернуть мемо/ : /^Hide memo/);
    const panel = page.locator(`#${await toggle.getAttribute('aria-controls')}`);
    assert.equal(await row.locator(`#${await toggle.getAttribute('aria-controls')}`).count(), 1, 'the memo sits in its row');
    const memo = await panel.evaluate(node => {
      const style = getComputedStyle(node);
      const headings = [...node.querySelectorAll('h1, h2, h3, h4, h5, h6')];
      return {
        toggles: node.querySelectorAll('details, summary').length,
        box: style.borderTopStyle !== 'none' || style.backgroundColor !== 'rgba(0, 0, 0, 0)',
        headings: headings.map(item => item.textContent),
        type: [...new Set(headings.map(item => `${getComputedStyle(item).fontSize}/${getComputedStyle(item).fontWeight}/${getComputedStyle(item).textTransform}`))],
        text: node.innerText,
        links: [...node.querySelectorAll('a')].map(item => [item.textContent, item.getAttribute('href'), item.target, item.rel,
          item.classList.contains('ql')]),
        items: [...node.querySelectorAll('li')].map(item => item.textContent),
      };
    });
    assert.equal(memo.toggles, 0, 'no inner disclosure: Open memo is the only toggle');
    assert.equal(memo.box, false, 'no box of its own inside the row');
    // «Откуда это: 2 источника» lands on a section of the same name.
    assert.deepEqual(memo.headings, ['Background', lang === 'ru' ? 'Источники' : 'Sources']);
    assert.deepEqual(memo.type, ['16px/600/none']);
    // R39: only what the digest shows whole is left out. The goal line here says more than the digest's goal (a
    // shortened file digest does the same), so it stays in full; the one question left reads on its own.
    assert.doesNotMatch(memo.text, /What budget|Who signs off|Which part of the proposal|Pilot review/);
    assert.match(memo.text, /^Agree on the pilot scope and the start date with Example LLC\.\n+A fourth question that the digest leaves out\?\n/);
    // The memo writer's format: a bold goal lead and [S1] marks on every line. Lines match without their marks, and
    // each mark is kept for its digest line; a question whose digest line was cut stays.
    assert.deepEqual(await page.evaluate(() => {
      const shown = { lines: ['Agree on the pilot scope and the start date', 'What budget is set for the pilot this year?', 'Who signs off…']
        .map(homeNorm), marks: new Map() };
      const nodes = homeMemoBody([
        '**Meeting goal.** Agree on the pilot scope and the start date [S1]', '', '## Questions to ask',
        '1. What budget is set for the pilot this year? [S1, S2]', '2. Who signs off the purchase? [S2]', '3. Which offices go first? [S1]',
        '', '## Sources', '- [S1] Proposal', '- [S2] Notes'].join('\n'), [], shown);
      return [nodes.map(node => [node.tagName, node.textContent]), [...shown.marks]];
    }), [[['H4', 'Questions to ask'], ['UL', 'Who signs off the purchase? [S2]Which offices go first? [S1]'], ['H4', 'Sources'],
      ['UL', '[S1] Proposal[S2] Notes']],
    [['agree on the pilot scope and the start date', '[S1]'], ['what budget is set for the pilot this year', '[S1, S2]']]]);
    // A section the digest empties goes before a following one is flattened: no Goal heading over the question.
    assert.deepEqual(await page.evaluate(() => homeMemoBody('## Goal\nAgree on scope [S1]\n\n## Questions\n1. What budget? [S1]\n2. Who signs? [S2]',
      [], { lines: ['Agree on scope', 'What budget?'].map(homeNorm), marks: new Map() }).map(node => [node.tagName, node.textContent])), [['P', 'Who signs? [S2]']]);
    // Links: an <https://...> autolink and a destination with balanced parentheses keep their whole address.
    assert.deepEqual(await page.evaluate(() => {
      const node = homeInline(document.createElement('p'), 'See <https://example.org/notes> and [Report](https://example.com/Report_(draft)).');
      return [node.textContent, [...node.querySelectorAll('a')].map(link => link.getAttribute('href'))];
    }), ['See example.org and Report.', ['https://example.org/notes', 'https://example.com/Report_(draft)']]);
    assert.deepEqual(memo.items, []);
    assert.doesNotMatch(memo.text, /The last proposal went out a week ago/, 'the background line is in the digest already');
    assert.match(memo.text, /See the thread/);
    assert.doesNotMatch(memo.text, /https?:|\(|\*\*/, 'no raw URL or Markdown marks');
    assert.deepEqual(memo.links, [
      ['Example LLC', 'https://example.com/llc', '_blank', 'noopener noreferrer', false],
      ['example.org', 'https://example.org/history', '_blank', 'noopener noreferrer', false],
      ['Proposal', 'https://example.com/proposal', '_blank', 'noopener noreferrer', true],
      ['Notes', 'https://example.org/notes', '_blank', 'noopener noreferrer', true]]);
    // The sources look like Join the call.
    const look = selector => page.locator(selector).first().evaluate(node => ['textDecorationLine', 'fontWeight', 'fontSize', 'color']
      .map(key => getComputedStyle(node)[key]).join(' '));
    assert.equal(await look('#home .row.next .memo-details a.ql'), await look('#home .row.next .actions a.ql'));
    // A 100-character source label wraps inside the memo at 400 px: no sideways scroll, the whole label readable.
    const label = 'A very long source label that keeps going so that it never fits on one narrow line of the memo panel';
    page.api.fixture.agenda.meetings[0].plans[0].links.push({ label, url: 'https://example.com/long' });
    await page.evaluate(() => refreshAgenda());
    await panel.locator('a.ql', { hasText: 'A very long' }).waitFor();
    await page.setViewportSize({ width: 400, height: 900 });
    assert.equal(label.length, 100);
    assert.deepEqual(await page.evaluate(() => [document.documentElement.scrollWidth <= innerWidth,
      [...document.querySelectorAll('#home .memo-links a')].at(-1).getBoundingClientRect().right <= innerWidth]), [true, true]);
    // R39 at 400 px: the open memo's row shows its digest unclamped, nothing cut.
    assert.deepEqual(await row.evaluate(node => [...node.querySelectorAll('.goal, .asks li, .bg > span')]
      .map(item => item.scrollHeight <= item.clientHeight + 1 && getComputedStyle(item).webkitLineClamp === 'none')), [true, true, true, true, true]);
    await page.setViewportSize({ width: 1440, height: 900 });
    // A memo from the memo writer: each digest line shows its source marks while the memo is open, not before.
    const plan = page.api.fixture.agenda.meetings[0].plans[0];
    plan.memo_markdown = ['**Meeting goal.** Agree on the pilot scope and the start date [S1]', '', '## Questions to ask',
      '1. What budget is set for the pilot this year? [S1, S2]', '2. Who signs off the purchase? [S2]', '', '## Sources', '- [S1] Proposal'].join('\n');
    await page.evaluate(() => refreshAgenda());
    await row.locator('.goal .marks').waitFor();
    assert.deepEqual(await row.locator('.goal .marks, .asks li .marks').allInnerTexts(), ['[S1]', '[S1, S2]', '[S2]']);
    // Where this comes from with no source links: focus lands on the memo's toggle, never on the page.
    plan.links = [];
    await page.evaluate(() => refreshAgenda());
    await toggle.click();
    assert.equal(await row.locator('.goal .marks').isVisible(), false, 'marks only with the memo open');
    await row.locator('.bg button.ql').focus();
    await page.keyboard.press('Enter');
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true, 'focus on the memo toggle');
    // Hide memo closes it again.
    await toggle.click();
    assert.equal(await panel.isVisible(), false);
    assert.match(await toggle.innerText(), lang === 'ru' ? /^Открыть мемо/ : /^Open memo/);
  },
  async preparing(page, lang) {
    assert.equal(await page.locator('#home .row.next .actions button', { hasText: /Открыть мемо|Open memo/ }).count(), 0);
    // One format on every row: the same bold lead (its start time when known) and the same note.
    // Past 5 minutes the note says it takes longer than usual.
    const lines = await page.locator('#home .row .state').evaluateAll(nodes => nodes.filter(node => node.closest('.row')
      .querySelector('.mtitle').textContent !== 'First talk about the pilot').map(node => [node.querySelector('.lead')?.textContent, node.textContent]));
    const [late, fresh] = await page.evaluate(() => window.agendaData.meetings.slice(0, 2).map(item => homeClock(item.memo.since)));
    assert.deepEqual(lines, lang === 'ru' ? [
      [`Мемо готовится с ${late},`, `Мемо готовится с ${late}, дольше обычного. Появится здесь само.`],
      [`Мемо готовится с ${fresh},`, `Мемо готовится с ${fresh}, обычно 2-3 минуты. Появится здесь само.`],
      ['Мемо готовится,', 'Мемо готовится, обычно 2-3 минуты. Появится здесь само.']] : [
      [`Memo in progress since ${late},`, `Memo in progress since ${late}, longer than usual. It will appear here by itself.`],
      [`Memo in progress since ${fresh},`, `Memo in progress since ${fresh}, usually 2-3 minutes. It will appear here by itself.`],
      ['Memo in progress,', 'Memo in progress, usually 2-3 minutes. It will appear here by itself.']]);
    // The lead is plain text in the text colour: the title carries the row.
    assert.deepEqual(await page.locator('#home .row .state .lead').first().evaluate(node => [getComputedStyle(node).fontWeight,
      getComputedStyle(node).color === getComputedStyle(node.closest('.row').querySelector('.mtitle')).color]), ['400', true]);
    // The note ages on the 30 s tick, in place: a fresh row turns late past 5 minutes and focus stays where it was.
    const link = page.locator('#home .row.next .actions a.ql');
    await link.focus();
    await link.evaluate(node => { node.dataset.marked = '1'; });
    await page.evaluate(() => renderHome(window.agendaData, window.appState, Date.now() + 4 * 60000));
    assert.match(await page.locator('#home .row .state').nth(1).innerText(), /дольше обычного|longer than usual/);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.marked), '1', 'focus stays on the call link');
  },
  // R37: each label names its destination, and the destination carries the same name.
  async nothing_found(page, lang) {
    const row = page.locator('#home .row.next');
    assert.deepEqual(await row.locator('.actions > *').evaluateAll(nodes => nodes.map(node => [node.textContent, node.className])),
      lang === 'ru' ? [['Подключить почту', ''], ['Подключить папку', 'ql'], ['Перейти в звонок', 'ql']]
        : [['Connect mail', ''], ['Connect a folder', 'ql'], ['Join the call', 'ql']]);
    const onScreen = selector => page.locator(selector).evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.checkVisibility() && box.top >= document.querySelector('.topbar').getBoundingClientRect().bottom && box.bottom <= innerHeight;
    });
    // The calendar row says only what is missing (the calendar itself works: the meeting is on Home).
    assert.equal(await row.locator('.state').innerText(), lang === 'ru' ? 'О собеседнике в ваших источниках пока ничего нет.'
      : 'Nothing about this contact in your sources yet.');
    // Connect mail: Settings at the Google section, named after mail. The calendar is read, so Google is connected:
    // focus goes to the Mail box, on screen. Escape closes Settings and focus comes back to Connect mail.
    const connect = row.locator('.actions button', { hasText: /^(Подключить почту|Connect mail)$/ });
    // A click that does not focus the button (WebKit, the macOS app): Escape still returns focus to it.
    await connect.evaluate(node => node.click());
    await page.locator('#settings-panel').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.matches('#google-sources input[value="gmail"]'));
    assert.equal(await onScreen('#google-sources input[value="gmail"]'), true, 'the Mail box is on screen');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-panel').isVisible(), false);
    assert.equal(await connect.evaluate(node => node === document.activeElement), true, 'focus back on Connect mail');
    // Settings from Menu after that deep link open at their top, with the focused heading on screen.
    await page.locator('#menu-button').click();
    await page.locator('#settings-open').click();
    await page.waitForFunction(() => document.activeElement?.id === 'settings-heading');
    assert.equal(await onScreen('#settings-heading'), true, 'the Settings heading is on screen');
    await page.keyboard.press('Escape');
    // Google signed out since: the plain sign-in step, Connect Google, on screen also in a 400 x 480 window.
    await page.setViewportSize({ width: 400, height: 480 });
    await page.route('**/api/google-context', route => route.fulfill({ json: { ok: true, connected: false, client_configured: true, sources: {} } }));
    await connect.click();
    await page.waitForFunction(() => document.activeElement?.id === 'google-connect');
    assert.equal(await onScreen('#google-connect'), true, 'Connect Google is on screen');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    // First time, no Google profile chosen: the documented first step is the own OAuth client under Report storage
    // and delivery (docs/DELIVERY.md); focus goes to its account choice, on screen.
    await page.unroute('**/api/google-context');
    await page.route('**/api/google-context', route => route.fulfill({ json: { ok: true, connected: false, client_configured: false, profile: '', sources: {} } }));
    await connect.click();
    await page.waitForFunction(() => document.activeElement?.id === 'delivery-profile');
    assert.equal(await onScreen('#delivery-profile'), true, 'the Google account choice is on screen');
    await page.keyboard.press('Escape');
    // A named gws profile whose sign-in is not set up: the line that says so, focused on the gws guide link.
    await page.unroute('**/api/google-context');
    await page.route('**/api/google-context', route => route.fulfill({ json: { ok: true, connected: false, client_configured: false, profile: 'work', sources: {} } }));
    await connect.click();
    await page.waitForFunction(() => document.activeElement?.closest('#google-account'));
    assert.deepEqual(await page.evaluate(() => [document.getElementById('google-account').textContent, document.activeElement.getAttribute('href')]),
      [lang === 'ru' ? 'Чтобы войти в Google, сначала один раз настройте программу gws от Google, это около 5 минут. Как настроить'
        : 'Signing in to Google needs a one-time setup of gws, a program from Google, about 5 minutes. How to set it up',
      `https://github.com/AIAgentLbs/meetontrack/blob/main/docs/CONTEXT_SOURCES.md#${lang === 'ru' ? 'ru-calendar' : 'install-the-calendar-reader-gws'}`]);
    assert.equal(await page.locator('#google-context-settings > summary').innerText(),
      lang === 'ru' ? 'Google: почта, календарь, файлы' : 'Google: mail, calendar, files');
    assert.equal(await page.locator('#google-sources label', { has: page.locator('input[value="gmail"]') }).innerText(),
      lang === 'ru' ? 'Почта (Gmail)' : 'Mail (Gmail)');
    assert.doesNotMatch(await page.locator('#google-context-settings').innerText(), /LLM|A1:Z80|−90/);
    // Mail gives a snippet, Docs give the excerpts that match: the limits say so, not "the start".
    assert.match(await page.locator('[data-i18n="google.limits"]').innerText(), lang === 'ru'
      ? /только заголовки и короткий отрывок письма.*подходящие отрывки документа/ : /headers and snippets.*relevant excerpts of a document/);
    await page.locator('#settings-close').click();
    // Connect a folder: the folders dialog, titled as the menu item, focused on Choose folder; usable without a recording.
    await row.locator('.actions a.ql, .actions button.ql').filter({ hasText: /^(Подключить папку|Connect a folder)$/ }).click();
    await page.waitForFunction(() => document.getElementById('project-dialog').open && document.activeElement?.id === 'context-folder-choose');
    assert.equal(await page.locator('#project-dialog h2').innerText(), lang === 'ru' ? 'Папки с файлами' : 'File folders');
    await page.waitForFunction(() => !/Загружаю|Loading/.test(document.getElementById('project-help').textContent));
    assert.equal(await page.locator('#project-help').innerText(), lang === 'ru'
      ? 'Проект для звонка можно выбрать, когда идет запись. Папки подключаются в любое время.'
      : 'You can choose a project for the call while it is recorded. Folders can be connected at any time.');
    assert.doesNotMatch(await page.locator('#project-dialog').innerText(), /—|Контекст этой встречи|Context for this meeting/);
  },
  async failed(page, lang) {
    const row = page.locator('#home .row.next');
    const line = await row.locator('.state').innerText();
    assert.match(line, lang === 'ru' ? /Мемо не получилось: ИИ не ответил\./ : /Memo not ready: the AI did not answer\./);
    assert.match(line, lang === 'ru' ? /Ничего делать не нужно, попробуем снова в \d\d:\d\d\./ : /Nothing to do, we will try again at \d\d:\d\d\./);
    // No AI chosen: nothing will retry by itself, so no promise of a retry.
    const choice = await rowOf(page, 'Pilot follow-up').locator('.state').innerText();
    assert.match(choice, /не выбран ИИ|no AI is chosen/);
    assert.doesNotMatch(choice, /Ничего делать не нужно|Nothing to do/);
    // Retrying cannot help without a chosen AI: the only action is Choose the AI.
    assert.deepEqual(await rowOf(page, 'Pilot follow-up').locator('.actions button').allInnerTexts(),
      [lang === 'ru' ? 'Выбрать ИИ' : 'Choose the AI']);
    // Nothing to do here: one quiet Retry now link at most, no Check the AI, then the call's own actions.
    assert.deepEqual(await row.locator('.actions > *').evaluateAll(nodes => nodes.map(node => [node.textContent, node.className])),
      lang === 'ru' ? [['Повторить сейчас', 'ql'], ['Перейти в звонок', 'ql']] : [['Retry now', 'ql'], ['Join the call', 'ql']]);
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
    await rowOf(page, 'Pilot follow-up').locator('button', { hasText: /^(Выбрать ИИ|Choose the AI)$/ }).evaluate(node => node.click());
    await page.locator('#getting-started').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#startup-ai-heading').evaluate(node => {
      const box = node.getBoundingClientRect();
      return box.top >= document.querySelector('.topbar').getBoundingClientRect().bottom && box.bottom <= innerHeight;
    }), true, 'the AI step is on screen');
    // Focus goes to the AI step's heading, which the step's refresh does not replace; Escape closes the guide and
    // focus comes back to Choose the AI (clicked without focus, as in WebKit).
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'startup-ai-heading');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#getting-started').isVisible(), false);
    assert.match(await page.evaluate(() => document.activeElement.textContent), /^(Выбрать ИИ|Choose the AI)$/);
  },
  async skipped(page, lang) {
    const row = page.locator('#home .row.next');
    // The next call to record is tomorrow's: the bar says tomorrow, also in its short form.
    const time = await page.evaluate(() => homeClock(window.agendaData.meetings[1].start));
    await page.waitForFunction(text => document.querySelector('#call-status-text').textContent === text, lang === 'ru'
      ? `Ждет звонка завтра в ${time}, запись включится сама` : `Waiting for tomorrow's ${time} call, recording starts by itself`);
    await page.setViewportSize({ width: 400, height: 900 });
    await page.waitForFunction(text => document.querySelector('#call-status-text').textContent === text,
      lang === 'ru' ? `Ждет звонка завтра в ${time}` : `Waiting for tomorrow's ${time} call`);
    await page.setViewportSize({ width: 1440, height: 900 });
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
    // A solo block without a plan is not a call: no row. One that carries a plan stays.
    assert.equal(await rowOf(page, 'Focus time').count(), 0);
    assert.equal(await rowOf(page, 'Example LLC sync').count(), 1);
    const unscheduled = rowOf(page, 'Contract draft review');
    assert.equal(await unscheduled.count(), 1);
    assert.match(await page.locator('#home h2').last().innerText(), /^(Подготовка без события в календаре|Preparation without a calendar event)$/);
    const lefts = await Promise.all([unscheduled, row].map(item => item.locator('.mtitle').evaluate(node => node.getBoundingClientRect().left)));
    assert.equal(lefts[0], lefts[1], 'an unscheduled title sits in the title column');
    await unscheduled.locator('button', { hasText: /Открыть мемо|Open memo/ }).click();
    const panel = page.locator(`#${await unscheduled.locator('button').getAttribute('aria-controls')}`);
    assert.match(await panel.innerText(), /Check the draft before sending it\./);
    assert.ok((await panel.boundingBox()).width > 300, 'the opened memo is as wide as the title column');
  },
  // A refresh failed after the rows loaded: the rows stay with one quiet line saying since when, and Retry.
  async stale(page, lang) {
    const line = page.locator('#home .stale');
    const time = await page.evaluate(() => homeClock(window.agendaLoadedAt));
    assert.equal(await line.innerText(), lang === 'ru' ? `Не удалось обновить звонки, показаны данные на ${time}. Повторить`
      : `Could not refresh your calls, showing them as of ${time}. Retry`);
    assert.equal(await page.locator('#home .row').count(), 3, 'the rows stay');
    assert.equal(await page.locator('#home .col > *').first().evaluate(node => node.classList.contains('stale')), true, 'the line comes first');
    assert.equal(await page.locator('#home .empty').count(), 0);
    // Retry: busy while it fetches; a good answer removes the line.
    const retry = line.locator('button');
    let reopen;
    page.api.gate = new Promise(resolve => { reopen = resolve; });
    page.api.fixture.agenda = states.ready.agenda;
    await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/agenda')), retry.click()]);
    assert.equal(await retry.isDisabled(), true);
    page.api.gate = null;
    reopen();
    await line.waitFor({ state: 'detached' });
    assert.equal(await page.locator('#home .row').count(), 3);
  },
  // Test seam: the skip code kept for MEETONTRACK-173, switched on by the fixture (never shipped in this release).
  async skip_seam(page, lang) {
    const row = page.locator('#home .row.next');
    // A stale agenda disables the actions that depend on current event times, until a refresh succeeds.
    await goStale(page);
    assert.equal(await row.locator('button.quiet').isDisabled(), true, 'no Do not record on stale times');
    page.api.fixture.agenda = states.skip_seam.agenda;
    await page.evaluate(() => refreshAgenda());
    await page.locator('#home .stale').waitFor({ state: 'detached' });
    assert.equal(await row.locator('button.quiet').isDisabled(), false);
    // Keys: N skips the next call, and the menu lists it.
    await page.locator('#menu-button').click();
    assert.match(await page.locator('#menu-shortcuts').innerText(), /Не записывать следующий звонок|Do not record the next call/);
    await page.keyboard.press('Escape');
    page.api.responses['/api/agenda/skip-recording'] = { status: 409, json: { ok: false, error: 'recorder_cannot_skip' } };
    await page.evaluate(() => document.activeElement.blur());
    await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/agenda/skip-recording')), page.keyboard.press('n')]);
    await row.locator('.row-error').waitFor();
    page.api.posts.length = 0;
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
    // A recording started meanwhile (the server knows it before Home does): the row says how to skip the call.
    page.api.responses['/api/agenda/skip-recording'] = { status: 409, json: { ok: false, error: 'recording_active' } };
    await row.locator('button.quiet').click();
    await page.waitForFunction(() => /Сейчас идет запись|recording is in progress/.test(document.querySelector('#home .row.next .row-error')?.textContent));
    assert.equal(await row.locator('.row-error').innerText(), lang === 'ru'
      ? 'Сейчас идет запись. Остановите ее, чтобы не записывать звонок.'
      : 'A recording is in progress. Stop it first to skip this call.');
    delete page.api.responses['/api/agenda/skip-recording'];
    // R32: while any recording runs, Home offers no Do not record, for the call on now or one that has not started.
    const next = page.api.fixture.agenda.meetings[0];
    page.api.fixture.state = { ...page.api.fixture.state,
      transcript: { meeting_id: 'm1', meeting: 'Pilot review', status: 'recording', live: true, segments: [], speakers: [],
        started_at: new Date(Date.now() - 40 * 60000).toISOString() },
      recording_health: { checked_at: Date.now() / 1000 + 60, capture: { state: 'recording', audio_recording: true } } };
    await page.waitForFunction(() => document.body.dataset.view === 'call');
    await page.locator('#nav-home').click();
    for (const minutes of [-2, 3]) {
      Object.assign(next, { start: new Date(Date.now() + minutes * 60000).toISOString(), end: new Date(Date.now() + (minutes + 30) * 60000).toISOString() });
      await page.evaluate(() => refreshAgenda());
      await page.waitForFunction(minutes => (minutes < 0 ? /идет сейчас|on now/ : /через|in /)
        .test(document.querySelector('#home .row.next .soon')?.textContent), minutes);
      assert.equal(await row.locator('button.quiet').count(), 0, `no Do not record during a recording (${minutes} min)`);
    }
    // Undo of a skip stays during a recording.
    next.skip_recording = true;
    await page.evaluate(() => refreshAgenda());
    await row.locator('[data-key$="|skip"]').waitFor();
    assert.equal(await row.locator('[data-key$="|skip"]').innerText(), lang === 'ru' ? 'Вернуть' : 'Undo');
  },
  async calendar_off(page, lang) {
    const block = await emptyState(page, lang, [{ ru: 'Календарь не подключен', en: 'The calendar is not connected' },
      { ru: 'Звонки и мемо появятся после подключения.', en: 'Calls and memos appear once it is connected.' }], 1);
    const button = block.locator('button.primary');
    assert.equal(await button.innerText(), lang === 'ru' ? 'Подключить календарь' : 'Connect the calendar');
    // The calendar settings sit low in a short window: they are scrolled into view.
    await page.setViewportSize({ width: 1024, height: 550 });
    await button.click();
    await page.locator('#settings-panel').waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => document.querySelector('#project-dialog').open), false);
    const calendarBox = await page.locator('#google-sources input[value="calendar"]').evaluate(node => {
      const box = node.getBoundingClientRect();
      return node.checkVisibility() && box.top >= document.querySelector('.topbar').getBoundingClientRect().bottom && box.bottom <= innerHeight;
    });
    assert.equal(calendarBox, true, 'the Calendar checkbox is on screen in Settings');
  },
  async calendar_off_with_plans(page, lang) {
    // One calendar block, then the plans without an event under their own heading.
    assert.deepEqual(await page.locator('#home .col > *').evaluateAll(nodes => nodes.map(node => node.className)), ['empty', 'day', 'row']);
    assert.match(await page.locator('#home h2.day').innerText(), /^(Подготовка без события в календаре|Preparation without a calendar event)$/);
    assert.equal(await rowOf(page, 'Contract draft review').count(), 1);
    assert.equal(await page.locator('#home .empty button, #home .empty a').count(), 1);
  },
  async tool_missing(page, lang) {
    const block = await emptyState(page, lang, [
      { ru: 'Нет программы для чтения календаря', en: 'The calendar reader is not installed' },
      { ru: 'Чтобы читать Google Календарь, нужна программа gws от Google.', en: 'To read Google Calendar, MeetOnTrack needs gws, a program from Google.' }], 2);
    const link = block.locator('a.ql');
    assert.deepEqual([await link.innerText(), await link.getAttribute('href'), await link.getAttribute('target'), await link.getAttribute('rel')],
      [lang === 'ru' ? 'Как ее установить' : 'How to install it',
        `https://github.com/AIAgentLbs/meetontrack/blob/main/docs/CONTEXT_SOURCES.md#${lang === 'ru' ? 'ru-calendar' : 'install-the-calendar-reader-gws'}`,
        '_blank', 'noopener noreferrer']);
    // The Russian step exists in the repo doc under that anchor.
    const doc = fs.readFileSync(path.join(__dirname, '../docs/CONTEXT_SOURCES.md'), 'utf8');
    assert.match(doc, /<a id="ru-calendar"><\/a>\n## [^\n]*[А-я]/);
    // Installed it: Check again reads the calendar again, no restart.
    const again = block.locator('button');
    assert.deepEqual([await again.innerText(), await again.getAttribute('class')], [lang === 'ru' ? 'Проверить снова' : 'Check again', '']);
    await Promise.all([page.waitForRequest(request => request.url().endsWith('/api/agenda')), again.click()]);
  },
  async no_meetings(page, lang) {
    await emptyState(page, lang, [{ ru: 'Больше звонков сегодня и завтра нет', en: 'No more calls today or tomorrow' },
      { ru: 'Прошедшие звонки - вверху.', en: 'Past calls are in the top bar.' }], 0);
    // No next call: the bar does not wait for one.
    assert.equal(await page.locator('#call-status-text').innerText(),
      lang === 'ru' ? 'Запись включится сама, когда начнется звонок' : 'Recording starts by itself when a call begins');
    // Up to 700 px the past calls are in the menu, and the line says so.
    await page.setViewportSize({ width: 400, height: 900 });
    assert.equal(await page.locator('#home .empty .state').innerText(), lang === 'ru' ? 'Прошедшие звонки - в меню.' : 'Past calls are in the menu.');
    await page.setViewportSize({ width: 1440, height: 900 });
  },
  async load_failed(page, lang) {
    const block = await emptyState(page, lang, [{ ru: 'Не удалось загрузить звонки', en: 'Could not load your calls' },
      { ru: 'Попробуем снова через минуту или нажмите Повторить.', en: 'We will try again in a minute, or press Retry.' }], 1);
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
    // The calendar could not be read: not "no calls", the same block with Retry.
    page.api.fixture.agenda = { ...states.no_meetings.agenda, calendar_state: 'failed' };
    await page.evaluate(() => refreshAgenda());
    await page.locator('#home .empty').waitFor();
    await emptyState(page, lang, [{ ru: 'Не удалось загрузить звонки', en: 'Could not load your calls' },
      { ru: 'Попробуем снова через минуту или нажмите Повторить.', en: 'We will try again in a minute, or press Retry.' }], 1);
    // Today loaded, tomorrow did not: today's rows stay, tomorrow says it could not be loaded, with Retry.
    const tomorrow = new Date(Date.now() + 24 * 3600000);
    const day = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth() + 1).padStart(2, '0')}-${String(tomorrow.getDate()).padStart(2, '0')}`;
    page.api.fixture.agenda = { ...states.ready.agenda, calendar_state: 'failed', failed_days: [day] };
    await page.evaluate(() => refreshAgenda());
    await page.locator('#home .row.next').waitFor();
    const partial = await page.evaluate(() => [...document.querySelectorAll('#home .col > *')].map(node =>
      node.matches('h2.day') ? 'day' : node.matches('.row') ? 'row' : node.matches('.empty') ? 'failed' : node.tagName));
    assert.ok(partial.includes('row') && partial.at(-1) === 'failed' && partial.at(-2) === 'day', JSON.stringify(partial));
    assert.equal(await page.locator('#home .empty button').innerText(), lang === 'ru' ? 'Повторить' : 'Retry');
    // The failed day goes in place by the local date of the headings, also for a call written in another offset:
    // today failed, tomorrow 00:30 local loaded (its ISO text carries a date that is still today at -10:00).
    const local = ms => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
    const at = new Date(); at.setDate(at.getDate() + 1); at.setHours(0, 30, 0, 0);
    const minus10 = ms => `${new Date(ms - 10 * 3600000).toISOString().slice(0, 19)}-10:00`;
    const late = { ...states.ready.agenda.meetings[0], event_id: 'evt-late', start: minus10(at.getTime()), end: minus10(at.getTime() + 30 * 60000) };
    const order = () => page.evaluate(() => [...document.querySelectorAll('#home .col > *')].map(node =>
      node.matches('h2.day') ? node.textContent : node.matches('.row') ? 'row' : node.matches('.empty') ? 'failed' : node.tagName));
    page.api.fixture.agenda = { ...states.ready.agenda, meetings: [late], unscheduled_plans: [], calendar_state: 'failed', failed_days: [local(Date.now())] };
    await page.evaluate(() => refreshAgenda());
    await page.waitForFunction(() => document.querySelectorAll('#home .row').length === 1);
    let shown = await order();
    assert.ok(/Сегодня|Today/.test(shown[0]) && shown[1] === 'failed' && /Завтра|Tomorrow/.test(shown[2]) && shown[3] === 'row', JSON.stringify(shown));
    // Only the failed day changes (the same row): Home redraws with the retry under the right date.
    page.api.fixture.agenda = { ...page.api.fixture.agenda, failed_days: [local(at.getTime())] };
    await page.evaluate(() => refreshAgenda());
    await page.waitForFunction(() => document.querySelector('#home .col > :last-child')?.matches('.empty'));
    shown = await order();
    assert.ok(/Завтра|Tomorrow/.test(shown[0]) && shown[1] === 'row' && shown.at(-1) === 'failed', JSON.stringify(shown));
  },
  async mic_missing(page, lang) {
    await failing(page);
    const time = await nextClock(page);
    // macOS (this fixture): the call audio is still recorded, only the owner's voice is lost.
    const text = lang === 'ru' ? `Нет доступа к микрофону: ваш голос в звонке в ${time} не запишется`
      : `No microphone access: your voice in the ${time} call will not be recorded`;
    await page.waitForFunction(text => document.querySelector('#call-status-text').textContent === text, text);
    // At 400 px a problem keeps its consequence: the whole text, wrapped, none of it cut.
    await page.setViewportSize({ width: 400, height: 900 });
    await frames(page);
    assert.deepEqual(await page.locator('#call-status-text').evaluate(node => [node.textContent,
      node.scrollHeight <= node.clientHeight + 1 && node.scrollWidth <= node.clientWidth + 1]), [text, true]);
    // 1024 px: the outlined memo button keeps its ↵ (Enter still opens it).
    await page.setViewportSize({ width: 1024, height: 900 });
    assert.equal(await visibleKbd(page.locator('#home .row.next .actions button[aria-controls]')), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    // The bar's fix is the one filled button: the row's Open memo is outlined, and ↵ still opens it.
    const memo = page.locator('#home .row.next .actions button[aria-controls]');
    assert.equal(await memo.getAttribute('class'), '');
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Enter');
    assert.equal(await memo.getAttribute('aria-expanded'), 'true');
    await memo.click();
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
    // The pill names the problem in a few words and never cuts them; the meeting is named in the dialog it opens.
    const pill = page.locator('#delivery-alert');
    await pill.waitFor();
    // Windows (this fixture): a denied microphone means the recording does not start.
    const time = await nextClock(page);
    await page.waitForFunction(text => document.querySelector('#call-status-text').textContent === text, lang === 'ru'
      ? `Нет доступа к микрофону: запись в ${time} не включится` : `No microphone access: the ${time} call will not be recorded`);
    for (const width of [1440, 1024, 960, 760, 400]) {
      await page.setViewportSize({ width, height: 900 });
      await frames(page);
      assert.deepEqual(await pill.evaluate(node => [node.textContent, node.scrollWidth <= node.clientWidth + 1 && node.scrollHeight <= node.clientHeight + 1]),
        [lang === 'ru' ? 'Проверить отправку отчета' : 'Review failed delivery', true], `pill at ${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 900 });
    const plural = await page.evaluate(() => {
      const item = n => ({ meeting_id: `m${n}`, channels: ['email'], title: 'Pilot review', started_at: new Date().toISOString() });
      const shown = [2, 5, 21].map(count => {
        renderDeliveryHealth({ ...deliveryHealth, undelivered: Array.from({ length: count }, (_, index) => item(index)) });
        return document.getElementById('delivery-alert').textContent;
      });
      for (const extra of [{ uncertain: true }, { missing: true }, { failed: { reason: 'pdf' } }, { failed: { fallback: 'html' } }, { final_wait: { state: 'waiting' } }]) {
        renderDeliveryHealth({ ...deliveryHealth, undelivered: [{ ...item(1), ...extra }] });
        shown.push(document.getElementById('delivery-alert').textContent);
      }
      // MEETONTRACK-189 step 7: a problem the person can fix says what and offers the fix; no minutes.
      renderDeliveryHealth({ ...deliveryHealth, undelivered: [{ ...item(1), final_wait: { state: 'missing', reason: 'capture_permission', permission: 'call_audio' } }] });
      shown.push(document.getElementById('delivery-alert').textContent);
      const row = document.querySelector('#delivery-undelivered .delivery-undelivered');
      shown.push([row.querySelector('.delivery-reason').textContent, row.querySelector('button')?.textContent || '']);
      renderDeliveryHealth({ ...deliveryHealth, undelivered: [{ ...item(1), final_wait: { state: 'missing', reason: 'final_transcript' } }] });
      shown.push(document.querySelector('#delivery-undelivered .delivery-undelivered').textContent);
      renderDeliveryHealth(window.appState.delivery);
      return shown;
    });
    const many = (more) => lang === 'ru' ? `Не отправлены: «Pilot review», «Pilot review»${more ? ` и еще ${more}` : ''}`
      : `Not sent: “Pilot review”, “Pilot review”${more ? ` and ${more} more` : ''}`;
    assert.deepEqual(plural.slice(0, 8), [many(0), many(3), many(19), ...(lang === 'ru'
      ? ['Отчет мог не дойти', 'Отчет не найден', 'Отчет не создан', 'PDF отчета не создан', 'Нет итоговой расшифровки']
      : ['Report may not have arrived', 'Report not found', 'Report not created', 'Report PDF not created', 'No final transcript'])]);
    assert.equal(plural[8], lang === 'ru' ? 'Встреча не записалась' : 'Meeting not recorded');
    assert.match(plural[9][0], lang === 'ru' ? /нет разрешения на запись системного звука/ : /no permission to record system audio/);
    assert.equal(plural[9][1], lang === 'ru' ? 'Открыть разрешение' : 'Open the permission');
    assert.match(plural[10], lang === 'ru' ? /трижды пыталось сделать итоговую расшифровку/ : /tried three times to make the final transcript/);
    assert.doesNotMatch(plural[10], /\d+ (мин|min)/, 'never elapsed minutes');
    await pill.click();
    await page.locator('#archive-dialog').waitFor({ state: 'visible' });
    assert.match(await page.locator('#archive-dialog').innerText(), lang === 'ru' ? /Отчет по встрече «Pilot review» от \d+ \S+ не отправлен/
      : /Report for “Pilot review” on \S+ \S+ was not sent/);
    await page.locator('#archive-close').click();
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
    await readableStatus(page, [701, 760, 860, 900, 960, 1024, 1120, 1200], 'problem with the delivery pill');
    // The status on its own row: Menu opens under the whole bar, not over the status action.
    for (const width of [760, 960]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('#menu-button').click();
      const [bar, menuBox, action] = await Promise.all(['.topbar', '#app-menu', '#call-status-action'].map(selector => page.locator(selector).boundingBox()));
      assert.ok(menuBox.y >= bar.y + bar.height && menuBox.y >= action.y + action.height, `menu under the bar at ${width}`);
      await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 1440, height: 900 });
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
    // The pill sits on Menu's row, not on a row of its own.
    const [pillBox, menuBox] = await Promise.all(['#delivery-alert', '#menu-button'].map(selector => page.locator(selector).boundingBox()));
    assert.ok(Math.abs(pillBox.y + pillBox.height / 2 - (menuBox.y + menuBox.height / 2)) < 4, `pill beside Menu: ${JSON.stringify({ pillBox, menuBox })}`);
    // Settings open under the taller bar: their header is not covered.
    await page.locator('#menu-button').click();
    await page.locator('#settings-open').click();
    const [bar, heading] = await Promise.all(['.topbar', '#settings-close'].map(selector => page.locator(selector).boundingBox()));
    assert.ok(heading.y >= bar.y + bar.height, `settings below the bar: ${JSON.stringify({ bar, heading })}`);
    await page.locator('#settings-close').click();
    // A setup blocker above the bar pushes it down: Settings still open below the bar, and follow it back up.
    const settingsUnderBar = async () => {
      await page.locator('#menu-button').click();
      await page.locator('#settings-open').click();
      await frames(page);
      const [bar, close] = await Promise.all(['.topbar', '#settings-close'].map(selector => page.locator(selector).boundingBox()));
      await page.locator('#settings-close').click();
      return { below: close.y >= bar.y + bar.height, gap: Math.round(close.y - (bar.y + bar.height)) };
    };
    await page.evaluate(() => { const banner = document.getElementById('blocker-banner'); banner.textContent = 'Example blocker line'; banner.hidden = false; });
    const blocked = await settingsUnderBar();
    assert.equal(blocked.below, true, `settings below the bar under a blocker: ${JSON.stringify(blocked)}`);
    await page.evaluate(() => { document.getElementById('blocker-banner').hidden = true; });
    assert.deepEqual(await settingsUnderBar(), { below: true, gap: blocked.gap }, 'without the blocker the panel follows the bar up');
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
    // The pill keeps one width with and without a recording problem.
    const pillWidths = async () => {
      const widths = {};
      for (const width of [400, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await frames(page);
        widths[width] = await page.locator('#delivery-alert').evaluate((node, width) => width === 400
          ? Math.round(node.getBoundingClientRect().width) : getComputedStyle(node).maxWidth, width);
      }
      return widths;
    };
    const withProblem = await pillWidths();
    page.api.fixture.permissions.microphone = 'granted';
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => !document.querySelector('#call-status-text').classList.contains('fail'));
    assert.deepEqual(withProblem, await pillWidths(), 'pill width with and without a problem');
  },
  async not_recording(page, lang) {
    await failing(page);
    assert.equal(await page.locator('#call-status-text').innerText(),
      lang === 'ru' ? 'Запись не идет: программа записи не запущена' : 'Not recording: the recorder is not running');
    await readableStatus(page, [701, 760, 860, 900, 960, 1024, 1120], 'not recording');
    const fix = lang === 'ru' ? 'Открыть программу записи' : 'Open the recorder';
    assert.equal(await page.locator('#call-status-action').innerText(), fix);
    // R34: the bar owns the call status, with How to fix beside its button. The row keeps its memo actions only.
    const help = page.locator('#call-status-help');
    assert.equal(await help.innerText(), lang === 'ru' ? 'Как исправить' : 'How to fix');
    const [action, beside] = await Promise.all([page.locator('#call-status-action').boundingBox(), help.boundingBox()]);
    assert.ok(beside.x >= action.x + action.width && Math.abs(beside.y + beside.height / 2 - (action.y + action.height / 2)) < 4,
      `How to fix beside the bar's button: ${JSON.stringify({ action, beside })}`);
    const row = page.locator('#home .row.next');
    const actions = await row.locator('.actions > *').evaluateAll(nodes => nodes.map(node => [node.textContent.replace('↵', ''), node.className]));
    assert.deepEqual(actions, lang === 'ru'
      ? [['Открыть мемо', ''], ['Перейти в звонок', 'ql']] : [['Open memo', ''], ['Join the call', 'ql']]);
    // One filled button on screen while the bar shows a problem: the memo is outlined and keeps its ↵.
    assert.equal(await row.locator('.actions button[aria-controls] kbd').innerText(), '↵');
    assert.equal(await page.locator('#home').getByText(fix).count(), 0, 'the fix is not repeated in the row');
    // The bar's fix posts once while it is in flight.
    let release;
    page.api.responses['/api/getting-started/open-recorder'] = new Promise(resolve => { release = resolve; });
    await page.locator('#call-status-action').click();
    assert.equal(await page.locator('#call-status-action').isDisabled(), true);
    await page.locator('#call-status-action').click({ force: true });
    release();
    await page.waitForFunction(() => !document.querySelector('#call-status-action').disabled);
    assert.deepEqual(page.api.posts.map(item => item.path), ['/api/getting-started/open-recorder']);
    // At 400 px How to fix stays beside the button, inside the window.
    await page.setViewportSize({ width: 400, height: 900 });
    const narrowBoxes = await Promise.all([page.locator('#call-status-action').boundingBox(), help.boundingBox()]);
    assert.ok(narrowBoxes[1].x + narrowBoxes[1].width <= 400 && Math.abs(narrowBoxes[1].y - narrowBoxes[0].y) < 20,
      `How to fix at 400: ${JSON.stringify(narrowBoxes)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
    await help.click();
    await page.locator('#getting-started').waitFor({ state: 'visible' });
    // How to fix lands on the recording step, focused on its button.
    await page.waitForFunction(() => document.activeElement?.id === 'startup-recorder');
    assert.equal(await page.locator('#startup-audio-heading').evaluate(node => node.getBoundingClientRect().top
      >= document.querySelector('.topbar').getBoundingClientRect().bottom), true, 'the recording step is on screen');
    await page.keyboard.press('Escape');
    assert.equal(await help.evaluate(node => node === document.activeElement), true, 'focus back on How to fix');
  },
  async menu_open(page, lang) {
    assert.equal(await page.locator('#app-menu').isVisible(), true);
    // The first visible item has no divider over it (the hidden navigation group leaves none behind).
    const first = await page.locator('#app-menu').evaluate(menu => {
      const shown = [...menu.children].filter(node => node.checkVisibility());
      return [shown[0].tagName, getComputedStyle(shown[0]).borderTopStyle];
    });
    assert.deepEqual(first, ['BUTTON', 'none']);
    // One name for the menu item and the dialog it opens; no tool words in the subtitle.
    assert.deepEqual([await page.locator('#repo-button .mi > span').innerText(), await page.locator('#repo-button small').innerText()],
      lang === 'ru' ? ['Папки с файлами', 'на компьютере и в Google Диске'] : ['File folders', 'on this computer and in Google Drive']);
    assert.equal(await page.locator('#menu-notes').isVisible(), false, 'notes belong to a call');
    const shortcuts = await page.locator('#menu-shortcuts [role="menuitem"]').evaluateAll(nodes =>
      nodes.filter(node => node.checkVisibility()).map(node => [node.querySelector('.mi').textContent, node.querySelector('kbd').textContent]));
    const key = await page.evaluate(() => (/Mac/.test(navigator.platform) ? '⌘⇧R' : 'Alt+Shift+R'));
    assert.deepEqual(shortcuts, lang === 'ru'
      ? [['Открыть мемо следующего звонка', '↵'], ['Начать запись', key], ['Перейти в звонок', 'J']]
      : [["Open the next call's memo", '↵'], ['Start recording', key], ['Join the call', 'J']]);
    assert.equal(await page.locator('#menu-shortcuts').getAttribute('aria-label'), lang === 'ru' ? 'Клавиши' : 'Keys');
    // Settings from the menu take focus (their heading); Escape closes them and Menu gets focus back.
    await page.locator('#settings-open').click();
    await page.waitForFunction(() => document.activeElement?.id === 'settings-heading');
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-panel').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'menu-button');
    await page.locator('#menu-button').click();
    // A change while the menu is open does not rebuild the list under the focused item.
    const link = page.locator('#menu-shortcuts [role="menuitem"]', { hasText: /Перейти|Join/ });
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
    // Focus moves to the fold button: Enter again folds, and once more opens.
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-controls')), await memo.getAttribute('aria-controls'));
    await page.keyboard.press('Enter');
    assert.equal(await memo.getAttribute('aria-expanded'), 'false');
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
    // Nor on anything that acts as a button.
    await page.evaluate(() => {
      const extra = Object.assign(document.createElement('span'), { tabIndex: 0 });
      extra.setAttribute('role', 'button');
      document.getElementById('home').append(extra);
      for (const node of [extra]) {
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
    // J opens the call link in a new tab; N does nothing while "Do not record" is off (R35).
    await page.context().route('https://example.com/**', route => route.fulfill({ body: 'call' }));
    await page.evaluate(() => document.activeElement.blur());
    const [tab] = await Promise.all([page.context().waitForEvent('page'), page.keyboard.press('j')]);
    assert.equal(tab.url(), 'https://example.com/call/evt-ready');
    await tab.close();
    await page.evaluate(() => document.activeElement.blur());
    const posted = page.api.posts.length;
    await page.keyboard.press('n');
    await page.waitForTimeout(300);
    assert.equal(page.api.posts.length, posted, 'N posts nothing');
    // Key labels: the bar's Start recording shows its key at 1440, not at 1024; Open memo (primary) keeps it at 1024.
    const start = page.locator('#call-status-action');
    assert.match(await start.innerText(), START);
    assert.equal(await visibleKbd(start), true);
    await page.setViewportSize({ width: 1024, height: 900 });
    assert.equal(await visibleKbd(start), false);
    assert.equal(await visibleKbd(memo), true);
    // Back from System Settings: the permissions are read again at once, not at the next minute's poll.
    page.api.fixture.permissions.microphone = 'denied';
    const reads = page.api.permissionReads.length;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await failing(page, 2000);
    // That read asks for a fresh answer (the server drops its cache); the polls keep the cache.
    assert.ok(page.api.permissionReads.slice(reads).includes('?fresh=1'), JSON.stringify(page.api.permissionReads));
    // A window covered by System Settings may never turn hidden: coming back to it (focus) reads them fresh too.
    page.api.fixture.permissions.microphone = 'granted';
    const focusReads = page.api.permissionReads.length;
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => !document.querySelector('#call-status-text').classList.contains('fail'), null, { timeout: 2000 });
    assert.equal(page.api.permissionReads.slice(focusReads).filter(query => query === '?fresh=1').length, 1,
      `focus and visibilitychange together read once: ${JSON.stringify(page.api.permissionReads)}`);
    assert.equal(page.api.permissionReads[0], '');
  },
  async long(page, lang) {
    // Past calls opened from Home take its place: in a short window their controls are on screen, and Home closes them.
    await page.setViewportSize({ width: 1024, height: 550 });
    await page.locator('#archive-button').click();
    await page.locator('#archive-dialog').waitFor({ state: 'visible' });
    const library = await page.evaluate(() => ({ home: document.getElementById('home').checkVisibility(),
      controls: ['#archive-search', '#archive-close'].every(selector => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return box.height > 0 && box.top >= 0 && box.bottom <= innerHeight;
      }) }));
    assert.deepEqual(library, { home: false, controls: true }, 'past calls replace Home at 1024x550');
    await page.locator('#nav-home').click();
    await page.locator('#archive-dialog').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#home .row.next').isVisible(), true);
    await page.setViewportSize({ width: 1440, height: 900 });
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

    // HOME_UI_ONLY=ready,load_failed runs only those fixtures (while working on them).
    const only = process.env.HOME_UI_ONLY?.split(',');
    for (const fixture of Object.keys(states).filter(name => !only || only.includes(name))) {
      for (const lang of ['ru', 'en']) {
        // The ready check reads today's wording and the preparing one moves its clock 4 minutes on: their fixture and
        // page clocks are pinned to today's noon (any run time).
        // HOME_UI_AT=HH:MM pins it elsewhere (to see the check at another hour).
        const pin = new Date();
        const [hours, minutes] = (process.env.HOME_UI_AT || '12:00').split(':').map(Number);
        pin.setHours(hours, minutes, 0, 0);
        const page = await open(browser, { fixture, lang, at: ['ready', 'preparing'].includes(fixture) ? pin.getTime() : null });
        await page.waitForFunction(lang => document.documentElement.lang === lang, lang);
        try {
          await page.locator('#home :is(.row, .empty)').first().waitFor({ timeout: 5000 });
          if (MENU.includes(fixture)) await page.locator('#menu-button').click();
          if (OPEN_MEMO.includes(fixture)) await pressOpenMemo(page);
          if (fixture === 'stale') await goStale(page);
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
          await frames(page); // the bar's short-text media query re-renders on the next frame, not at once
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
