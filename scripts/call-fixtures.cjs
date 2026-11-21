// Synthetic live-call data for the Call view checks: invented people and companies only, every time
// relative to the moment a fixture is read. Shapes follow the real /api/state payload (server.py), the
// capture health of recording_health.py and the stop state of recording_control.py.
// The data is English for the checks; the critique renders ask for it in the page's language (`data: 'ru'`).
const { route } = require('./home-fixtures.cjs');

const SEC = 1000;
const MIN = 60 * SEC;
const iso = ms => new Date(ms).toISOString();
const TEXT = {
  en: {
    review: 'Pilot review', anna: 'Anna Petrova', company: 'Example LLC', me: 'Me',
    questions: ['What budget is set for the pilot this year?', 'Who signs off the purchase?', 'Which part of the proposal matters most now?'],
    ask: 'Ask who signs off the purchase?\nEvidence: Anna mentioned a committee but no name.',
    risk: 'The start date slips if the contract waits for the committee.\nSource: Anna, 12:31',
    objection: 'The price looks high next to their own estimate.',
    contradiction: 'Anna said two offices, the memo says five.\nSource: memo, background',
    claim: 'Our pilot last year covered every regional office.', fact: 'Last year the pilot covered two offices out of five.',
    incoming: 'When can you start the pilot?', reply: 'We can start on the first Monday after the contract is signed.',
    heard: 'How long does the setup take on our side?',
    own: 'What did Anna say about the budget?', ownAnswer: 'Anna said the budget is approved for one quarter and needs the committee to extend it.',
    said: ['Thanks for joining, shall we start with the pilot scope?', 'Yes, we have two offices ready to begin.',
      'Who else needs to see the proposal before it is signed?', 'The committee meets on Thursdays, so that is the earliest.'],
    long: 'Ask whether the regional offices that join the pilot later will keep the same price and the same start conditions as the first two offices',
  },
  ru: {
    review: 'Обзор пилота', anna: 'Анна Петрова', company: 'ООО Пример', me: 'Я',
    questions: ['Какой бюджет заложен на пилот в этом году?', 'Кто подписывает закупку?', 'Какая часть предложения сейчас важнее всего?'],
    ask: 'Спросите, кто подписывает закупку?\nОснование: Анна упомянула комитет, но без имени.',
    risk: 'Старт сдвинется, если договор будет ждать комитет.\nИсточник: Анна, 12:31',
    objection: 'Цена кажется высокой рядом с их собственной оценкой.',
    contradiction: 'Анна сказала про два офиса, в мемо пять.\nИсточник: мемо, контекст',
    claim: 'Наш пилот в прошлом году охватил все региональные офисы.', fact: 'В прошлом году пилот охватил два офиса из пяти.',
    incoming: 'Когда вы сможете начать пилот?', reply: 'Можем начать в первый понедельник после подписания договора.',
    heard: 'Сколько времени занимает настройка с нашей стороны?',
    own: 'Что Анна сказала про бюджет?', ownAnswer: 'Анна сказала, что бюджет утвержден на квартал и для продления нужен комитет.',
    said: ['Спасибо, что подключились, начнем с объема пилота?', 'Да, у нас готовы два офиса.',
      'Кто еще должен увидеть предложение до подписания?', 'Комитет собирается по четвергам, раньше не получится.'],
    long: 'Спросите, сохранятся ли для региональных офисов, которые подключатся к пилоту позже, та же цена и те же условия старта, что и для первых двух офисов',
  },
};

// recording_health.py:169-174: any stalled track makes the capture stalled and not recording.
function capture(now, tracks) {
  const states = new Set(tracks.map(track => track.state));
  const state = !tracks.length ? 'inactive' : states.has('stalled') ? 'stalled' : states.has('verifying') ? 'verifying' : 'recording';
  return { state, audio_recording: state === 'recording', tracks,
    ...(tracks.length ? { started_at: iso(now - 12 * MIN - 40 * SEC), directory: '/tmp/example-call', pid: 4242 } : {}) };
}
const track = (source, state = 'recording', age = 1) => ({ source, bytes: 1048576, state, last_growth_age_seconds: age });

