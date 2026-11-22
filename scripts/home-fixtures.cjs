// Synthetic Home data for the browser checks: invented people and companies only, every time
// relative to the moment a fixture is read, so the checks pass on any day and in any time zone.
// The data is English for the checks; the critique renders ask for it in the page's language (`data: 'ru'`).
const fs = require('node:fs/promises');
const path = require('node:path');

const MIN = 60000;
const root = path.resolve(__dirname, '../copilot/web');
const iso = ms => new Date(ms).toISOString();
const me = { name: 'Me', email: 'me@example.com', self: true };
const nina = { name: '', email: 'nina@example.org', self: false };
// Every text of the fixtures, in English (the checks) and Russian (the critique renders of the RU page).
const TEXT = {
  en: {
    anna: 'Anna Petrova', company: 'Example LLC', oleg: 'Oleg Ivanov', review: 'Pilot review', supply: 'Supply accounting intro',
    first: 'First talk about the pilot', sync: 'Example LLC sync', followup: 'Pilot follow-up', focus: 'Focus time',
    draft: 'Contract draft review', draftText: 'Check the draft before sending it.',
    goal: 'Agree on the pilot scope and the start date',
    questions: ['What budget is set for the pilot this year?', 'Who signs off the purchase?', 'Which part of the proposal matters most now?'],
    fourth: 'A fourth question that the digest leaves out?', background: 'The last proposal went out a week ago and has no answer yet.',
    memoGoal: 'Agree on the **pilot scope** and the start date with [Example LLC](https://example.com/llc).',
    questionsHeading: 'Questions', backgroundHeading: 'Background', thread: 'See the thread: https://example.org/history', links: ['Proposal', 'Notes'],
    longTitle: 'Quarterly review of the supply accounting pilot with every regional office and the central procurement team',
    longGoal: 'Agree on the pilot scope, ', longQuestion: 'Which offices will join the pilot first and why',
    longBackground: 'A long background line that keeps going ', participant: n => `Participant Number${n} Longsurname`,
  },
  ru: {
    anna: 'Анна Петрова', company: 'ООО Пример', oleg: 'Олег Иванов', review: 'Обзор пилота', supply: 'Знакомство по учету поставок',
    first: 'Первый разговор о пилоте', sync: 'Встреча с ООО Пример', followup: 'Продолжение по пилоту', focus: 'Время без встреч',
    draft: 'Проверка черновика договора', draftText: 'Проверить черновик перед отправкой.',
    goal: 'Согласовать объем пилота и дату старта',
    questions: ['Какой бюджет заложен на пилот в этом году?', 'Кто подписывает закупку?', 'Какая часть предложения сейчас важнее всего?'],
    fourth: 'Четвертый вопрос, которого нет в кратком мемо?', background: 'Последнее предложение ушло неделю назад, ответа пока нет.',
    memoGoal: 'Согласовать **объем пилота** и дату старта с [ООО Пример](https://example.com/llc).',
    questionsHeading: 'Вопросы', backgroundHeading: 'Контекст', thread: 'Переписка: https://example.org/history', links: ['Предложение', 'Заметки'],
    longTitle: 'Квартальный обзор пилота по учету поставок со всеми региональными офисами и центральной службой закупок',
    longGoal: 'Согласовать объем пилота, ', longQuestion: 'Какие офисы подключатся к пилоту первыми и почему',
    longBackground: 'Длинная строка контекста, которая все продолжается ', participant: n => `Участник Номер${n} Длиннофамильный`,
  },
};

const memo = (state, extra = {}) => ({ state, goal: '', questions: [], background: '', source_count: 0, plan_id: '',
  written_by: 'app', since: null, reason: '', retry_at: null, ...extra });
const plan = (id, title, markdown, links = []) => ({ id, title, source_label: 'Example LLC', links,
  memo_markdown: markdown, memo_url: '', talk_track_markdown: '', has_memo: Boolean(markdown) });
