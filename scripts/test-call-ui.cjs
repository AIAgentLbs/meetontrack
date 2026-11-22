// The Call view against a fake API. Task 5: the pure functions of call.js (hint choice, heartbeat, clock,
// last phrase), evaluated on the `hint` page so they run with the real translations. Task 6: the feed, the dock
// and the panels opened on demand. Task 7: the top bar. Task 8: the narrow window and More.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { build, open, NAMES } = require('./call-fixtures.cjs');

const SEC = 1000;
const STATUS_ERROR_MS_TEST = 8000; // shell.js STATUS_ERROR_MS: the hold of every error

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
  // B1: a hint is never cut. The first line shows whole: no fragment, no "…".
  assert.equal(spoken.dash, 'Уточните сроки запуска пилота — заказчик говорил про конец квартала, а в договоре стоит середина следующего года без оговорок');
  assert.equal(spoken.short, 'Who signs the purchase on your side, and when?');
  assert.equal(spoken.question, 'Why is the proposal 1,1 million, if your own estimate is 3,4 million and the contractor costs 700 thousand?');
  assert.equal(spoken.plain, 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty');
  assert.equal(spoken.evidence, 'Ask who signs.');
  assert.equal(spoken.inline, 'Ask who signs.');
  // Model markdown never reaches the hint.
  assert.equal(spoken.markdown, 'Ask who signs now.');
  assert.equal(spoken.markdownInline, 'Ask who signs.');
  assert.equal(spoken.dashFallback, 'Да — это первый ответ без запятых который идет все дальше и дальше и еще дальше');
  for (const line of Object.values(spoken)) assert.ok(!line.endsWith('…'), line);

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
      copilot: { messages: [] }, transcript: { started_at: ago(600) },
    });
    const kinds = pick => ({ current: pick.current?.kind ?? null, label: pick.current?.label, source: pick.current?.source,
      detail: pick.current?.detail, text: pick.current?.text, earlier: pick.earlier.map(hint => hint.kind) });
    const own = base(20, 10, 5);
    own.copilot.messages = [{ role: 'user', text: 'What did Anna say?', at: ago(52) }, { role: 'assistant', text: 'She said one quarter.', at: ago(50) }];
    const ask = { journal: [{ category: 'ASK', text: 'Who signs the purchase?', created_at: ago(3) }], copilot: { messages: [] },
      transcript: { started_at: ago(600) } };
    const risk = { journal: [{ category: 'RISK', text: 'The start date slips.', created_at: ago(3) }], copilot: { messages: [] },
      transcript: { started_at: ago(600) } };
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
  // The label is the words only; its age is a node of its own (G1).
  assert.equal(picks.answer.label, 'Anna Petrova asks');
  assert.equal(picks.check.current, 'check');
  assert.equal(picks.check.label, 'Clarify');
  assert.equal(picks.memo.current, 'memo');
  assert.equal(picks.memo.source, 'From the memo, question 2');
  assert.deepEqual(picks.memo.detail, ['Example LLC']);
  assert.equal(picks.memo.label, 'Ask');
  assert.deepEqual(picks.memo.earlier, ['signal', 'check', 'answer']);
  assert.equal(picks.own.current, 'own');
  assert.equal(picks.own.label, 'Answer to your question');
  assert.equal(picks.ownQuestion, 'What did Anna say?');
  assert.deepEqual(picks.own.earlier, ['signal', 'check', 'answer']);
  assert.equal(picks.askLabel, 'Ask');
  assert.equal(picks.riskLabel, 'Say');
  assert.deepEqual(picks.none, { current: null, earlier: [] });

  // A journal hint: its source is the first line after the hint line, the rest goes to the detail.
  const parts = await run(() => hintCandidates({ journal: [{ category: 'RISK', created_at: new Date().toISOString(),
    text: 'Say the date slips.\nSource: Anna, 12:31\nThe memo has no date.', evidence: 'we wait for the committee', speaker: 'Anna Petrova' }] })[0]);
  // The label says the verb once: a line that starts with it loses it (ruling 8).
  assert.equal(parts.text, 'The date slips.');
  assert.equal(parts.label, 'Say');
  assert.equal(parts.source, 'Source: Anna, 12:31', 'one source prefix (G5)');
  assert.deepEqual(parts.detail, ['The memo has no date.', 'we wait for the committee', 'Anna Petrova']);
  const fallback = await run(() => hintCandidates({ journal: [{ category: 'ASK', created_at: new Date().toISOString(),
    text: 'Ask who signs?', evidence: 'a committee decides' }] })[0]);
  assert.equal(fallback.source, 'Source: a committee decides');
  assert.deepEqual(fallback.detail, []);
  const marked = await run(() => hintCandidates({ journal: [{ category: 'RISK', created_at: new Date().toISOString(),
    text: '**Say the date slips.**\n**Source:** `memo`' }] })[0]);
  assert.deepEqual([marked.text, marked.source], ['The date slips.', 'Source: memo']);
  // The verb sets the label (ruling 6), and the line shows whole (B1).
  const verbs = await run(() => ['Спросите, кто подписывает?', 'Скажите: старт в понедельник.', 'Ask whether the regional offices that join the pilot later keep the same price and start conditions',
    'Asking around is fine.', 'Уточните сроки.'].map(line => {
    const hint = hintCandidates({ journal: [{ category: line.startsWith('Уточните') ? 'CONTRADICTION' : 'ASK', text: line, created_at: new Date().toISOString() }] })[0];
    return [hint.label.split(' · ')[0], hint.text, hint.full];
  }));
  assert.deepEqual(verbs, [['Ask', 'Кто подписывает?', ''], ['Say', 'Старт в понедельник.', ''],
    // B1: shown whole; an Ask line that lost its verb still reads as a question.
    ['Ask', 'Whether the regional offices that join the pilot later keep the same price and start conditions?', ''],
    ['Say', 'Asking around is fine.', ''], ['Clarify', 'Сроки.', '']]);
  // A resolved contradiction is never a hint; an open one is.
  const contradictions = await run(() => hintCandidates({ journal: [
    { category: 'CONTRADICTION', text: 'Two offices, not five.', status: 'resolved', created_at: new Date().toISOString() },
    { category: 'CONTRADICTION', text: 'Q3, not Q2.', status: 'clarify', created_at: new Date().toISOString() }] }).map(hint => hint.text));
  assert.deepEqual(contradictions, ['Q3, not Q2.']);
  const fixtureHint = await run(state => pickHint(state, Date.now()).current.kind, build('hint').state);
  assert.equal(fixtureHint, 'signal');
  const fixtureMemo = await run(state => pickHint(state, Date.now()), build('memo_question').state);
  assert.equal(fixtureMemo.current.source, 'From the memo, question 2');
  // The ASK that says the memo question again is not listed under it (ruling 8).
  assert.deepEqual(fixtureMemo.earlier.map(hint => hint.kind), ['answer', 'signal']);

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
  assert.deepEqual(lost.other, { state: 'not_heard', since: now - 40 * SEC, speaking: false }); // nothing heard from them since
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
        const acts = call.querySelector('#call-slot .why-acts:has(button[aria-expanded])');
        const why = call.querySelector('#call-slot .why');
        const more = [...call.querySelectorAll('#call-slot .why-more p')].map(line => line.textContent);
        const whereNew = !acts || !shown(acts) || (why && why.scrollWidth > why.clientWidth)
          || more.some(line => line !== why?.textContent && line !== hint?.textContent);
        return { scroll: document.documentElement.scrollWidth - innerWidth, hidden: call.hidden, max, largest, whereNew,
          text: `${call.innerText}\n${document.querySelector('.topbar').innerText}\n${document.getElementById('blocker-banner').innerText}`,
          hint: hint && shown(hint) ? parseFloat(getComputedStyle(hint).fontSize) : null };
      });
      assert.equal(report.hidden, false, label);
      // A render error inside the poll is swallowed as a failed poll: none may happen.
      assert.equal(await page.evaluate(() => stateFailures), 0, `${label}: the poll failed`);
      assert.ok(report.scroll <= 0, `${label}: horizontal scroll ${report.scroll}`);
      if (lang === 'ru') assert.doesNotMatch(report.text, /[ёЁ]/, label);
      assert.doesNotMatch(report.text, /[—!]/, label);
      assert.doesNotMatch(report.text, /Пропустить|Skip|Не записывать|Do not record/, label);
      assert.doesNotMatch(report.text, /AI_[A-Z]+|no answer within/, `${label}: server text`);
      assert.ok(report.whereNew, `${label}: Where this comes from reveals nothing new`);
      if (report.hint !== null) {
        // 22-24 px, one step less for a long line (B1).
        assert.ok(report.hint >= (name === 'long_hint' ? 19 : 22) && report.hint <= 24, `${label}: hint ${report.hint}px`);
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
  assert.match(await text(page, '#call-slot .say'), /^Ask · (?:just now|только что)$/);
  assert.equal(await text(page, '#call-slot .hint'), 'Who signs off the purchase?');
  const why = await page.$eval('#call-slot .why', node => ({ height: node.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(node).lineHeight), text: node.textContent }));
  assert.ok(why.height < why.line * 1.5, `the source is one line: ${why.height} / ${why.line}`);
  assert.match(why.text, /Anna mentioned a committee/);
  // The whole source fits on its line and there is nothing more: no Where this comes from.
  assert.equal(await visible(page, '#call-slot .why-acts'), false);
  // A source too long for its line gets it.
  page.api.fixture.state.journal[0].text = `Ask who signs off the purchase?\nEvidence: ${'Anna mentioned a committee that meets on Thursdays and has the final word on every purchase of this size. '.repeat(3)}`;
  await refresh(page);
  const where = page.locator('#call-slot .why-acts button.ql');
  assert.equal(await where.isVisible(), true);
  assert.equal(await where.textContent(), 'Where this comes from');
  assert.equal(await where.getAttribute('aria-expanded'), 'false');
  assert.equal(await visible(page, '#call-slot .why-more'), false);
  await where.click();
  assert.equal(await visible(page, '#call-slot .why-more'), true);
  assert.match(await text(page, '#call-slot .why-more'), /final word on every purchase of this size\. *$/);
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
  assert.match(await text(page, '#call-slot .say'), /^Anna Petrova asks · (?:just now|только что)$/);
  assert.equal(await text(page, '#call-slot .heard-q'), 'When can you start the pilot?');
  assert.equal(await page.$eval('#call-slot .heard-q', node => getComputedStyle(node).fontWeight), '400');
  assert.equal(await text(page, '#call-slot .hint'), 'We can start on the first Monday after the contract is signed.');
  await page.context().close();

  // A question heard, the answer not ready: the question and the usual wait.
  page = await callPage(browser, 'heard');
  assert.match(await text(page, '#call-slot .say'), /^Anna Petrova asks · (?:just now|только что)$/);
  assert.equal(await text(page, '#call-slot .heard-q'), 'How long does the setup take on our side?');
  assert.match(await text(page, '#call-slot .heard-wait'), /usually a few seconds/);
  assert.equal(await page.locator('#call-slot .hint').count(), 0);
  await page.context().close();

  // Nothing fresh: the next open memo question, with its place in the memo.
  page = await callPage(browser, 'memo_question');
  assert.equal(await text(page, '#call-slot .hint'), 'Who signs off the purchase?');
  assert.equal(await text(page, '#call-slot .why'), 'From the memo, question 2');
  await page.click('#call-slot .why-acts button.ql');
  assert.deepEqual(await page.locator('#call-slot .why-more p').allTextContents(), ['From the memo, question 2', 'Example LLC']);
  await page.context().close();

  // A long hint keeps its verb label and shows whole: nothing to open (ruling 6, B1).
  page = await callPage(browser, 'long_hint');
  assert.match(await text(page, '#call-slot .say'), /^Ask · (?:just now|только что)$/);
  assert.equal(await text(page, '#call-slot .hint'),
    'Will the regional offices that join the pilot later keep the same price and the same start conditions as the first two?');
  await page.context().close();
  page = await callPage(browser, 'long_hint', { lang: 'ru', data: 'ru' });
  assert.match(await text(page, '#call-slot .say'), /^Спросите · (?:just now|только что)$/);
  assert.match(await text(page, '#call-slot .hint'), /^Сохранятся ли/);
  await page.context().close();

  // Nothing to say yet: the waiting line and where else to look; no hint. No Earlier while there is none (ruling 4).
  page = await callPage(browser, 'waiting');
  assert.match(await text(page, '#call-slot .waiting'), /^Listening\. A hint appears here/);
  assert.match(await text(page, '#call-slot .heard-wait'), /You can ask your own question below/);
  assert.equal(await page.locator('#call .hint').count(), 0);
  assert.equal(await visible(page, '#call-note'), false);
  assert.equal(await visible(page, '#call-earlier-open'), false);
  assert.equal(await visible(page, '#call-earlier'), false);
  await page.context().close();

  // The AI did not answer: hints pause with the next try, and the link opens the guide.
  page = await callPage(browser, 'paused_ai');
  assert.equal(await text(page, '#call-slot .waiting'), 'Hints paused: the AI did not answer.');
  // The pause is the only message: no analysis-failure banner over the Call view.
  assert.equal(await visible(page, '#blocker-banner'), false);
  // A retry time that has passed is not shown.
  page.api.fixture.state.copilot.analysis.at = new Date(Date.now() - 10 * 60000).toISOString();
  await refresh(page);
  assert.equal(await text(page, '#call-slot .heard-wait').then(value => value.replace(/ Check the AI in settings$/, '')),
    'Recording continues, the next try comes with the next analysis.');
  // A hint still fresh keeps the slot; the pause is a note under it.
  page.api.fixture.state.journal = [{ id: 'j1', category: 'ASK', text: 'Ask who signs?', meeting_id: 'm1', created_at: new Date().toISOString() }];
  await refresh(page);
  assert.equal(await text(page, '#call-note').then(value => value.replace(/ Check the AI in settings$/, '')),
    'Hints paused: the AI did not answer. Recording continues, the next try comes with the next analysis.');
  // A code without a translation never reaches the page as server text.
  assert.equal(await page.evaluate(() => {
    const keep = uiLanguage;
    uiLanguage = 'ru';
    const shown = plainError('AI_TIMEOUT: no answer within the limit');
    uiLanguage = keep;
    return shown;
  }), await page.evaluate(() => translations.ru['error.AI_FAILED']));
  assert.equal(await text(page, '#call-note button.ql'), 'Check the AI in settings');
  await page.click('#call-note button.ql');
  await page.waitForSelector('#getting-started:not([hidden])');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // The other side not heard: for how long, the sound output first, How to fix on the guide's audio step.
  page = await callPage(browser, 'other_lost', { at: Date.now() });
  assert.match(await text(page, '#call-problem .problem h3'), /^The other side has not been heard for 4\d s$/);
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
  assert.match(await text(page, '#call-problem .problem h3'), /^You have not been heard for 5\d s$/);
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

  // An auto-analysis holds the request: the question waits in the slot and goes out when it ends (B3, replaces F4).
  page = await callPage(browser, 'hint');
  let release;
  page.api.responses['/api/analyze'] = new Promise(resolve => { release = resolve; });
  await page.evaluate(() => { void analyze(false); });
  await page.waitForFunction(() => requestBusy);
  await page.fill('#call-question', 'What did Anna say about the budget?');
  await page.press('#call-question', 'Enter');
  assert.equal(await page.inputValue('#call-question'), '');
  assert.equal(await text(page, '#call-slot .heard-q'), 'What did Anna say about the budget?');
  assert.deepEqual(posts(page, '/api/chat'), []);
  release({ status: 200, json: { ok: true, skipped: true } });
  await expectPost(page, '/api/chat', { question: 'What did Anna say about the budget?' });
  await page.context().close();

  // The answer to your own question, and the link to all questions and answers.
  page = await callPage(browser, 'own_answer');
  assert.equal(await text(page, '#call-slot .say').then(value => value.split(' · ')[0]), 'Answer to your question');
  assert.equal(await text(page, '#call-slot .heard-q'), 'What did Anna say about the budget?');
  assert.equal(await text(page, '#call-slot .own-answer'), 'Anna said the budget is approved for one quarter and needs the committee to extend it.');
  assert.equal(await page.$eval('#call-slot .own-answer', node => getComputedStyle(node).fontSize), '18px');
  assert.equal(await text(page, '#call-slot button.ql'), 'All questions and answers');
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
  assert.equal(count, 4);
  const current = await text(page, '#call-slot .hint');
  assert.ok(!(await page.locator('#call-earlier li .earlier-hint').allTextContents()).includes(current), 'no duplicate of the current hint');
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
  // The panel follows the tab it shows, so F5 holds when the tab changes underneath (C1 hides the tab bar in Call).
  for (const [panel, tab, composer] of [['board', 'notes', true], ['board', 'chat', true], ['chat', 'board', false], ['notes', 'plan', false]]) {
    await page.evaluate(panel => openCallPanel(panel), panel);
    await page.evaluate(tab => document.querySelector(`[data-content-view="${tab}"]`).click(), tab);
    assert.equal(await page.evaluate(() => document.body.dataset.callPanel), tab, `${panel} -> ${tab}`);
    assert.equal(await visible(page, '#question'), composer, `${panel} -> ${tab}: #question`);
    assert.equal(await visible(page, '#note-button'), composer, `${panel} -> ${tab}: #note-button`);
  }
  await page.context().close();

  // The transcript panel shows even with the transcript_hidden preference (F12).
  page = await callPage(browser, 'transcript_open');
  page.api.fixture.state.preferences.transcript_hidden = true;
  await refresh(page);
  await page.waitForSelector('.workspace.transcript-hidden', { state: 'attached' });
  await page.click('#call-transcript-open');
  assert.equal(await visible(page, '.transcript-pane'), true);
  // One name for the transcript: the button, the panel title and its tab (ruling 7).
  const names = await page.evaluate(() => ['#call-transcript-open', '#transcript-heading', '[data-transcript-view="transcript"]']
    .map(selector => document.querySelector(selector).textContent.trim()));
  assert.deepEqual(names, ['Transcript', 'Transcript', 'Transcript']);
  assert.equal(await visible(page, '.transcript-tabs'), false, 'Call shows the heading once, no tab (C1)');
  assert.deepEqual(await page.evaluate(() => ['call.transcript', 'transcript.heading', 'transcript.tab'].map(key => translations.ru[key])),
    ['Расшифровка', 'Расшифровка', 'Расшифровка']);
  await page.context().close();

  // Transcript and Board open as panels over the feed; Escape and Back to the call return to the opener.
  for (const [fixture, opener, target, heading] of [['transcript_open', '#call-transcript-open', '.transcript-pane', '#transcript-heading'],
    ['board_open', '#call-board-open', '#call-board', '#call-board']]) {
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

// The top bar during a call (Task 7): Recording with the clock, whether each side is heard, the last line heard,
// Stop recording and its undo window. Fixed clocks keep the countdown and the timer exact.
const beatTexts = page => page.locator('#call-beats .beat').allTextContents();
async function callBar(browser) {
  const stopKey = page => page.evaluate(() => (MAC ? 'Meta+Shift+E' : 'Alt+Shift+E'));
  let page = await callPage(browser, 'hint', { at: Date.now() });
  assert.equal(await text(page, '#call-status-text'), 'Recording');
  assert.equal(await page.$eval('#call-status-text', node => node.classList.contains('rec')), true);
  const timer = await text(page, '#call-timer');
  assert.match(timer, /^\d\d:\d\d$/);
  await page.clock.runFor(1100);
  assert.notEqual(await text(page, '#call-timer'), timer, 'the clock runs');
  assert.deepEqual(await beatTexts(page), ['You: heard', 'Other side: heard']);
  assert.equal(await page.locator('#call-beats .bars[aria-hidden="true"]').count(), 2);
  const heard = await page.$eval('#call-heard', node => ({ text: node.textContent, height: node.getBoundingClientRect().height,
    line: parseFloat(getComputedStyle(node).lineHeight) || parseFloat(getComputedStyle(node).fontSize) * 1.5 }));
  assert.match(heard.text, /^Transcript: /);
  assert.ok(heard.height < heard.line * 1.5, `one line: ${heard.height} / ${heard.line}`);
  // Stop recording sits after the status, right before Menu.
  const order = await page.evaluate(() => {
    const all = [...document.querySelectorAll('.topbar *')];
    const stop = document.getElementById('call-stop');
    return { afterStatus: all.indexOf(stop) > all.indexOf(document.getElementById('call-status')),
      next: stop.nextElementSibling?.id };
  });
  assert.deepEqual(order, { afterStatus: true, next: 'menu-button' });
  assert.equal(await text(page, '#call-stop .lbl-l'), 'Stop recording');
  assert.equal(await page.locator('#call-stop kbd').isVisible(), true, 'the key shows at 1440 px');
  // One click stops: no dialog.
  await page.click('#call-stop');
  await expectPost(page, '/api/recording/stop', { meeting_id: 'm1' });
  assert.equal(await page.locator('dialog[open]').count(), 0);
  page.api.posts.length = 0;
  await page.waitForFunction(() => !document.getElementById('call-stop').disabled);
  await page.keyboard.press(await stopKey(page));
  await expectPost(page, '/api/recording/stop', { meeting_id: 'm1' });
  // The menu lists Stop and the ask field's key.
  assert.match(await page.locator('#menu-shortcuts').textContent(), /Stop recording.*A question about this call|A question about this call.*Stop recording/s);
  // "/" outside a field goes to the ask field and is not typed; inside the field it is typed.
  await page.locator('body').click({ position: { x: 5, y: 300 } });
  await page.keyboard.press('/');
  assert.equal(await focused(page), '#call-question');
  assert.equal(await page.inputValue('#call-question'), '');
  await page.keyboard.press('/');
  assert.equal(await page.inputValue('#call-question'), '/');
  await page.fill('#call-question', '');
  // A layout that needs Shift for "/" (F20).
  await page.locator('#call-name').click();
  await page.evaluate(() => document.activeElement.blur());
  await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: '/', code: 'Digit7', shiftKey: true, bubbles: true, cancelable: true })));
  assert.equal(await focused(page), '#call-question');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // Under 1100 px the key label goes.
  page = await callPage(browser, 'hint', { width: 1024 });
  assert.equal(await page.locator('#call-stop').isVisible(), true);
  assert.equal(await page.locator('#call-stop kbd').isVisible(), false, 'no key at 1024 px');
  await page.context().close();

  // The other side not heard: the bar keeps Recording and says which side, never contradicting the feed card.
  for (const width of [1440, 400]) {
    page = await callPage(browser, 'other_lost', { width });
    assert.equal(await text(page, '#call-status-text'), 'Recording', `${width}`);
    assert.equal(await page.$eval('#call-status-text', node => node.className), 'status-text rec');
    assert.deepEqual(await beatTexts(page), ['You: heard', 'Other side: not heard']);
    assert.equal(await page.locator('#call-beats .beat').nth(1).evaluate(node => node.classList.contains('lost')), true);
    assert.equal(await visible(page, '#call-beats'), true);
    assert.match(await text(page, '#call-problem .problem p'), /^You are heard\./);
    assert.doesNotMatch(await page.locator('.topbar').innerText(), /not recording|stopped/i);
    if (width === 400) assert.equal(await text(page, '#call-stop .lbl-s'), 'Stop');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${width}: scroll`);
    await page.context().close();
  }

  // The undo window: the seconds left (G2); Resume, no Stop and no heartbeat.
  page = await callPage(browser, 'stopped', { at: Date.now() });
  const stopped = await text(page, '#call-status-text');
  assert.match(stopped, /^Recording stops in \d+\u00a0s\.$/);
  const seconds = Number(stopped.match(/in (\d+)\u00a0s/)[1]);
  // A screen reader hears the stop once, not every second (Minor 2): the bar's text is not a live region.
  assert.equal(await page.$eval('#call-status-text', node => node.getAttribute('aria-live')), null);
  const announced = await text(page, '#call-status-live');
  assert.match(announced, /^Recording stops in/);
  await page.clock.runFor(2000);
  assert.ok(Number((await text(page, '#call-status-text')).match(/in (\d+)\u00a0s/)[1]) < seconds, 'the countdown falls');
  assert.equal(await text(page, '#call-status-live'), announced, 'the countdown is not announced');
  assert.equal(await page.$eval('#call-status-text', node => node.className), 'status-text');
  assert.equal(await visible(page, '#call-stop'), false);
  assert.equal(await visible(page, '#call-live'), false);
  assert.equal(await text(page, '#call-status-action'), 'Resume recording');
  await page.click('#call-status-action');
  await expectPost(page, '/api/recording/resume', { meeting_id: 'm1' });
  await page.context().close();

  // Too late to resume: plain words, never the code (F6).
  page = await callPage(browser, 'stopped');
  page.api.responses['/api/recording/resume'] = { status: 409, json: { ok: false, error: 'too_late' } };
  await page.click('#call-status-action');
  await page.waitForFunction(() => document.getElementById('call-status-text').textContent === 'The recording has already stopped');
  assert.doesNotMatch(await page.locator('.topbar').innerText(), /too_late/);
  await page.context().close();

  // The deferred stop keeps failing (A3): the bar says so with Open the recorder, and Stop is offered again.
  page = await callPage(browser, 'stop_failed');
  assert.equal(await text(page, '#call-status-text'), 'The recording did not stop, open the recorder');
  assert.equal(await page.$eval('#call-status-text', node => node.className), 'status-text fail');
  assert.equal(await text(page, '#call-status-action'), 'Open the recorder');
  assert.equal(await visible(page, '#call-stop'), true);
  assert.doesNotMatch(await page.locator('.topbar').innerText(), /Resume/);
  await page.click('#call-stop');
  await expectPost(page, '/api/recording/stop', { meeting_id: 'm1' });
  await page.context().close();

  // Stopped for good (a recorder that cannot pause): no Resume, no Stop.
  page = await callPage(browser, 'stopped_final');
  assert.equal(await text(page, '#call-status-text'), 'Recording stopped.');
  assert.equal(await visible(page, '#call-status-action'), false);
  assert.equal(await visible(page, '#call-stop'), false);
  await page.context().close();

  // Not recording (paused, or no fresh data): no heartbeat beside it, the bar says why (Important 2).
  page = await callPage(browser, 'hint');
  assert.equal(await text(page, '#call-status-live'), 'Recording');
  for (const kind of ['paused', 'stale']) {
    const state = page.api.fixture.state;
    if (kind === 'paused') Object.assign(state.recording_health.capture, { state: 'paused' });
    else state.recording_health.checked_at = Date.now() / 1000 - 600;
    await refresh(page);
    assert.match(await text(page, '#call-status-text'), /^Not recording: /, kind);
    assert.equal(await visible(page, '#call-live'), false, `${kind}: no heartbeat`);
    assert.equal(await text(page, '#call-status-live'), await text(page, '#call-status-text'), `${kind}: announced`);
  }
  await page.context().close();

  // Still bars rest at one visible height; a side not heard shows its words, no red dots (Minor 3).
  page = await callPage(browser, 'other_lost');
  const bars = await page.$$eval('#call-beats .beat', nodes => nodes.map(node => ({
    quiet: node.querySelector('.bars').classList.contains('quiet'), shown: node.querySelector('.bars').getClientRects().length > 0,
    heights: [...node.querySelectorAll('.bars i')].map(bar => bar.getBoundingClientRect().height) })));
  const still = bars.find(beat => beat.quiet && beat.shown);
  assert.ok(still, 'a quiet side');
  assert.equal(new Set(still.heights).size, 1, `one resting height: ${still.heights}`);
  assert.ok(still.heights[0] >= 6, `a visible baseline: ${still.heights[0]}`);
  assert.equal(bars[1].shown, false, 'the lost side has no bars');
  await page.context().close();

  // A failed Stop stays readable for 8 s at least and offers Open the recorder (Minor 1).
  page = await callPage(browser, 'hint', { at: Date.now() });
  page.api.responses['/api/recording/stop'] = { status: 500, json: { ok: false, error: 'stop_failed' } };
  await page.click('#call-stop');
  await page.waitForFunction(() => document.getElementById('call-status-text').textContent === 'The recording did not stop, open the recorder');
  assert.equal(await text(page, '#call-status-action'), 'Open the recorder');
  await page.clock.runFor(5000); // two polls
  assert.equal(await text(page, '#call-status-text'), 'The recording did not stop, open the recorder', 'still there after the polls');
  await page.clock.runFor(4000);
  await refresh(page);
  assert.equal(await text(page, '#call-status-text'), 'Recording', 'gone after 8 s and a new state');
  assert.equal(await visible(page, '#call-status-action'), false);
  // Open the recorder does what the bar's own one does.
  await page.waitForFunction(() => !document.getElementById('call-stop').disabled);
  await page.click('#call-stop');
  await page.waitForFunction(() => document.getElementById('call-status-action').textContent === 'Open the recorder');
  await page.click('#call-status-action');
  await expectPost(page, '/api/getting-started/open-recorder', {});
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // RU at 400 px: the number and «с» never part.
  page = await callPage(browser, 'stopped', { width: 400, lang: 'ru', data: 'ru' });
  assert.match(await text(page, '#call-status-text'), /^Запись остановится через \d+\u00a0сек\.$/); // D4, G2
  await page.context().close();

  // No capture marker and nobody heard yet: silence is never "not heard".
  page = await callPage(browser, 'windows_no_tracks');
  page.api.fixture.state.transcript.segments = [];
  await refresh(page);
  assert.doesNotMatch((await beatTexts(page)).join(' '), /not heard/);
  assert.deepEqual(await beatTexts(page), ['You', 'Other side']);
  await page.context().close();
}

// A narrow window (Task 8): under 700 px the dock's row goes into More, the call's name keeps one line, the slot is
// in view without scrolling and the bar keeps Stop with its short label.
const box = (page, selector) => page.$eval(selector, node => {
  const { top, bottom, left, right, height } = node.getBoundingClientRect();
  return { top, bottom, left, right, height, line: parseFloat(getComputedStyle(node).lineHeight) };
});
const items = page => page.$$eval('#call-more-menu [role="menuitem"]', nodes => nodes.filter(node => node.getClientRects().length)
  .map(node => node.innerText.replace(/\s+/g, ' ').trim()));
async function narrow(browser) {
  for (const width of [400, 520]) for (const fixture of ['hint', 'heard', 'other_lost', 'stopped']) {
    const label = `${fixture} ${width}`;
    const page = await callPage(browser, fixture, { width });
    assert.equal(await visible(page, '.dock-row'), false, `${label}: dock row`);
    assert.equal(await visible(page, '#call-more'), true, `${label}: More`);
    assert.equal(await text(page, '#call-more'), 'More');
    assert.equal(await page.evaluate(() => scrollY), 0);
    const slot = await box(page, '#call-slot :is(.hint, .heard-q, .waiting)');
    const dock = await box(page, '.dock');
    const bar = await box(page, '.topbar');
    assert.ok(slot.top >= bar.bottom && slot.bottom <= dock.top, `${label}: the slot is in view ${JSON.stringify([slot, bar.bottom, dock.top])}`);
    // Stop stays in the bar with its short label, the only Stop: More never has one; stopped, the bar has none either.
    assert.equal(await page.locator('#call-more-menu [role="menuitem"]').count(), 3, `${label}: three items in More`);
    assert.equal(await page.locator('#call-more-stop').count(), 0);
    const stop = await visible(page, '#call-stop');
    assert.equal(stop, fixture !== 'stopped', `${label}: Stop`);
    if (stop) {
      assert.equal(await visible(page, '#call-stop .lbl-s'), true, `${label}: short label`);
      assert.equal(await text(page, '#call-stop .lbl-s'), 'Stop');
      assert.equal(await visible(page, '#call-stop .lbl-l'), false);
    }
    // "/" still goes to the ask field: More hides the row, never the field.
    await page.locator('#call-name').click();
    await page.keyboard.press('/');
    assert.equal(await focused(page), '#call-question', `${label}: /`);
    // The call's name keeps one line, a long one too, cut with an ellipsis (critique P3).
    page.api.fixture.state.transcript.display_meeting = 'Pilot review with Example LLC on the regional offices, the committee and the second quarter';
    await refresh(page);
    const name = await page.$eval('#call-name', node => ({ height: node.clientHeight, line: parseFloat(getComputedStyle(node).lineHeight),
      cut: node.scrollWidth > node.clientWidth, overflow: getComputedStyle(node).textOverflow }));
    assert.ok(name.height > 0 && name.height < name.line * 1.5, `${label}: one line ${JSON.stringify(name)}`);
    assert.deepEqual([name.cut, name.overflow], [true, 'ellipsis'], label);
    // The bar says what the card says: the other side not heard, still Recording (at 400 px too).
    if (fixture === 'other_lost') {
      assert.equal(await text(page, '#call-status-text'), 'Recording', label);
      assert.deepEqual(await beatTexts(page), ['You: heard', 'Other side: not heard'], label);
      assert.match(await text(page, '#call-problem .problem h3'), /^The other side has not been heard/, label);
    }
    if (width === 520 && fixture !== 'stopped') {
      // 480-600 px: the clock and the sides on their own row under the record line, words kept, the last line heard on one.
      const record = await box(page, '#call-status-text');
      const live = await box(page, '#call-timer');
      assert.ok(live.top >= record.bottom, `${label}: own row ${live.top} / ${record.bottom}`);
      assert.match((await beatTexts(page)).join(' | '), /^You: heard \| Other side: (not )?heard$/);
      const heard = await box(page, '#call-heard');
      assert.ok(heard.height < (heard.line || 20) * 1.5, `${label}: one line heard`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, `${label}: scroll`);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }

  // More at 400 px: three items in order, opened on the first, arrows move, Escape closes it back on More.
  let page = await callPage(browser, 'more_open', { width: 400 });
  const more = page.locator('#call-more');
  assert.equal(await more.getAttribute('aria-haspopup'), 'menu');
  await more.click();
  assert.equal(await visible(page, '#call-more-menu'), true);
  assert.equal(await more.getAttribute('aria-expanded'), 'true');
  assert.deepEqual(await items(page), ['Earlier hints (1)', 'Transcript the whole conversation as text',
    'Board questions, risks and fact checks']);
  assert.equal(await focused(page), '#call-more-earlier');
  await page.keyboard.press('ArrowDown');
  assert.equal(await focused(page), '#call-more-transcript');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  assert.equal(await focused(page), '#call-more-board');
  const menuBox = await box(page, '#call-more-menu');
  const barBox = await box(page, '.topbar');
  assert.ok(menuBox.top >= barBox.bottom && menuBox.bottom <= 900 && menuBox.left >= 0 && menuBox.right <= 400,
    `the menu fits ${JSON.stringify(menuBox)}`);
  await page.keyboard.press('Escape');
  assert.equal(await visible(page, '#call-more-menu'), false);
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal(await focused(page), '#call-more');
  assert.equal(await visible(page, '#call'), true, 'Escape on the menu leaves the feed');
  // A click outside closes it.
  await more.click();
  await page.locator('#call-name').click();
  assert.equal(await visible(page, '#call-more-menu'), false);
  // Earlier shows the list under the slot.
  await more.click();
  await page.click('#call-more-earlier');
  assert.equal(await visible(page, '#call-earlier'), true);
  assert.equal(await visible(page, '#call-more-menu'), false);
  // Transcript and Board open their panels; Escape returns to the feed with focus on More (F2).
  for (const [item, target, heading] of [['#call-more-transcript', '.transcript-pane', '#transcript-heading'],
    ['#call-more-board', '#call-board', '#call-board']]) {
    await more.click();
    await page.click(item);
    assert.equal(await visible(page, target), true, item);
    assert.equal(await visible(page, '#call'), false);
    assert.equal(await focused(page), heading);
    await page.keyboard.press('Escape');
    assert.equal(await visible(page, '#call'), true, `${item}: Escape`);
    assert.equal(await focused(page), '#call-more');
  }
  // The window widens past 700 px with More open: More closes, and focus goes to the ask field, never to the page.
  await more.click();
  assert.equal(await focused(page), '#call-more-earlier');
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForFunction(() => document.getElementById('call-more-menu').hidden, null, { timeout: 2000 });
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  assert.equal(await focused(page), '#call-question');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // A short window (400x560): the menu opens between the bar and the dock, its height capped by both.
  page = await callPage(browser, 'other_lost', { width: 400, height: 560 });
  await page.click('#call-more');
  const short = await page.evaluate(() => {
    const menu = document.getElementById('call-more-menu').getBoundingClientRect();
    const bar = document.querySelector('.topbar').getBoundingClientRect().bottom;
    const dock = document.querySelector('.dock').getBoundingClientRect();
    return { top: menu.top, bottom: menu.bottom, bar, dockTop: dock.top, dockHeight: dock.height,
      max: parseFloat(getComputedStyle(document.getElementById('call-more-menu')).maxHeight) };
  });
  assert.ok(short.top >= short.bar && short.bottom <= short.dockTop, `short window: ${JSON.stringify(short)}`);
  assert.ok(short.max <= 560 - short.bar - short.dockHeight, `max-height leaves the bar and the dock: ${JSON.stringify(short)}`);
  // Earlier from More scrolls the list into view, between the bar and the dock.
  await page.click('#call-more-earlier');
  // The list starts below the dock at this height, so seeing it means the page scrolled to it.
  assert.ok(await page.evaluate(() => scrollY) > 0, 'scrolled to Earlier');
  const list = await box(page, '#call-earlier');
  const barNow = await box(page, '.topbar');
  const dockNow = await box(page, '.dock');
  assert.ok(list.top >= barNow.bottom - 1 && list.top < dockNow.top - 20, `Earlier in view: ${JSON.stringify([list, barNow.bottom, dockNow.top])}`);
  // E1: the whole list sits above the sticky dock when it fits, never under it.
  if (list.height <= dockNow.top - barNow.bottom) assert.ok(list.bottom <= dockNow.top + 1, `Earlier above the dock: ${JSON.stringify([list, dockNow])}`);
  else assert.ok(list.top >= barNow.bottom - 1, 'a tall list starts under the bar');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // RU: the item notes.
  page = await callPage(browser, 'more_open', { width: 400, lang: 'ru', data: 'ru' });
  await page.click('#call-more');
  assert.deepEqual((await items(page)).slice(1, 3), ['Расшифровка весь разговор текстом', 'Доска вопросы, риски и проверка фактов']);
  assert.equal(await text(page, '#call-more'), 'Еще');
  await page.context().close();

  // A wide window keeps the dock's row and has no More.
  page = await callPage(browser, 'hint');
  assert.equal(await visible(page, '.dock-row'), true);
  assert.equal(await visible(page, '#call-more'), false);
  // The menu in the Call view: Show transcript and Swap panels do nothing here, so they are not offered.
  page.api.fixture.state.preferences.transcript_hidden = true;
  await refresh(page);
  await page.waitForSelector('#transcript-show:not([hidden])', { state: 'attached' });
  await page.click('#menu-button');
  const offered = await page.$$eval('#app-menu [role="menuitem"]', nodes => nodes.filter(node => node.getClientRects().length).map(node => node.id));
  assert.ok(!offered.includes('transcript-show') && !offered.includes('swap-panels'), offered.join(', '));
  await page.keyboard.press('Escape');
  assert.equal(await focused(page), '#menu-button');
  await page.context().close();
}

// The fix wave after the final review (fix-wave.md), one block per item.
async function fixWave(browser) {
  // E3: in a narrow window the last line heard keeps its label and its newest words; the cut is at the start.
  for (const width of [520, 760]) {
    const page = await callPage(browser, 'hint', { width });
    const said = 'The committee meets on Thursdays and the regional offices join later, so the earliest start is the second week';
    page.api.fixture.state.transcript.segments.push({ source: 'system', speaker: 'Anna Petrova', text: said, timestamp: new Date().toISOString() });
    await refresh(page);
    const shown = await page.evaluate(() => {
      const line = document.getElementById('call-heard');
      const box = line.getBoundingClientRect();
      const range = document.createRange();
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
      const at = (node, offset) => { range.setStart(node, offset); range.setEnd(node, offset + 1); return range.getBoundingClientRect(); };
      const first = at(nodes[0], 0), lastNode = nodes.at(-1), last = at(lastNode, lastNode.length - 1);
      return { text: line.textContent,
        first: first.left >= box.left - 1 && first.right <= box.right + 1, last: last.left >= box.left - 1 && last.right <= box.right + 1,
        cut: line.scrollWidth > line.clientWidth || [...line.children].some(child => child.scrollWidth > child.clientWidth) };
    });
    assert.ok(shown.text.startsWith('Transcript: '), shown.text);
    assert.ok(shown.text.endsWith('second week'), shown.text);
    assert.equal(shown.first, true, `${width}: the label shows`);
    assert.equal(shown.last, true, `${width}: the newest words show`);
    await page.context().close();
  }
  // E2: the call ends while More is open: More closes, so Home's shortcuts work again.
  {
    const page = await callPage(browser, 'more_open', { width: 400 });
    await page.click('#call-more');
    assert.equal(await visible(page, '#call-more-menu'), true);
    page.api.fixture.state.transcript = { ...page.api.fixture.state.transcript, status: 'finished', live: false,
      ended_at: new Date(Date.now() - 2 * 3600000).toISOString(), updated_at: new Date(Date.now() - 2 * 3600000).toISOString(),
      latest_at: new Date(Date.now() - 2 * 3600000).toISOString() };
    page.api.fixture.state.recording_health.capture = { state: 'inactive', audio_recording: false, tracks: [] };
    await refresh(page);
    assert.equal(await page.evaluate(() => document.body.dataset.view), 'home');
    assert.equal(await page.evaluate(() => document.getElementById('call-more-menu').hidden), true, 'More closed');
    assert.equal(await page.getAttribute('#call-more', 'aria-expanded'), 'false');
    await page.context().close();
  }
  // E1: a long Earlier list opened from More starts under the real top bar (taller than --bar-h at 400 px when it
  // wraps), not under it; a short one ends above the real dock.
  for (const [fixture, extra] of [['earlier_open', 8], ['other_lost', 0]]) {
    const page = await callPage(browser, fixture, { width: 400, height: 560, lang: 'ru', data: 'ru' });
    if (extra) {
      const base = page.api.fixture.state.journal;
      page.api.fixture.state.journal = [...base, ...Array.from({ length: extra }, (_, index) => ({ ...base.at(-1), id: `x${index}`,
        category: 'RISK', text: `Риск номер ${index + 1}: срок сдвигается, если комитет не соберется.`,
        created_at: new Date(Date.now() - (5 + index) * 60000).toISOString() }))];
      await refresh(page);
    }
    await page.click('#call-more');
    await page.click('#call-more-earlier');
    await page.waitForTimeout(200);
    const r = await page.evaluate(() => { const b = s => document.querySelector(s).getBoundingClientRect();
      return { bar: b('.topbar').bottom, dock: b('.dock').top, top: b('#call-earlier').top, bottom: b('#call-earlier').bottom }; });
    assert.ok(r.top >= r.bar - 1, `${fixture}: starts under the bar ${JSON.stringify(r)}`);
    if (r.bottom - r.top <= r.dock - r.bar) assert.ok(r.bottom <= r.dock + 1, `${fixture}: ends above the dock ${JSON.stringify(r)}`);
    await page.context().close();
  }
  // D6: plain copy in both languages, each key once.
  {
    const page = await callPage(browser, 'waiting', { lang: 'ru' });
    assert.match(await text(page, '#call-slot .waiting'), /^Слушаю разговор\. Подсказка появится здесь/);
    const copy = await page.evaluate(() => ['call.open_chat', 'call.you_lost', 'call.other_lost'].map(key => [translations.ru[key], translations.en[key]]));
    assert.deepEqual(copy, [['Все вопросы и ответы', 'All questions and answers'], ['Вас не слышно {time}', 'You have not been heard for {time}'],
      ['Собеседника не слышно {time}', 'The other side has not been heard for {time}']]);
    for (const lang of ['ru', 'en']) assert.doesNotMatch(build('earlier_open', lang).state.journal.map(item => item.text).join(' '), /контекст|background/);
    await page.context().close();
    const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../copilot/web/app.js'), 'utf8');
    for (const key of ['call.waiting_heard', 'call.open_chat', 'call.you_lost', 'call.other_lost'])
      assert.equal(source.split(`"${key}":`).length - 1, 2, `${key}: once per language`);
  }
  // D5: the ask button says Send, so it never clashes with the hint's Ask; the placeholder keeps its wording.
  for (const [lang, send, placeholder] of [['en', 'Send', 'Ask about this call'], ['ru', 'Отправить', 'Спросить про звонок']]) {
    const page = await callPage(browser, 'hint', { lang });
    assert.equal(await page.locator('#call-send span').textContent(), send, lang);
    assert.equal(await page.getAttribute('#call-question', 'placeholder'), placeholder, lang);
    await page.context().close();
  }
  // D3: a failed automatic analysis shows once, as the feed's pause, never also as the red banner; copilot.error
  // arrives with it from the server. Outside Call the banner still says the AI failed.
  {
    const page = await callPage(browser, 'paused_ai');
    assert.equal(build('paused_ai').state.copilot.error.startsWith('AI_TIMEOUT'), true);
    await page.waitForTimeout(300);
    assert.equal(await visible(page, '#blocker-banner'), false);
    assert.equal(await page.locator('#call').innerText().then(value => value.match(/AI did not answer/g).length), 1);
    await page.evaluate(() => openView('after'));
    await page.waitForFunction(() => !document.getElementById('blocker-banner').hidden);
    assert.match(await text(page, '#blocker-banner'), /^AI help failed: /);
    await page.context().close();
  }
  // D2: paused AI with nothing to show: the main line says hints are paused, one message, no waiting line under it.
  for (const [lang, main, retry] of [['en', 'Hints paused: the AI did not answer.', /^Recording continues, next try in 5\u00a0min\. Check the AI in settings$/],
    ['ru', 'Подсказки на паузе: ИИ не ответил.', /^Запись идет, следующая попытка через 5\u00a0мин\. /]]) {
    const page = await callPage(browser, 'paused_ai', { at: Date.now(), lang });
    assert.equal(await text(page, '#call-slot .waiting'), main, lang);
    assert.match(await text(page, '#call-slot .heard-wait'), retry, lang);
    assert.equal(await visible(page, '#call-note'), false, `${lang}: one message`);
    assert.doesNotMatch(await page.locator('#call').innerText(), /A hint appears here|Подсказка появится здесь|ask your own question below|Свой вопрос можно задать/);
    await page.click('#call-slot button.ql');
    assert.equal(await visible(page, '#getting-started'), true, `${lang}: the link opens the guide`);
    await page.context().close();
  }
  // D1, replaced by G1: one clock per job (polish below); the paused retry is still a count of minutes.
  {
    const at = Date.now();
    let page;
    page = await callPage(browser, 'paused_ai', { at });
    assert.match(await text(page, '#call'), /next try in 5\u00a0min\./);
    await page.context().close();
    page = await callPage(browser, 'paused_ai', { at, lang: 'ru' });
    assert.match(await text(page, '#call'), /следующая попытка через 5\u00a0мин\./);
    await page.context().close();
    for (const name of ['stopped', 'stop_failed', 'stopped_final']) {
      const { state } = build(name, 'en', at);
      const stop = Date.parse((state.recording_control.stopping || state.recording_control.last_stop).stopped_at);
      assert.ok(state.journal.every(item => Date.parse(item.created_at) <= stop), `${name}: no hint after the stop`);
    }
  }
  // C1: in Call a panel shows only what it was opened for. Board: the four columns, no tab bar, no chips, no
  // per-card pill or dropdown, no red, and the current hint once. Transcript: one heading, no Frames tab.
  {
    const page = await callPage(browser, 'board_open', { lang: 'ru', data: 'ru' });
    await page.click('#call-board-open');
    assert.equal(await page.locator('#call-board .board-column').count(), 4);
    for (const hidden of ['#workspace-filters', '#call-board .board-summary', '#call-board select', '#call-board .traffic-light'])
      assert.equal(await visible(page, hidden), false, hidden);
    const mine = await page.locator('#call-board .board-column.mine .board-item > .board-item-heading p').allTextContents();
    assert.equal(mine.filter(line => /подписывает закупку/i.test(line)).length, 1, `one copy of the current hint: ${mine}`);
    const danger = await page.evaluate(() => getComputedStyle(document.body).getPropertyValue('--danger').trim());
    const red = await page.evaluate(danger => {
      const probe = document.createElement('i'); probe.style.color = danger; document.body.append(probe);
      const rgb = getComputedStyle(probe).color; probe.remove();
      return [...document.querySelectorAll('#call-board *')].filter(node => node.checkVisibility() && node.children.length === 0
        && node.textContent.trim() && getComputedStyle(node).color === rgb).map(node => node.textContent.trim());
    }, danger);
    assert.deepEqual(red, [], 'no text in the error colour');
    assert.equal(await focused(page), '#call-board');
    // Chat and Notes stay reachable from Menu.
    await page.keyboard.press('Escape');
    await page.click('#menu-button');
    await page.click('#menu-notes');
    assert.equal(await page.evaluate(() => document.body.dataset.callPanel), 'notes');
    assert.equal(await visible(page, '#journal'), true);
    assert.equal(await visible(page, '#workspace-filters'), false);
    await page.context().close();
  }
  {
    const page = await callPage(browser, 'transcript_open', { lang: 'ru', data: 'ru' });
    await page.click('#call-transcript-open');
    const header = await page.locator('.transcript-pane .pane-header').innerText();
    assert.equal(header.match(/Расшифровка/g).length, 1, header);
    assert.doesNotMatch(header, /Кадры|Последняя реплика/);
    await page.context().close();
  }
  // B6: in Earlier, a heard question says who asked, in quotes, and our answer sits under its own label.
  for (const [lang, asked, label] of [['en', 'Anna Petrova asked: “When can you start the pilot?”', 'Answer · 2 min ago'],
    // RU keeps the present tense: a past verb would guess the speaker's gender from a name.
    ['ru', 'Анна Петрова спрашивает: «Когда вы сможете начать пилот?»', 'Ответ · 2\u00a0мин назад']]) {
    const page = await callPage(browser, 'earlier_open', { lang, data: lang });
    await page.click('#call-earlier-open');
    const item = page.locator('#call-earlier li', { hasText: asked });
    assert.equal(await item.count(), 1, lang);
    assert.deepEqual(await item.locator('p').allTextContents().then(lines => lines.slice(0, 3)),
      [asked, label, build('earlier_open', lang).state.journal[1].reply], lang);
    // The question shows once: no source line repeating it under the answer.
    const question = build('earlier_open', lang).state.journal[1].text;
    assert.equal((await item.locator('p').allTextContents()).filter(line => line.trim() === question).length, 0, `${lang}: question once`);
    await page.context().close();
  }
  // B5: the server skipped the automatic analysis (the start of an automatic recording): a heard question is not
  // promised an answer, and the page asks again while it waits.
  {
    const page = await callPage(browser, 'heard');
    page.api.responses['/api/analyze'] = { status: 200, json: { ok: true, skipped: true, reason: 'short_automatic_recording' } };
    page.api.fixture.state.copilot.busy = false;
    await refresh(page);
    for (let tries = 0; tries < 50 && !posts(page, '/api/analyze').length; tries++) await page.waitForTimeout(20);
    await refresh(page);
    const wait = await text(page, '#call-slot .heard-wait');
    assert.doesNotMatch(wait, /being prepared/);
    assert.equal(wait, 'The answer comes later: the AI skips the first minutes of an automatic recording.');
    assert.ok(await page.evaluate(() => urgentRetryAt > Date.now()), 'asks again after the gap');
    await page.context().close();
  }
  // B3: a question typed while an analysis runs is queued: it shows as waiting at once and goes out when the
  // analysis ends. A failed Ask says so in the feed and gives the question back for another try.
  {
    const page = await callPage(browser, 'hint');
    await page.evaluate(() => { requestBusy = true; });
    await page.fill('#call-question', 'What did Anna say about the budget?');
    await page.press('#call-question', 'Enter');
    assert.equal(await page.inputValue('#call-question'), '');
    assert.equal(await text(page, '#call-slot .heard-q'), 'What did Anna say about the budget?');
    assert.match(await text(page, '#call-slot .heard-wait'), /^The answer is being prepared/);
    await refresh(page);
    assert.deepEqual(posts(page, '/api/chat'), []);
    await page.evaluate(() => { requestBusy = false; });
    await refresh(page);
    await expectPost(page, '/api/chat', { question: 'What did Anna say about the budget?' });
    await page.context().close();
  }
  {
    const page = await callPage(browser, 'hint');
    page.api.responses['/api/chat'] = 'abort';
    await page.fill('#call-question', 'Who signs?');
    await page.press('#call-question', 'Enter');
    const unreachable = await page.evaluate(() => t('error.unreachable'));
    await page.waitForFunction(text => document.getElementById('call-slot').textContent.includes(text), unreachable);
    assert.equal(await text(page, '#call-slot .heard-q'), 'Who signs?');
    assert.equal(await page.inputValue('#call-question'), 'Who signs?');
    await refresh(page);
    assert.ok((await text(page, '#call-slot')).includes(unreachable), 'the error stays through a poll');
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
  // B1: the long hint shows whole, in one smaller step of type, never clamped and with nothing hidden behind Where.
  for (const [lang, width] of [['ru', 1440], ['en', 1440], ['ru', 400]]) {
    const page = await callPage(browser, 'long_hint', { lang, data: lang, width });
    const long = build('long_hint', lang).state.journal[0].text;
    const shown = await text(page, '#call-slot .hint');
    assert.ok(long.endsWith(shown) || long.toLowerCase().endsWith(shown.toLowerCase()), `${lang}: ${shown}`);
    assert.ok(!shown.endsWith('…'), shown);
    const style = await page.$eval('#call-slot .hint', node => ({ size: parseFloat(getComputedStyle(node).fontSize),
      clamp: getComputedStyle(node).webkitLineClamp, cut: node.scrollHeight > node.clientHeight + 1 }));
    assert.deepEqual([style.size, style.cut], [width > 600 ? 20 : 19, false], `${lang} ${width}: ${JSON.stringify(style)}`);
    assert.equal(await page.locator('#call-slot .why-full').count(), 0);
    await page.context().close();
  }
  const short = await callPage(browser, 'hint');
  assert.equal(await short.$eval('#call-slot .hint', node => parseFloat(getComputedStyle(node).fontSize)), 24);
  await short.context().close();

  // A4: during the undo window and after the final stop the feed never says the call is heard or recorded, no
  // problem card shows for the paused tracks, the hint slot gives way to one plain line, and the ask field still works.
  for (const fixture of ['stopped', 'stopped_final']) {
    const page = await callPage(browser, fixture);
    const state = page.api.fixture.state;
    state.call_plan = null;
    state.recording_health.capture.tracks[1] = { ...state.recording_health.capture.tracks[1], state: 'stalled', last_growth_age_seconds: 50 };
    await refresh(page);
    const feed = await page.locator('#call').innerText();
    assert.doesNotMatch(feed, /Recording\. A hint|is heard|not heard|Ask who signs/, `${fixture}: ${feed}`);
    assert.equal(await page.locator('#call-problem > *').count(), 0, `${fixture}: no problem card`);
    // One plain line (G2, G3): hints paused in the undo window, the recording saved after the final stop.
    assert.equal(await text(page, '#call-slot p'), fixture === 'stopped' ? 'Hints are paused.' : 'The recording is saved.', fixture);
    assert.equal(await page.locator('#call-question').isEnabled(), true);
    await page.fill('#call-question', 'What did Anna say about the budget?');
    await page.press('#call-question', 'Enter');
    await expectPost(page, '/api/chat', { question: 'What did Anna say about the budget?' });
    assert.deepEqual(page.errors, []);
    await page.context().close();
  }
}

// Section G, critique 2: one clock per job, the end of the call, the panels and Earlier.
async function polish(browser) {
  const ru = (fixture, options = {}) => callPage(browser, fixture, { lang: 'ru', data: 'ru', ...options });
  const at = Date.parse('2026-11-26T15:47:50Z');
  // G1: the bar has the elapsed timer; an item in the feed or Earlier says how old it is; lost audio says for how
  // long; the transcript is stamped in elapsed time. No other time shows anywhere in Call.
  {
    const page = await ru('hint', { at });
    assert.equal(await text(page, '#call-slot .say'), 'Спросите · только что');
    const bar = await page.locator('.topbar').innerText();
    assert.deepEqual(bar.match(/\d+:\d\d/g), ['12:40'], bar);
    assert.doesNotMatch(await page.locator('#call').innerText(), /\d:\d\d/);
    await page.click('#call-transcript-open');
    assert.deepEqual(await page.locator('#transcript .utterance time').allTextContents(), ['11:50', '12:00', '12:20', '12:34']);
    assert.deepEqual(await page.locator('#transcript .speaker-name-button').allTextContents(), ['Вы', 'Анна Петрова', 'Вы', 'Анна Петрова']);
    await page.context().close();
  }
  for (const [lang, labels] of [['ru', ['Уточните · 1\u00a0мин назад', 'Ответ · 2\u00a0мин назад', 'Скажите · 3\u00a0мин назад']],
    ['en', ['Clarify · 1 min ago', 'Answer · 2 min ago', 'Say · 3 min ago']]]) {
    const page = await callPage(browser, 'earlier_open', { lang, data: lang, at });
    await page.click('#call-earlier-open');
    const shown = await page.locator('#call-earlier .say').allTextContents();
    for (const label of labels) assert.ok(shown.includes(label), `${lang}: ${label} in ${shown.join(' | ')}`);
    assert.doesNotMatch(await page.locator('#call').innerText(), /\d:\d\d/, lang);
    // The age keeps counting between polls, in place: the item is not rebuilt.
    const item = await page.$('#call-earlier li:last-child .say');
    const before = await item.textContent();
    await page.clock.fastForward(60 * SEC);
    assert.equal(await item.evaluate(node => node.isConnected), true, `${lang}: kept`);
    assert.notEqual(await item.textContent(), before, `${lang}: the age moved on`);
    await page.context().close();
  }
  for (const [lang, fixture, title] of [['ru', 'other_lost', /^Собеседника не слышно 4\d\u00a0сек$/], ['en', 'other_lost', /^The other side has not been heard for 4\d s$/],
    ['ru', 'you_lost', /^Вас не слышно 5\d\u00a0сек$/], ['en', 'you_lost', /^You have not been heard for 5\d s$/]]) {
    const page = await callPage(browser, fixture, { lang, data: lang, at });
    assert.match(await text(page, '#call-problem .problem h3'), title, `${lang} ${fixture}`);
    assert.doesNotMatch(await page.locator('#call').innerText(), /\d:\d\d/, `${lang} ${fixture}`);
    await page.context().close();
  }
  // The other side's lost sound comes before the hint shown, never after it (P3-6).
  {
    const { state } = build('other_lost', 'ru');
    const lost = Date.parse(state.transcript.capture_warnings[0].started_at);
    assert.ok(state.journal.every(item => Date.parse(item.created_at) < lost), 'hints older than the loss');
    assert.ok(state.transcript.segments.filter(item => item.source === 'system').every(item => Date.parse(item.timestamp) < lost));
  }
  // The fixtures carry no clock time.
  for (const name of NAMES) for (const lang of ['en', 'ru']) {
    assert.doesNotMatch(JSON.stringify(build(name, lang).state.journal.map(item => [item.text, item.reply, item.evidence])), /\b\d\d:\d\d\b/, `${name} ${lang}`);
  }
  // G2: the undo window says once that the recording stops and offers to go on; the feed does not repeat the bar.
  for (const [lang, bar, feed] of [['ru', /^Запись остановится через \d+\u00a0сек\.$/, 'Подсказки на паузе.'],
    ['en', /^Recording stops in \d+\u00a0s\.$/, 'Hints are paused.']]) {
    const page = await callPage(browser, 'stopped', { lang, data: lang, at });
    assert.match(await text(page, '#call-status-text'), bar, lang);
    assert.equal(await text(page, '#call-status-action'), lang === 'ru' ? 'Продолжить запись' : 'Resume recording');
    assert.equal(await text(page, '#call-slot'), feed, lang);
    assert.doesNotMatch(await page.locator('#call').innerText(), /больше не будет|No more hints|\d:\d\d/, lang);
    await page.context().close();
  }
  // G3: the final stop says the recording is saved and opens this meeting's results.
  for (const [lang, bar, saved, button] of [['ru', 'Запись остановлена.', 'Запись сохранена.', 'Открыть итоги звонка'],
    ['en', 'Recording stopped.', 'The recording is saved.', 'Open the call results']]) {
    const page = await callPage(browser, 'stopped_final', { lang, data: lang, at });
    assert.equal(await text(page, '#call-status-text'), bar, lang);
    assert.equal(await text(page, '#call-slot p'), saved, lang);
    assert.equal(await text(page, '#call-slot button'), button, lang);
    await page.click('#call-slot button');
    assert.equal(await page.evaluate(() => document.body.dataset.view), 'after', lang);
    assert.equal(await visible(page, '#call-status-action'), false, `${lang}: no way back to a stopped call`);
    await page.context().close();
  }
  // G4: a panel sits in the feed's column on the feed's background; RU says Вы and Расшифровка; the board's
  // headings are plain words and it shows no zero counters. The After view keeps its own board.
  {
    const page = await ru('board_open', { at });
    const column = () => page.evaluate(() => {
      const pane = [...document.querySelectorAll('.transcript-pane, .copilot-pane')].find(node => node.getClientRects().length);
      const box = pane.getBoundingClientRect();
      const color = node => getComputedStyle(node).backgroundColor;
      return { left: box.left, right: box.right, pane: color(pane), workspace: color(document.querySelector('main.workspace')),
        feed: color(document.body) };
    });
    await page.click('#call-board-open');
    let shown = await column();
    assert.ok(shown.left >= 130 && shown.right <= 1310, JSON.stringify(shown));
    assert.equal(shown.pane, 'rgba(0, 0, 0, 0)');
    assert.equal(shown.workspace, shown.feed);
    const board = await page.locator('#call-board').innerText();
    assert.deepEqual(await page.locator('#call-board .board-column-header h3').allTextContents(),
      ['Спросить у клиента', 'Вопросы к вам', 'Риски и возражения', 'Проверка фактов']);
    for (const line of await page.locator('#call-board .board-column-header p').allTextContents()) assert.doesNotMatch(line, /(^|\s)0\s/, line);
    assert.doesNotMatch(board, /стенограм/i);
    assert.doesNotMatch(board, /Подготовка/, 'a tag every card shares is left out');
    const heights = await page.$$eval('#call-board .board-column-header', nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
    assert.equal(new Set(heights).size, 1, `the column rules line up: ${heights}`);
    await page.click('#call-back');
    await page.click('#call-transcript-open');
    shown = await column();
    assert.ok(shown.left >= 240 && shown.right <= 1200, JSON.stringify(shown));
    assert.equal(shown.pane, 'rgba(0, 0, 0, 0)');
    const names = await page.evaluate(() => [getComputedStyle(document.getElementById('speaker-edit')).color, getComputedStyle(document.body).color]);
    assert.equal(names[0], names[1], 'Имена is a normal button, not a disabled-looking one');
    await page.context().close();
  }
  // G5: Earlier lists only lines to say, a question once, one form of source line, and wraps at 400 px.
  for (const lang of ['ru', 'en']) {
    const page = await callPage(browser, 'earlier_open', { lang, data: lang, at, width: 400 });
    await page.click('#call-more');
    await page.click('#call-more-earlier');
    const lines = await page.locator('#call-earlier .earlier-hint').allTextContents();
    assert.ok(lines.includes(lang === 'ru' ? 'Старт в марте или в апреле?' : 'Does the start fall in March or in April?'), lines.join(' | '));
    assert.equal((await page.locator('#call-earlier').innerText()).split(build('earlier_open', lang).state.journal[1].text).length - 1, 1, `${lang}: question once`);
    // One source prefix across Call (G5 addendum): "Источник:" / "Source:", never "Основание" / "Evidence".
    for (const source of await page.locator('#call-earlier .why').allTextContents()) {
      assert.match(source, lang === 'ru' ? /^Источник: \S/ : /^Source: \S/, source);
    }
    assert.doesNotMatch(await page.locator('#call').innerText(), /Основание|Evidence/, lang);
    const clipped = await page.$$eval('#call-earlier .why', nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).length);
    assert.equal(clipped, 0, `${lang}: wrapped, not cut`);
    await page.context().close();
  }
  // The live slot's source line has the same prefix; the memo's line says where it is from by itself; the board's
  // detail uses the same word.
  {
    let page = await ru('hint', { at });
    assert.equal(await text(page, '#call-slot .why'), 'Источник: Анна упомянула комитет, но без имени.');
    await page.click('#call-board-open');
    await page.$$eval('#call-board details', nodes => nodes.forEach(node => { node.open = true; }));
    const board = await page.locator('#call-board').innerText();
    assert.doesNotMatch(board, /Основание/, board);
    assert.match(board, /Источник/);
    await page.context().close();
    page = await ru('memo_question', { at });
    assert.equal(await text(page, '#call-slot .why'), 'Из мемо, вопрос 2');
    await page.context().close();
  }
  // The last phrase heard never opens on half a word at 400 px.
  for (const lang of ['ru', 'en']) {
    const page = await callPage(browser, 'hint', { lang, data: lang, at, width: 400 });
    const phrase = build('hint', lang).state.transcript.segments.at(-1).text;
    const shown = await page.evaluate(() => {
      const words = document.querySelector('#call-heard .heard-words');
      return { text: words.textContent, cut: words.scrollWidth > words.clientWidth + 1 };
    });
    assert.equal(shown.cut, false, `${lang}: fits`);
    const rest = shown.text.replace(/^…/, '');
    assert.ok(phrase.endsWith(rest), `${lang}: ${shown.text}`);
    assert.ok(rest === phrase || phrase[phrase.length - rest.length - 1] === ' ', `${lang}: starts on a word: ${shown.text}`);
    await page.context().close();
  }
}

// Sections H, I and J: critique 3, the re-review and Codex on the fix wave.
async function round3(browser) {
  // J3: a queued question belongs to its meeting; a second one never overwrites the first.
  {
    const page = await callPage(browser, 'hint', { lang: 'ru', data: 'ru' });
    await page.evaluate(() => { requestBusy = true; });
    await page.fill('#call-question', 'Кто подписывает?');
    await page.press('#call-question', 'Enter');
    await page.fill('#call-question', 'Какой бюджет?');
    await page.press('#call-question', 'Enter');
    assert.equal(await page.inputValue('#call-question'), 'Какой бюджет?', 'the second stays in the field');
    assert.equal(await text(page, '#call-note'), 'Один вопрос уже ждет ответа.');
    assert.equal(await text(page, '#call-slot .heard-q'), 'Кто подписывает?');
    await page.evaluate(() => { requestBusy = false; });
    await refresh(page);
    await expectPost(page, '/api/chat', { question: 'Кто подписывает?' });
    assert.equal(posts(page, '/api/chat').length, 1);
    await page.context().close();
  }
  {
    const page = await callPage(browser, 'hint', { lang: 'ru', data: 'ru' });
    await page.evaluate(() => { requestBusy = true; });
    await page.fill('#call-question', 'Кто подписывает?');
    await page.press('#call-question', 'Enter');
    page.api.fixture.state.transcript.meeting_id = 'm2';
    await page.evaluate(() => { requestBusy = false; });
    await refresh(page);
    assert.deepEqual(posts(page, '/api/chat'), [], 'never sent against the next call');
    assert.equal(await text(page, '#call-note'), 'Вопрос не отправлен: звонок сменился.');
    assert.equal(await page.inputValue('#call-question'), 'Кто подписывает?');
    await page.context().close();
  }
  // I4: Chat is reachable from Menu in Call (not on Home), and the Call transcript's error says "расшифровку".
  {
    const page = await callPage(browser, 'hint', { lang: 'ru', data: 'ru' });
    await page.click('#menu-button');
    assert.equal(await text(page, '#menu-chat'), 'Все вопросы и ответы');
    await page.click('#menu-chat');
    assert.equal(await page.evaluate(() => document.body.dataset.callPanel), 'chat');
    assert.equal(await visible(page, '#chat'), true);
    Object.assign(page.api.fixture.state.transcript, { error: 'boom', segments: [] });
    await page.click('#call-back');
    await page.click('#call-transcript-open');
    await refresh(page);
    assert.equal(await text(page, '#transcript strong'), 'Не удалось обновить расшифровку');
    await page.context().close();
  }
  // I1: a failed Ask never locks the slot. A newer hint replaces it, it goes after the error hold, and a stop
  // outranks it, so "Запись сохранена" and the results button always show.
  for (const then of ['hint', 'time', 'stopped_final']) {
    const page = await callPage(browser, 'waiting', { at: Date.now() });
    page.api.responses['/api/chat'] = 'abort';
    await page.fill('#call-question', 'Who signs?');
    await page.press('#call-question', 'Enter');
    const unreachable = await page.evaluate(() => t('error.unreachable'));
    await page.waitForFunction(text => document.getElementById('call-slot').textContent.includes(text), unreachable);
    const state = page.api.fixture.state;
    if (then === 'hint') state.journal = [{ id: 'j-new', category: 'ASK', text: 'Ask who signs off the purchase?', meeting_id: 'm1',
      created_at: new Date(await page.evaluate(() => Date.now()) + 1000).toISOString(), status: 'open' }];
    if (then === 'time') await page.clock.fastForward(STATUS_ERROR_MS_TEST + 1000);
    if (then === 'stopped_final') state.recording_control.last_stop = { meeting_id: 'm1', stopped_at: new Date(await page.evaluate(() => Date.now())).toISOString() };
    if (then === 'hint') await page.clock.fastForward(2000);
    await refresh(page);
    const slot = await text(page, '#call-slot');
    assert.ok(!slot.includes(unreachable), `${then}: ${slot}`);
    if (then === 'hint') assert.equal(await text(page, '#call-slot .hint'), 'Who signs off the purchase?');
    if (then === 'stopped_final') {
      assert.equal(await text(page, '#call-slot p'), 'The recording is saved.');
      assert.equal(await text(page, '#call-slot button'), 'Open the call results');
    }
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
    // ONLY=round3 runs one block of checks while working on it.
    if (process.env.ONLY) { await { round3, polish }[process.env.ONLY](browser); console.log(`${process.env.ONLY} passed`); return; }
    await functions(browser);
    await fixtures(browser);
    await interactions(browser);
    await callBar(browser);
    await narrow(browser);
    await everyFixture(browser);
    await fixWave(browser);
    await polish(browser);
    await round3(browser);
    console.log('call UI checks passed');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
