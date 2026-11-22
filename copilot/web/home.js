// Home: today's and tomorrow's meetings, each with its memo digest or an honest state.
// Calendar titles, attendee names and memo text are untrusted: every value goes in through textContent.
const homeErrors = new Map(); // row key -> message key of a skip or retry that failed
const homeOpenMemos = new Set(); // row keys whose full memo is open
const homeBusy = new Set(); // button keys whose POST and agenda refresh are in flight
// The install step in the page's language (a repo doc; the Russian section has its own anchor).
const homeToolHelp = () => `https://github.com/AIAgentLbs/meetontrack/blob/main/docs/CONTEXT_SOURCES.md#${
  uiLanguage === "en" ? "install-the-calendar-reader-gws" : "ru-calendar"}`;
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

// One rule for row actions: an outlined button for the action that unblocks the row (Connect mail, Choose the AI),
// underlined text for an optional or alternative one (Connect a folder, Retry now) and for links out of the app.
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

// Without a chosen AI: the getting-started guide, on its AI step.
const homeChooseAI = event => openGuideStep("startup-ai-heading", null, event.currentTarget);

// Connect mail or the calendar: Settings at «Google: почта, календарь, файлы». Once the connection is read, focus
// and scroll go to the one control that moves on: the source's box when Google is connected, else Connect Google
// (the plain sign-in). Sign-in not set up yet: with no Google profile (or the own client) the documented first step
// is the own OAuth client under Report storage and delivery (docs/DELIVERY.md), its account choice; with a named
// gws profile, the line about the gws setup and its guide link.
async function homeConnectGoogle(source, opener) {
  openPanel("settings-open", opener);
  const section = document.getElementById("google-context-settings");
  section.open = true;
  section.scrollIntoView({ block: "start" });
  await window.googleLoad;
  const box = document.querySelector(`#google-sources input[value="${source}"]`);
  const account = document.getElementById("google-account");
  const target = !box.disabled ? box : account.dataset.client === "true" ? document.getElementById("google-connect")
    : !["personal", "work"].includes(account.dataset.profile) ? document.getElementById("delivery-profile")
    : account.querySelector("a") || account;
  target.scrollIntoView({ block: "center" });
  target.focus({ preventScroll: true });
}

// Connect a folder: the folders dialog (the menu's «Папки с файлами»), focused on Choose folder.
function homeConnectFolder() {
  document.getElementById("repo-button").click();
  document.getElementById("context-folder-choose").focus();
}

// The bar shows a problem (not recording, no microphone...): its fix is the one filled button on screen.
const homeProblem = (state, agenda, now) => !["recording", "waiting"].includes(callStatus(state, agenda, window.permissionsData, now).kind);
// A memo still in progress 5 minutes after it started takes longer than usual.
const homeLate = (since, now) => Boolean(since) && now - Date.parse(since) >= 5 * 60000;
const homeNote = (since, now) => ` ${t(homeLate(since, now) ? "home.preparing_late" : "home.preparing_note")}`;

// Home without rows: a title, one line and its actions (none, one, or a link and a button).
function homeEmpty(prefix, action, text = [t(`${prefix}_text`)]) {
  const block = textNode("div", "empty", "");
  const line = textNode("p", "state", "");
  line.append(...text);
  block.append(textNode("h2", "", t(`${prefix}_title`)), line);
  if (action) {
    const actions = textNode("div", "actions", "");
    actions.append(...[action].flat());
    block.append(actions);
  }
  return block;
}

const homeNorm = text => String(text).toLowerCase().replace(/\s+/g, " ").replace(/[\s.,;:!?…]+$/u, "").trim();
// A memo line as the digest would say it: without its list mark, a bold lead («**Цель встречи.**»), Markdown and
// the memo writer's source marks ([S1], [S1, S2]).
const HOME_MARKS = /(?:\s*\[S\d+(?:\s*,\s*S\d+)*\])+$/;
const homeBare = line => homeNorm(homePlain(line.replace(/^(?:[-*+]|\d+[.)])\s+/, "").replace(/^\*\*[^*]+\*\*\s*/, ""))
  .replace(HOME_MARKS, ""));

