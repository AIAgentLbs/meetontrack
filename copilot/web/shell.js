// The shell picks one view from the state: a live recording shows the call, a recording that ended
// in the last two hours shows After, anything else shows Home. A view opened by hand holds for two
// hours at most, and only until the call changes (a different meeting, or recording starting or stopping).
const $ = id => document.getElementById(id);
const AFTER_WINDOW_MS = 2 * 60 * 60 * 1000;
// The recorder's own statuses while it runs (release_updates.RECORDING). A recorder that crashed leaves
// its last status behind, so the status counts only while the live file is still being rewritten
// (Windows rewrites it every 5 s, server.py LIVE_STATUS_FRESH_SECONDS).
const RECORDING_STATUSES = new Set(["recording", "paused", "loading", "overloaded"]);
const LIVE_STATUS_FRESH_MS = 300 * 1000;

// Live for the whole call, not only while speech arrives: the capture marker (verifying, recording,
// stalled, paused) or a fresh recorder status keeps it true through silence, pauses and stalled tracks.
function isLive(state, now = Date.now()) {
  const capture = state?.recording_health?.capture?.state;
  const transcript = state?.transcript || {};
  return Boolean(capture && capture !== "inactive") || transcript.live === true
    || RECORDING_STATUSES.has(transcript.status) && now - Date.parse(transcript.updated_at || "") < LIVE_STATUS_FRESH_MS;
}

// isLive picks the view; the bar claims Recording only for capture that is running and freshly confirmed
// (recordingFresh, the rule of the call's own capture line). Otherwise the reason it is not: paused, stalled, stale.
function notRecordingReason(state, now = Date.now()) {
  const health = state?.recording_health || {};
  const capture = health.capture?.state;
  if (capture && capture !== "inactive") {
    if (!recordingFresh(health, now)) return "stale";
    // One stalled side is still a recording: its beat and the feed's problem say which side (F19).
    if (capture === "stalled") return (health.capture.tracks || []).every(track => track.state === "stalled") ? "stalled" : "";
    return capture === "paused" ? capture : "";
  }
  // No capture marker (Windows): the recorder's own fresh status, read while the server still answers.
  if (stateConnectionFailed) return "stale";
  return state?.transcript?.status === "paused" ? "paused" : "";
}

function callKey(state, now = Date.now()) {
  return `${isLive(state, now)}:${state?.transcript?.meeting_id || ""}`;
}

function viewFor(state, manual, now = Date.now()) {
  if (manual && manual.key === callKey(state, now) && now - manual.at < AFTER_WINDOW_MS) return manual.view;
  if (isLive(state, now)) return "call";
  const transcript = state?.transcript || {};
  // When the recording ended, as the server counts it (meeting_boundaries.py): the stop, the finished export, the last line.
  const ended = Date.parse(transcript.ended_at || transcript.updated_at || transcript.latest_at || "");
  if (transcript.status === "finished" && transcript.meeting_id && now - ended <= AFTER_WINDOW_MS) return "after";
  return "home";
}

function openView(view) {
  try {
    localStorage.setItem("meetontrack-view", JSON.stringify({ view, key: callKey(window.appState), at: Date.now() }));
  } catch {}
  renderShell();
}

