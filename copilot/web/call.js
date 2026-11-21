// Call: the one hint to say or ask now, the audio heartbeat and the call clock, from the /api/state poll.
// Transcript, journal and AI text are untrusted: every value goes in through textContent.
const HINT_FRESH_MS = 30000; // an event hint stays current this long
const OWN_FRESH_MS = 60000; // the answer to the person's own question stays current this long
const CALL_HINT_WORDS = 12;
const CALL_HINT_SPLIT = /\n|(?:Основание|Источник|Evidence|Source):/u; // the split of the board's main line
const CALL_CLAUSE_MARKS = [", ", "; ", ": ", " - ", " — ", " – "]; // dashes: Russian model output uses them (F15)
const callWords = text => text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));

// The part of a hint a person can say aloud: its first line, cut to a clause or to twelve words.
function speakable(text) {
  const line = readableAnswer(String(text || "")).split(CALL_HINT_SPLIT)[0].trim();
  if (callWords(line).length <= CALL_HINT_WORDS) return line;
  const at = Math.min(...CALL_CLAUSE_MARKS.map(mark => line.indexOf(mark)).filter(index => index > 0));
  const clause = Number.isFinite(at) ? line.slice(0, at).trim() : "";
  const size = callWords(clause).length;
  if (size >= 3 && size <= CALL_HINT_WORDS) return line.endsWith("?") && !clause.endsWith("?") ? `${clause}?` : clause;
  // The same words the count saw: a lone dash is not a word, and no dash or stop is left before the ellipsis.
  return `${callWords(line).slice(0, CALL_HINT_WORDS).join(" ").replace(/[\s,;:.\-–—]+$/u, "")}…`;
}

