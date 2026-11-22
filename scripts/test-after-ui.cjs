// The After view against a fake API. Task 5: the pure functions of after.js (board, send state, times),
// evaluated on the `draft` page so they run with the real translations.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { build, open } = require('./after-fixtures.cjs');

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
  assert.equal(facts.rows[0].other, 'Last year the pilot covered two offices out of five.');
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

(async () => {
  const browser = await chromium.launch();
  try {
    await functions(browser);
    console.log('After UI: board, send state and times: OK');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