// One call status for the bar, first rule that matches. `next` is the first call not over and not skipped.
// A permission the platform cannot read ("unknown") shows nothing; Start recording never shows without a microphone.
function callStatus(state, agenda, permissions, now = Date.now()) {
  const action = (id, primary = true) => ({ id, label: t(`action.${id}`), primary });
  // Stop recording pressed for this call: the undo window, then the final stop until the recorder goes inactive.
  // A recorder that cannot pause stops at once and reaches the page only as last_stop (no Resume).
  const control = state?.recording_control || {};
  const meeting = state?.transcript?.meeting_id;
  const stopping = control.stopping;
  // The deferred stop was not acknowledged: the server retries it, the bar says so and offers Stop again (A3).
  if (stopping?.failed && stopping.meeting_id === meeting) {
    return { kind: "stop_failed", text: t("status.error.stop_failed"), action: action("open_recorder") };
  }
  // The undo window: Stopped and the call's clock frozen at the stop; the one countdown is in the feed, and Resume
  // takes Stop's own place (N2, N3).
  if (stopping && stopping.meeting_id === meeting) {
    const clock = callClock(state?.recording_health?.capture?.started_at || state?.transcript?.started_at, Date.parse(stopping.stopped_at));
    return { kind: "stopped", text: t("status.stopped", { time: clock }), clock, action: null, resume: true };
  }
  // A live recording that began after the final stop is a new one, even under the same id.
  const started = Date.parse(state?.recording_health?.capture?.started_at || state?.transcript?.started_at || "");
  if (!stopping && isLive(state, now) && control.last_stop?.meeting_id === meeting && !(started > Date.parse(control.last_stop.stopped_at))) {
    return { kind: "stopped", final: true, text: t("status.stopped_final"), action: null };
  }
  if (stateConnectionFailed && !isLive(state, now)) return { kind: "disconnected", text: t("status.disconnected"), action: null };
  if (isLive(state, now)) {
    const reason = notRecordingReason(state, now);
    return reason ? { kind: "not_recording", text: t("status.not_recording", { reason: t(`status.reason.${reason}`) }), action: null }
      : { kind: "recording", text: t("status.recording"), action: null };
  }
  const next = (agenda?.meetings || []).find(meeting => Date.parse(meeting.end) > now && !meeting.skip_recording && homeIsCall(meeting));
  const time = next && homeClock(next.start);
  const mic = permissions?.microphone === "denied";
  if (next && Date.parse(next.start) + 120000 <= now) {
    const reason = mic ? "mic" : permissions?.recorder === "stopped" ? "recorder" : "not_detected";
    return { kind: "not_recording", text: t("status.not_recording", { reason: t(`status.reason.${reason}`) }),
      action: action({ mic: "open_mic", recorder: "open_recorder", not_detected: "start" }[reason]) };
  }
  // macOS still records the call audio without the microphone (only the owner's voice is lost); Windows does not start.
  if (next && mic) {
    return { kind: "mic_missing", text: t(permissions.platform === "macos" ? "status.mic_missing_mac" : "status.mic_missing", { time }),
      action: action("open_mic") };
  }
  if (next && permissions?.call_audio === "denied") {
    return { kind: "mic_missing", text: t("status.call_audio_missing", { time }), action: action("open_call_audio") };
  }
  // Recording starts by itself only with auto-record on and the recorder not known to be stopped.
  const manual = permissions?.auto_record === false || permissions?.recorder === "stopped" ? "_manual" : "";
  // A next call starting on the next local day is tomorrow's; one that began before midnight is not. `short` is for a narrow bar.
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = next && new Date(next.start).toDateString() === tomorrow.toDateString() ? "tomorrow_" : "";
  return { kind: "waiting", text: next ? t(`status.waiting_${day}at${manual}`, { time }) : t(`status.waiting${manual}`),
    short: next ? t(`status.waiting_${day}at_manual`, { time }) : null, action: mic ? null : action("start", false) };
}

const currentStatus = () => callStatus(window.appState, window.agendaData, window.permissionsData);
const STATUS_POSTS = {
  open_mic: ["/api/permissions/open", { which: "microphone" }],
  open_call_audio: ["/api/permissions/open", { which: "call_audio" }],
  open_recorder: ["/api/getting-started/open-recorder", {}],
  start: ["/api/getting-started/start-recording", {}],
  // Recording control names the call shown on the page (contract "Recording control"): a stale tab stops nothing else.
  stop: ["/api/recording/stop", {}],
  resume: ["/api/recording/resume", {}],
};
// The server's own codes for Stop and Resume, in plain words (F6); anything else goes through plainError.
// A recorder that did not answer gets the bar's existing Open the recorder.
const STATUS_ERRORS = { meeting_changed: null, too_late: null, stop_failed: "open_recorder", resume_failed: "open_recorder" };
const STATUS_ERROR_MS = 8000; // a Stop or Resume error stays this long at least, so it can be read on stage
const MAC = /Mac/.test(navigator.platform);
const RECORD_KEY = MAC ? "⌘⇧R" : "Alt+Shift+R";
const STOP_KEY = MAC ? "⌘⇧E" : "Alt+Shift+E";
const keyHint = label => {
  const node = textNode("kbd", "", label);
  node.setAttribute("aria-hidden", "true");
  return node;
};
// {text, state, until, action}: a failed status action, shown until the next state poll replaces the state and,
// for Stop and Resume, at least until `until`; `action` is offered in place of the status's own.
let statusError = null;

