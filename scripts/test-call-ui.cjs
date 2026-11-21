// The Call view against a fake API. Task 5: the pure functions of call.js (hint choice, heartbeat, clock,
// last phrase), evaluated on the `hint` page so they run with the real translations.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { build, open, NAMES } = require('./call-fixtures.cjs');

const SEC = 1000;

async function functions(browser) {
  const page = await open(browser, { fixture: 'hint', lang: 'en' });
  const run = (fn, arg) => page.evaluate(fn, arg);

  // speakable: one line to say aloud.
  const spoken = await run(() => ({
    dash: speakable('Уточните сроки запуска пилота — заказчик говорил про конец квартала, а в договоре стоит середина следующего года без оговорок'),
    short: speakable('Who signs the purchase on your side, and when?'),
    question: speakable('Why is the proposal 1,1 million, if your own estimate is 3,4 million and the contractor costs 700 thousand?'),
    plain: speakable('One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty'),
    evidence: speakable('Ask who signs.\nОснование: the contract names a committee.'),
    inline: speakable('Ask who signs. Evidence: the contract names a committee.'),
    markdown: speakable('**Ask who signs** `now`.\n**Основание:** the contract.'),
    markdownInline: speakable('**Ask who signs.** **Evidence:** the contract.'),
    dashFallback: speakable('Да — это первый ответ без запятых который идет все дальше и дальше и еще дальше'),
    dashEnd: speakable('Yes, one two three four five six seven eight nine ten eleven— twelve thirteen'),
  }));
  assert.equal(spoken.dash, 'Уточните сроки запуска пилота');
  assert.ok(!spoken.dash.includes('—'));
  assert.equal(spoken.short, 'Who signs the purchase on your side, and when?');
  assert.equal(spoken.question, 'Why is the proposal 1,1 million?');
  assert.equal(spoken.plain, 'One two three four five six seven eight nine ten eleven twelve…');
  assert.equal(spoken.evidence, 'Ask who signs.');
  assert.equal(spoken.inline, 'Ask who signs.');
  // Model markdown never reaches the hint, and the cut never leaves a lone dash.
  assert.equal(spoken.markdown, 'Ask who signs now.');
  assert.equal(spoken.markdownInline, 'Ask who signs.');
  assert.equal(spoken.dashFallback, 'Да это первый ответ без запятых который идет все дальше и дальше…');
  assert.equal(spoken.dashEnd, 'Yes, one two three four five six seven eight nine ten eleven…');

  // pickHint: the newest fresh hint of the lowest tier, the memo when nothing is fresh.
  const picks = await run(() => {
    const now = Date.now();
    const ago = seconds => new Date(now - seconds * 1000).toISOString();
    const base = (replyAge, factAge, riskAge) => ({
      journal: [
        { category: 'RISK', text: 'The start date slips without the committee.\nSource: Anna', created_at: ago(riskAge) },
        { category: 'INCOMING_QUESTION', text: 'When can you start?', reply: 'On the first Monday after signing.', speaker: 'Anna Petrova', created_at: ago(replyAge) },
      ],
      fact_checks: { items: [{ status: 'refuted', fact: 'Two offices, not five.', quote: 'We covered five offices.',
        segment: { speaker: 'Anna Petrova' }, checked_at: ago(factAge) }] },
      call_plan: { source_label: 'Example LLC', items: [
        { kind: 'risk', text: 'Budget', status: 'open' },
        { kind: 'question', text: 'What budget is set?', status: 'resolved' },
        { kind: 'question', text: 'Who signs off the purchase?', status: 'open' },
      ] },
      copilot: { messages: [] },
    });
    const kinds = pick => ({ current: pick.current?.kind ?? null, label: pick.current?.label, source: pick.current?.source,
      detail: pick.current?.detail, text: pick.current?.text, earlier: pick.earlier.map(hint => hint.kind) });
    const own = base(20, 10, 5);
    own.copilot.messages = [{ role: 'user', text: 'What did Anna say?', at: ago(52) }, { role: 'assistant', text: 'She said one quarter.', at: ago(50) }];
    const ask = { journal: [{ category: 'ASK', text: 'Who signs the purchase?', created_at: ago(3) }], copilot: { messages: [] } };
    const risk = { journal: [{ category: 'RISK', text: 'The start date slips.', created_at: ago(3) }], copilot: { messages: [] } };
    return {
      answer: kinds(pickHint(base(20, 10, 5), now)),
      check: kinds(pickHint(base(31, 10, 5), now)),
      memo: kinds(pickHint(base(60, 50, 40), now)),
      own: kinds(pickHint(own, now)),
      askLabel: pickHint(ask, now).current.label,
      riskLabel: pickHint(risk, now).current.label,
      none: pickHint({}, now),
      ownQuestion: pickHint(own, now).current.question,
    };
  });
  assert.equal(picks.answer.current, 'answer');
  assert.equal(picks.answer.text, 'On the first Monday after signing.');
  assert.match(picks.answer.label, /^Anna Petrova asks · \d\d:\d\d$/);
  assert.equal(picks.check.current, 'check');
  assert.match(picks.check.label, /^Clarify · \d\d:\d\d$/);
  assert.equal(picks.memo.current, 'memo');
  assert.equal(picks.memo.source, 'From the memo, question 2');
  assert.deepEqual(picks.memo.detail, ['Example LLC']);
  assert.equal(picks.memo.label, 'Ask');
  assert.deepEqual(picks.memo.earlier, ['signal', 'check', 'answer']);
  assert.equal(picks.own.current, 'own');
  assert.match(picks.own.label, /^Answer to your question · \d\d:\d\d$/);
  assert.equal(picks.ownQuestion, 'What did Anna say?');
  assert.deepEqual(picks.own.earlier, ['signal', 'check', 'answer']);
  assert.match(picks.askLabel, /^Ask · \d\d:\d\d$/);
  assert.match(picks.riskLabel, /^Say · /);
  assert.deepEqual(picks.none, { current: null, earlier: [] });

  // A journal hint: its source is the first line after the hint line, the rest goes to the detail.
  const parts = await run(() => hintCandidates({ journal: [{ category: 'RISK', created_at: new Date().toISOString(),
    text: 'Say the date slips.\nSource: Anna, 12:31\nThe memo has no date.', evidence: 'we wait for the committee', speaker: 'Anna Petrova' }] })[0]);
  assert.equal(parts.text, 'Say the date slips.');
  assert.equal(parts.source, 'Source: Anna, 12:31');
  assert.deepEqual(parts.detail, ['The memo has no date.', 'we wait for the committee', 'Anna Petrova']);
  const fallback = await run(() => hintCandidates({ journal: [{ category: 'ASK', created_at: new Date().toISOString(),
    text: 'Ask who signs?', evidence: 'a committee decides' }] })[0]);
  assert.equal(fallback.source, 'a committee decides');
  assert.deepEqual(fallback.detail, []);
  const marked = await run(() => hintCandidates({ journal: [{ category: 'RISK', created_at: new Date().toISOString(),
    text: '**Say the date slips.**\n**Source:** `memo`' }] })[0]);
  assert.deepEqual([marked.text, marked.source], ['Say the date slips.', 'Source: memo']);
  // A resolved contradiction is never a hint; an open one is.
  const contradictions = await run(() => hintCandidates({ journal: [
    { category: 'CONTRADICTION', text: 'Two offices, not five.', status: 'resolved', created_at: new Date().toISOString() },
    { category: 'CONTRADICTION', text: 'Q3, not Q2.', status: 'clarify', created_at: new Date().toISOString() }] }).map(hint => hint.text));
  assert.deepEqual(contradictions, ['Q3, not Q2.']);
  const fixtureHint = await run(state => pickHint(state, Date.now()).current.kind, build('hint').state);
  assert.equal(fixtureHint, 'signal');
  const fixtureMemo = await run(state => pickHint(state, Date.now()), build('memo_question').state);
  assert.equal(fixtureMemo.current.source, 'From the memo, question 2');
  assert.deepEqual(fixtureMemo.earlier.map(hint => hint.kind), ['signal', 'answer', 'signal']);

  // heartbeat: only a stalled track or a lost call-audio warning reads as not heard; silence never does.
  const beats = await run(() => {
    const now = Date.now();
    const ago = seconds => new Date(now - seconds * 1000).toISOString();
    const tracks = (mic, system, age = 1) => ({ capture: { tracks: [
      { source: 'mic', state: mic, last_growth_age_seconds: 1 }, { source: 'system', state: system, last_growth_age_seconds: age }] } });
    const seg = (source, seconds) => ({ source, text: 'words', timestamp: ago(seconds) });
    return {
      both: heartbeat({ recording_health: tracks('recording', 'recording'), transcript: { segments: [seg('microphone', 3)] } }, now),
      stalled: heartbeat({ recording_health: tracks('recording', 'stalled', 40), transcript: { segments: [] } }, now),
      stalledUnknownAge: heartbeat({ recording_health: tracks('recording', 'stalled', null), transcript: {} }, now).other,
      warning: heartbeat({ recording_health: tracks('recording', 'recording'), transcript: { segments: [],
        capture_warnings: [{ reason: 'system-audio-lost', started_at: ago(25) }] } }, now).other,
      closed: heartbeat({ recording_health: tracks('recording', 'recording'), transcript: { segments: [],
        capture_warnings: [{ reason: 'system-audio-lost', started_at: ago(90), ended_at: ago(60) }] } }, now).other,
      verifying: heartbeat({ recording_health: tracks('verifying', 'recording'), transcript: {} }, now).you,
      now,
    };
  });
  assert.deepEqual(beats.both.you, { state: 'heard', since: null, speaking: true });
  assert.deepEqual(beats.both.other, { state: 'heard', since: null, speaking: false });
  assert.deepEqual(beats.stalled.other, { state: 'not_heard', since: beats.now - 40 * SEC, speaking: false });
  assert.equal(beats.stalled.you.state, 'heard');
  assert.deepEqual(beats.stalledUnknownAge, { state: 'not_heard', since: null, speaking: false });
  assert.equal(beats.warning.state, 'not_heard');
  assert.equal(Math.round((beats.now - beats.warning.since) / SEC), 25);
  assert.equal(beats.closed.state, 'heard');
  assert.equal(beats.verifying.state, 'checking');

  const now = Date.now();
  const windows = build('windows_no_tracks', 'en', now).state;
  assert.deepEqual(windows.recording_health.capture.tracks, []);
  const silent = build('silent_partner', 'en', now).state;
  const fixtures = await run(({ windows, silent, now }) => {
    const quiet = { ...windows, transcript: { ...windows.transcript, segments: windows.transcript.segments.filter(item => item.source !== 'system') } };
    return { windows: heartbeat(windows, now), quiet: heartbeat(quiet, now), silent: heartbeat(silent, now) };
  }, { windows, silent, now });
  assert.deepEqual(fixtures.windows.other, { state: 'heard', since: null, speaking: false });
  assert.equal(fixtures.quiet.other.state, 'unknown');
  assert.deepEqual(fixtures.silent.other, { state: 'heard', since: null, speaking: false });
  assert.equal(fixtures.silent.you.speaking, true);
  const lost = await run(({ other, you, now }) => ({ other: heartbeat(other, now).other, you: heartbeat(you, now).you }),
    { other: build('other_lost', 'en', now).state, you: build('you_lost', 'en', now).state, now });
  assert.deepEqual(lost.other, { state: 'not_heard', since: now - 40 * SEC, speaking: true });
  assert.equal(lost.you.state, 'not_heard');
  assert.equal(lost.you.since, now - 50 * SEC);

  // callClock and lastPhrase.
  const clock = await run(() => {
    const now = Date.now();
    const start = seconds => new Date(now - seconds * 1000).toISOString();
    const long = 'x'.repeat(110) + 'y'.repeat(90);
    return { short: callClock(start(760), now), long: callClock(start(3725), now), zero: callClock(start(0), now),
      phrase: lastPhrase({ transcript: { segments: [{ text: 'first' }, { text: long, provisional: true }] } }),
      plain: lastPhrase({ transcript: { segments: [{ text: 'Short line.' }] } }), empty: lastPhrase({ transcript: { segments: [] } }) };
  });
  assert.equal(clock.short, '12:40');
  assert.equal(clock.long, '1:02:05');
  assert.equal(clock.zero, '00:00');
  assert.equal(clock.phrase.length, 91);
  assert.equal(clock.phrase, `…${'y'.repeat(90)}`);
  assert.equal(clock.plain, 'Short line.');
  assert.equal(clock.empty, '');
  assert.equal(await run(() => [HINT_FRESH_MS, OWN_FRESH_MS].join()), '30000,60000');

  assert.deepEqual(page.errors, []);
  await page.context().close();
}

// Every fixture builds in both languages and loads without a script error from call.js.
async function fixtures(browser) {
  for (const name of NAMES) for (const lang of ['en', 'ru']) {
    const { state } = build(name, lang);
    assert.equal(state.transcript.live, true, name);
    assert.equal(state.transcript.meeting_id, 'm1', name);
    const capture = state.recording_health.capture;
    if (capture.tracks.some(track => track.state === 'stalled')) assert.deepEqual([capture.state, capture.audio_recording], ['stalled', false], name);
  }
  const stopping = build('stopped').state.recording_control.stopping;
  assert.ok(Date.parse(stopping.until) - Date.now() > 19 * SEC);
  const final = build('stopped_final').state.recording_control;
  assert.deepEqual([final.stopping, final.last_stop.meeting_id], [null, 'm1']);
  const page = await open(browser, { fixture: 'hint', lang: 'ru', data: 'ru' });
  await page.waitForFunction(() => typeof renderCall === 'function');
  assert.deepEqual(page.errors, []);
  await page.context().close();
}

(async () => {
  const browser = await chromium.launch();
  try {
    await functions(browser);
    await fixtures(browser);
    console.log('call UI checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
