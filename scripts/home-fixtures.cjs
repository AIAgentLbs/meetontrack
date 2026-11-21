// Synthetic Home data for the browser checks: invented people and companies only, every time
// relative to the moment a fixture is read, so the checks pass on any day and in any time zone.
const fs = require('node:fs/promises');
const path = require('node:path');

const MIN = 60000;
const root = path.resolve(__dirname, '../copilot/web');
const iso = ms => new Date(ms).toISOString();
const me = { name: 'Me', email: 'me@example.com', self: true };
const anna = { name: 'Anna Petrova', email: 'anna@example.com', company: 'Example LLC', self: false };
const oleg = { name: 'Oleg Ivanov', email: 'oleg@example.org', self: false };
const nina = { name: '', email: 'nina@example.org', self: false };

const memo = (state, extra = {}) => ({ state, goal: '', questions: [], background: '', source_count: 0, plan_id: '',
  written_by: 'app', since: null, reason: '', retry_at: null, ...extra });
const plan = (id, title, markdown, links = []) => ({ id, title, source_label: 'Example LLC', links,
  memo_markdown: markdown, memo_url: '', talk_track_markdown: '', has_memo: Boolean(markdown) });
const meeting = (id, start, minutes, title, attendees, extra = {}) => ({ event_id: id, start: iso(start),
  end: iso(start + minutes * MIN), title, link: `https://example.com/call/${id}`, attendees: [me, ...attendees],
  plans: [], skip_recording: false, ...extra });

const MEMO_TEXT = [
  '# Pilot review', '', 'Agree on the **pilot scope** and the start date with [Example LLC](https://example.com/llc).', '',
  '## Questions', '- What budget is set for the pilot this year?', '- Who signs off the purchase?',
  '- Which part of the proposal matters most now?', '- A fourth question that the digest leaves out?',
].join('\n');
const LINKS = [{ label: 'Proposal', url: 'https://example.com/proposal' }, { label: 'Notes', url: 'https://example.org/notes' }];

