// The shell picks one view from the state: a live recording shows the call, a recording that ended
// in the last two hours shows After, anything else shows Home. A view opened by hand holds for two
// hours at most, and only until the call changes (a different meeting, or recording starting or stopping).
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
  document.getElementById("home").hidden = view !== "home";
  renderHome(window.agendaData, window.appState);
}

renderShell();