// A status action from the bar: its busy key makes a double click post once, and it stays disabled until the
// agenda and permissions (Stop and Resume: the state) are fetched again. A failed Stop or Resume keeps the state
// it failed on, so its error shows until the next poll.
async function statusAction(button, id) {
  const key = `status|${id}`;
  if (homeBusy.has(key)) return;
  homeBusy.add(key);
  button.disabled = true;
  renderShell();
  const [path, body] = STATUS_POSTS[id];
  const recording = path.startsWith("/api/recording/");
  let failed = false;
  try {
    await post(path, recording ? { meeting_id: window.appState?.transcript?.meeting_id } : body);
    statusError = null;
  } catch (error) {
    failed = true;
    const code = Object.hasOwn(STATUS_ERRORS, error?.message) ? error.message : null;
    statusError = { text: code ? t(`status.error.${code}`) : plainError(error), state: window.appState,
      until: recording ? Date.now() + STATUS_ERROR_MS : 0, action: code && STATUS_ERRORS[code] };
  }
  try {
    await (recording ? !failed && state() : refreshAgenda());
  } finally {
    homeRelease(key);
    renderShell();
    if (document.activeElement === document.body && !button.closest("#home")) {
      [$("call-status-action"), $("call-stop")].find(node => !node.hidden)?.focus();
    }
  }
}

// Up to 480 px the waiting status drops "recording starts by itself", so the bar keeps to two rows. A problem keeps
// its whole text, consequence included, and wraps.
const SHORT_BAR = matchMedia("(max-width: 480px)");
SHORT_BAR.addEventListener("change", () => renderShell());

function renderStatus(view) {
  if (statusError && statusError.state !== window.appState && !(statusError.until > Date.now())) statusError = null;
  const status = currentStatus();
  // Another view opened by hand during a call: the way back to the call is the status's action.
  // A stopped call keeps its own action (Resume in the undo window, none after): there is no call to go back to.
  if (isLive(window.appState) && status.kind !== "stopped" && view !== viewFor(window.appState, null)) {
    status.action = { id: "back", label: t("action.back_to_call"), primary: true };
  }
  if (statusError?.action) status.action = { id: statusError.action, label: t(`action.${statusError.action}`), primary: true };
  const text = $("call-status-text");
  const shown = statusError?.text || (SHORT_BAR.matches && status.short) || status.text;
  if (text.textContent !== shown) text.textContent = shown;
  // Screen readers hear a change of status, not each second of the undo countdown (the visible text is not live).
  const heard = $("call-status-live");
  const said = status.kind === "stopped" && !statusError ? `${status.kind}|${status.action?.id}` : shown;
  if (heard.dataset.said !== said) {
    heard.dataset.said = said;
    heard.textContent = shown;
  }
  const calm = status.kind === "waiting" || status.kind === "stopped";
  text.className = `status-text${status.kind === "recording" ? " rec" : statusError || !calm ? " fail" : ""}`;
  const button = $("call-status-action");
  button.hidden = !status.action;
  if (status.action) {
    const { id, label, primary } = status.action;
    button.dataset.action = id;
    button.dataset.key = `status|${id}`;
    button.disabled = homeBusy.has(button.dataset.key);
    button.className = primary ? "primary" : "";
    button.replaceChildren(label);
    if (id === "start") button.append(keyHint(RECORD_KEY));
  }
  // Stop recording: during a live call until it is pressed; one click, no dialog. In the undo window the same button,
  // in the same place and size, is Resume (N3).
  const stop = $("call-stop");
  stop.dataset.mode = status.resume ? "resume" : "stop";
  stop.setAttribute("aria-label", t(status.resume ? "action.resume" : "action.stop"));
  stop.hidden = !status.resume && (!isLive(window.appState) || status.kind === "stopped");
  stop.disabled = homeBusy.has(`status|${stop.dataset.mode}`);
  // R34: the bar owns a call that is not being recorded, and How to fix sits beside its button.
  $("call-status-help").hidden = status.kind !== "not_recording";
  $("menu-notes").hidden = view === "home";
  $("menu-chat").hidden = view !== "call"; // in Call the chat tab is hidden; After keeps its tabs (C1, I4)
  const transcript = window.appState?.transcript || {};
  const title = transcript.display_meeting || transcript.meeting;
  $("menu-notes-title").textContent = title ? t("shell.notes", { title }) : t("journal.notes");
  // The guide's own Start recording follows the microphone too, also while the guide is open.
  $("startup-record").hidden = window.permissionsData?.microphone === "denied";
  fitBar();
}

