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

function callKey(state, now = Date.now()) {
  return `${isLive(state, now)}:${state?.transcript?.meeting_id || ""}`;
}

function viewFor(state, manual, now = Date.now()) {
  if (manual && manual.key === callKey(state, now) && now - manual.at < AFTER_WINDOW_MS) return manual.view;
  if (isLive(state, now)) return "call";
  const transcript = state?.transcript || {};
  const ended = Date.parse(transcript.latest_at || "");
  if (transcript.status === "finished" && transcript.meeting_id && now - ended <= AFTER_WINDOW_MS) return "after";
  return "home";
}

function openView(view) {
  try {
    localStorage.setItem("meetontrack-view", JSON.stringify({ view, key: callKey(window.appState), at: Date.now() }));
  } catch {}
  renderShell();
}

function renderShell() {
  let manual = null;
  try {
    manual = JSON.parse(localStorage.getItem("meetontrack-view"));
  } catch {}
  const view = viewFor(window.appState, manual);
  document.body.dataset.view = view;
  $("home").hidden = view !== "home";
  if (view === "home") $("nav-home").setAttribute("aria-current", "page");
  else $("nav-home").removeAttribute("aria-current");
  // ponytail: the bar repeats the recorder's status line; the call status gets its own rules with Task 8.
  const capture = $("capture-status");
  $("call-status-text").textContent = (capture.hidden ? $("live-status") : capture).textContent.trim();
  renderHome(window.agendaData, window.appState);
}

// The menu: opens on its first item, arrows move, Escape or a click outside closes it.
// Choosing an item closes it too; focus goes back to Menu unless the item moved it elsewhere.
const menu = $("app-menu");
const menuItems = () => [...menu.querySelectorAll('[role="menuitem"]')].filter(item => item.getClientRects().length && !item.disabled);

function toggleMenu(open) {
  if (!open && menu.contains(document.activeElement)) $("menu-button").focus();
  menu.hidden = !open;
  $("menu-button").setAttribute("aria-expanded", String(open));
  if (open) menuItems()[0]?.focus();
}

$("menu-button").addEventListener("click", () => toggleMenu(menu.hidden));
menu.addEventListener("click", event => event.target.closest('[role="menuitem"]') && toggleMenu(false));
menu.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    event.stopPropagation();
    toggleMenu(false);
  } else if (event.key === "Tab") {
    toggleMenu(false);
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const items = menuItems();
    items.at((items.indexOf(document.activeElement) + (event.key === "ArrowDown" ? 1 : -1)) % items.length)?.focus();
  }
});
document.addEventListener("click", event => {
  if (!menu.hidden && !menu.contains(event.target) && !$("menu-button").contains(event.target)) toggleMenu(false);
});
$("nav-home").addEventListener("click", () => openView("home"));
$("menu-nav-home").addEventListener("click", () => openView("home"));
$("menu-past-calls").addEventListener("click", () => $("archive-button").click());
$("menu-updates").addEventListener("click", () => $("updates-notice").click());
$("getting-started-open").addEventListener("click", () => $("settings-panel").hidden || $("settings-close").click());

renderShell();