const meeting = (id, start, minutes, title, attendees, extra = {}) => ({ event_id: id, start: iso(start),
  end: iso(start + minutes * MIN), title, link: `https://example.com/call/${id}`, attendees: [me, ...attendees],
  plans: [], skip_recording: false, ...extra });

// The full memo: a title heading, the goal, the questions (three of them in the digest), a background section.
const memoText = L => [
  `# ${L.review}`, '', L.memoGoal, '',
  `## ${L.questionsHeading}`, ...L.questions.map(question => `- ${question}`), `- ${L.fourth}`, '',
  `## ${L.backgroundHeading}`, L.background, L.thread,
].join('\n');
const links = L => [{ label: L.links[0], url: 'https://example.com/proposal' }, { label: L.links[1], url: 'https://example.org/notes' }];

function build(name, lang = 'en', now = Date.now()) {
  const L = TEXT[lang];
  const MEMO_TEXT = memoText(L);
  const LINKS = links(L);
  const anna = { name: L.anna, email: 'anna@example.com', company: L.company, self: false };
  const oleg = { name: L.oleg, email: 'oleg@example.org', self: false };
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  const at10 = tomorrow.getTime();
  const ready = (extra = {}) => meeting('evt-ready', now + 40 * MIN, 30, L.review, [anna], {
    plans: [plan('plan-1', L.review, MEMO_TEXT, LINKS)],
    memo: memo('ready', { goal: L.goal, plan_id: 'plan-1', source_count: 2, questions: L.questions, background: L.background }),
    ...extra });
  // Started 2 minutes ago unless told otherwise; past 5 minutes the row says it takes longer than usual.
  const preparing = (start, id = 'evt-prep', since = now - 2 * MIN) => meeting(id, start, 45, L.supply, [oleg],
    { memo: memo('preparing', { since: iso(since) }) });
  // Tomorrow at 10:00 local time: always on the next calendar day, so it always crosses midnight.
  const nothing = (start, id = 'evt-nothing') => meeting(id, start, 30, L.first, [nina],
    { memo: memo('nothing_found') });
  // As shipped (R35): the server never offers "Do not record". SEAMS below switch the skip code on explicitly.
  const agenda = (meetings, extra = {}) => ({ calendar: true, calendar_state: 'connected', skip_recording_supported: false,
    meetings: meetings.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), unscheduled_plans: [], ...extra });
  const agendas = {
    ready: () => agenda([ready(), preparing(now + 120 * MIN), nothing(at10)]),
    preparing: () => agenda([preparing(now + 40 * MIN, 'evt-prep', now - 8 * MIN), preparing(now + 60 * MIN, 'evt-prep-fresh'), nothing(at10),
      meeting('evt-prep-3', now + 90 * MIN, 30, L.sync, [anna], { memo: memo('preparing') })]),
    nothing_found: () => agenda([nothing(now + 40 * MIN), preparing(at10, 'evt-prep-2')]),
    failed: () => agenda([
      meeting('evt-failed', now + 40 * MIN, 30, L.supply, [oleg],
        { memo: memo('failed', { reason: 'ai_no_answer', retry_at: iso(now + 20 * MIN) }) }),
      meeting('evt-choice', now + 180 * MIN, 30, L.followup, [anna],
        { memo: memo('failed', { reason: 'ai_needs_choice', retry_at: iso(now + 30 * MIN) }) }),
    ]),
    skipped: () => agenda([ready({ skip_recording: true }), nothing(at10)], { skip_recording_supported: true }),
    skip_seam: () => agenda([ready(), preparing(now + 120 * MIN), nothing(at10)], { skip_recording_supported: true }),
    adapter: () => {
      const strip = item => { delete item.memo; return item; };
      return agenda([
        strip(ready()),
        strip(meeting('evt-ext', now + 150 * MIN, 30, L.followup, [oleg])),
        // Solo blocks have no call link: one without a plan is not a Home row, one with a plan is.
        strip(meeting('evt-solo', at10, 60, L.focus, [], { link: '' })),
        meeting('evt-solo-plan', at10 + 120 * MIN, 30, L.sync, [], { link: '', plans: [plan('plan-3', L.sync, L.draftText)],
          memo: memo('ready', { goal: L.draftText, plan_id: 'plan-3' }) }),
      ], { unscheduled_plans: [plan('plan-2', L.draft, L.draftText)] });
    },
    long: () => {
      const people = Array.from({ length: 10 }, (_, index) => ({ name: L.participant(index + 1),
        email: `participant.number${index + 1}.with.a.long.address@subdomain.example.org`, self: false }));
      const goal = L.longGoal.repeat(12).slice(0, 300);
      return agenda([
        meeting('evt-long', now + 40 * MIN, 60, L.longTitle,
          people, { memo: memo('ready', { goal, questions: [Array(6).fill(L.longQuestion).join(', ') + '?'],
            background: L.longBackground.repeat(8), source_count: 2, plan_id: 'plan-long' }),
          plans: [plan('plan-long', 'Long', MEMO_TEXT)] }),
        nothing(at10),
      ]);
    },
    calendar_off: () => agenda([], { calendar: false, calendar_state: 'not_connected' }),
    calendar_off_with_plans: () => agenda([], { calendar: false, calendar_state: 'not_connected',
      unscheduled_plans: [plan('plan-2', L.draft, L.draftText)] }),
    tool_missing: () => agenda([], { calendar: false, calendar_state: 'tool_missing', skip_recording_supported: false }),
    no_meetings: () => agenda([]),
    load_failed: () => null, // /api/agenda answers 500
    mic_missing: () => agenda([ready(), nothing(at10)]),
    mic_missing_delivery: () => agenda([ready(), nothing(at10)]),
    // Started 5 minutes ago and still nothing recorded.
    not_recording: () => agenda([ready({ start: iso(now - 5 * MIN), end: iso(now + 25 * MIN) }), nothing(at10)]),
    // The next call's memo opened (the check and the critique renders press Open memo first).
    ready_memo_open: () => agenda([ready(), preparing(now + 120 * MIN), nothing(at10)]),
    // Loaded once, then a refresh failed (the runner and the renders fail it after the first load).
    stale: () => agenda([ready(), preparing(now + 120 * MIN), nothing(at10)]),
    menu_open: () => agenda([ready(), nothing(at10)]),
    menu_narrow: () => agenda([ready(), nothing(at10)]),
    keys: () => agenda([ready(), nothing(at10)]),
  };
  const permissions = { microphone: 'granted', call_audio: 'granted', recorder: 'running',
    ...{ mic_missing: { microphone: 'denied', platform: 'macos' }, mic_missing_delivery: { microphone: 'denied', platform: 'windows' },
      not_recording: { recorder: 'stopped' } }[name] };
  const state = { preferences: {}, journal: [], frames: [], project: {}, updates: {},
    delivery: { channels: {}, undelivered: [], notifications: [] },
    transcript: { meeting_id: '', status: 'idle', live: false, segments: [], speakers: [] },
    recording_health: { capture: { state: 'inactive' } }, copilot: { busy: false, analysis: { state: 'idle' }, messages: [] } };
  // A report that did not reach its channel: the delivery pill joins the bar.
  if (name === 'mic_missing_delivery') Object.assign(state.delivery, { channels: { gmail: { configured: true, state: 'sent', issues: [] } },
    undelivered: [{ meeting_id: 'm9', channels: ['email'], title: L.review, started_at: iso(now - 24 * 60 * MIN) }] });
  return { agenda: agendas[name](), state, permissions };
}