function build(name) {
  const now = Date.now();
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(10, 0, 0, 0);
  const at10 = tomorrow.getTime();
  const ready = (extra = {}) => meeting('evt-ready', now + 40 * MIN, 30, 'Pilot review', [anna], {
    plans: [plan('plan-1', 'Pilot review', MEMO_TEXT, LINKS)],
    memo: memo('ready', { goal: 'Agree on the pilot scope and the start date', plan_id: 'plan-1', source_count: 2,
      questions: ['What budget is set for the pilot this year?', 'Who signs off the purchase?',
        'Which part of the proposal matters most now?'],
      background: 'The last proposal went out a week ago and has no answer yet.' }), ...extra });
  const preparing = (start, id = 'evt-prep') => meeting(id, start, 45, 'Supply accounting intro', [oleg],
    { memo: memo('preparing', { since: iso(now - 5 * MIN) }) });
  // Tomorrow at 10:00 local time: always on the next calendar day, so it always crosses midnight.
  const nothing = (start, id = 'evt-nothing') => meeting(id, start, 30, 'First talk about the pilot', [nina],
    { memo: memo('nothing_found') });
  const agenda = (meetings, extra = {}) => ({ calendar: true, calendar_state: 'connected', skip_recording_supported: true,
    meetings: meetings.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)), unscheduled_plans: [], ...extra });
  const agendas = {
    ready: () => agenda([ready(), preparing(now + 120 * MIN), nothing(at10)]),
    preparing: () => agenda([preparing(now + 40 * MIN), nothing(at10),
      meeting('evt-prep-3', now + 90 * MIN, 30, 'Example LLC sync', [anna], { memo: memo('preparing') })]),
    nothing_found: () => agenda([nothing(now + 40 * MIN), preparing(at10, 'evt-prep-2')]),
    failed: () => agenda([
      meeting('evt-failed', now + 40 * MIN, 30, 'Supply accounting intro', [oleg],
        { memo: memo('failed', { reason: 'ai_no_answer', retry_at: iso(now + 20 * MIN) }) }),
      meeting('evt-choice', now + 180 * MIN, 30, 'Pilot follow-up', [anna],
        { memo: memo('failed', { reason: 'ai_needs_choice', retry_at: iso(now + 30 * MIN) }) }),
    ]),
    skipped: () => agenda([ready({ skip_recording: true }), nothing(at10)]),
    adapter: () => {
      const strip = item => { delete item.memo; return item; };
      return agenda([
        strip(ready()),
        strip(meeting('evt-ext', now + 150 * MIN, 30, 'Pilot follow-up', [oleg])),
        strip(meeting('evt-solo', at10, 60, 'Focus time', [])),
      ], { unscheduled_plans: [plan('plan-2', 'Contract draft review', 'Check the draft before sending it.')] });
    },
    no_skip_support: () => agenda([ready(), preparing(now + 120 * MIN)], { skip_recording_supported: false }),
    long: () => {
      const people = Array.from({ length: 10 }, (_, index) => ({ name: `Participant Number${index + 1} Longsurname`,
        email: `participant.number${index + 1}.with.a.long.address@subdomain.example.org`, self: false }));
      const goal = 'Agree on the pilot scope, '.repeat(12).slice(0, 300);
      return agenda([
        meeting('evt-long', now + 40 * MIN, 60,
          'Quarterly review of the supply accounting pilot with every regional office and the central procurement team',
          people, { memo: memo('ready', { goal, questions: [Array(6).fill('Which offices will join the pilot first and why').join(', ') + '?'],
            background: 'A long background line that keeps going '.repeat(8), source_count: 2, plan_id: 'plan-long' }),
          plans: [plan('plan-long', 'Long', MEMO_TEXT)] }),
        nothing(at10),
      ]);
    },
    calendar_off: () => agenda([], { calendar: false, calendar_state: 'not_connected' }),
    calendar_off_with_plans: () => agenda([], { calendar: false, calendar_state: 'not_connected',
      unscheduled_plans: [plan('plan-2', 'Contract draft review', 'Check the draft before sending it.')] }),
    tool_missing: () => agenda([], { calendar: false, calendar_state: 'tool_missing', skip_recording_supported: false }),
    no_meetings: () => agenda([]),
    load_failed: () => null, // /api/agenda answers 500
    mic_missing: () => agenda([ready(), nothing(at10)]),
    mic_missing_delivery: () => agenda([ready(), nothing(at10)]),
    // Started 5 minutes ago and still nothing recorded.
    not_recording: () => agenda([ready({ start: iso(now - 5 * MIN), end: iso(now + 25 * MIN) }), nothing(at10)]),
    menu_open: () => agenda([ready(), nothing(at10)]),
    menu_narrow: () => agenda([ready(), nothing(at10)]),
    keys: () => agenda([ready(), nothing(at10)]),
  };
  const permissions = { microphone: 'granted', call_audio: 'granted', recorder: 'running',
    ...{ mic_missing: { microphone: 'denied' }, mic_missing_delivery: { microphone: 'denied' }, not_recording: { recorder: 'stopped' } }[name] };
  const state = { preferences: {}, journal: [], frames: [], project: {}, updates: {},
    delivery: { channels: {}, undelivered: [], notifications: [] },
    transcript: { meeting_id: '', status: 'idle', live: false, segments: [], speakers: [] },
    recording_health: { capture: { state: 'inactive' } }, copilot: { busy: false, analysis: { state: 'idle' }, messages: [] } };
  // A report that did not reach its channel: the delivery pill joins the bar.
  if (name === 'mic_missing_delivery') Object.assign(state.delivery, { channels: { gmail: { configured: true, state: 'sent', issues: [] } },
    undelivered: [{ meeting_id: 'm9', channels: ['email'], title: 'Pilot review', started_at: iso(now - 24 * 60 * MIN) }] });
  return { agenda: agendas[name](), state, permissions };
}

// name -> {agenda, state, permissions}, rebuilt on every read so the times stay relative to now.
const states = Object.defineProperties({}, Object.fromEntries(
  ['ready', 'preparing', 'nothing_found', 'failed', 'skipped', 'adapter', 'no_skip_support', 'long',
    'calendar_off', 'calendar_off_with_plans', 'tool_missing', 'no_meetings', 'load_failed',
    'mic_missing', 'mic_missing_delivery', 'not_recording', 'menu_open', 'menu_narrow', 'keys']
    .map(name => [name, { enumerable: true, get: () => build(name) }])));

// Serves the real UI files and the fixture. The returned object records POST bodies; a test can set
// `responses[path]` to {status, json}, 'abort' or a promise of either, and `gate` to a promise that holds back
// /api/agenda. A fixture without an agenda makes /api/agenda answer 500. `clock` installs a fake page clock that many milliseconds ahead of now.
async function route(context, fixture, origin) {
  const api = { fixture, posts: [], responses: {}, gate: null };
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
    if (url.pathname === '/api/permissions') return request.fulfill({ json: api.fixture.permissions });
    if (url.pathname.startsWith('/api/')) return request.fulfill({ json: { ok: true } });
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (file.includes('/') || !/\.(html|js|css)$/.test(file)) return request.abort();
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    return request.fulfill({ contentType: type, body: await fs.readFile(path.join(root, file)) });
  });
  return api;
}

// A page on Home with the fixture: page.api is the route's recorder, page.errors the script errors.
async function open(browser, { fixture, width = 1440, scheme = 'light', lang = 'ru', gate = null, clock = null }) {
  const origin = 'http://home-ui.test';
  const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: scheme, locale: lang });
  const data = states[fixture];
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
  await page.goto(`${origin}/`);
  return page;
}

module.exports = { states, route, open };