const callAt = value => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
};
const callLabel = (label, at) => (at === null ? label : t("call.at", { label, time: homeClock(at) }));
// The verb the label says (Ask, Say, Clarify): a line that starts with it loses it, so the verb is said once
// (ruling 8). The verb comes from the whole line, so a cut never turns Ask into Say (ruling 6).
const CALL_VERBS = [["ask", "Спросите|Ask"], ["say", "Скажите|Say"], ["clarify", "Уточните|Clarify"]];
function callLine(raw) {
  const line = readableAnswer(String(raw || "")).split(CALL_HINT_SPLIT)[0].trim();
  for (const [verb, words] of CALL_VERBS) {
    const match = line.match(new RegExp(`^(?:${words})(?=[\\s,:]|$)[\\s,:]*`, "iu"));
    if (match && match[0].length < line.length) {
      const rest = line.slice(match[0].length);
      return { line, verb, rest: rest[0].toLocaleUpperCase() + rest.slice(1) };
    }
  }
  return { line, verb: null, rest: line };
}
// The line to say, and the whole line when it was cut, so it can be read in full.
function callCut(line) {
  const text = speakable(line);
  return { text, full: text === line ? "" : line };
}
const callVerbLabel = ({ verb, rest }) => t(`call.${verb || (rest.endsWith("?") ? "ask" : "say")}`);
const callSame = (a, b) => [a, b].map(text => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")).reduce((x, y) => x === y);

// Source and detail of a journal hint: the lines after the hint line, then the evidence and the speaker.
function callParts(raw, item) {
  const text = readableAnswer(String(raw || ""));
  const head = text.split(CALL_HINT_SPLIT)[0];
  const rest = text.slice(head.length).replace(/^\n/, "").split("\n").map(line => line.trim()).filter(Boolean);
  const evidence = String(item.evidence || "").trim();
  return { source: rest[0] || evidence, detail: [...rest.slice(1), rest.length ? evidence : "", String(item.speaker || "").trim()].filter(Boolean) };
}

function hintCandidates(state) {
  const hints = [];
  const messages = state?.copilot?.messages || [];
  const own = messages.findLastIndex((message, index) => message.role === "assistant" && messages[index - 1]?.role === "user");
  if (own > 0) {
    const at = callAt(messages[own].at);
    hints.push({ kind: "own", tier: 0, at, label: callLabel(t("call.own"), at), question: String(messages[own - 1].text || ""),
      text: String(messages[own].text || ""), source: "", detail: [] });
  }
  for (const item of state?.journal || []) {
    const at = callAt(item.created_at);
    const open = item.status !== "resolved";
    if (item.category === "INCOMING_QUESTION" && item.reply && open) {
      const speaker = String(item.speaker || "").trim();
      const label = speaker ? t("call.asks", { name: speaker }) : t("call.asks_plain");
      hints.push({ kind: "answer", tier: 1, at, label: callLabel(label, at), question: String(item.text || ""),
        ...callCut(callLine(item.reply).line), ...callParts(item.reply, item) });
    } else if (item.category === "CONTRADICTION" && open) {
      const line = callLine(item.text);
      hints.push({ kind: "check", tier: 2, at, label: callLabel(t("call.clarify"), at), question: "",
        ...callCut(line.verb === "clarify" ? line.rest : line.line), ...callParts(item.text, item) });
    } else if (["ASK", "RISK", "OBJECTION"].includes(item.category) && open) {
      const line = callLine(item.text);
      hints.push({ kind: "signal", tier: 3, at, label: callLabel(callVerbLabel(line), at), question: "", ...callCut(line.rest),
        ...callParts(item.text, item) });
    }
  }
  for (const item of state?.fact_checks?.items || []) {
    if (item.status !== "refuted") continue;
    const at = callAt(item.checked_at);
    const speaker = String(item.segment?.speaker || item.segment?.speaker_label || "").trim();
    const said = item.quote || item.claim || "";
    const quote = uiLanguage === "ru" ? `«${said}»` : `“${said}”`;
    const line = callLine(item.fact);
    hints.push({ kind: "check", tier: 2, at, label: callLabel(t("call.clarify"), at), question: "",
      ...callCut(line.verb === "clarify" ? line.rest : line.line), source: speaker ? `${speaker}: ${quote}` : quote, detail: [] });
  }
  const questions = (state?.call_plan?.items || []).filter(item => item.kind === "question");
  const next = questions.findIndex(item => item.status !== "resolved");
  if (next >= 0) {
    const line = callLine(questions[next].text);
    const label = state.call_plan.source_label;
    hints.push({ kind: "memo", tier: 4, at: null, label: callVerbLabel(line), question: "", ...callCut(line.rest),
      source: t("call.from_memo", { n: next + 1 }), detail: label ? [label] : [] });
  }
  return hints;
}

// The one hint to show now and the earlier ones, newest first.
function pickHint(state, now) {
  const hints = hintCandidates(state);
  const events = hints.filter(hint => hint.kind !== "memo" && hint.at !== null).sort((a, b) => b.at - a.at);
  const fresh = events.filter(hint => now - hint.at <= (hint.kind === "own" ? OWN_FRESH_MS : HINT_FRESH_MS));
  const current = fresh.sort((a, b) => a.tier - b.tier)[0] || hints.find(hint => hint.kind === "memo") || null;
  // A hint that says the current one again (an ASK repeating the memo question) is not listed under it.
  return { current, earlier: events.filter(hint => hint !== current && !(current && callSame(hint.text, current.text))).slice(0, 20) };
}

// Is each side heard? Only a stalled track or a lost call-audio warning reads as not heard: silence never does.
function heartbeat(state, now) {
  const tracks = state?.recording_health?.capture?.tracks || [];
  const segments = state?.transcript?.segments || [];
  const mark = (kind, source) => {
    const newest = Math.max(...segments.filter(item => item.source === source).map(item => callAt(item.timestamp) ?? -Infinity));
    const speaking = now - newest < 10000;
    const track = tracks.find(item => item.source === kind);
    if (track?.state === "stalled") {
      const age = track.last_growth_age_seconds;
      return { state: "not_heard", since: age === null || age === undefined ? null : now - age * 1000, speaking };
    }
    const lost = kind === "system" && (state?.transcript?.capture_warnings || [])
      .find(item => item.reason === "system-audio-lost" && !item.ended_at);
    if (lost) return { state: "not_heard", since: callAt(lost.started_at), speaking };
    if (track?.state === "recording") return { state: "heard", since: null, speaking };
    if (track?.state === "verifying") return { state: "checking", since: null, speaking };
    return { state: now - newest < 120000 ? "heard" : "unknown", since: null, speaking };
  };
  return { you: mark("mic", "microphone"), other: mark("system", "system") };
}

function callClock(startIso, now) {
  const start = callAt(startIso);
  if (start === null) return "";
  const seconds = Math.max(0, Math.floor((now - start) / 1000));
  const two = value => String(value).padStart(2, "0");
  const [hours, minutes] = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60];
  return hours ? `${hours}:${two(minutes)}:${two(seconds % 60)}` : `${two(minutes)}:${two(seconds % 60)}`;
}

