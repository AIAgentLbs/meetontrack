// Home: today's and tomorrow's meetings, each with its memo digest or an honest state.
// Calendar titles, attendee names and memo text are untrusted: every value goes in through textContent.
const homeErrors = new Map(); // row key -> message key of a skip or retry that failed
const homeOpenMemos = new Set(); // row keys whose full memo is open
const homeBusy = new Set(); // button keys whose POST and agenda refresh are in flight
const HOME_TOOL_HELP = "https://github.com/AIAgentLbs/meetontrack/blob/main/docs/CONTEXT_SOURCES.md#install-the-calendar-reader-gws";
let homeSignature = "";

const homeKey = meeting => meeting.event_id || `${meeting.start}|${meeting.title}`;
const homeLocale = () => (uiLanguage === "en" ? "en-GB" : "ru-RU");
const homeClock = value => new Date(value).toLocaleTimeString(homeLocale(), { hour: "2-digit", minute: "2-digit" });
const homeSafeLink = value => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};
// An e-mail may wrap after @ or a dot: each piece is its own text node with a <wbr> between.
function homeBreakable(tag, className, value) {
  const node = textNode(tag, className, "");
  String(value).split(/(?<=[@.])/).forEach((part, index) => node.append(...(index ? [document.createElement("wbr")] : []), part));
  return node;
}
const homePlain = line => line.replace(/^(?:[-*+]|\d+[.)])\s+/, "")
  .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__|`/g, "").trim();

// Only a fallback when the server sends no memo block: a digest derived from a prepared plan's Markdown.
function memoFromPlans(meeting) {
  const plan = (meeting.plans || []).find(item => item.has_memo);
  if (!plan) return { state: (meeting.attendees || []).some(person => !person.self) ? "nothing_found" : "none" };
  const lines = String(plan.memo_markdown || "").split("\n").map(line => line.trim()).filter(line => line && !/^-{3,}$/.test(line));
  const goalAt = lines.findIndex(line => !/^(?:#|>|[-*+]\s|\d+[.)]\s)/.test(line));
  const goal = goalAt < 0 ? "" : homePlain(lines[goalAt]);
  const questions = lines.filter((line, index) => index !== goalAt && !/^[#>]/.test(line))
    .map(homePlain).filter(line => line.endsWith("?")).slice(0, 3);
  return { state: "ready", goal: goal.length > 160 ? `${goal.slice(0, 159)}…` : goal, questions, background: "",
    source_count: (plan.links || []).length, plan_id: plan.id, written_by: "file" };
}

// Someone else is invited, or there is a call link: a solo block (focus time, lunch) is not a call (skip_recording.is_call).
const homeIsCall = meeting => (meeting.attendees || []).some(person => !person.self) || Boolean(meeting.link);

function nextMeeting(agenda, now = Date.now()) {
  return (agenda?.meetings || []).find(meeting => Date.parse(meeting.end) > now && homeIsCall(meeting)) || null;
}

function homeTimeLeft(meeting, now) {
  const minutes = Math.ceil((Date.parse(meeting.start) - now) / 60000);
  if (minutes <= 0) return t("home.now");
  if (minutes < 60) return t("home.in_minutes", { n: minutes });
  return t(minutes % 60 ? "home.in_hours" : "home.in_hours_whole", { h: Math.floor(minutes / 60), m: minutes % 60 });
}

function homeDayTitle(start, now) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const tomorrow = Date.parse(start) >= midnight.getTime();
  const date = new Date(tomorrow ? start : now)
    .toLocaleDateString(homeLocale(), { weekday: "long", day: "numeric", month: "long" }).replace(",", "");
  return t(tomorrow ? "home.tomorrow" : "home.today", { date });
}

function homeButton(label, className, key, onClick) {
  const button = textNode("button", className, label);
  button.type = "button";
  button.dataset.key = key;
  button.disabled = homeBusy.has(key);
  button.addEventListener("click", onClick);
  return button;
}

// A skip or retry the server refused leaves the row as it was and adds one line to it.
// The button stays disabled until its POST and the agenda refresh after it are done, so a double click posts
// once; a row rebuilt meanwhile gets its button disabled too, and focus comes back to it by key.
async function homeAction(button, key, path, body) {
  const id = button.dataset.key;
  homeBusy.add(id);
  button.disabled = true;
  try {
    await post(path, body);
    homeErrors.delete(key);
  } catch (error) {
    homeErrors.set(key, error.status !== 409 || path !== "/api/agenda/skip-recording" ? "home.action_failed"
      : error.message === "recording_active" ? "home.recording_active" : "home.cannot_skip");
  }
  try {
    renderHome(window.agendaData, window.appState);
    await refreshAgenda();
  } finally {
    homeRelease(id);
  }
}

// Retry on the load-failed block: busy while the agenda is fetched again.
async function homeReload(button) {
  homeBusy.add(button.dataset.key);
  button.disabled = true;
  try {
    await refreshAgenda();
  } finally {
    homeRelease(button.dataset.key);
  }
}

// The button with this key, if it is still on Home, is enabled again and gets focus back from body.
function homeRelease(id) {
  homeBusy.delete(id);
  const current = [...document.querySelectorAll("#home [data-key]")].find(node => node.dataset.key === id);
  if (current) {
    current.disabled = false;
    if (document.activeElement === document.body) current.focus();
  }
}

// The calendar is connected in Settings, Google section: open it there with the Calendar checkbox in view.
function homeConnect() {
  document.getElementById("settings-open").click();
  document.getElementById("google-context-settings").open = true;
  document.querySelector('#google-sources input[value="calendar"]').scrollIntoView({ block: "center" });
}

// Home without rows: a title, one line and at most one action.
function homeEmpty(prefix, action) {
  const block = textNode("div", "empty", "");
  block.append(textNode("h2", "", t(`${prefix}_title`)), textNode("p", "state", t(`${prefix}_text`)));
  if (action) {
    const actions = textNode("div", "actions", "");
    actions.append(action);
    block.append(actions);
  }
  return block;
}

// The full memo under the row, and the Open memo button that shows and hides it.
function homeMemo(plan, key, id, primary) {
  const panel = document.createElement("div");
  panel.className = "memo-details";
  panel.id = id;
  panel.hidden = !homeOpenMemos.has(key);
  panel.append(...memoNodes(plan));
  const links = document.createElement("div");
  if (plan.links?.length) {
    links.className = "call-plan-links";
    links.append(...plan.links.map(link => externalLink(link.label, link.url)));
    panel.append(textNode("h4", "call-plan-section-title", t("plan.links")), links);
  }
  const label = textNode("span", "", "");
  const button = homeButton("", primary ? "primary" : "", `${key}|memo`, () => toggle(panel.hidden));
  button.setAttribute("aria-controls", id);
  button.append(label);
  if (primary) {
    const hint = textNode("kbd", "", "↵");
    hint.setAttribute("aria-hidden", "true");
    button.append(hint);
  }
  function toggle(open) {
    panel.hidden = !open;
    if (open) homeOpenMemos.add(key);
    else homeOpenMemos.delete(key);
    button.setAttribute("aria-expanded", String(open));
    label.textContent = t(open ? "home.hide_memo" : "home.open_memo");
  }
  toggle(!panel.hidden);
  return { panel, button, show: () => { toggle(true); links.querySelector("a")?.focus(); } };
}

function homeRow(meeting, { next, now, supported, id, status, recording }) {
  const key = homeKey(meeting);
  const memo = meeting.memo || memoFromPlans(meeting);
  const plan = (meeting.plans || []).find(item => item.id === memo.plan_id);
  const row = document.createElement("article");
  row.className = next ? "row next" : "row";
  const when = textNode("div", "when", "");
  if (meeting.start) when.append(textNode("p", "time", homeClock(meeting.start)));
  if (next) when.append(textNode("span", "soon", homeTimeLeft(meeting, now)));
  const title = textNode("h3", "mtitle", meeting.title);
  const main = textNode("div", "main", "");
  const actions = document.createElement("div");
  actions.className = "actions";
  // A call that is on without a recording: the fix first, Start recording when it can work, then How to fix.
  const notRecording = next && !meeting.skip_recording && status?.kind === "not_recording" && status.action;
  if (notRecording) {
    const fix = status.action.id;
    for (const [index, actionId] of [...new Set([fix, ...(fix === "open_mic" ? [] : ["start"])])].entries()) {
      actions.append(homeButton(t(`action.${actionId}`), index ? "" : "primary", `status|${actionId}`,
        event => statusAction(event.currentTarget, actionId)));
    }
    actions.append(homeButton(t("action.how_to_fix"), "ql", `${key}|fix`, () => document.getElementById("getting-started-open").click()));
  }
  const memoView = memo.state === "ready" && plan ? homeMemo(plan, key, id, next && !notRecording) : null;

  if (memo.state === "ready") {
    if (memo.goal) main.append(textNode("p", "goal", t("home.goal", { goal: memo.goal })));
    if (memo.questions?.length) {
      const asks = document.createElement("ul");
      asks.className = "asks";
      asks.append(...memo.questions.slice(0, 3).map(question => textNode("li", "", question)));
      main.append(asks);
    }
    const sources = memo.source_count > 0 && memoView;
    if (memo.background || sources) {
      const background = textNode("p", "bg", "");
      if (memo.background) background.append(textNode("span", "", memo.background), " ");
      if (sources) {
        const count = memo.source_count;
        const form = new Intl.PluralRules(homeLocale()).select(count);
        background.append(homeButton(t(`home.sources.${form}`, { n: count }), "ql inline", `${key}|sources`, memoView.show));
      }
      main.append(background);
    }
    if (memoView) actions.append(memoView.button);
  } else if (memo.state === "preparing") {
    const status = document.createElement("p");
    status.className = "state";
    status.setAttribute("role", "status");
    if (memo.since) status.append(textNode("b", "", t("home.preparing_since", { time: homeClock(memo.since) })), ` ${t("home.preparing_note")}`);
    else status.append(t("home.preparing"));
    main.append(status);
  } else if (memo.state === "nothing_found") {
    const status = document.createElement("p");
    status.className = "state";
    status.append(textNode("b", "", t("home.nothing_found")), ` ${t("home.calendar_on")}`);
    main.append(status);
    actions.append(homeButton(t("home.connect_sources"), "", `${key}|sources`, homeConnect));
  } else if (memo.state === "failed") {
    const reason = ["ai_no_answer", "ai_needs_choice", "timeout", "error"].includes(memo.reason) ? memo.reason : "error";
    const status = document.createElement("p");
    status.className = "state";
    status.append(textNode("span", "fail", t("home.failed", { reason: t(`home.reason.${reason}`) })));
    if (memo.retry_at && reason !== "ai_needs_choice") status.append(` ${t("home.retry_at", { time: homeClock(memo.retry_at) })}`);
    main.append(status);
    // Without a chosen AI a retry cannot succeed: the only way on is Check the AI.
    if (meeting.event_id && reason !== "ai_needs_choice") {
      actions.append(homeButton(t("home.retry"), "", `${key}|retry`,
        event => homeAction(event.currentTarget, key, "/api/memo/rebuild", { event_id: meeting.event_id })));
    }
    actions.append(homeButton(t("home.check_ai"), "ql", `${key}|ai`, () => document.getElementById("getting-started-open").click()));
  }

  if (next && homeSafeLink(meeting.link)) {
    actions.append(Object.assign(externalLink(t("home.call_link"), meeting.link), { className: "ql" }));
  }
  const skip = value => event => homeAction(event.currentTarget, key, "/api/agenda/skip-recording",
    { event_id: meeting.event_id || "", start: meeting.start, end: meeting.end, title: meeting.title, skip: value });
  if (meeting.skip_recording) {
    actions.append(textNode("span", "status-text", t("home.skipped")));
    if (supported) actions.append(homeButton(t("home.unskip"), "ql", `${key}|skip`, skip(false)));
  } else if (next && supported && meeting.start && !recording) {
    // R32: not while any recording runs; the recorders read the skip only before they start (the server says 409).
    actions.append(homeButton(t("home.skip"), "quiet", `${key}|skip`, skip(true)));
  }
  if (actions.childElementCount) main.append(actions);
  if (homeErrors.has(key)) {
    const error = document.createElement("p");
    error.className = "row-error";
    error.setAttribute("role", "alert");
    error.append(textNode("span", "fail", t(homeErrors.get(key))));
    main.append(error);
  }
  if (memoView) main.append(memoView.panel);

  const who = document.createElement("p");
  who.className = "who";
  const others = (meeting.attendees || []).filter(person => !person.self);
  for (const person of others.slice(0, 3)) {
    who.append(homeBreakable("b", "", person.name || person.email || ""));
    const detail = person.company || (person.name ? person.email : "");
    if (detail) who.append(homeBreakable("span", "", detail));
  }
  // A long invite shows three people and a count; the whole list stays in the line's tooltip.
  if (others.length > 3) {
    const more = textNode("span", "more", t("home.more_people", { n: others.length - 3 }));
    more.title = others.map(person => person.name || person.email || "").join(", ");
    who.append(more);
  }
  // Reading order: time, title, people, digest; at desktop width the grid puts the people in the right column.
  row.append(when, title, who, main);
  return row;
}

function renderHome(agenda, state, now = Date.now()) {
  const home = document.getElementById("home");
  const meetings = (agenda?.meetings || []).filter(meeting => Date.parse(meeting.end) > now);
  const unscheduled = agenda?.unscheduled_plans || [];
  const next = nextMeeting(agenda, now);
  // Not loaded at all, or the calendar could not be read: never shown as an empty day.
  const failed = !agenda && Boolean(window.agendaFailed) || agenda?.calendar_state === "failed";
  const status = callStatus(state, agenda, window.permissionsData, now);
  const recording = isLive(state, now);
  const signature = JSON.stringify([uiLanguage, new Date(now).toDateString(), Boolean(agenda), failed, agenda?.calendar_state,
    meetings, unscheduled, agenda?.skip_recording_supported, [...homeErrors], status.kind, status.action?.id,
    recording, agenda?.failed_days]);
  if (signature === homeSignature) {
    // Same rows: only the time left changes, in place, so focus, scroll and an open memo stay.
    const soon = home.querySelector(".soon");
    if (soon && next) soon.textContent = homeTimeLeft(next, now);
    return;
  }
  homeSignature = signature;
  const focused = home.contains(document.activeElement) ? document.activeElement.dataset.key : "";
  const heading = textNode("h1", "visually-hidden", t("home.title"));
  heading.id = "home-heading";
  const column = document.createElement("div");
  column.className = "col";
  // Not loaded yet shows nothing; otherwise one empty-state block when there are no rows to show.
  const calendar = agenda?.calendar_state;
  const loadFailed = () => homeEmpty("home.load_failed", homeButton(t("home.retry"), "primary", "empty|reload", event => homeReload(event.currentTarget)));
  // One calendar day could not be read: the other day's rows stay, the failed day says so in its place.
  const failedDays = failed && meetings.length ? [...(agenda.failed_days || [])].sort() : [];
  // The local date of a call, as its heading counts it (its ISO text may carry another offset's date).
  const localDay = iso => {
    const date = new Date(iso);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };
  const failedDay = date => column.append(textNode("h2", "day", homeDayTitle(`${date}T12:00:00`, now)), loadFailed());
  if (failed && !failedDays.length) {
    column.append(loadFailed());
  } else if (calendar === "tool_missing") {
    column.append(homeEmpty("home.tool", Object.assign(externalLink(t("home.tool_link"), HOME_TOOL_HELP), { className: "ql" })));
  } else if (calendar === "not_connected") {
    column.append(homeEmpty("home.calendar_off", homeButton(t("home.calendar_connect"), "primary", "empty|connect", homeConnect)));
  } else if (agenda && !meetings.length && !unscheduled.length) {
    column.append(homeEmpty("home.empty"));
  }
  let day = "", index = 0;
  for (const meeting of meetings) {
    while (failedDays.length && failedDays[0] < localDay(meeting.start)) failedDay(failedDays.shift());
    const title = homeDayTitle(meeting.start, now);
    if (title !== day) column.append(textNode("h2", "day", (day = title)));
    column.append(homeRow(meeting, { next: meeting === next, now, supported: agenda.skip_recording_supported, id: `home-memo-${index++}`, status, recording }));
  }
  failedDays.forEach(failedDay);
  if (unscheduled.length) {
    column.append(textNode("h2", "day", t("plan.unscheduled")));
    for (const plan of unscheduled) {
      const memo = { state: plan.has_memo ? "ready" : "none", plan_id: plan.id };
      column.append(homeRow({ title: plan.title, event_id: `plan:${plan.id}`, plans: [plan], attendees: [], memo },
        { next: false, now, supported: false, id: `home-memo-${index++}` }));
    }
  }
  home.replaceChildren(heading, column);
  if (focused) [...home.querySelectorAll("[data-key]")].find(node => node.dataset.key === focused)?.focus();
}

// The time left moves on even when nothing is polled.
setInterval(() => renderHome(window.agendaData, window.appState), 30000);
