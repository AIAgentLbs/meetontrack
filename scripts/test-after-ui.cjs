// The After view against a fake API. Task 5: the pure functions of after.js (board, send state, times),
// evaluated on the `draft` page so they run with the real translations. Task 6: the view itself.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { build, open, NAMES } = require('./after-fixtures.cjs');

async function functions(browser) {
  const page = await open(browser, { fixture: 'draft', lang: 'en' });
  await page.waitForFunction(() => typeof viewFor === 'function' && document.body.dataset.view);
  const data = build('draft');
  const lanes = board => Object.fromEntries(board.lanes.map(lane => [lane.lane, lane]));

  // The board: memo questions with the memo check's answers, the asks heard live, risks, the fact check.
  const board = await page.evaluate(({ state, after }) => afterBoard(state, after), data);
  const { ask, asked, risks, facts } = lanes(board);
  assert.deepEqual(board.lanes.map(lane => lane.lane), ['ask', 'asked', 'risks', 'facts']);
  assert.deepEqual(ask.rows.map(row => [row.key, row.tag, row.memo]), [['memo:q2', 'no_answer', true], ['memo:q3', 'no_answer', true]],
    'the journal ASK saying question 2 again is not a second row');
  assert.equal(ask.rows[0].text, 'Who signs off the purchase?');
  assert.equal(ask.folded.length, 1);
  assert.equal(ask.folded[0].key, 'memo:q1');
  assert.equal(ask.folded[0].tag, 'answered');
  assert.equal(ask.folded[0].quote, 'The pilot budget is approved for this year.');
  assert.equal(ask.folded[0].speaker, 'Anna Petrova');
  assert.match(ask.folded[0].at, /^\d\d:\d\d$/);
  assert.equal(ask.folded[0].at, '05:12', 'elapsed call time, not the wall clock');
  assert.deepEqual(asked.rows.map(row => [row.key, row.tag, row.text]), [['journal:j-incoming_question', 'no_answer', 'When can you start the pilot?']]);
  assert.deepEqual(risks.rows.map(row => row.tag), ['risk', 'objection']);
  assert.equal(risks.rows[0].text, 'The start slips if the committee does not meet this Thursday.', 'the first line, whole');
  assert.deepEqual(facts.rows.map(row => [row.key, row.tag]), [['fact:fc-1', 'differs'], ['differs:0123456789ab', 'differs']]);
  assert.equal(facts.rows[0].other, 'Fact check: Last year the pilot covered two offices out of five.', 'the correct fact is labelled');
  assert.match(facts.rows[1].other, /Example LLC/);
  assert.match(facts.rows[1].other, /The pilot starts in April\./);
  assert.equal(facts.rows[1].quote, 'We plan to start in March.');
  assert.equal(facts.rows[1].at, '33:40');
  assert.ok(board.lanes.every(lane => [...lane.rows, ...lane.folded].every(row => row.removed === false)));
  assert.equal(board.memoLine, 'What was said on the call, checked against the memo.');

  const removed = await page.evaluate(({ state, after }) => afterBoard(state, { ...after, removed: ['memo:q2'] }), data);
  assert.equal(lanes(removed).ask.rows.find(row => row.key === 'memo:q2').removed, true);

  // Without the memo check the plan's own status: a resolved question folds, with no quote to show.
  const plain = await page.evaluate(({ state, after }) => afterBoard(state, { ...after, memo_check: null }), data);
  assert.deepEqual(lanes(plain).ask.folded.map(row => [row.key, row.tag, row.quote]), [['memo:q1', 'answered', '']]);
  assert.equal(plain.memoLine, '');

  // A removed journal item of a past meeting is on the board from /api/after, so it can be brought back.
  const past = await page.evaluate(({ state, after }) => afterBoard({ ...state, journal: [] },
    { ...after, removed: ['journal:j9'], removed_journal: [{ key: 'journal:j9', category: 'RISK', text: 'Budget runs out in May.' }] }), data);
  assert.deepEqual(lanes(past).risks.rows.map(row => [row.key, row.removed]), [['journal:j9', true]]);

  const memoLines = await page.evaluate(({ state, after }) => ['waiting', 'failed', 'not_checked'].map(kind => afterBoard(state,
    { ...after, memo_check: kind === 'waiting' ? { state: 'waiting' } : kind === 'failed' ? { state: 'failed', reason: 'timeout' }
      : { state: 'unavailable', reason: 'not_checked' } }).memoLine), data);
  assert.deepEqual(memoLines, ['The check against the memo comes with the final transcript.',
    'No check against the memo: the AI did not answer in time. The report goes without it.',
    'No check against the memo: the memo check runs only for recent calls. The report goes without it.']);

  // The send block: the headline from the gate's state, the rules while it can still wait, the actions.
  const send = await page.evaluate(names => {
    const pick = ({ state, headline, rules, actions, recipients, channels }) => ({ state, headline, rules, actions, recipients, channels });
    return Object.fromEntries(Object.entries(names).map(([name, after]) => [name, pick(afterSend(after))]));
  }, { draft: data.after, held: build('held').after, sent: build('sent').after, edited: build('edited').after,
    failed: build('failed').after, no_channels: build('no_channels').after,
    send_now: { ...data.after, send: { ...data.after.send, send_now: true } } });
  assert.deepEqual(send.draft.actions, ['send_now', 'hold']);
  assert.deepEqual(send.draft.rules, ['Changes to the summary, the next steps or the board hold the report for 30 seconds.',
    'The refined summary never replaces your text.']);
  assert.equal(send.draft.headline, 'The report goes by itself once the final transcript is ready, usually in 2-3 minutes.');
  assert.equal(send.draft.recipients, 'You receive it: e-mail owner@example.org, Telegram (Saved messages), a note in your CRM, record Example LLC. The other side does not receive the report.');
  assert.deepEqual(send.draft.channels, []);
  assert.deepEqual(send.held.actions, ['send_now']);
  assert.deepEqual(send.held.rules, []);
  assert.deepEqual(send.sent.actions, []);
  assert.equal(send.sent.channels.length, 3);
  assert.match(send.sent.channels[0], /^E-mail: sent at \d\d:\d\d$/);
  assert.deepEqual(send.edited.actions, ['send_again']);
  assert.deepEqual(send.failed.actions, ['retry']);
  assert.match(send.failed.channels[1], /^Telegram: not delivered, next try at \d\d:\d\d$/);
  assert.equal(send.send_now.headline, 'The report goes as soon as the final transcript is ready.');
  assert.deepEqual([send.no_channels.actions, send.no_channels.recipients], [[], '']);
  // Nothing to resend without an e-mail, Telegram or Drive channel (ruling C11); Retry only for a channel it can resend.
  const crmOnly = await page.evaluate(() => {
    const crm = status => ({ channel: 'twenty', to: '', status, at: null, retry_at: null });
    return [afterSend({ send: { state: 'edited', channels: [crm('sent')] } }).actions,
      afterSend({ send: { state: 'failed', channels: [crm('failed')] } }).actions,
      afterSend(null).headline];
  });
  assert.deepEqual(crmOnly, [[], [], 'The report goes by itself once the final transcript is ready, usually in 2-3 minutes.']);

  // An e-mail channel with no address reads plainly, never "e-mail " with nothing after it.
  const noAddress = await page.evaluate(() => {
    const send = { send: { state: 'draft', channels: [{ channel: 'email', to: '', status: 'waiting', at: null, retry_at: null }] } };
    const en = afterSend(send).recipients;
    uiLanguage = 'ru';
    const ru = afterSend(send).recipients;
    uiLanguage = 'en';
    return [en, ru];
  });
  assert.deepEqual(noAddress, ['You receive it: e-mail. The other side does not receive the report.',
    'Получите вы: почта. Собеседнику отчет не уходит.']);

  // A channel line never ends on "at": with no time the time clause goes.
  const timeless = await page.evaluate(() => afterSend({ send: { state: 'failed', channels: [
    { channel: 'email', to: '', status: 'sent', at: null, retry_at: null },
    { channel: 'telegram', to: '', status: 'failed', at: null, retry_at: null }] } }).channels);
  assert.deepEqual(timeless, ['E-mail: sent', 'Telegram: not delivered']);
  const timelessRu = await page.evaluate(() => ['after.ch.sent_plain', 'after.ch.failed_plain'].map(key => translations.ru[key]));
  assert.deepEqual(timelessRu, ['{channel}: отправлено', '{channel}: не доставлено']);

  // The rule that keeps the person's text says so in Russian too: the refined summary is the subject.
  assert.equal(await page.evaluate(() => translations.ru['after.rule.keep']), 'Уточненный итог не заменяет ваш текст.');

  // Quote rows show what was said, verbatim: no verb stripped, no "?" added.
  const said = await page.evaluate(({ state, after }) => {
    const board = afterBoard({ ...state, fact_checks: { items: [{ ...state.fact_checks.items[0], claim: 'Скажите, когда старт?' }] } },
      { ...after, memo_check: { ...after.memo_check, differs: [{ ...after.memo_check.differs[0], quote: 'Ask Maria first' }] } });
    return board.lanes.find(lane => lane.lane === 'facts').rows.map(row => row.text);
  }, data);
  assert.deepEqual(said, ['Скажите, когда старт?', 'Ask Maria first']);

  assert.deepEqual(await page.evaluate(() => [afterTime('2026-11-22T10:05:12Z', '2026-11-22T10:00:00Z'),
    afterTime('', '2026-11-22T10:00:00Z'), afterTime('2026-11-22T10:05:12Z', ''), afterTime('2026-11-22T11:05:12Z', '2026-11-22T10:00:00Z')]),
  ['05:12', '', '', '1:05:12']);
  assert.deepEqual(page.errors, []);
  await page.context().close();
}

