// The Call view against a fake API. Task 5: the pure functions of call.js (hint choice, heartbeat, clock,
// last phrase), evaluated on the `hint` page so they run with the real translations. Task 6: the feed, the dock
// and the panels opened on demand.
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

// A Call page in English with the view rendered; `refresh` is the next poll, run now.
async function callPage(browser, fixture, options = {}) {
  const page = await open(browser, { fixture, lang: 'en', data: 'en', ...options });
  await page.waitForSelector('#call:not([hidden]) #call-slot > *');
  return page;
}
const refresh = page => page.evaluate(async () => {
  while (stateRequestInFlight) await new Promise(resolve => setTimeout(resolve, 20));
  await state();
});
const visible = (page, selector) => page.locator(selector).first().isVisible();
const text = (page, selector) => page.locator(selector).first().textContent();
const focused = page => page.evaluate(() => {
  const active = document.activeElement;
  return active.id ? `#${active.id}` : `${active.tagName.toLowerCase()}${active.dataset.contentView ? `[${active.dataset.contentView}]` : ''}`;
});
const posts = (page, path) => page.api.posts.filter(item => item.path === path).map(item => item.body);

// Every fixture at 1440 and 400 px, light and dark, RU and EN (data in the page's language): no horizontal scroll,
// no ё, em dash or exclamation mark, no Skip or Do not record, and the hint (when shown) is the largest text.
async function everyFixture(browser) {
  for (const width of [1440, 400]) for (const scheme of ['light', 'dark']) for (const lang of ['ru', 'en']) {
    const page = await open(browser, { fixture: NAMES[0], width, scheme, lang, data: lang });
    await page.waitForSelector('#call:not([hidden]) #call-slot > *');
    for (const name of NAMES) {
      const label = `${name} ${width} ${scheme} ${lang}`;
      const data = build(name, lang);
      data.state.preferences.interface_language = lang;
      page.api.fixture = data;
      await refresh(page);
      const report = await page.evaluate(() => {
        const call = document.getElementById('call');
        const shown = node => node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
        let max = 0;
        let largest = '';
        for (const node of call.querySelectorAll('*')) {
          if (!shown(node) || ![...node.childNodes].some(child => child.nodeType === 3 && child.textContent.trim())) continue;
          const size = parseFloat(getComputedStyle(node).fontSize);
          if (size > max) [max, largest] = [size, node.className || node.tagName];
        }
        const hint = call.querySelector('.hint');
        return { scroll: document.documentElement.scrollWidth - innerWidth, hidden: call.hidden, max, largest,
          text: `${call.innerText}\n${document.querySelector('.topbar').innerText}`,
          hint: hint && shown(hint) ? parseFloat(getComputedStyle(hint).fontSize) : null };
      });
      assert.equal(report.hidden, false, label);
      // A render error inside the poll is swallowed as a failed poll: none may happen.
      assert.equal(await page.evaluate(() => stateFailures), 0, `${label}: the poll failed`);
      assert.ok(report.scroll <= 0, `${label}: horizontal scroll ${report.scroll}`);
      if (lang === 'ru') assert.doesNotMatch(report.text, /[ёЁ]/, label);
      assert.doesNotMatch(report.text, /[—!]/, label);
      assert.doesNotMatch(report.text, /Пропустить|Skip|Не записывать|Do not record/, label);
      if (report.hint !== null) {
        assert.ok(report.hint >= 22 && report.hint <= 24, `${label}: hint ${report.hint}px`);
        assert.equal(report.max, report.hint, `${label}: ${report.largest} is larger than the hint`);
      }
    }
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
}

// One fixture at a time at 1440 px: what the slot says, and what each control does.
async function interactions(browser) {
  // A fresh hint: the label with its time, one source line, Where this comes from opens the rest and stays open.
  let page = await callPage(browser, 'hint');
  assert.equal(await text(page, '#call-name'), 'Pilot review');
  assert.match(await text(page, '#call-slot .say'), /^Ask · \d\d:\d\d$/);
  assert.equal(await text(page, '#call-slot .hint'), 'Ask who signs off the purchase?');
  const why = await page.$eval('#call-slot .why', node => ({ height: node.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(node).lineHeight), text: node.textContent }));
  assert.ok(why.height < why.line * 1.5, `the source is one line: ${why.height} / ${why.line}`);
  assert.match(why.text, /Anna mentioned a committee/);
  const where = page.locator('#call-slot .why-acts button.ql');
  assert.equal(await where.textContent(), 'Where this comes from');
  assert.equal(await where.getAttribute('aria-expanded'), 'false');
  assert.equal(await visible(page, '#call-slot .why-more'), false);
  await where.click();
  assert.equal(await visible(page, '#call-slot .why-more'), true);
  assert.match(await text(page, '#call-slot .why-more'), /Anna mentioned a committee but no name/);
  assert.equal(await where.getAttribute('aria-expanded'), 'true');
  assert.equal(await where.textContent(), 'Hide');
  await refresh(page);
  assert.equal(await visible(page, '#call-slot .why-more'), true, 'the open source survives the poll');
  assert.equal(await page.evaluate(() => document.activeElement.matches('#call-slot .why-acts button')), true);
  await page.locator('#call-slot .why-acts button.ql').click();
  assert.equal(await visible(page, '#call-slot .why-more'), false);
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // A question put to the person: who asks and when, the question in regular weight, the reply as the hint.
  page = await callPage(browser, 'answer');
  assert.match(await text(page, '#call-slot .say'), /^Anna Petrova asks · \d\d:\d\d$/);
  assert.equal(await text(page, '#call-slot .heard-q'), 'When can you start the pilot?');
  assert.equal(await page.$eval('#call-slot .heard-q', node => getComputedStyle(node).fontWeight), '400');
  assert.equal(await text(page, '#call-slot .hint'), 'We can start on the first Monday after the contract is signed.');
  await page.context().close();

  // A question heard, the answer not ready: the question and the usual wait.
  page = await callPage(browser, 'heard');
  assert.match(await text(page, '#call-slot .say'), /^Anna Petrova asks · \d\d:\d\d$/);
  assert.equal(await text(page, '#call-slot .heard-q'), 'How long does the setup take on our side?');
  assert.match(await text(page, '#call-slot .heard-wait'), /usually a few seconds/);
  assert.equal(await page.locator('#call-slot .hint').count(), 0);
  await page.context().close();

  // Nothing fresh: the next open memo question, with its place in the memo.
  page = await callPage(browser, 'memo_question');
  assert.equal(await text(page, '#call-slot .hint'), 'Who signs off the purchase?');
  assert.equal(await text(page, '#call-slot .why'), 'From the memo, question 2');
  await page.context().close();

  // Nothing to say yet: the waiting line and where else to look; no hint. Earlier is empty and says so.
  page = await callPage(browser, 'waiting');
  assert.match(await text(page, '#call-slot .waiting'), /^The conversation is heard\. A hint appears here/);
  assert.match(await text(page, '#call-slot .heard-wait'), /You can ask your own question below/);
  assert.equal(await page.locator('#call .hint').count(), 0);
  assert.equal(await visible(page, '#call-note'), false);
  assert.equal(await text(page, '#call-earlier-open'), 'Earlier hints (0)');
  await page.click('#call-earlier-open');
  assert.equal(await text(page, '#call-earlier'), 'No earlier hints yet.');
  await page.context().close();

  // The AI did not answer: hints pause with the next try, and the link opens the guide.
  page = await callPage(browser, 'paused_ai');
  const note = await text(page, '#call-note');
  assert.match(note, /^Hints paused: the AI did not answer\. Recording continues, next try at \d\d:\d\d\./);
  const retry = await page.evaluate(() => homeClock(Date.parse(window.appState.copilot.analysis.at) + 300000));
  assert.ok(note.includes(retry), `${note} / ${retry}`);
  assert.equal(await text(page, '#call-note button.ql'), 'Check the AI in settings');
  await page.click('#call-note button.ql');
  await page.waitForSelector('#getting-started:not([hidden])');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // The other side not heard: since when, the sound output first, How to fix on the guide's audio step.
  const at = Math.floor(Date.now() / 60000) * 60000 + 50000; // since = :10 of this minute, a few seconds of drift never cross it
  page = await callPage(browser, 'other_lost', { at });
  const since = await page.evaluate(at => homeClock(at - 40000), at);
  assert.equal(await text(page, '#call-problem .problem h3'), `The other side is not heard since ${since}`);
  assert.match(await text(page, '#call-problem .problem p'), /^You are heard\./);
  assert.equal(await text(page, '#call-problem button.primary'), 'Choose where to listen to the call from');
  await page.click('#call-problem button.primary');
  await expectPost(page, '/api/permissions/open', { which: 'sound_output' });
  assert.equal(await text(page, '#call-problem button.ql'), 'How to fix');
  await page.click('#call-problem button.ql');
  await page.waitForSelector('#getting-started:not([hidden])');
  const step = await page.$eval('#startup-audio-heading', node => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight;
  });
  assert.equal(step, true, 'the audio step is in view');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // Your microphone not heard: the microphone settings.
  page = await callPage(browser, 'you_lost');
  assert.match(await text(page, '#call-problem .problem h3'), /^You are not heard since \d\d:\d\d$/);
  await page.click('#call-problem button.primary');
  await expectPost(page, '/api/permissions/open', { which: 'microphone' });
  await page.context().close();

  // Your own question: Enter sends it, the field empties, the slot holds it until the answer.
  page = await callPage(browser, 'own_pending');
  await page.click('#call-send');
  assert.deepEqual(posts(page, '/api/chat'), [], 'an empty field sends nothing');
  await page.fill('#call-question', 'What did Anna say about the budget?');
  await page.press('#call-question', 'Enter');
  await expectPost(page, '/api/chat', { question: 'What did Anna say about the budget?' });
  assert.equal(await page.inputValue('#call-question'), '');
  assert.equal(await text(page, '#call-slot .say'), 'Answer to your question');
  assert.equal(await text(page, '#call-slot .heard-q'), 'What did Anna say about the budget?');
  assert.match(await text(page, '#call-slot .heard-wait'), /usually a few seconds/);
  await refresh(page);
  assert.equal(await text(page, '#call-slot .heard-q'), 'What did Anna say about the budget?', 'pending until the answer');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // An auto-analysis holds the request: the question stays in the field and nothing is sent (F4).
  page = await callPage(browser, 'own_pending');
  let release;
  page.api.responses['/api/analyze'] = new Promise(resolve => { release = resolve; });
  await page.evaluate(() => { void analyze(false); });
  await page.waitForFunction(() => requestBusy);
  await page.fill('#call-question', 'What did Anna say about the budget?');
  await page.press('#call-question', 'Enter');
  await page.waitForTimeout(200);
  assert.equal(await page.inputValue('#call-question'), 'What did Anna say about the budget?');
  assert.deepEqual(posts(page, '/api/chat'), []);
  assert.equal(await page.locator('#call-slot .heard-wait').count(), 0);
  release();
  await page.context().close();

  // The answer to your own question, and Open in chat.
  page = await callPage(browser, 'own_answer');
  assert.equal(await text(page, '#call-slot .say').then(value => value.split(' · ')[0]), 'Answer to your question');
  assert.equal(await text(page, '#call-slot .heard-q'), 'What did Anna say about the budget?');
  assert.equal(await text(page, '#call-slot .own-answer'), 'Anna said the budget is approved for one quarter and needs the committee to extend it.');
  assert.equal(await page.$eval('#call-slot .own-answer', node => getComputedStyle(node).fontSize), '18px');
  assert.equal(await text(page, '#call-slot button.ql'), 'Open in chat');
  await page.click('#call-slot button.ql');
  assert.equal(await page.evaluate(() => document.body.dataset.callPanel), 'chat');
  assert.equal(await visible(page, '#chat'), true);
  assert.equal(await visible(page, '#call'), false);
  await page.context().close();

  // Earlier hints open under the slot; the count is the list.
  page = await callPage(browser, 'earlier_open');
  const open = page.locator('#call-earlier-open');
  assert.equal(await open.getAttribute('aria-expanded'), 'false');
  assert.equal(await visible(page, '#call-earlier'), false);
  await open.click();
  assert.equal(await open.getAttribute('aria-expanded'), 'true');
  assert.equal(await visible(page, '#call-earlier'), true);
  const count = Number((await open.textContent()).match(/\((\d+)\)/)[1]);
  assert.equal(count, 5);
  assert.equal(await page.locator('#call-earlier li').count(), count);
  assert.equal(await page.locator('#call-earlier li .say').count(), count);
  await refresh(page);
  assert.equal(await visible(page, '#call-earlier'), true, 'Earlier stays open across the poll');
  await open.click();
  assert.equal(await visible(page, '#call-earlier'), false);
  await page.context().close();

  // The Notes and Chat panels keep their composer; the feed, the transcript and the board do not show it (F5).
  page = await callPage(browser, 'hint');
  for (const panel of [null, 'transcript', 'board', 'notes', 'chat']) {
    await page.evaluate(panel => openCallPanel(panel), panel);
    const composer = ['notes', 'chat'].includes(panel);
    assert.equal(await visible(page, '#question'), composer, `${panel}: #question`);
    assert.equal(await visible(page, '#note-button'), composer, `${panel}: #note-button`);
  }
  await page.context().close();

  // The transcript panel shows even with the transcript_hidden preference (F12).
  page = await callPage(browser, 'transcript_open');
  page.api.fixture.state.preferences.transcript_hidden = true;
  await refresh(page);
  await page.waitForSelector('.workspace.transcript-hidden', { state: 'attached' });
  await page.click('#call-transcript-open');
  assert.equal(await visible(page, '.transcript-pane'), true);
  await page.context().close();

  // Transcript and Board open as panels over the feed; Escape and Back to the call return to the opener.
  for (const [fixture, opener, target, heading] of [['transcript_open', '#call-transcript-open', '.transcript-pane', '#transcript-heading'],
    ['board_open', '#call-board-open', '#call-board', 'button[board]']]) {
    page = await callPage(browser, fixture);
    assert.equal(await visible(page, '.workspace'), false, 'the feed hides the workspace');
    for (const close of ['Escape', '#call-back']) {
      await page.click(opener);
      assert.equal(await visible(page, target), true, `${fixture}: ${target}`);
      assert.equal(await visible(page, '#call'), false);
      assert.equal(await focused(page), heading);
      assert.equal(await text(page, '#call-back'), 'Back to the call');
      if (close === 'Escape') await page.keyboard.press('Escape');
      else await page.click(close);
      assert.equal(await visible(page, '#call'), true, `${fixture}: ${close} closes`);
      assert.equal(await visible(page, target), false);
      assert.equal(await visible(page, '#call-back'), false);
      assert.equal(await focused(page), opener);
    }
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
}

async function expectPost(page, path, body) {
  for (let tries = 0; tries < 50 && !posts(page, path).length; tries++) await page.waitForTimeout(20);
  assert.deepEqual(posts(page, path), [body]);
}

(async () => {
  const browser = await chromium.launch();
  try {
    await functions(browser);
    await fixtures(browser);
    await interactions(browser);
    await everyFixture(browser);
    console.log('call UI checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