// Memo text with its links: a Markdown link shows its label, a bare web address its host; never a raw URL.
function homeInline(node, text) {
  const strip = value => value.replace(/\*\*|__|`/g, "");
  let at = 0;
  // [label](address, may hold balanced parentheses), <https://autolink>, or a bare address.
  for (const match of text.matchAll(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)|<(https?:\/\/[^\s>]+)>|https?:\/\/[^\s)<>]+/g)) {
    node.append(strip(text.slice(at, match.index)));
    at = match.index + match[0].length;
    let url = match[2] || match[3] || match[0];
    const tail = match[2] || match[3] ? "" : url.match(/[.,;:!?]+$/)?.[0] || "";
    url = url.slice(0, url.length - tail.length);
    const label = match[1] ? strip(match[1]) : homeSafeLink(url) ? new URL(url).host : "";
    node.append(homeSafeLink(url) ? externalLink(label, url) : label, tail);
  }
  node.append(strip(text.slice(at)));
  return node;
}

// The memo's Markdown as section headings, paragraphs and lists, showing only what the digest does not (R39). Left
// out: a top heading that repeats the title, the lines the digest shows whole (`shown.lines`: goal, questions,
// background, compared without source marks, whose marks go to `shown.marks` for the digest), and a heading left
// with nothing under it. A section the digest emptied down to one item shows that item alone, without its heading.
function homeMemoBody(markdown, titles, shown = { lines: [], marks: new Map() }) {
  const nodes = [];
  const trimmed = new Set(); // headings whose section lost lines to the digest
  let list = null, section = null;
  for (const raw of String(markdown || "").split("\n")) {
    const line = raw.trim().replace(/^>\s*/, "");
    if (!line || /^-{3,}$/.test(line)) {
      list = null;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      list = null;
      if (heading[1] !== "#" || !titles.includes(homeNorm(homePlain(heading[2])))) nodes.push(section = homeInline(textNode("h4", "", ""), heading[2]));
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+/.test(line);
    const bare = homeBare(line);
    // Left out only when the digest shows all of it: a longer line, or one whose digest was cut, stays whole.
    if (shown.lines.includes(bare)) {
      const marks = line.match(HOME_MARKS)?.[0].trim();
      if (marks) shown.marks.set(bare, marks);
      if (section) trimmed.add(section);
      continue;
    }
    if (item) {
      if (!list) nodes.push(list = document.createElement("ul"));
      list.append(homeInline(document.createElement("li"), line.replace(/^(?:[-*+]|\d+[.)])\s+/, "")));
    } else {
      list = null;
      nodes.push(homeInline(document.createElement("p"), line));
    }
  }
  // Empty sections go first, so a flattened one never leaves its item under the heading before it.
  const kept = nodes.filter((node, index) => node.tagName !== "H4" || (nodes[index + 1] && nodes[index + 1].tagName !== "H4"));
  const result = [];
  for (let index = 0; index < kept.length; index += 1) {
    const only = kept[index + 1], after = kept[index + 2];
    if (trimmed.has(kept[index]) && only?.tagName === "UL" && only.childElementCount === 1 && (!after || after.tagName === "H4")) {
      const line = document.createElement("p");
      line.append(...only.firstChild.childNodes);
      result.push(line);
      index += 1;
    } else result.push(kept[index]);
  }
  return result;
}

// The full memo, part of the row under its actions, and the Open memo button that shows and hides it.
function homeMemo(plan, memo, title, key, id, primary, filled = primary) {
  const panel = document.createElement("div");
  panel.className = "memo-details";
  panel.id = id;
  panel.hidden = !homeOpenMemos.has(key);
  const titles = [title, plan.title].filter(Boolean).map(value => homeNorm(value));
  const shown = { lines: [memo.goal, ...(memo.questions || []).slice(0, 3), memo.background].map(value => homeNorm(value || "")).filter(Boolean),
    marks: new Map() };
  panel.append(...homeMemoBody(plan.memo_markdown, titles, shown));
  if (plan.talk_track_markdown) panel.append(textNode("h4", "", t("plan.talk_track")), ...homeMemoBody(plan.talk_track_markdown, titles));
  // Materials: plain underlined links, like Open the call link.
  const links = document.createElement("div");
  links.className = "memo-links";
  if (homeSafeLink(plan.memo_url)) links.append(Object.assign(externalLink(t("plan.memo_open"), plan.memo_url), { className: "ql" }));
  for (const link of plan.links || []) {
    if (homeSafeLink(link.url)) links.append(Object.assign(externalLink(link.label || new URL(link.url).host, link.url), { className: "ql" }));
  }
  if (links.childElementCount) panel.append(textNode("h4", "", t("plan.links")), links);
  const label = textNode("span", "", "");
  const button = homeButton("", filled ? "primary" : "", `${key}|memo`, () => toggle(panel.hidden));
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
  // Where this comes from: the memo's first source link, or its toggle when the sources are plain text.
  return { panel, button, marks: shown.marks, show: () => { toggle(true); (links.querySelector("a") || button).focus(); } };
}

// A digest line's source marks from the memo writer ([S1, S2]), shown while its memo is open (screens.css).
const homeMarks = (memoView, line) => {
  const marks = memoView?.marks.get(homeNorm(line));
  return marks ? [" ", textNode("span", "marks", marks)] : [];
};

function homeRow(meeting, { next, now, supported, id, recording, stale, problem }) {
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
  // R34: a call that is not being recorded is the bar's; the row keeps its memo actions.
  const memoView = memo.state === "ready" && plan ? homeMemo(plan, memo, meeting.title, key, id, next, next && !problem) : null;

  if (memo.state === "ready") {
    if (memo.goal) {
      const goal = textNode("p", "goal", "");
      goal.append(textNode("b", "", t("home.goal")), ` ${memo.goal}`, ...homeMarks(memoView, memo.goal));
      main.append(goal);
    }
    if (memo.questions?.length) {
      const asks = document.createElement("ul");
      asks.className = "asks";
      asks.append(...memo.questions.slice(0, 3).map(question => {
        const item = textNode("li", "", question);
        item.append(...homeMarks(memoView, question));
        return item;
      }));
      main.append(asks);
    }
    const sources = memo.source_count > 0 && memoView;
    if (memo.background || sources) {
      const background = textNode("p", "bg", "");
      if (memo.background) {
        const text = textNode("span", "", memo.background);
        text.append(...homeMarks(memoView, memo.background));
        background.append(text, " ");
      }
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
    // One format: a lead (with the start time when known) and the note, which ages after 5 minutes, in place.
    status.dataset.since = memo.since || "";
    status.append(textNode("span", "lead", memo.since ? t("home.preparing_since", { time: homeClock(memo.since) }) : t("home.preparing")),
      textNode("span", "note", homeNote(memo.since, now)));
    main.append(status);
  } else if (memo.state === "nothing_found") {
    const status = document.createElement("p");
    status.className = "state";
    status.append(textNode("span", "lead", t("home.nothing_found")));
    main.append(status);
    actions.append(homeButton(t("home.connect_mail"), "", `${key}|mail`, event => homeConnectGoogle("gmail", event.currentTarget)),
      homeButton(t("home.connect_folder"), "ql", `${key}|folder`, homeConnectFolder));
  } else if (memo.state === "failed") {
    const reason = ["ai_no_answer", "ai_needs_choice", "timeout", "error"].includes(memo.reason) ? memo.reason : "error";
    const status = document.createElement("p");
    status.className = "state";
    status.append(textNode("span", "fail", t("home.failed", { reason: t(`home.reason.${reason}`) })));
    if (memo.retry_at && reason !== "ai_needs_choice") status.append(` ${t("home.retry_at", { time: homeClock(memo.retry_at) })}`);
    main.append(status);
    // Without a chosen AI a retry cannot succeed: the only way on is Choose the AI. Otherwise it retries by itself,
    // so the row offers one quiet Retry now at most.
    if (reason === "ai_needs_choice") actions.append(homeButton(t("home.choose_ai"), "", `${key}|ai`, homeChooseAI));
    else if (meeting.event_id) {
      actions.append(homeButton(t("home.retry_now"), "ql", `${key}|retry`,
        event => homeAction(event.currentTarget, key, "/api/memo/rebuild", { event_id: meeting.event_id })));
    }
  }

  if (next && homeSafeLink(meeting.link)) {
    actions.append(Object.assign(externalLink(t("home.call_link"), meeting.link), { className: "ql" }));
  }
  const skip = value => event => homeAction(event.currentTarget, key, "/api/agenda/skip-recording",
    { event_id: meeting.event_id || "", start: meeting.start, end: meeting.end, title: meeting.title, skip: value });
  // A skip names the call by its times: not on a stale agenda, whose times may have moved.
  const timed = button => Object.assign(button, { disabled: button.disabled || Boolean(stale) });
  if (meeting.skip_recording) {
    actions.append(textNode("span", "status-text", t("home.skipped")));
    if (supported) actions.append(timed(homeButton(t("home.unskip"), "ql", `${key}|skip`, skip(false))));
  } else if (next && supported && meeting.start && !recording) {
    // R32: not while any recording runs; the recorders read the skip only before they start (the server says 409).
    actions.append(timed(homeButton(t("home.skip"), "quiet", `${key}|skip`, skip(true))));
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
    const detail = person.company || "";  // an e-mail only stands in for a missing name
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
  // Calls only: a solo block (lunch, focus time) is not a row unless it carries a plan.
  const meetings = (agenda?.meetings || []).filter(meeting => Date.parse(meeting.end) > now
    && (homeIsCall(meeting) || Boolean(meeting.plans?.length)));
  const unscheduled = agenda?.unscheduled_plans || [];
  const next = nextMeeting(agenda, now);
  // Not loaded at all, or the calendar could not be read: never shown as an empty day.
  const failed = !agenda && Boolean(window.agendaFailed) || agenda?.calendar_state === "failed";
  const recording = isLive(state, now);
  // A refresh failed after rows loaded: they stay, marked with the time they were read.
  const stale = Boolean(agenda && window.agendaFailed);
  const problem = homeProblem(state, agenda, now);
  const signature = JSON.stringify([uiLanguage, new Date(now).toDateString(), Boolean(agenda), failed, agenda?.calendar_state,
    stale && window.agendaLoadedAt, problem, meetings, unscheduled, agenda?.skip_recording_supported, [...homeErrors], recording, agenda?.failed_days]);
  if (signature === homeSignature) {
    // Same rows: only the time left changes, in place, so focus, scroll and an open memo stay.
    const soon = home.querySelector(".soon");
    if (soon && next) soon.textContent = homeTimeLeft(next, now);
    for (const status of home.querySelectorAll("[data-since]")) {
      const note = status.querySelector(".note");
      const text = homeNote(status.dataset.since, now);
      if (note.textContent !== text) note.textContent = text;
    }
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
  if (stale) {
    const line = textNode("p", "stale", `${t("home.stale", { time: homeClock(window.agendaLoadedAt) })} `);
    line.setAttribute("role", "status");
    line.append(homeButton(t("home.retry"), "ql", "stale|reload", event => homeReload(event.currentTarget)));
    column.append(line);
  }
  if (failed && !failedDays.length) {
    column.append(loadFailed());
  } else if (calendar === "tool_missing") {
    column.append(homeEmpty("home.tool", [Object.assign(externalLink(t("home.tool_link"), homeToolHelp()), { className: "ql" }),
      homeButton(t("home.check_again"), "", "empty|recheck", event => homeReload(event.currentTarget))]));
  } else if (calendar === "not_connected") {
    column.append(homeEmpty("home.calendar_off", homeButton(t("home.calendar_connect"), "primary", "empty|connect", event => homeConnectGoogle("calendar", event.currentTarget))));
  } else if (agenda && !meetings.length && !unscheduled.length) {
    // Past calls are in the top bar, or in the menu where the bar has no room for them (up to 700 px).
    column.append(homeEmpty("home.empty", null, [textNode("span", "by-wide", t("home.empty_text_wide")),
      textNode("span", "by-narrow", t("home.empty_text_narrow"))]));
  }
  let day = "", index = 0;
  for (const meeting of meetings) {
    while (failedDays.length && failedDays[0] < localDay(meeting.start)) failedDay(failedDays.shift());
    const title = homeDayTitle(meeting.start, now);
    if (title !== day) column.append(textNode("h2", "day", (day = title)));
    column.append(homeRow(meeting, { next: meeting === next, now, supported: agenda.skip_recording_supported, id: `home-memo-${index++}`,
      recording, stale, problem }));
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