// ---- The view (Task 6) ----
const text = (page, selector) => page.locator(selector).first().innerText();
const visible = (page, selector) => page.locator(selector).first().isVisible();
const focusedId = page => page.evaluate(() => document.activeElement?.id || '');
const posts = (page, path) => page.api.posts.filter(post => post.path === path);
// Waits, in this process, until a recorded request makes the check true (never a fixed sleep).
async function until(check, label, ms = 5000) {
  for (const end = Date.now() + ms; !check(); await new Promise(resolve => setTimeout(resolve, 20))) {
    if (Date.now() > end) throw new Error(`timed out: ${label}`);
  }
}
// The page has an answer of at least this many GETs drawn and none in flight.
const drawn = (page, polls) => page.waitForFunction(seq => afterRequest === null && window.afterData?.seq >= seq, polls);

// A page on After with its send block drawn from the first /api/after answer.
async function afterPage(browser, fixture, options = {}) {
  const page = await open(browser, { fixture, lang: 'en', ...options });
  await page.waitForFunction(() => document.body.dataset.view === 'after'
    && !document.getElementById('after').hidden && document.querySelector('#after-send .after-headline')?.textContent);
  return page;
}

// Every POST of the view names exactly the meeting the last GET /api/after asked for (the server's Hold cache is keyed by it).
function sameMeeting(page) {
  const gets = page.api.afterGets;
  assert.ok(gets.length > 0);
  for (const post of page.api.posts.filter(post => post.path.startsWith('/api/after/'))) {
    assert.equal(post.body.meeting_id, gets.at(-1), `${post.path} names the meeting GET used`);
  }
}