// name -> {agenda, state, permissions}, rebuilt on every read so the times stay relative to now.
const states = Object.defineProperties({}, Object.fromEntries(
  ['ready', 'ready_memo_open', 'stale', 'preparing', 'nothing_found', 'failed', 'skipped', 'skip_seam', 'adapter', 'long',
    'calendar_off', 'calendar_off_with_plans', 'tool_missing', 'no_meetings', 'load_failed',
    'mic_missing', 'mic_missing_delivery', 'not_recording', 'menu_open', 'menu_narrow', 'keys']
    .map(name => [name, { enumerable: true, get: () => build(name) }])));

// Serves the real UI files and the fixture. The returned object records POST bodies; a test can set
// `responses[path]` to {status, json}, 'abort' or a promise of either, and `gate` to a promise that holds back
// /api/agenda. A fixture without an agenda makes /api/agenda answer 500. `clock` installs a fake page clock that many milliseconds ahead of now.
async function route(context, fixture, origin) {
  const api = { fixture, posts: [], responses: {}, gate: null, permissionReads: [] };
  await context.route(`${origin}/**`, async request => {
    const url = new URL(request.request().url());
    if (request.request().method() === 'POST' && url.pathname.startsWith('/api/')) {
      api.posts.push({ path: url.pathname, body: request.request().postDataJSON() });
      const answer = await api.responses[url.pathname]; // a promise holds the answer back
      if (answer === 'abort') return request.abort();
      return request.fulfill(answer ? { status: answer.status, json: answer.json } : { json: { ok: true } });
    }
    if (url.pathname === '/api/state') return request.fulfill({ json: api.fixture.state });
    if (url.pathname === '/api/agenda') {
      await api.gate;
      if (!api.fixture.agenda) return request.fulfill({ status: 500, json: { ok: false, error: 'boom' } });
      return request.fulfill({ json: { ok: true, ...api.fixture.agenda } });
    }
    if (url.pathname === '/api/permissions') {
      api.permissionReads.push(url.search);
      return request.fulfill({ json: api.fixture.permissions });
    }
    // Google is connected exactly when the calendar is read (calendar_meetings reads only a connected Google).
    if (url.pathname === '/api/google-context') {
      const connected = api.fixture.agenda?.calendar_state === 'connected';
      return request.fulfill({ json: { ok: true, connected, client_configured: true, account: connected ? 'me@example.com' : '',
        sources: { calendar: connected, gmail: false, drive: false } } });
    }
    // The guide's speech step reads the engines on open: the server always lists them (none here).
    if (url.pathname === '/api/stt/options') return request.fulfill({ json: { ok: true, engines: [] } });
    if (url.pathname.startsWith('/api/')) return request.fulfill({ json: { ok: true } });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (file.includes('/') || !/\.(html|js|css)$/.test(file)) return request.abort();
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    return request.fulfill({ contentType: type, body: await fs.readFile(path.join(root, file)) });
  });
  return api;
}

