// The shell picks one view from the state: a live recording shows the call, a recording that ended
// in the last two hours shows After, anything else shows Home. A view opened by hand holds until
// the call changes (a different meeting, or recording starting or stopping).
const AFTER_WINDOW_MS = 2 * 60 * 60 * 1000;

function callKey(state) {
  const live = state?.recording_health?.capture?.audio_recording === true || state?.transcript?.live === true;
  return `${live}:${state?.transcript?.meeting_id || ""}`;
}

function viewFor(state, manual, now = Date.now()) {
  if (manual && manual.key === callKey(state)) return manual.view;
  if (callKey(state).startsWith("true:")) return "call";
  const transcript = state?.transcript || {};
  const ended = Date.parse(transcript.latest_at || "");
  if (transcript.status === "finished" && transcript.meeting_id && now - ended <= AFTER_WINDOW_MS) return "after";
  return "home";
}

function openView(view) {
  try {
    localStorage.setItem("meetontrack-view", JSON.stringify({ view, key: callKey(window.appState) }));
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
