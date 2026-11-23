// Synthetic After data for the browser checks: invented people and companies only, every time relative to the
// moment a fixture is read. /api/state follows server.py, /api/after the contract (after_state.after_payload).
// The data is English for the checks; the critique renders ask for it in the page's language (`data: 'ru'`).
const { route } = require('./home-fixtures.cjs');

const SEC = 1000;
const MIN = 60 * SEC;
const iso = ms => new Date(ms).toISOString();
const TEXT = {
  en: {
    review: 'Pilot review', anna: 'Anna Petrova', company: 'Example LLC', me: 'Me',
    questions: ['What budget is set for the pilot this year?', 'Who signs off the purchase?', 'Which part of the proposal matters most now?'],
    budget: 'The pilot budget is approved for this year.',
    ask: 'Ask who signs off the purchase?\nEvidence: Anna mentioned a committee but not who decides in it.',
    incoming: 'When can you start the pilot?',
    risk: 'The start slips if the committee does not meet this Thursday.\nEvidence: Anna said the committee decides the purchase.',
    objection: 'Setup is already in the price, there is nothing extra to pay.\nEvidence: Anna compared the price with her own estimate.',
    claim: 'Our pilot last year covered every regional office.', fact: 'Last year the pilot covered two offices out of five.',
    report: 'Pilot report, 12 October',
    march: 'We plan to start in March.', memoStart: 'The pilot starts in April.',
    summary: ['Two offices start the pilot.', 'The committee decides the purchase on Thursday.'],
    refined: ['Two offices start the pilot in March.', 'The committee decides the purchase on Thursday.'],
    next: ['Send the proposal to Anna Petrova by Friday.', 'Agree on the start date after the committee.'],
    said: ['Thanks for joining, shall we start with the pilot scope?', 'Yes, we have two offices ready to begin.'],
  },
  ru: {
    review: 'Обзор пилота', anna: 'Анна Петрова', company: 'ООО Пример', me: 'Вы',
    questions: ['Какой бюджет заложен на пилот в этом году?', 'Кто подписывает закупку?', 'Какая часть предложения сейчас важнее всего?'],
    budget: 'Бюджет на пилот на этот год утвержден.',
    ask: 'Спросите, кто подписывает закупку?\nОснование: Анна упомянула комитет, но не сказала, кто в нем решает.',
    incoming: 'Когда вы сможете начать пилот?',
    risk: 'Старт сдвинется, если комитет не соберется в этот четверг.\nОснование: Анна сказала, что закупку решает комитет.',
    objection: 'Настройка уже входит в цену, доплачивать не нужно.\nОснование: Анна сравнила цену со своей оценкой.',
    claim: 'Наш пилот в прошлом году охватил все региональные офисы.', fact: 'В прошлом году пилот охватил два офиса из пяти.',
    report: 'Отчет о пилоте, 12 октября',
    march: 'Старт у нас в марте.', memoStart: 'Пилот стартует в апреле.',
    summary: ['Пилот начинают два офиса.', 'Комитет решает закупку в четверг.'],
    refined: ['Пилот начинают два офиса в марте.', 'Комитет решает закупку в четверг.'],
    next: ['Отправить предложение Анне Петровой до пятницы.', 'Согласовать дату старта после комитета.'],
    said: ['Спасибо, что подключились, начнем с объема пилота?', 'Да, у нас готовы два офиса.'],
  },
};

const NAMES = ['just_stopped', 'draft', 'refining', 'showing', 'changes', 'held', 'sending', 'sent', 'edited', 'failed',
  'no_channels', 'no_memo', 'memo_failed', 'removed', 'answered_open', 'transcript_open', 'far_end_not_recorded'];