// A page on Home with the fixture: page.api is the route's recorder, page.errors the script errors.
// `at` pins both clocks: the fixture is built for that moment and the page's clock starts there (and runs on).
async function open(browser, { fixture, width = 1440, scheme = 'light', lang = 'ru', data: dataLang = 'en', gate = null, clock = null, at = null }) {
  const origin = 'http://home-ui.test';
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale: lang });
  const data = build(fixture, dataLang, at ?? Date.now());
  data.state.preferences.interface_language = lang;
  const api = await route(context, data, origin);
  api.gate = gate;
  await context.addInitScript(lang => {
    localStorage.setItem('meetontrack-started', '1');
    localStorage.setItem('meeting-copilot-language', lang);
  }, lang);
  const page = await context.newPage();
  page.api = api;
  page.errors = [];
  page.on('pageerror', error => page.errors.push(String(error.stack || error)));
  if (clock !== null) await page.clock.install({ time: Date.now() + clock });
  if (at !== null) await page.clock.install({ time: at });
  await page.goto(`${origin}/`);
  return page;
}

// Fixtures that switch on the "Do not record" code kept for MEETONTRACK-173 (a test seam; never shipped, never rendered).
const SEAMS = ['skipped', 'skip_seam'];

// A refresh after the first load fails: the rows stay, marked as not current.
async function goStale(page) {
  page.api.fixture.agenda = null;
  await page.evaluate(() => refreshAgenda());
  await page.locator('#home .stale').waitFor();
}

module.exports = { states, build, route, open, SEAMS, goStale };