// The rules of every screen: no sideways scroll, plain house style, no dialog, no primary button, no key labels.
async function generic(page, label) {
  const found = await page.evaluate(() => {
    const seen = ['#after', '.topbar'].map(selector => document.querySelector(selector)?.innerText || '').join('\n');
    const panel = Boolean(document.body.dataset.callPanel);
    return {
      scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      yo: /[ёЁ]/u.test(seen), dash: seen.includes('—'), bang: seen.includes('!'), steno: /стенограм/iu.test(seen),
      dialogs: document.querySelectorAll('dialog[open]').length,
      workspace: getComputedStyle(document.querySelector('.workspace')).display !== 'none', panel,
      primary: document.querySelectorAll('#after button.primary').length,
      kbd: document.querySelectorAll('#after-send kbd').length,
    };
  });
  assert.ok(found.scroll <= 0, `${label}: no horizontal scroll (${found.scroll})`);
  assert.deepEqual([found.yo, found.dash, found.bang, found.steno], [false, false, false, false], `${label}: house style`);
  assert.equal(found.dialogs, 0, `${label}: no dialog`);
  assert.equal(found.workspace, found.panel, `${label}: the workspace shows only under a panel`);
  assert.equal(found.primary, 0, `${label}: no primary button`);
  assert.equal(found.kbd, 0, `${label}: no key label in the send block`);
  assert.deepEqual(page.errors, [], `${label}: no page error`);
}