// A status cut short keeps its whole text in the tooltip. The bar grows to two rows in a narrow window or with
// a long status, and a setup blocker above it pushes it down; overlays open under it, wherever it ends on screen.
// Checked on every render, every resize of the bar or the blocker, and every scroll.
function fitBar() {
  const text = $("call-status-text");
  text.title = text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1 ? text.textContent : "";
  const bottom = Math.max(0, Math.ceil(document.querySelector(".topbar").getBoundingClientRect().bottom));
  document.documentElement.style.setProperty("--bar-h", `${bottom}px`);
}
const barWatch = new ResizeObserver(fitBar);
barWatch.observe(document.querySelector(".topbar"));
barWatch.observe($("blocker-banner"));
addEventListener("scroll", fitBar, { passive: true });

// Keys. Enter opens the next call's memo, J its link, N skips it (Home only, through the row's own controls);
// the record key starts recording when the status offers it, the stop key stops it during a call, and "/" goes to
// the call's ask field. None fire in a field, on a button (Enter), or while a dialog, an overlay or the menu is open.
// `combo`: a modifier combination that is ours everywhere; `shift`: Shift allowed (layouts that need it for "/");
// `focus`: the control takes focus instead of a click.
const homeControl = selector => ($("home").hidden ? null : $("home").querySelector(`.row.next ${selector}`));
const shortcuts = [
  { label: "shell.key.memo", kbd: "↵", match: event => event.key === "Enter",
    control: () => homeControl('.actions button[aria-controls][aria-expanded="false"]') },
  { label: "action.start", kbd: RECORD_KEY, combo: true,
    match: event => event.code === "KeyR" && event.shiftKey && (MAC ? event.metaKey && !event.altKey : event.altKey && !event.metaKey),
    control: () => (currentStatus().action?.id === "start" ? $("call-status-action") : null) },
  { label: "action.stop", kbd: STOP_KEY, combo: true,
    match: event => event.code === "KeyE" && event.shiftKey && (MAC ? event.metaKey && !event.altKey : event.altKey && !event.metaKey),
    control: () => ($("call-stop").hidden ? null : $("call-stop")) },
  { label: "call.ask_label", kbd: "/", shift: true, focus: true, match: event => event.key === "/",
    control: () => ($("call-question").getClientRects().length ? $("call-question") : null) },
  { label: "shell.key.join", kbd: "J", match: event => event.code === "KeyJ", control: () => homeControl('.actions a.ql[target="_blank"]') },
  { label: "shell.key.skip", kbd: "N", match: event => event.code === "KeyN", control: () => homeControl('.actions button.quiet[data-key$="|skip"]') },
];
const OVERLAYS = "dialog[open], #settings-panel:not([hidden]), #getting-started:not([hidden]), #archive-dialog:not([hidden]), #app-menu:not([hidden]), #call-more-menu:not([hidden])";