function build(name, lang = 'en', now = Date.now()) {
  const L = TEXT[lang];
  const ago = ms => iso(now - ms);
  const segment = (source, text, age, extra = {}) => ({ source, speaker: source === 'system' ? L.anna : L.me,
    text, timestamp: ago(age), ...extra });
  const event = (category, text, age, extra = {}) => ({ id: `j-${category}-${age}`, category, text, meeting_id: 'm1',
    meeting: L.review, source: 'copilot', created_at: ago(age), logical_event: true, ...extra });
  const planItem = (index, status = 'open') => ({ id: `q${index + 1}`, kind: 'question', text: L.questions[index], status,
    evidence: '', updated_at: '', source: '' });
  const plan = statuses => ({ id: 'plan-1', meeting_id: 'm1', match: 'confirmed', title: L.review, intro: '',
    source_label: L.company, links: [], items: statuses.map((status, index) => planItem(index, status)) });
  const refuted = age => ({ id: `fc-${age}`, category: 'FACT_CHECK', source: 'fact_check', meeting_id: 'm1', meeting: L.review,
    created_at: ago(age + 20 * SEC), status: 'refuted', claim: L.claim, quote: L.claim, query: 'pilot offices',
    segment: { source: 'system', speaker: L.anna }, timestamp: ago(age + 25 * SEC), fact: L.fact,
    sources: [{ kind: 'web', url: 'https://example.com/pilot-report', quote: L.fact }], checked_at: ago(age) });

  const segments = [segment('microphone', L.said[0], 50 * SEC), segment('system', L.said[1], 40 * SEC),
    segment('microphone', L.said[2], 20 * SEC), segment('system', L.said[3], 6 * SEC)];
  const state = {
    preferences: {}, updates: {}, frames: [], frame_capture: {}, meeting_chat: [], repositories: 0, all_repositories: 0,
    project: {}, delivery: { channels: {}, undelivered: [], notifications: [] },
    recording_health: { checked_at: (now - 2 * SEC) / 1000, capture: capture(now, [track('mic'), track('system')]) },
    transcript: { meeting_id: 'm1', meeting: L.review, display_meeting: L.review, status: 'recording', live: true,
      started_at: ago(12 * MIN + 40 * SEC), updated_at: ago(2 * SEC), latest_at: ago(6 * SEC), latest_age_seconds: 2,
      segments, speakers: [], capture_warnings: [], remote_attendees: [L.anna], meeting_link: 'https://example.com/call/m1',
      error: '', refreshing: false, revision: 1 },
    call_plan: plan(['resolved', 'open', 'open']),
    copilot: { messages: [], busy: false, error: '', connected: true, analysis: { state: 'signal', at: ago(15 * SEC), message: '' } },
    journal: [], heard_question: null, fact_checks: { items: [], web: true, provider: '', web_providers: [] },
    recording_control: { stopping: null, last_stop: null },
  };
  const older = () => [event('RISK', L.risk, 3 * MIN), event('INCOMING_QUESTION', L.incoming, 2 * MIN, { reply: L.reply, speaker: L.anna,
    evidence: L.incoming, direction: 'incoming' }), event('ASK', L.ask, 90 * SEC)];
  const hint = () => { state.journal = [event('ASK', L.ask, 5 * SEC), event('OBJECTION', L.objection, 4 * MIN)]; };
  const setups = {
    hint,
    // The other side asked, and the analysis has a line to answer with.
    answer: () => { state.journal = [event('INCOMING_QUESTION', L.incoming, 8 * SEC, { reply: L.reply, speaker: L.anna,
      evidence: L.incoming, direction: 'incoming' })]; segments.push(segment('system', L.incoming, 12 * SEC)); },
    // A question heard, the analysis not done with it yet.
    heard: () => { segments.push(segment('system', L.heard, 4 * SEC)); state.copilot.busy = true;
      state.heard_question = { text: L.heard, speaker: L.anna, at: ago(4 * SEC) }; },
    // Nothing fresh: the next open memo question (question 1 is resolved).
    memo_question: () => { state.journal = older(); },
    // Recording and heard, nothing to say yet, no memo.
    waiting: () => { state.call_plan = null; },
    // The analysis failed: hints pause, the recording goes on.
    paused_ai: () => { state.call_plan = null;
      state.copilot.analysis = { state: 'error', at: ago(20 * SEC), message: 'AI_TIMEOUT: no answer within the limit' }; },
    // The call audio stopped growing 40 s ago, and the transcript carries the open gap.
    other_lost: () => { hint(); state.recording_health.capture = capture(now, [track('mic'), track('system', 'stalled', 40)]);
      state.transcript.capture_warnings = [{ reason: 'system-audio-lost', started_at: ago(40 * SEC) }]; },
    you_lost: () => { hint(); state.recording_health.capture = capture(now, [track('mic', 'stalled', 50), track('system')]); },
    // An own question sent, the answer not back yet.
    own_pending: () => { hint(); state.copilot.busy = true;
      state.copilot.messages = [{ role: 'user', text: L.own, kind: 'chat', meeting_id: 'm1', at: ago(3 * SEC) }]; },
    own_answer: () => { hint(); state.copilot.messages = [{ role: 'user', text: L.own, kind: 'chat', meeting_id: 'm1', at: ago(12 * SEC) },
      { role: 'assistant', text: L.ownAnswer, kind: 'chat', meeting_id: 'm1', at: ago(5 * SEC) }]; },
    // Earlier hints to open: older events and a refuted fact, the memo question current.
    earlier_open: () => { state.journal = [...older(), event('CONTRADICTION', L.contradiction, 70 * SEC)];
      state.fact_checks.items = [refuted(60 * SEC)]; },
    // Stop pressed 10 s ago: the recorder is paused, the stop lands in 20 s.
    stopped: () => { hint(); state.recording_control.stopping = { meeting_id: 'm1', stopped_at: ago(10 * SEC), until: iso(now + 20 * SEC) }; },
    // A recorder without pause stopped at once; the call still reads live until the recorder's last write ages out.
    stopped_final: () => { hint(); state.recording_control.last_stop = { meeting_id: 'm1', stopped_at: ago(4 * SEC) }; },
    more_open: hint,
    transcript_open: hint,
    board_open: hint,
    long_hint: () => { state.journal = [event('ASK', L.long, 5 * SEC)]; },
    // A recorder that writes no capture marker (Windows today): no tracks, the system segment 30 s old.
    windows_no_tracks: () => { hint(); state.recording_health.capture = capture(now, []);
      state.transcript.segments = [segment('microphone', L.said[0], 50 * SEC), segment('system', L.said[1], 30 * SEC)]; },
    // A quiet partner: the call audio track grows, nobody on that side has spoken for 5 minutes.
    silent_partner: () => { hint(); state.transcript.segments = [segment('system', L.said[1], 5 * MIN),
      segment('microphone', L.said[0], 3 * SEC)]; },
  };
  setups[name]();
  const permissions = { ok: true, microphone: 'granted', call_audio: 'granted', recorder: 'running', auto_record: true,
    platform: name === 'windows_no_tracks' ? 'windows' : 'macos' };
  const agenda = { calendar: true, calendar_state: 'connected', skip_recording_supported: false, meetings: [], unscheduled_plans: [] };
  return { state, agenda, permissions };
}