async function everyScreen(browser) {
  const runs = [];
  for (const fixture of NAMES) {
    for (const width of [1440, 400]) {
      for (const scheme of ['light', 'dark']) {
        for (const lang of ['ru', 'en']) runs.push({ fixture, width, scheme, lang });
      }
    }
  }
  for (let index = 0; index < runs.length; index += 8) {
    await Promise.all(runs.slice(index, index + 8).map(async ({ fixture, width, scheme, lang }) => {
      const label = `${fixture} ${width} ${scheme} ${lang}`;
      const page = await afterPage(browser, fixture, { width, scheme, lang, data: lang });
      if (fixture === 'answered_open') await page.locator('#after-board button.ql[aria-expanded]').first().click();
      if (fixture === 'transcript_open') await page.click('#after-transcript');
      await generic(page, label);
      await page.context().close();
    }));
  }
}

async function interactions(browser) {
  // Draft: the headline, both rules, who gets it; Send now and Do not send post for the meeting shown.
  let page = await afterPage(browser, 'draft');
  assert.equal(await text(page, '#after-send .after-headline'),
    'The report goes by itself once the final transcript is ready, usually in 2-3 minutes.');
  assert.deepEqual(await page.locator('#after-send .after-rule').allInnerTexts(),
    ['Changes to the summary, the next steps or the board hold the report for 30 seconds.', 'The refined summary never replaces your text.']);
  const to = await text(page, '#after-to');
  assert.match(to, /owner@example\.org/);
  assert.match(to, /The other side does not receive the report\./);
  assert.equal(await visible(page, '#after-change'), true);
  assert.doesNotMatch(await page.locator('#after-send button:has-text("Send now")').getAttribute('class') || '', /primary|ql/,
    'Send now is secondary');
  assert.match(await page.locator('#after-send button:has-text("Do not send")').getAttribute('class'), /\bql\b/);
  await page.click('#after-send button:has-text("Send now")');
  await until(() => posts(page, '/api/after/send').length, 'send');
  await page.click('#after-send button:has-text("Do not send")');
  await until(() => posts(page, '/api/after/hold').length, 'hold');
  assert.deepEqual(posts(page, '/api/after/send').map(post => post.body), [{ meeting_id: 'm1' }]);
  assert.deepEqual(posts(page, '/api/after/hold').map(post => post.body), [{ meeting_id: 'm1' }]);
  // Remove on a row posts its key; the page never sends `record` commands.
  await page.locator('#after-board li.bitem button:has-text("Remove")').first().click();
  await until(() => posts(page, '/api/after/remove').length, 'remove');
  assert.deepEqual(posts(page, '/api/after/remove').map(post => post.body), [{ meeting_id: 'm1', key: 'memo:q2', removed: true }]);
  // The transcript and the chat open as a panel; the meta line says when the recording stopped.
  assert.match(await text(page, '#after-meta'), /Recording stopped at 42:10\./);
  assert.equal(await text(page, '#after-title'), 'Pilot review');
  sameMeeting(page);
  assert.equal(await page.locator('dialog[open]').count(), 0);
  await page.context().close();

  // Held: only Send now.
  page = await afterPage(browser, 'held');
  assert.deepEqual(await page.locator('#after-send .row-act button').allInnerTexts(), ['Send now']);
  await page.context().close();

  // Refining: typing in the summary saves 1 s after the last key; the next poll's refined summary never replaces it.
  page = await afterPage(browser, 'refining', { at: Date.now() });
  assert.equal(page.api.afterPolls, 1, 'the refined summary has not arrived yet');
  assert.match(await text(page, '.two .after-note'), /being refined/);
  assert.match(await text(page, 'label[for="after-summary"]'), /^Summary · draft$/);
  await page.click('#after-summary');
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Pilot starts in March.');
  assert.equal(posts(page, '/api/after/edit').length, 0, 'not before the pause');
  await page.clock.runFor(1100);
  await until(() => posts(page, '/api/after/edit').length, 'edit');
  assert.deepEqual(posts(page, '/api/after/edit').map(post => post.body), [{ meeting_id: 'm1', field: 'summary', text: 'Pilot starts in March.' }]);
  await page.clock.runFor(3500);
  await until(() => page.api.afterPolls >= 3, 'the refined summary came');
  await drawn(page, 3);
  assert.equal(await page.inputValue('#after-summary'), 'Pilot starts in March.');
  assert.equal(await focusedId(page), 'after-summary');
  assert.equal(await page.$eval('#after-summary', node => node.selectionStart), 'Pilot starts in March.'.length);
  sameMeeting(page);
  await page.context().close();

  // Send now sends what is on screen: a pending edit is saved first, then the send goes (I1).
  for (const [fixture, button, path] of [['showing', 'Send now', '/api/after/send'], ['edited', 'Send again', '/api/after/send-again'],
    ['failed', 'Retry', '/api/after/send-again']]) {
    page = await afterPage(browser, fixture);
    await page.fill('#after-next', 'Call Anna on Monday.');
    await page.click(`#after-send button:has-text("${button}")`);
    await until(() => posts(page, path).length, `${button} after the flush`);
    const order = page.api.posts.map(post => post.path).filter(item => item === '/api/after/edit' || item === path);
    assert.deepEqual(order.slice(0, 2), ['/api/after/edit', path], `${fixture}: the edit reaches the server before ${button}`);
    assert.equal(posts(page, '/api/after/edit')[0].body.text, 'Call Anna on Monday.');
    await page.context().close();
  }
  // A save that fails sends nothing and says why; the next good save clears the line (M2).
  page = await afterPage(browser, 'showing', { at: Date.now() });
  page.api.responses['/api/after/edit'] = { status: 500, json: { ok: false, error: 'boom' } };
  await page.fill('#after-summary', 'Pilot starts in March.');
  await page.click('#after-send button:has-text("Send now")');
  await page.locator('#after-send .after-error').waitFor();
  assert.equal(await text(page, '#after-send .after-error'), await page.evaluate(() => t('error.generic')));
  assert.equal(posts(page, '/api/after/send').length, 0, 'nothing is sent when the edit did not save');
  delete page.api.responses['/api/after/edit'];
  const tries = posts(page, '/api/after/edit').length;
  await page.clock.runFor(3100);
  await until(() => posts(page, '/api/after/edit').length > tries, 'the save is tried again');
  await page.locator('#after-send .after-error').waitFor({ state: 'detached' });
  await page.context().close();

  // The send block speaks only when its headline changes: not for a board change or a cached (stale) answer (M1).
  page = await afterPage(browser, 'draft');
  await page.evaluate(() => {
    window.headlineChanges = 0;
    window.sendRebuilds = 0;
    new MutationObserver(() => window.headlineChanges++).observe(document.getElementById('after-said'),
      { childList: true, characterData: true, subtree: true });
    new MutationObserver(() => window.sendRebuilds++).observe(document.getElementById('after-send'), { childList: true });
  });
  assert.equal(await page.getAttribute('#after-send', 'aria-live'), null, 'the block itself is not live');
  assert.equal(await page.getAttribute('#after-said', 'aria-live'), 'polite');
  assert.equal(await text(page, '#after-said'), await text(page, '#after-send .after-headline'));
  page.api.fixture.after = { ...page.api.fixture.after, stale: true, removed: ['memo:q2'] };
  await page.locator('#after-board li.bitem.removed').waitFor();
  const before = page.api.afterPolls;
  await until(() => page.api.afterPolls > before, 'a stale poll');
  await drawn(page, before + 1);
  assert.deepEqual(await page.evaluate(() => [window.headlineChanges, window.sendRebuilds]), [0, 0]);
  page.api.fixture.after = { ...page.api.fixture.after, send: { ...page.api.fixture.after.send, state: 'held' } };
  await page.waitForFunction(() => document.querySelector('#after-send .after-headline').textContent.startsWith('The report will not go'));
  assert.equal(await page.evaluate(() => window.headlineChanges), 1, 'one change, heard once');
  await page.context().close();

  // Showing: the summary is marked as updated from the final transcript.
  page = await afterPage(browser, 'showing');
  assert.match(await text(page, 'label[for="after-summary"]'), /updated from the final transcript/);
  assert.match(await text(page, '.two .after-note'), /Goes into the report as written\./);
  await page.context().close();

  // Sent: one line per channel with its time, nothing to press.
  page = await afterPage(browser, 'sent');
  const lines = await page.locator('#after-send ul.chan li').allInnerTexts();
  assert.equal(lines.length, 3);
  for (const line of lines) assert.match(line, /\d\d:\d\d/);
  assert.equal(await page.locator('#after-send .row-act button').count(), 0);
  assert.equal(await visible(page, '#after-change'), true, 'Change recipients is always there');
  await page.context().close();

  // Edited: Send again with its note above it.
  page = await afterPage(browser, 'edited');
  assert.equal(await text(page, '#after-send .after-again'),
    'The e-mail and the Telegram message arrive a second time, the CRM note stays as it was.');
  await page.click('#after-send button:has-text("Send again")');
  await until(() => posts(page, '/api/after/send-again').length, 'send again');
  assert.deepEqual(posts(page, '/api/after/send-again').map(post => post.body), [{ meeting_id: 'm1' }]);
  sameMeeting(page);
  await page.context().close();

  // Failed: Retry sends only the failed channel (C9); Check the delivery settings opens them.
  page = await afterPage(browser, 'failed');
  assert.deepEqual(await page.locator('#after-send .row-act button').allInnerTexts(), ['Retry', 'Check the delivery settings']);
  await page.click('#after-send button:has-text("Retry")');
  await until(() => posts(page, '/api/after/send-again').length, 'retry');
  assert.deepEqual(posts(page, '/api/after/send-again').map(post => post.body), [{ meeting_id: 'm1', channels: ['telegram'] }]);
  await page.click('#after-send button:has-text("Check the delivery settings")');
  await page.locator('#delivery-settings').waitFor({ state: 'visible' });
  assert.equal(await page.locator('dialog[open]').count(), 0);
  sameMeeting(page);
  await page.context().close();

  // A first answer that fails waits for the next poll: it never asks again in a loop.
  page = await afterPage(browser, 'draft');
  let failing = 0;
  await page.context().route('**/api/after?**', route => (failing++, route.abort()));
  await page.evaluate(() => {
    window.afterData = undefined;
    afterAsked = null;
    renderAfter(window.appState);
  });
  await until(() => failing >= 1, 'the first GET');
  await page.waitForTimeout(800); // the one kept sleep: a loop shows only as GETs that come within a window, before the 3 s poll
  assert.ok(failing >= 1 && failing <= 2, `one failed GET, not a loop (${failing})`);
  await page.context().close();

  // The server is busy sending: the person is told and can press again.
  page = await afterPage(browser, 'draft');
  page.api.responses['/api/after/send'] = { status: 503, json: { ok: false, error: 'busy' } };
  await page.click('#after-send button:has-text("Send now")');
  await page.locator('#after-send .after-error').waitFor();
  assert.equal(await text(page, '#after-send .after-error'), 'The app is sending a report right now. Try again in a few seconds.');
  assert.equal(await page.locator('#after-send button:has-text("Send now")').isEnabled(), true);
  await page.context().close();

  // Removed: the row says so, Bring back posts removed false.
  page = await afterPage(browser, 'removed');
  const row = page.locator('#after-board li.bitem.removed');
  assert.equal(await row.count(), 1);
  assert.match(await row.innerText(), /Removed from the report\./);
  await row.locator('button:has-text("Bring back")').click();
  await until(() => posts(page, '/api/after/remove').length, 'bring back');
  assert.deepEqual(posts(page, '/api/after/remove').map(post => post.body), [{ meeting_id: 'm1', key: 'memo:q2', removed: false }]);
  sameMeeting(page);
  await page.context().close();

  // Answered: folded under one line that opens in place.
  page = await afterPage(browser, 'answered_open');
  const fold = page.locator('#after-board .bcol').first().locator('button.ql[aria-expanded]');
  assert.equal(await fold.getAttribute('aria-expanded'), 'false');
  assert.equal(await fold.innerText(), 'Answered: 1');
  assert.equal(await page.locator('#after-board li.bitem:has-text("What budget is set for the pilot")').isVisible(), false);
  await fold.click();
  assert.equal(await fold.getAttribute('aria-expanded'), 'true');
  const q1 = page.locator('#after-board li.bitem:has-text("What budget is set for the pilot")');
  assert.equal(await q1.isVisible(), true);
  // One closing mark, no ".”,": the quote's own full stop goes before the speaker.
  assert.match(await q1.innerText(), /“The pilot budget is approved for this year”, Anna Petrova, 05:12/);
  // It stays open through the next poll.
  const polls = page.api.afterPolls;
  await until(() => page.api.afterPolls > polls, 'next poll');
  await drawn(page, polls + 1);
  assert.equal(await fold.getAttribute('aria-expanded'), 'true');
  await page.context().close();

  // No memo: no memo line, the ask lane has only the live ask.
  page = await afterPage(browser, 'no_memo');
  assert.equal(await text(page, '#after-board .board-head'), 'Goes into the report, remove what does not belong.');
  const asks = page.locator('#after-board .bcol').first().locator('li.bitem');
  assert.equal(await asks.count(), 1);
  assert.doesNotMatch(await asks.first().innerText(), /From the memo/);
  await page.context().close();

  // Memo check failed: the line names the reason.
  page = await afterPage(browser, 'memo_failed');
  assert.match(await text(page, '#after-board .board-head'), /the AI did not answer in time/);
  await page.context().close();

  // Delivery not set up: the headline, no actions, Change recipients is the way to set it up.
  page = await afterPage(browser, 'no_channels');
  assert.equal(await text(page, '#after-send .after-headline'), 'Report delivery is not set up. The report is saved on this computer.');
  assert.equal(await page.locator('#after-send .row-act button').count(), 0);
  await page.context().close();

  // Just stopped: the first answer is a 404; the view stays After, then shows the draft.
  page = await afterPage(browser, 'just_stopped');
  assert.equal(await page.evaluate(() => document.body.dataset.view), 'after');
  assert.equal(await visible(page, '#after-to'), false, 'no recipients before the report exists');
  assert.equal(await text(page, '#after-send .after-headline'),
    'The report goes by itself once the final transcript is ready, usually in 2-3 minutes.');
  await page.waitForFunction(() => !document.getElementById('after-to').hidden, null, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.body.dataset.view), 'after');
  assert.match(await text(page, '#after-meta'), /Recording stopped at 42:10\./);
  await page.context().close();

  // The transcript as a panel over After; Escape comes back with focus on the link that opened it.
  page = await afterPage(browser, 'transcript_open');
  await page.click('#after-transcript');
  assert.equal(await visible(page, '.transcript-pane'), true);
  assert.equal(await page.locator('#after').isHidden(), true);
  assert.equal(await text(page, '#call-back'), 'Back', 'ruling C13');
  await page.keyboard.press('Escape');
  assert.equal(await visible(page, '#after'), true);
  assert.equal(await visible(page, '.transcript-pane'), false);
  assert.equal(await focusedId(page), 'after-transcript');
  // Back returns too; the chat opens the same way.
  await page.click('#after-chat');
  assert.equal(await visible(page, '#chat'), true);
  await page.click('#call-back');
  assert.equal(await visible(page, '#after'), true);
  assert.equal(await focusedId(page), 'after-chat');
  await page.context().close();
}