document.addEventListener("keydown", event => {
  const shortcut = shortcuts.find(item => item.match(event));
  if (!shortcut) return;
  // The combos are ours everywhere, so they never reload the page or open a browser tool, even where they do nothing.
  if (shortcut.combo) event.preventDefault();
  if (event.repeat || document.querySelector(OVERLAYS)) return;
  const plain = !shortcut.combo && (event.metaKey || event.ctrlKey || event.altKey || (event.shiftKey && !shortcut.shift));
  if (plain || event.target.closest?.(`input, textarea, select, [contenteditable]${shortcut.kbd === "↵" ? ', button, a, summary, [role="button"]' : ""}`)) return;
  const control = shortcut.control();
  if (!control || control.disabled) return;
  if (shortcut.focus) {
    event.preventDefault(); // the "/" goes to the field, not into it (F20)
    return control.focus();
  }
  control.click();
  // ↵ leaves focus on the memo's button, so ↵ again folds it (this ↵ must not also press the button it lands on).
  if (shortcut.kbd === "↵") {
    event.preventDefault();
    control.focus();
  }
});

// The menu lists the shortcuts that work now, each as an item doing the same thing. Rebuilt only when that
// list changes, so a poll never takes focus away from an item.
let shortcutSignature = "";
function renderShortcuts() {
  if (!menu.hidden) return; // never rebuilt under the focused item: toggleMenu refreshes it before opening
  const ready = shortcuts.filter(item => item.control());
  const signature = JSON.stringify([uiLanguage, ready.map(item => item.label)]);
  if (signature === shortcutSignature) return;
  shortcutSignature = signature;
  const group = $("menu-shortcuts");
  group.hidden = !ready.length;
  group.setAttribute("aria-label", t("shell.keys"));
  const heading = textNode("p", "menu-label", t("shell.keys"));
  heading.setAttribute("aria-hidden", "true");
  group.replaceChildren(heading, ...ready.map(item => {
    const button = textNode("button", "", "");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.append(textNode("span", "mi", t(item.label)), keyHint(item.kbd));
    button.addEventListener("click", () => (item.focus ? item.control()?.focus() : item.control()?.click()));
    return button;
  }));
}

function renderShell() {
  // Before the first state answer the view is unknown: show none rather than Home flashing over a live call.
  // Once the poll calls the connection failed, Home shows with the bar saying so, never a blank page.
  if (window.appState === undefined && !stateConnectionFailed) return;
  let manual = null;
  try {
    manual = JSON.parse(localStorage.getItem("meetontrack-view"));
  } catch {}
  const view = viewFor(window.appState, manual);
  document.body.dataset.view = view;
  $("home").hidden = view !== "home";
  // The Call view: the feed, or one panel over it (call.js openCallPanel). Another view closes the panel.
  if (view !== "call") delete document.body.dataset.callPanel;
  // More belongs to the Call feed: left open as the call ends, it would block Home's shortcuts (E2).
  if (view !== "call" && !$("call-more-menu").hidden) toggleMenu($("call-more-menu"), $("call-more"), false);
  const panel = Boolean(document.body.dataset.callPanel);
  // Board and Transcript keep the feed's hint and the dock around them (N6); chat and notes take the whole view.
  $("call").hidden = view !== "call" || (panel && !["board", "transcript"].includes(document.body.dataset.callPanel));
  $("call-back").hidden = !panel;
  if (view === "call") renderCall(window.appState);
  renderCallBar(window.appState, Date.now());
  if (view === "home") $("nav-home").setAttribute("aria-current", "page");
  else $("nav-home").removeAttribute("aria-current");
  renderHome(window.agendaData, window.appState);
  renderStatus(view);
  renderShortcuts();
}

// A menu (Menu in the bar, More in the dock): opens on its first item, arrows move, Escape or a click outside closes it.
// Choosing an item closes it too; focus goes back to its button unless the item moved it elsewhere.
const menu = $("app-menu");
const MENUS = [[menu, $("menu-button")], [$("call-more-menu"), $("call-more")]];
const menuItems = list => [...list.querySelectorAll('[role="menuitem"]')].filter(item => item.getClientRects().length && !item.disabled);

function toggleMenu(list, button, open) {
  if (!open && list.contains(document.activeElement)) button.focus();
  if (open && list === menu) renderShortcuts();
  list.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
  if (open) menuItems(list)[0]?.focus();
}

