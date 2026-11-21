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
    return capture === "paused" || capture === "stalled" ? capture : "";
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
      short: t("status.mic_missing_short"), action: action("open_mic") };
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
};
const MAC = /Mac/.test(navigator.platform);
const RECORD_KEY = MAC ? "⌘⇧R" : "Alt+Shift+R";
const keyHint = label => {
  const node = textNode("kbd", "", label);
  node.setAttribute("aria-hidden", "true");
  return node;
};
let statusError = null; // {text, state}: a failed status action, shown until the next state poll replaces the state

// A status action from the bar: its busy key makes a double click post once, and it stays disabled until the
// agenda and permissions are fetched again.
async function statusAction(button, id) {
  const key = `status|${id}`;
  if (homeBusy.has(key)) return;
  homeBusy.add(key);
  button.disabled = true;
  renderShell();
  try {
    await post(...STATUS_POSTS[id]);
  } catch (error) {
    statusError = { text: plainError(error), state: window.appState };
  }
  try {
    await refreshAgenda();
  } finally {
    homeRelease(key);
    renderShell();
    if (document.activeElement === document.body && !button.closest("#home")) $("call-status-action").focus();
  }
}

// Up to 480 px the waiting status drops "recording starts by itself", so the bar keeps to two rows.
const SHORT_BAR = matchMedia("(max-width: 480px)");
SHORT_BAR.addEventListener("change", () => renderShell());

function renderStatus(view) {
  if (statusError && statusError.state !== window.appState) statusError = null;
  const status = currentStatus();
  // Another view opened by hand during a call: the way back to the call is the status's action.
  if (isLive(window.appState) && view !== viewFor(window.appState, null)) {
    status.action = { id: "back", label: t("action.back_to_call"), primary: true };
  }
  const text = $("call-status-text");
  const shown = statusError?.text || (SHORT_BAR.matches && status.short) || status.text;
  if (text.textContent !== shown) text.textContent = shown;
  text.className = `status-text${status.kind === "recording" ? " rec" : statusError || status.kind !== "waiting" ? " fail" : ""}`;
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
  // R34: the bar owns a call that is not being recorded, and How to fix sits beside its button.
  $("call-status-help").hidden = status.kind !== "not_recording";
  $("menu-notes").hidden = view === "home";
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
// the record key starts recording when the status offers it. None fire in a field, on a button (Enter),
// or while a dialog, an overlay or the menu is open.
const homeControl = selector => ($("home").hidden ? null : $("home").querySelector(`.row.next ${selector}`));
const shortcuts = [
  { label: "shell.key.memo", kbd: "↵", match: event => event.key === "Enter",
    control: () => homeControl('.actions button[aria-controls][aria-expanded="false"]') },
  { label: "action.start", kbd: RECORD_KEY, record: true,
    match: event => event.code === "KeyR" && event.shiftKey && (MAC ? event.metaKey && !event.altKey : event.altKey && !event.metaKey),
    control: () => (currentStatus().action?.id === "start" ? $("call-status-action") : null) },
  { label: "shell.key.join", kbd: "J", match: event => event.code === "KeyJ", control: () => homeControl('.actions a.ql[target="_blank"]') },
  { label: "shell.key.skip", kbd: "N", match: event => event.code === "KeyN", control: () => homeControl('.actions button.quiet[data-key$="|skip"]') },
];
const OVERLAYS = "dialog[open], #settings-panel:not([hidden]), #getting-started:not([hidden]), #archive-dialog:not([hidden]), #app-menu:not([hidden])";

document.addEventListener("keydown", event => {
  const shortcut = shortcuts.find(item => item.match(event));
  if (!shortcut) return;
  // The record combo is ours everywhere, so it never reloads the page, even where it does nothing.
  if (shortcut.record) event.preventDefault();
  if (event.repeat || document.querySelector(OVERLAYS)) return;
  const plain = !shortcut.record && (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey);
  if (plain || event.target.closest?.(`input, textarea, select, [contenteditable]${shortcut.kbd === "↵" ? ', button, a, summary, [role="button"]' : ""}`)) return;
  const control = shortcut.control();
  if (!control || control.disabled) return;
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
    button.addEventListener("click", () => item.control()?.click());
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
  if (view === "home") $("nav-home").setAttribute("aria-current", "page");
  else $("nav-home").removeAttribute("aria-current");
  renderHome(window.agendaData, window.appState);
  renderStatus(view);
  renderShortcuts();
}

// The menu: opens on its first item, arrows move, Escape or a click outside closes it.
// Choosing an item closes it too; focus goes back to Menu unless the item moved it elsewhere.
const menu = $("app-menu");
const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]')].filter(item => item.getClientRects().length && !item.disabled);

function toggleMenu(open) {
  if (!open && menu.contains(document.activeElement)) $("menu-button").focus();
  if (open) renderShortcuts();
  menu.hidden = !open;
  $("menu-button").setAttribute("aria-expanded", String(open));
  if (open) menuItems()[0]?.focus();
}

$("menu-button").addEventListener("click", () => toggleMenu(menu.hidden));
menu.addEventListener("click", event => event.target.closest('[role="menuitem"]') && toggleMenu(false));
// While the menu is open its keys work wherever focus is, and Escape closes nothing else.
document.addEventListener("keydown", event => {
  if (menu.hidden) return;
  if (event.key === "Escape") {
    event.stopPropagation();
    toggleMenu(false);
    $("menu-button").focus();
  } else if (event.key === "Tab") {
    toggleMenu(false);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const items = menuItems(), index = items.indexOf(document.activeElement), down = event.key === "ArrowDown";
    items.at(index < 0 ? (down ? 0 : -1) : (index + (down ? 1 : -1)) % items.length)?.focus();
  }
}, true);
document.addEventListener("click", event => {
  if (!menu.hidden && !menu.contains(event.target) && !$("menu-button").contains(event.target)) toggleMenu(false);
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
$("call-status-help").addEventListener("click", () => $("getting-started-open").click());
$("call-status-action").addEventListener("click", event => {
  if (event.currentTarget.dataset.action !== "back") return statusAction(event.currentTarget, event.currentTarget.dataset.action);
  try {
    localStorage.removeItem("meetontrack-view");
  } catch {}
  renderShell();
});
$("menu-notes").addEventListener("click", () => document.querySelector('[data-content-view="notes"]').click());

renderShell();