const NAMES = ['hint', 'answer', 'heard', 'memo_question', 'waiting', 'paused_ai', 'other_lost', 'you_lost', 'own_pending',
  'own_answer', 'earlier_open', 'stopped', 'stopped_final', 'more_open', 'transcript_open', 'board_open', 'long_hint',
  'windows_no_tracks', 'silent_partner'];
// name -> {state, agenda, permissions}, rebuilt on every read so the times stay relative to now.
const states = Object.defineProperties({}, Object.fromEntries(NAMES.map(name => [name, { enumerable: true, get: () => build(name) }])));

// A page with the fixture: page.api is the route's recorder, page.errors the script errors.
// `at` pins both clocks: the fixture is built for that moment and the page's clock starts there (and runs on).
async function open(browser, { fixture, width = 1440, scheme = 'light', lang = 'ru', data: dataLang = 'en', at = null }) {
  const origin = 'http://call-ui.test';
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale: lang });
  const data = build(fixture, dataLang, at ?? Date.now());
  data.state.preferences.interface_language = lang;
  const api = await route(context, data, origin);
  await context.addInitScript(lang => {
    localStorage.setItem('meetontrack-started', '1');
    localStorage.setItem('meeting-copilot-language', lang);
  }, lang);
  const page = await context.newPage();
  page.api = api;
  page.errors = [];
  page.on('pageerror', error => page.errors.push(String(error.stack || error)));
  if (at !== null) await page.clock.install({ time: at });
  await page.goto(`${origin}/`);
  return page;
}

module.exports = { states, build, open, NAMES };