// `after` is the /api/after answer, or a list of answers for successive polls (the last one repeats; null is a 404).
function build(name, lang = 'en', now = Date.now()) {
  const L = TEXT[lang];
  const start = now - 42 * MIN - 14 * SEC; // the stop 4 s ago reads 42:10 on the call's clock
  const stoppedAt = iso(now - 4 * SEC);
  const at = ms => iso(start + ms); // a moment of the call
  const live = name === 'just_stopped';
  const segment = (source, text, ms) => ({ source, speaker: source === 'system' ? L.anna : L.me, text, timestamp: at(ms) });
  const event = (category, text, ms, extra = {}) => ({ id: `j-${category.toLowerCase()}`, category, text, meeting_id: 'm1',
    meeting: L.review, source: 'copilot', created_at: at(ms), status: 'open', logical_event: true, ...extra });
  const items = ['resolved', 'open', 'open'].map((status, index) => ({ id: `q${index + 1}`, kind: 'question',
    text: L.questions[index], status, evidence: '', updated_at: status === 'resolved' ? at(5 * MIN + 20 * SEC) : '', source: '' }));
  const state = {
    preferences: {}, updates: {}, frames: [], frame_capture: {}, meeting_chat: [], repositories: 0, all_repositories: 0,
    project: {}, delivery: { channels: {}, undelivered: [], notifications: [] },
    recording_health: { checked_at: (now - 2 * SEC) / 1000, capture: live
      ? { state: 'recording', audio_recording: true, started_at: iso(start), directory: '/tmp/example-call', pid: 4242,
        tracks: [{ source: 'mic', bytes: 1048576, state: 'recording', last_growth_age_seconds: 1 },
          { source: 'system', bytes: 1048576, state: 'recording', last_growth_age_seconds: 1 }] }
      : { state: 'inactive' } },
    transcript: { meeting_id: 'm1', meeting: L.review, display_meeting: L.review, status: live ? 'recording' : 'finished', live,
      started_at: iso(start), ...(live ? {} : { ended_at: stoppedAt }), updated_at: iso(now - 2 * SEC), latest_at: at(33 * MIN + 40 * SEC),
      segments: [segment('microphone', L.said[0], 20 * SEC), segment('system', L.said[1], 40 * SEC),
        segment('system', L.budget, 5 * MIN + 12 * SEC), segment('system', L.incoming, 12 * MIN + 30 * SEC),
        segment('microphone', L.claim, 30 * MIN), segment('system', L.march, 33 * MIN + 40 * SEC)],
      speakers: [], capture_warnings: [], remote_attendees: [L.anna], meeting_link: 'https://example.com/call/m1',
      error: '', refreshing: false, revision: 1 },
    call_plan: { id: 'plan-1', meeting_id: 'm1', match: 'confirmed', title: L.review, intro: '', source_label: L.company, links: [], items,
      memo_markdown: '', memo_url: '', talk_track_markdown: '', has_memo: false,
      score: { resolved: 1, clarify: 0, total: 3, percent: 33,
        by_kind: { question: { resolved: 1, clarify: 0, total: 3 }, risk: { resolved: 0, clarify: 0, total: 0 }, objection: { resolved: 0, clarify: 0, total: 0 } } } },
    copilot: { messages: [], busy: false, error: '', connected: true, analysis: { state: 'idle' } },
    // The ASK says memo question 2 again: the board lists it once.
    journal: [event('INCOMING_QUESTION', L.incoming, 12 * MIN + 35 * SEC, { speaker: L.anna, direction: 'incoming' }),
      event('ASK', L.ask, 15 * MIN), event('RISK', L.risk, 20 * MIN), event('OBJECTION', L.objection, 25 * MIN)],
    heard_question: null,
    fact_checks: { web: true, provider: '', web_providers: [], items: [{ id: 'fc-1', category: 'FACT_CHECK', source: 'fact_check',
      meeting_id: 'm1', meeting: L.review, created_at: at(30 * MIN + 5 * SEC), status: 'refuted', claim: L.claim, quote: L.claim,
      query: 'pilot offices', segment: { source: 'microphone', speaker: L.me }, timestamp: at(30 * MIN), fact: L.fact,
      sources: [{ kind: 'kb', title: L.report, location: 'https://example.com/pilot-report', quote: L.fact }], checked_at: at(30 * MIN + 20 * SEC) }] },
    recording_control: { stopping: null, last_stop: { meeting_id: 'm1', stopped_at: stoppedAt } },
  };

  const channel = (name, to, status = 'waiting', extra = {}) => ({ channel: name, to, status, at: null, retry_at: null, ...extra });
  const waiting = status => [channel('email', 'owner@example.org', status), channel('telegram', '', status),
    channel('twenty', L.company, status)];
  const memoCheck = { state: 'done',
    questions: [{ id: 'q1', text: L.questions[0], status: 'answered', quote: L.budget, speaker: L.anna, at: at(5 * MIN + 12 * SEC) },
      { id: 'q2', text: L.questions[1], status: 'open', quote: '', speaker: '', at: '' },
      { id: 'q3', text: L.questions[2], status: 'open', quote: '', speaker: '', at: '' }],
    differs: [{ key: 'differs:0123456789ab', memo: L.memoStart, quote: L.march, speaker: L.anna, at: at(33 * MIN + 40 * SEC) }] };
  const payload = (sendState, extra = {}, { final = false, channels = waiting('waiting'), summary = L.summary } = {}) => ({
    // The report's own identity, not the id the page asks with: every POST must name the latter.
    ok: true, meeting_id: 'report-m1', title: L.review, started_at: iso(start), ended_at: stoppedAt, duration_seconds: 2530,
    send: { state: sendState, send_at: null, send_now: false, channels },
    summary: { lines: summary, edited: false, final }, next_steps: { lines: L.next, edited: false, final },
    removed: [], removed_journal: [], memo_check: memoCheck, ...extra });
  const sentAt = iso(now - MIN);
  const sent = [channel('email', 'owner@example.org', 'sent', { at: sentAt }), channel('telegram', '', 'sent', { at: sentAt }),
    channel('twenty', L.company, 'sent', { at: sentAt })];
  const draft = () => payload('draft');
  const afters = {
    just_stopped: () => [null, draft()],
    draft, answered_open: draft, transcript_open: draft,
    refining: () => [draft(), payload('draft', {}, { summary: L.refined })],
    showing: () => payload('showing', { send: { state: 'showing', send_at: iso(now + 30 * SEC), send_now: false, channels: waiting('waiting') } },
      { final: true }),
    changes: () => {
      const result = payload('changes', {}, { final: true });
      result.summary.edited = true;
      return result;
    },
    held: () => payload('held', {}, { channels: waiting('held') }),
    sending: () => payload('sending', {}, { final: true }),
    sent: () => payload('sent', {}, { final: true, channels: sent }),
    edited: () => {
      const result = payload('edited', {}, { final: true, channels: sent });
      result.summary.edited = true;
      return result;
    },
    failed: () => payload('failed', {}, { final: true, channels: [channel('email', 'owner@example.org', 'sent', { at: sentAt }),
      channel('telegram', '', 'failed', { retry_at: iso(now + 14 * MIN) }), channel('twenty', L.company, 'sent', { at: sentAt })] }),
    no_channels: () => payload('no_channels', {}, { channels: [] }),
    no_memo: () => payload('draft', { memo_check: null }),
    memo_failed: () => payload('draft', { memo_check: { state: 'failed', reason: 'timeout' } }),
    removed: () => payload('draft', { removed: ['memo:q2'] }),
    // MEETONTRACK-189 P1-10: the recorder never heard the other side.
    far_end_not_recorded: () => payload('sent', { capture_problems: ['far_end_not_recorded'] }, { final: true, channels: sent }),
  };
  if (name === 'no_memo') state.call_plan = null;
  const permissions = { ok: true, microphone: 'granted', call_audio: 'granted', recorder: live ? 'running' : 'stopped', auto_record: true,
    platform: 'macos' };
  const agenda = { calendar: true, calendar_state: 'connected', skip_recording_supported: false, meetings: [], unscheduled_plans: [] };
  return { state, after: afters[name](), agenda, permissions };
}