function lastPhrase(state) {
  const text = String(state?.transcript?.segments?.at(-1)?.text || "").trim();
  return text.length > 90 ? `…${text.slice(-90)}` : text;
}

// The feed: the call's name, a problem when a side is not heard, the one slot, the paused note and the earlier
// hints. Each part is rebuilt only when what it shows changes, so focus and an open source line survive the poll.
let callPending = null; // {question, at}: the person's own question, sent, its answer not back yet
let callEarlierOpen = false;
const callWhereOpen = new Set(); // keys of the hints whose source is open
const callSignatures = {};

const callHintKey = hint => `${hint.kind}|${hint.at}|${hint.text}`;
function callButton(className, label, onClick) {
  const button = textNode("button", className, label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}
// Rebuilt only when its description changes.
function callPart(id, description, build) {
  const signature = JSON.stringify([uiLanguage, description]);
  if (callSignatures[id] === signature) return;
  callSignatures[id] = signature;
  $(id).replaceChildren(...(description ? build(description) : []));
}

async function callOpenSettings(which) {
  try {
    await post("/api/permissions/open", { which });
  } catch (error) {
    statusError = { text: plainError(error), state: window.appState };
    renderShell();
  }
}

// One problem at a time, the other side first: without its sound there are no hints on what it says.
function callProblem(state, now) {
  const beat = heartbeat(state, now);
  const side = beat.other.state === "not_heard" ? "other" : beat.you.state === "not_heard" ? "you" : null;
  if (!side) return null;
  const since = beat[side].since;
  return { side, title: since === null ? t(`call.${side}_lost_now`) : t(`call.${side}_lost`, { time: homeClock(since) }) };
}

// What the slot shows: the pending own question, then the hint picked, a heard question, or the waiting line.
function callSlot(state, current, now) {
  const own = current?.kind === "own" ? current : null;
  if (callPending && ((own && own.at > callPending.at) || (!requestBusy && !state?.copilot?.busy))) callPending = null;
  if (callPending) return { type: "pending", label: t("call.own"), question: callPending.question };
  if (own) return { type: "own", label: own.label, question: own.question, text: own.text };
  if (current?.kind === "answer") {
    return { type: "answer", key: callHintKey(current), label: current.label, question: current.question, text: current.text,
      full: current.full, source: "", detail: [] };
  }
  const heard = state?.heard_question;
  if (heard?.text) {
    const speaker = String(heard.speaker || "").trim();
    const label = speaker ? t("call.asks", { name: speaker }) : t("call.asks_plain");
    return { type: "heard", label: callLabel(label, callAt(heard.at)), question: String(heard.text) };
  }
  if (current) {
    const key = callHintKey(current);
    return { type: "hint", key, label: current.label, text: current.text, full: current.full, source: current.source, detail: current.detail };
  }
  const beat = heartbeat(state, now);
  return { type: "waiting", text: t(beat.you.state === "heard" || beat.other.state === "heard" ? "call.waiting_heard" : "call.waiting") };
}

function callSlotNodes(slot) {
  const nodes = [textNode("p", "say", slot.label || "")];
  if (slot.type === "waiting") return [textNode("p", "waiting", slot.text), textNode("p", "heard-wait", t("call.waiting_help"))];
  if (slot.question) nodes.push(textNode("p", "heard-q", slot.question));
  if (slot.type === "pending" || slot.type === "heard") nodes.push(textNode("p", "heard-wait", t("call.heard_wait")));
  if (slot.type === "own") {
    nodes.push(textNode("p", "own-answer", readableAnswer(slot.text)));
    const actions = document.createElement("p");
    actions.className = "why-acts";
    actions.append(callButton("ql", t("call.open_chat"), () => openCallPanel("chat")));
    nodes.push(actions);
  }
  if (slot.type === "answer" || slot.type === "hint") nodes.push(textNode("p", "hint", slot.text));
  // Where this comes from opens what the slot does not show: the whole hint when it was cut, the whole source line
  // and the detail. A source that fits on its line with nothing else to show gets no control (callFitWhere).
  const more = [slot.full, slot.source, ...(slot.detail || [])].filter(Boolean);
  if ((slot.type === "answer" || slot.type === "hint") && more.length) {
    const why = slot.source ? textNode("p", "why", slot.source) : null;
    const box = document.createElement("div");
    box.className = "why-more";
    box.id = "call-why-more";
    box.append(...more.map((line, index) => textNode("p", index === 0 && slot.full ? "why-full" : "", line)));
    const actions = document.createElement("p");
    actions.className = "why-acts";
    if (!slot.full && !slot.detail?.length) actions.dataset.clip = "";
    const where = callButton("ql", "", () => {
      if (callWhereOpen.has(slot.key)) callWhereOpen.delete(slot.key);
      else callWhereOpen.add(slot.key);
      show();
    });
    where.setAttribute("aria-controls", box.id);
    // Toggled in place: the live slot is not rebuilt, so the hint is not announced again.
    const show = () => {
      const open = callWhereOpen.has(slot.key);
      if (why) why.hidden = open;
      box.hidden = !open;
      where.textContent = t(open ? "call.where_hide" : "call.where");
      where.setAttribute("aria-expanded", String(open));
    };
    show();
    actions.append(where);
    nodes.push(...[why, box, actions].filter(Boolean));
  }
  return nodes;
}

function renderCall(state) {
  const now = Date.now();
  const transcript = state?.transcript || {};
  const name = transcript.display_meeting || transcript.meeting || "";
  if ($("call-name").textContent !== name) $("call-name").textContent = name;

  callPart("call-problem", callProblem(state, now), problem => {
    const box = document.createElement("div");
    box.className = "problem";
    const heading = document.createElement("h3");
    heading.append(textNode("span", "fail", problem.title));
    const actions = document.createElement("div");
    actions.className = "actions";
    const other = problem.side === "other";
    actions.append(
      callButton("primary", t(other ? "action.sound_output" : "action.open_mic"), () => callOpenSettings(other ? "sound_output" : "microphone")),
      // One target for How to fix everywhere: the guide's recording step, as in the bar (F17).
      callButton("ql", t("action.how_to_fix"), () => openGuideStep("startup-audio-heading", "startup-recorder")),
    );
    box.append(heading, textNode("p", "", t(other ? "call.other_lost_text" : "call.you_lost_text")), actions);
    return [box];
  });

  const pick = pickHint(state, now);
  callPart("call-slot", callSlot(state, pick.current, now), callSlotNodes);
  callFitWhere();

  // The analysis failed: hints pause until the next try, five minutes after it (F3).
  const analysis = state?.copilot?.analysis;
  const failed = analysis?.state === "error" ? callAt(analysis.at) : null;
  const retry = failed === null ? null : failed + 300000;
  // A retry time that has passed is not shown: the next try comes with the next analysis.
  const note = retry === null ? null : retry > now ? t("call.paused", { time: homeClock(retry) }) : t("call.paused_next");
  $("call-note").hidden = !note;
  callPart("call-note", note, text => [`${text} `, callButton("ql", t("call.check_ai"), () => $("getting-started-open").click())]);

  const earlier = pick.earlier.map(hint => ({ label: hint.label, text: hint.text, source: hint.source }));
  const open = $("call-earlier-open");
  const count = t("call.earlier", { n: earlier.length });
  if (open.textContent !== count) open.textContent = count;
  open.setAttribute("aria-expanded", String(callEarlierOpen));
  // Nothing earlier: no Earlier button at all (ruling 4).
  open.hidden = !earlier.length;
  $("call-earlier").hidden = !callEarlierOpen || !earlier.length;
  callPart("call-earlier", earlier, list => {
    const items = document.createElement("ul");
    items.append(...list.map(hint => {
      const item = document.createElement("li");
      item.append(textNode("p", "say", hint.label), textNode("p", "earlier-hint", hint.text));
      if (hint.source) item.append(textNode("p", "why", hint.source));
      return item;
    }));
    return [items];
  });
}

// A source with nothing else to open shows Where this comes from only when its line is cut. Measured after every
// render and on resize; an open source stays open.
function callFitWhere() {
  const actions = $("call-slot").querySelector(".why-acts[data-clip]");
  const why = $("call-slot").querySelector(".why");
  if (actions && why && !why.hidden) actions.hidden = why.scrollWidth <= why.clientWidth;
}
addEventListener("resize", callFitWhere);

// The transcript or the board (and the chat and notes tabs) opened as a panel over the feed. Focus goes to the
// panel's heading, and back to the control that opened it when the panel closes.
let callOpener = null;
function openCallPanel(panel) {
  const body = document.body;
  const wasOpen = Boolean(body.dataset.callPanel);
  if (panel) {
    if (!wasOpen) callOpener = document.activeElement === body ? null : document.activeElement;
    body.dataset.callPanel = panel;
    if (panel !== "transcript") document.querySelector(`[data-content-view="${panel}"]`).click();
  } else {
    delete body.dataset.callPanel;
  }
  renderShell();
  if (panel) (panel === "transcript" ? $("transcript-heading") : document.querySelector(`[data-content-view="${panel}"]`)).focus();
  else if (wasOpen) returnFocus(callOpener);
}

addEventListener("DOMContentLoaded", () => {
  $("call-earlier-open").addEventListener("click", () => {
    callEarlierOpen = !callEarlierOpen;
    renderCall(window.appState);
  });
  $("call-transcript-open").addEventListener("click", () => openCallPanel("transcript"));
  $("call-board-open").addEventListener("click", () => openCallPanel("board"));
  $("call-back").addEventListener("click", () => openCallPanel(null));
  // A tab switched inside a panel: the panel follows it, so the composer rule (F5) holds.
  document.querySelectorAll("[data-content-view]").forEach(button => button.addEventListener("click", () => {
    const panel = document.body.dataset.callPanel;
    if (panel && panel !== "transcript") document.body.dataset.callPanel = button.dataset.contentView;
  }));
  // The question goes out only when ask() takes it; otherwise it stays in the field (F4).
  $("call-ask").addEventListener("submit", event => {
    event.preventDefault();
    const field = $("call-question");
    const question = field.value.trim();
    if (!question || !window.callAsk(question)) return;
    callPending = { question, at: Date.now() };
    field.value = "";
    renderCall(window.appState);
  });
});
// Escape closes the panel, unless a menu, a dialog or an overlay is open: that one closes first.
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !document.body.dataset.callPanel || document.querySelector(`${OVERLAYS}, #call-more-menu:not([hidden])`)) return;
  event.preventDefault();
  openCallPanel(null);
}, true);