// The CRM line shows while it waits for a record, whatever the send state (carry from Task 4).
async function needsChoice(browser) {
  const page = await afterPage(browser, 'sending');
  page.api.fixture.after.send.channels[2].status = 'needs_choice';
  await page.waitForFunction(() => document.querySelector('#after-send ul.chan')?.innerText.includes('CRM: choose the record'),
    null, { timeout: 5000 });
  await page.context().close();
}

async function narrow(browser) {
  for (const fixture of ['draft', 'sent', 'answered_open']) {
    const page = await afterPage(browser, fixture, { width: 400 });
    if (fixture === 'answered_open') await page.locator('#after-board button.ql[aria-expanded]').first().click();
    const box = selector => page.locator(selector).first().boundingBox();
    const [send, summary, next] = [await box('#after-send'), await box('#after-summary'), await box('#after-next')];
    assert.ok(send.y + send.height <= summary.y, `${fixture}: the send block comes before the fields`);
    assert.equal(summary.x, next.x, `${fixture}: one column of fields`);
    const lanes = await page.locator('#after-board .bcol').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
    assert.equal(new Set(lanes).size, 1, `${fixture}: one column of lanes`);
    const outside = await page.evaluate(() => [...document.querySelectorAll('#after button')].filter(node => node.getClientRects().length)
      .map(node => node.getBoundingClientRect()).filter(rect => rect.left < 0 || rect.right > innerWidth).length);
    assert.equal(outside, 0, `${fixture}: every button inside the window`);
    await page.context().close();
  }
}

async function words(browser) {
  const page = await open(browser, { fixture: 'draft', lang: 'ru' });
  await page.waitForFunction(() => typeof translations === 'object');
  const ru = await page.evaluate(() => [translations.ru['speakers.saved'], translations.ru['message.thinking']]);
  for (const line of ru) assert.match(line, /расшифровк/u);
  await page.context().close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await functions(browser);
    console.log('After UI: board, send state and times: OK');
    await words(browser);
    await interactions(browser);
    await needsChoice(browser);
    await narrow(browser);
    console.log('After UI: the view: OK');
    await everyScreen(browser);
    console.log('After UI: every screen at 1440 and 400, light and dark, RU and EN: OK');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