for (const [list, button] of MENUS) {
  button.addEventListener("click", () => toggleMenu(list, button, list.hidden));
  list.addEventListener("click", event => event.target.closest('[role="menuitem"]') && toggleMenu(list, button, false));
}
// While a menu is open its keys work wherever focus is, and Escape closes nothing else.
document.addEventListener("keydown", event => {
  const [list, button] = MENUS.find(([list]) => !list.hidden) || [];
  if (!list) return;
  if (event.key === "Escape") {
    event.stopPropagation();
    toggleMenu(list, button, false);
    button.focus();
  } else if (event.key === "Tab") {
    toggleMenu(list, button, false);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const items = menuItems(list), index = items.indexOf(document.activeElement), down = event.key === "ArrowDown";
    items.at(index < 0 ? (down ? 0 : -1) : (index + (down ? 1 : -1)) % items.length)?.focus();
  }
}, true);
// More lives only under 700 px: a window widened past that closes it, and focus left in it goes to the ask field.
const MORE_WIDTH = matchMedia("(max-width: 700px)");
MORE_WIDTH.addEventListener("change", () => {
  const [list, button] = MENUS[1];
  if (MORE_WIDTH.matches || list.hidden) return;
  const inside = list.contains(document.activeElement);
  toggleMenu(list, button, false);
  if (inside) $("call-question").focus();
});
document.addEventListener("click", event => {
  for (const [list, button] of MENUS) {
    if (!list.hidden && !list.contains(event.target) && !button.contains(event.target)) toggleMenu(list, button, false);
  }
});
const goHome = () => {
  if (!$("archive-dialog").hidden) closeArchive();
  openView("home");
};
$("nav-home").addEventListener("click", goHome);
$("menu-nav-home").addEventListener("click", goHome);
$("menu-past-calls").addEventListener("click", () => $("archive-button").click());
$("menu-updates").addEventListener("click", () => $("updates-notice").click());
$("getting-started-open").addEventListener("click", () => $("settings-panel").hidden || $("settings-close").click());
// The guide opened at one step: the step at its top, focus on its button (or the step's first control).
function openGuideStep(heading, control) {
  $("getting-started-open").click();
  const step = $(heading);
  step.scrollIntoView({ block: "start" });
  (control ? $(control) : step.closest(".startup-step").querySelector("button:not([hidden]):not(:disabled), select"))?.focus({ preventScroll: true });
}
// Every reason How to fix shows for (recorder, microphone, call audio) is the guide's recording step.
$("call-status-help").addEventListener("click", () => openGuideStep("startup-audio-heading", "startup-recorder"));
// Settings and the guide: focus goes to the panel's heading when it opens, Escape closes it, and focus goes back to
// the control that opened it (a menu item, hidden by then, hands it to Menu). Registered after getting-started.js
// sets its own handlers, so the panel is already shown when the heading takes focus.
const PANELS = [["settings-panel", "settings-open", "settings-close", "settings-heading"],
  ["getting-started", "getting-started-open", "getting-started-close", "getting-started-heading"]];
addEventListener("DOMContentLoaded", () => {
  for (const [panel, open, close, heading] of PANELS) {
    let opener = null;
    $(open).addEventListener("click", () => {
      opener = document.activeElement === document.body ? null : document.activeElement;
      if (!$(panel).hidden) $(heading).focus({ preventScroll: true });
    });
    $(close).addEventListener("click", () => returnFocus(opener));
  }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || document.querySelector("dialog[open]")) return;
  const open = PANELS.find(([panel]) => !$(panel).hidden);
  if (open) $(open[2]).click();
});
$("call-status-action").addEventListener("click", event => {
  if (event.currentTarget.dataset.action !== "back") return statusAction(event.currentTarget, event.currentTarget.dataset.action);
  try {
    localStorage.removeItem("meetontrack-view");
  } catch {}
  renderShell();
});
$("call-stop").addEventListener("click", event => statusAction(event.currentTarget, event.currentTarget.dataset.mode === "resume" ? "resume" : "stop"));
$("call-stop").querySelector("kbd").textContent = STOP_KEY;
$("menu-chat").addEventListener("click", () => openCallPanel("chat"));
$("menu-notes").addEventListener("click", () => (document.body.dataset.view === "call" ? openCallPanel("notes")
  : document.querySelector('[data-content-view="notes"]').click()));

renderShell();