// name -> {state, after, agenda, permissions}, rebuilt on every read so the times stay relative to now.
const states = Object.defineProperties({}, Object.fromEntries(NAMES.map(name => [name, { enumerable: true, get: () => build(name) }])));

// A page with the fixture: page.api is the route's recorder (posts, afterPolls, afterGets), page.errors the script errors.
// `just_stopped` opens After by hand, as the Call bar's Open the call results does.
async function open(browser, { fixture, width = 1440, height = 900, scheme = 'light', lang = 'ru', data: dataLang = 'en', at = null }) {
  const origin = 'http://after-ui.test';
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, locale: lang });
  const data = build(fixture, dataLang, at ?? Date.now());
  data.state.preferences.interface_language = lang;
  const api = await route(context, data, origin);
  api.afterPolls = 0;
  api.afterGets = []; // the meeting_id each GET /api/after asked for
  // Registered after `route`, so it answers first; everything else falls back to it.
  await context.route(`${origin}/api/after**`, async request => {
    const url = new URL(request.request().url());
    if (request.request().method() === 'POST') {
      api.posts.push({ path: url.pathname, body: request.request().postDataJSON() });
      const answer = await api.responses[url.pathname];
      if (answer === 'abort') return request.abort();
      if (answer) return request.fulfill({ status: answer.status, json: answer.json });
      return request.fulfill({ json: url.pathname === '/api/after/edit' ? { ok: true, send_at: iso(Date.now() + 30 * SEC) } : { ok: true } });
    }
    if (url.pathname !== '/api/after') return request.fallback();
    api.afterGets.push(url.searchParams.get('meeting_id'));
    const list = Array.isArray(api.fixture.after) ? api.fixture.after : [api.fixture.after];
    const answer = list[Math.min(api.afterPolls++, list.length - 1)];
    return answer ? request.fulfill({ json: answer }) : request.fulfill({ status: 404, json: { ok: false, error: 'not_found' } });
  });
  // The delivery job that Send again and Retry start: `api.job` is its state (idle until a check sets it).
  await context.route(`${origin}/api/delivery/job`, request => request.fulfill({ json: { ok: true, job: api.job || { state: 'idle' } } }));
  await context.addInitScript(({ lang, manual }) => {
    localStorage.setItem('meetontrack-started', '1');
    localStorage.setItem('meeting-copilot-language', lang);
    if (manual) localStorage.setItem('meetontrack-view', JSON.stringify({ view: 'after', key: 'true:m1', at: Date.now() }));
  }, { lang, manual: fixture === 'just_stopped' });
  const page = await context.newPage();
  page.api = api;
  page.errors = [];
  page.on('pageerror', error => page.errors.push(String(error.stack || error)));
  if (at !== null) await page.clock.install({ time: at });
  await page.goto(`${origin}/`);
  return page;
}

module.exports = { states, build, open, NAMES };
