// Call: the one hint to say or ask now, the audio heartbeat and the call clock, from the /api/state poll.
// Transcript, journal and AI text are untrusted: every value goes in through textContent.
const HINT_FRESH_MS = 30000; // an event hint stays current this long
const OWN_FRESH_MS = 60000; // the answer to the person's own question stays current this long
const CALL_ANALYSIS_MS = 5000; // hints this close to the newest one come from the same analysis
const CALL_HINT_WORDS = 12; // a longer hint line shows whole, one step smaller (B1)
const CALL_HINT_SPLIT = /\n|(?:Основание|Источник|Evidence|Source):/u; // the split of the board's main line
const callWords = text => text.split(/\s+/).filter(word => /[\p{L}\p{N}]/u.test(word));

// The part of a hint a person can say aloud: its first line, whole. A hint is never cut: a fragment cannot be
// said to a client (B1), so a long line wraps and steps its type down instead.
function speakable(text) {
  return readableAnswer(String(text || "")).split(CALL_HINT_SPLIT)[0].trim();
}

const callAt = value => {
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : at;
};
// One clock per job (G1): the bar counts the call (callClock), an item says how old it is, lost sound says for how
// long. A time node carries its moment and is kept current in place by callTimes, so nothing is rebuilt for it.
const callStartIso = state => state?.recording_health?.capture?.started_at || state?.transcript?.started_at;
function callTime(at, kind) {
  const node = textNode("span", "", "");
  node.dataset.time = kind;
  node.dataset.at = at;
  return node;
}
function callTimes(now = Date.now()) {
  for (const node of document.querySelectorAll("[data-time]")) {
    const left = node.dataset.time === "left"; // seconds until dataset.at (the undo window, L3)
    const seconds = Math.max(0, left ? Math.ceil((Number(node.dataset.at) - now) / 1000) : Math.floor((now - Number(node.dataset.at)) / 1000));
    const minutes = left ? 0 : Math.floor(seconds / 60);
    const text = node.dataset.time === "age" ? (minutes ? t("call.min_ago", { n: minutes }) : t("call.just_now"))
      : minutes ? t("call.for_min", { n: minutes }) : t("call.for_sec", { n: seconds });
    if (node.textContent !== text) node.textContent = text;
  }
}
// A label with the item's age: "Спросите · 2 мин назад". A memo question has no moment, so no age.
function callSay(className, label, at) {
  const node = textNode("p", className, label);
  if (at !== null && at !== undefined) node.append(" · ", callTime(at, "age"));
  return node;
}
// The verb the label says (Ask, Say, Clarify): a line that starts with it loses it, so the verb is said once
// (ruling 8). The verb comes from the whole line, so a cut never turns Ask into Say (ruling 6).
const CALL_VERBS = [["ask", "Спросите|Ask"], ["say", "Скажите|Say"], ["clarify", "Уточните|Clarify"]];
function callLine(raw) {
  const line = readableAnswer(String(raw || "")).split(CALL_HINT_SPLIT)[0].trim();
  for (const [verb, words] of CALL_VERBS) {
    const match = line.match(new RegExp(`^(?:${words})(?=[\\s,:]|$)[\\s,:]*`, "iu"));
    if (match && match[0].length < line.length) {
      let rest = line.slice(match[0].length);
      // "Ask whether…" or "Clarify the dates" without its verb is a question: it ends like one, never as a bare
      // fragment (B1), so Clarify always stands over a question (H3).
      if ((verb === "ask" || verb === "clarify") && !/[?？]$/u.test(rest)) rest = `${rest.replace(/[.\s]+$/u, "")}?`;
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
// Labels are verbs for what to say (H3). Clarify stands only over a question: a statement under it is said.
const callVerbLabel = ({ verb, rest }) => t(`call.${verb || (rest.endsWith("?") ? "ask" : "say")}`);
const callCheckLabel = text => t(text.endsWith("?") ? "call.clarify" : "call.say");
const callSame = (a, b) => [a, b].map(text => text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "")).reduce((x, y) => x === y);

// Source and detail of a journal hint: the lines after the hint line, then the evidence and the speaker.
function callParts(raw, item) {
  const text = readableAnswer(String(raw || ""));
  const head = text.split(CALL_HINT_SPLIT)[0];
  const rest = text.slice(head.length).replace(/^\n/, "").split("\n").map(line => line.trim()).filter(Boolean);
  const evidence = String(item.evidence || "").trim();
  // One source prefix across Call (G5): "Источник:", whatever word the model put in front.
  const source = (rest[0] || evidence).replace(/^(?:Основание|Источник|Evidence|Source):\s*/u, "");
  return { source: source && t("call.source", { text: source }), raw: source, detail: [...rest.slice(1), rest.length ? evidence : "", String(item.speaker || "").trim()].filter(Boolean) };
}

function hintCandidates(state) {
  const hints = [];
  const messages = state?.copilot?.messages || [];
  const own = messages.findLastIndex((message, index) => message.role === "assistant" && messages[index - 1]?.role === "user");
  if (own > 0) {
    const at = callAt(messages[own].at);
    hints.push({ kind: "own", tier: 0, at, label: t("call.own"), question: String(messages[own - 1].text || ""),
      text: String(messages[own].text || ""), source: "", detail: [] });
  }
  for (const item of state?.journal || []) {
    const at = callAt(item.created_at);
    const open = item.status !== "resolved";
    if (item.category === "INCOMING_QUESTION" && item.reply && open) {
      const speaker = String(item.speaker || "").trim();
      const label = callAsks(speaker);
      const parts = callParts(item.reply, item);
      // A source that only repeats the question is left out: the question shows once (B6).
      if (callSame(parts.raw, String(item.text || ""))) parts.source = "";
      parts.detail = parts.detail.filter(line => line !== speaker); // who asked shows above the answer already (N1)
      hints.push({ kind: "answer", tier: 1, at, label, question: String(item.text || ""), speaker,
        ...callCut(callLine(item.reply).line), ...parts });
    } else if (item.category === "CONTRADICTION" && open) {
      const line = callLine(item.text);
      const cut = callCut(line.verb === "clarify" ? line.rest : line.line);
      hints.push({ kind: "check", tier: 2, at, label: callCheckLabel(cut.text), question: "", ...cut, ...callParts(item.text, item) });
    } else if (["ASK", "RISK", "OBJECTION"].includes(item.category) && open) {
      const line = callLine(item.text);
      hints.push({ kind: "signal", tier: 3, at, label: callVerbLabel(line), question: "", ...callCut(line.rest),
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
    const cut = callCut(line.verb === "clarify" ? line.rest : line.line);
    // What was said, then what it is checked against: the client's words are never labelled a source (O1).
    const said_line = speaker ? t("call.said", { name: speaker, quote }) : quote;
    const ref = item.sources?.[0];
    let name = ref?.title || "";
    try { name ||= ref?.url ? new URL(ref.url).hostname.replace(/^www\./, "") : ""; } catch {}
    const what = ref?.quote && !callSame(ref.quote, cut.text) ? `: ${ref.quote}` : "";
    const per = name ? ` · ${t("call.per", { source: name })}${what}` : "";
    hints.push({ kind: "check", tier: 2, at, label: callCheckLabel(cut.text), question: "", ...cut, source: `${said_line}${per}`, detail: [] });
  }
  const questions = (state?.call_plan?.items || []).filter(item => item.kind === "question");
  const next = questions.findIndex(item => item.status !== "resolved");
  if (next >= 0) {
    const line = callLine(questions[next].text);
    // Its age, like every hint (H3): since the question before it was closed, or since the call began.
    const closed = questions.slice(0, next).map(item => callAt(item.updated_at)).filter(at => at !== null);
    const since = closed.length ? Math.max(...closed) : callAt(state?.transcript?.started_at);
    // Where the question comes from, in the person's words: the preparation and its number, no company (H2, N6).
    hints.push({ kind: "memo", tier: 4, at: null, since, label: callVerbLabel(line), question: "", ...callCut(line.rest),
      source: t("call.from_memo", { n: next + 1 }), detail: [] });
  }
  return hints;
}

// The one hint to show now and the earlier ones, newest first.
function pickHint(state, now) {
  const hints = hintCandidates(state);
  const events = hints.filter(hint => hint.kind !== "memo" && hint.at !== null).sort((a, b) => b.at - a.at);
  const fresh = events.filter(hint => now - hint.at <= (hint.kind === "own" ? OWN_FRESH_MS : HINT_FRESH_MS));
  // The slot picks among the latest analysis only, so the current hint is never older than what Earlier lists (L2).
  const latest = fresh.filter(hint => fresh[0].at - hint.at <= CALL_ANALYSIS_MS);
  const event = latest.sort((a, b) => a.tier - b.tier)[0];
  const memo = hints.find(hint => hint.kind === "memo");
  // The memo question stands as of the latest analysis that found nothing newer: never older than Earlier either.
  const current = event || (memo ? { ...memo, since: Math.max(memo.since ?? -Infinity, ...events.map(hint => hint.at)) } : null);
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
  return text.length > 90 ? `…${text.slice(-90).replace(/^\S*\s+/u, "")}` : text;
}
// Who said the last line: "Вы", or a named person by first name; a generic label stays whole (N4).
function lastSpeaker(state) {
  const segment = state?.transcript?.segments?.at(-1);
  if (!segment) return "";
  const label = speakerLabel(segment);
  return label && label === (segment.speaker_label || segment.speaker) ? label.split(/\s+/u)[0] : label;
}

// The feed: the call's name, a problem when a side is not heard, the one slot, the paused note and the earlier
// hints. Each part is rebuilt only when what it shows changes, so focus and an open source line survive the poll.
let callPending = null; // {question, at, queued, meeting}: the person's own question, its answer not back yet; queued: not sent yet
let callAskNote = null; // a line under the feed about the Ask field: one question already waits, or the call changed (J3)
let callCountdownShown = false; // the feed shows the undo countdown; when it does not, the bar does (P4)
let callKept = null; // a question that came back while the field held another draft: one click returns it (M5)
// An unsent question goes back into an empty field; over another draft it is kept, never lost (M5).
function callGiveBack(question) {
  const field = $("call-question");
  const draft = field.value.trim();
  if (!draft) field.value = question;
  else if (draft !== question) callKept = question;
}
// Returning it keeps the draft it replaces in turn, so the button stays until the field is empty or the same.
function callReturnKept() {
  const field = $("call-question");
  const draft = field.value.trim();
  field.value = callKept;
  callKept = draft && draft !== callKept ? draft : null;
  renderCall(window.appState);
  field.focus();
}
let callAskError = null; // {question, text, at}: the last Ask failed, shown in the feed for a while (B3, I1)
let callEarlierOpen = false;
const callWhereOpen = new Set(); // keys of the hints whose source is open
const callSignatures = {};

const callHintKey = hint => `${hint.kind}|${hint.at}|${hint.text}`;
// "<name> asks" has one form everywhere (N6): this label with the age, then the question in regular weight.
const callAsks = speaker => speaker ? t("call.asks", { name: speaker }) : t("call.asks_plain");
// A question put to the person: who asks and when, the question, then Answer over the reply (K3, N6).
const callAskedNodes = (asks, question, at, answer) => [callSay("say", asks, at), textNode("p", "heard-q", question),
  textNode("p", "say answer-say", answer)];
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
  return { side, since: beat[side].since };
}

// What the slot shows: the pending own question, then the hint picked, a heard question, or the waiting line.
// Stopped (the undo window, the final stop, or a stop not yet acknowledged): one plain line, and the person's own
// question and its answer still show, since the ask field keeps working.
function callSlot(state, current, now, stopped = null) {
  const own = current?.kind === "own" ? current : null;
  if (callPending && !callPending.queued && ((own && own.at > callPending.at) || (!requestBusy && !state?.copilot?.busy))) callPending = null;
  // A failed Ask shows for the hold every error gets, until a newer hint, and never over a stop (I1).
  if (callAskError && (stopped || now - callAskError.at > STATUS_ERROR_MS || (current?.at ?? -Infinity) > callAskError.at)) callAskError = null;
  if (callPending) return { type: "pending", label: t("call.own"), question: callPending.question };
  if (callAskError) return { type: "ask_error", label: t("call.own"), question: callAskError.question, text: callAskError.text };
  if (own) return { type: "own", label: own.label, at: own.at, question: own.question, text: own.text };
  // The undo window: hints pause, the bar says when the recording stops (G2). The final stop: saved, and the
  // way to this meeting's results (G3).
  if (stopped) return { type: "stopped", final: stopped === "stopped_final",
    until: stopped === "stopped" ? callAt(state?.recording_control?.stopping?.until) : null,
    text: t({ stop_failed: "call.stop_pending", stopped: "call.stopped", stopped_final: "call.saved" }[stopped]) };
  // Who asked, in quotes, then Answer over the line, as in Earlier (B6, K3).
  if (current?.kind === "answer") {
    return { type: "answer", key: callHintKey(current), label: t("call.answer"), at: current.at, asks: callAsks(current.speaker), asked: current.question,
      text: current.text, full: current.full, source: current.source, detail: current.detail };
  }
  const heard = state?.heard_question;
  if (heard?.text) {
    const speaker = String(heard.speaker || "").trim();
    const label = callAsks(speaker);
    const later = analysisSkipped !== null && analysisSkipped === state?.transcript?.meeting_id;
    return { type: "heard", label, at: callAt(heard.at), question: String(heard.text), later };
  }
  if (current) {
    const key = callHintKey(current);
    return { type: "hint", key, label: current.label, at: current.at ?? current.since, text: current.text, full: current.full, source: current.source, detail: current.detail };
  }
  const beat = heartbeat(state, now);
  return { type: "waiting", text: t(beat.you.state === "heard" || beat.other.state === "heard" ? "call.waiting_heard" : "call.waiting") };
}

function callSlotNodes(slot) {
  const nodes = slot.asked ? callAskedNodes(slot.asks, slot.asked, slot.at, slot.label) : [callSay("say", slot.label || "", slot.at)];
  if (slot.type === "stopped") {
    // The undo window says what comes next, counting down in place (L3); the bar already says it stopped.
    if (slot.until !== null && slot.until !== undefined) {
      const [before, after = ""] = t("call.stopped_until").split("{time}");
      const line = textNode("p", "waiting", before);
      line.append(callTime(slot.until, "left"), after);
      return [line];
    }
    if (!slot.final) return [textNode("p", "waiting", slot.text)];
    // The last screen of the call has one way on: this meeting's results (G3).
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.append(callButton("primary", t("call.open_results"), () => openView("after")));
    return [textNode("p", "waiting", slot.text), actions];
  }
  if (slot.type === "paused") {
    const retry = textNode("p", "heard-wait", `${slot.retry} `);
    retry.append(callButton("ql", t("call.check_ai"), () => $("getting-started-open").click()));
    return [textNode("p", "waiting", slot.text), retry];
  }
  if (slot.type === "waiting") return [textNode("p", "waiting", slot.text), textNode("p", "heard-wait", t("call.waiting_help"))];
  if (slot.question) nodes.push(textNode("p", "heard-q", slot.question));
  if (slot.type === "pending" || slot.type === "heard") nodes.push(textNode("p", "heard-wait", t(slot.later ? "call.heard_later" : "call.heard_wait")));
  // A heard question comes from the transcript: Where this comes from opens it (N1).
  if (slot.type === "heard") nodes.push(callWhereLink(() => openCallPanel("transcript")));
  if (slot.type === "ask_error") nodes.push(textNode("p", "heard-wait fail", slot.text));
  if (slot.type === "own") {
    nodes.push(textNode("p", "own-answer", readableAnswer(slot.text)), callWhereLink(() => openCallPanel("chat")));
  }
  if (slot.type === "answer" || slot.type === "hint") {
    nodes.push(textNode("p", callWords(slot.text).length > CALL_HINT_WORDS ? "hint long" : "hint", slot.text));
  }
  // One source component on every hint (N1): Where this comes from, closed, opens the source, the whole hint when it
  // was cut and the detail. Nothing to open: one muted line says there is no source, never an empty space.
  const more = [slot.full, slot.source, ...(slot.detail || [])].filter(Boolean);
  if ((slot.type === "answer" || slot.type === "hint") && !more.length) nodes.push(textNode("p", "why", t("call.no_source")));
  if ((slot.type === "answer" || slot.type === "hint") && more.length) {
    const box = document.createElement("div");
    box.className = "why-more";
    box.id = "call-why-more";
    box.append(...more.map((line, index) => textNode("p", index === 0 && slot.full ? "why-full" : "", line)));
    const actions = document.createElement("p");
    actions.className = "why-acts";
    const where = callButton("ql", "", () => {
      if (callWhereOpen.has(slot.key)) callWhereOpen.delete(slot.key);
      else callWhereOpen.add(slot.key);
      show();
    });
    where.setAttribute("aria-controls", box.id);
    // Toggled in place: the live slot is not rebuilt, so the hint is not announced again.
    const show = () => {
      const open = callWhereOpen.has(slot.key);
      box.hidden = !open;
      where.textContent = t(open ? "call.where_hide" : "call.where");
      where.setAttribute("aria-expanded", String(open));
    };
    show();
    actions.append(where);
    nodes.push(box, actions);
  }
  return nodes;
}
// Where this comes from as a link to the place that holds it (the chat, the transcript): one name across Call (H2).
function callWhereLink(open) {
  const actions = document.createElement("p");
  actions.className = "why-acts";
  actions.append(callButton("ql", t("call.where"), open));
  return actions;
}

function renderCall(state) {
  const now = Date.now();
  const transcript = state?.transcript || {};
  const name = transcript.display_meeting || transcript.meeting || "";
  if ($("call-name").textContent !== name) $("call-name").textContent = name;

  // After Stop the paused tracks stop growing: no problem card, no hint, no paused note (A4).
  const status = callStatus(state, window.agendaData, window.permissionsData, now);
  const stopped = status.kind === "stop_failed" ? "stop_failed" : status.kind === "stopped" ? (status.final ? "stopped_final" : "stopped") : null;
  const problem = stopped ? null : callProblem(state, now);
  callPart("call-problem", problem && { side: problem.side, timed: problem.since !== null }, problem => {
    const box = document.createElement("div");
    box.className = "problem";
    const heading = document.createElement("h3");
    // "Собеседника не слышно 40 сек": the duration is a time node, so the card is not rebuilt every second.
    const [before, after = ""] = t(`call.${problem.side}_lost${problem.timed ? "" : "_now"}`).split("{time}");
    heading.append(textNode("span", "fail", before));
    if (problem.timed) heading.firstChild.append(callTime(0, "for"), after);
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
  const lost = $("call-problem").querySelector("[data-time]");
  if (lost) lost.dataset.at = problem.since;

  // A question queued behind an analysis goes out once nothing else holds the line, and only for the call it was
  // asked in: after a change of call it comes back to the field, unsent (J3).
  if (callPending?.queued && callPending.meeting !== transcript.meeting_id) {
    callGiveBack(callPending.question);
    callPending = null;
    callAskNote = t("call.ask_changed");
  } else if (callPending?.queued && !requestBusy && !state?.copilot?.busy && window.callAsk(callPending.question, callPending.meeting)) {
    callPending = { question: callPending.question, at: Date.now() };
    callAskNote = null;
  }
  // The analysis failed: hints pause until the next try, five minutes after it (F3).
  const analysis = state?.copilot?.analysis;
  const failed = analysis?.state === "error" ? callAt(analysis.at) : null;
  const retry = failed === null ? null : failed + 300000;
  // A retry time that has passed is not shown: the next try comes with the next analysis.
  const paused = retry === null || stopped ? null : retry > now ? t("call.paused_retry", { n: Math.ceil((retry - now) / 60000) }) : t("call.paused_next");
  const pick = pickHint(state, now);
  const slot = callSlot(state, pick.current, now, stopped);
  const countdown = slot.type === "stopped" && slot.until !== null && slot.until !== undefined;
  if (countdown !== callCountdownShown && stopped === "stopped") queueMicrotask(renderShell); // the bar takes it over at once
  callCountdownShown = countdown;
  // Nothing else to show: the pause is the main line, one message (D2). Under a hint it stays a note.
  const pausedSlot = paused && slot.type === "waiting";
  callPart("call-slot", pausedSlot ? { type: "paused", text: t("call.paused"), retry: paused } : slot, callSlotNodes);
  const note = callAskNote || callKept ? { text: callAskNote || "", kept: callKept }
    : paused && !pausedSlot ? { text: `${t("call.paused")} ${paused}`, check: true } : null;
  $("call-note").hidden = !note;
  callPart("call-note", note, note => note.check
    ? [`${note.text} `, callButton("ql", t("call.check_ai"), () => $("getting-started-open").click())]
    : [note.text, ...(note.kept ? [note.text ? " " : "", callButton("ql", t("call.return_question"), callReturnKept)] : [])]);

  // A heard question says who asked, in quotes; our answer sits under its own label, so it never reads as hers (B6).
  const earlier = pick.earlier.map(hint => (hint.kind === "answer"
    ? { asks: callAsks(hint.speaker), asked: hint.question, label: t("call.answer"), at: hint.at, text: hint.text, source: hint.source }
    : { label: hint.label, at: hint.at, text: hint.text, source: hint.source }));
  const open = $("call-earlier-open");
  // Open, it says how to close it (H5); More's item presses the same button and says the same.
  const count = callEarlierOpen ? t("call.earlier_hide") : t("call.earlier", { n: earlier.length });
  if (open.textContent !== count) open.textContent = count;
  open.setAttribute("aria-expanded", String(callEarlierOpen));
  // Nothing earlier: no Earlier button at all (ruling 4), in the dock or in More.
  open.hidden = !earlier.length;
  if ($("call-more-earlier").textContent !== count) $("call-more-earlier").textContent = count;
  $("call-more-earlier").hidden = !earlier.length;
  $("call-earlier").hidden = !callEarlierOpen || !earlier.length;
  callPart("call-earlier", earlier, list => {
    const items = document.createElement("ul");
    items.append(...list.map(hint => {
      const item = document.createElement("li");
      item.append(...(hint.asked ? callAskedNodes(hint.asks, hint.asked, hint.at, hint.label) : [callSay("say", hint.label, hint.at)]),
        textNode("p", "earlier-hint", hint.text));
      if (hint.source) item.append(textNode("p", "why", hint.source));
      return item;
    }));
    return [items];
  });
  callTimes(now);
}

// The bar during a live call: the clock, whether each side is heard (from the same heartbeat as the feed's problem,
// so the two never disagree) and the last line heard. Shown only beside Recording: a call not live (F16), stopped,
// paused or without fresh data has no heartbeat to show. One stalled side is still Recording (F19), with its beat.
const CALL_BEAT_WORDS = { heard: "call.heard", not_heard: "call.not_heard", checking: "call.checking" };
function renderCallBar(state, now) {
  const live = callStatus(state, window.agendaData, window.permissionsData, now).kind === "recording";
  $("call-live").hidden = !live;
  if (!live) return;
  const clock = callClock(state.recording_health?.capture?.started_at || state.transcript?.started_at, now);
  if ($("call-timer").textContent !== clock) $("call-timer").textContent = clock;
  const beat = heartbeat(state, now);
  callPart("call-beats", ["you", "other"].map(side => [side, beat[side].state, beat[side].speaking]), sides => sides.map(([side, heard, speaking]) => {
    const node = textNode("span", `beat${heard === "not_heard" ? " lost" : ""}`, "");
    const bars = textNode("span", `bars${speaking ? "" : " quiet"}`, "");
    bars.setAttribute("aria-hidden", "true");
    bars.append(...[0, 1, 2].map(() => document.createElement("i")));
    node.append(bars, t(`call.${side}`));
    if (CALL_BEAT_WORDS[heard]) node.append(": ", textNode("b", "", t(CALL_BEAT_WORDS[heard])));
    return node;
  }));
  const phrase = lastPhrase(state);
  const label = phrase ? t("call.last_phrase", { who: lastSpeaker(state) }).split("{text}")[0] : "";
  const line = phrase ? `${label}${phrase}` : "";
  // The label stays whole and the words are cut from the start, so the newest ones show in a narrow bar (E3).
  const heard = $("call-heard");
  if (heard.dataset.line !== line) {
    heard.dataset.line = line;
    heard.dataset.phrase = phrase;
    const words = document.createElement("span");
    words.className = "heard-words";
    words.append(textNode("bdi", "", phrase));
    heard.replaceChildren(textNode("span", "", label), words);
    callFitHeard();
  }
  // The rest of the bar renders after this (its buttons narrow the line): fit again once it has, if squeezed (L4).
  requestAnimationFrame(() => callHeardSqueezed() && callFitHeard());
}
// Whole words only: they drop from the start until the line fits, so it never opens on half a word (G5, L4). Fewer
// than three words left is a bare fragment: the line shows nothing. Run again whenever the bar's width changes.
function callFitHeard() {
  const heard = $("call-heard");
  const phrase = heard.dataset.phrase || "";
  const words = heard.querySelector(".heard-words");
  heard.hidden = !phrase || !words;
  if (heard.hidden) return;
  const shown = words.firstChild;
  let rest = phrase.replace(/^…/u, "");
  shown.textContent = phrase;
  while (words.scrollWidth > words.clientWidth + 1 && /\s/u.test(rest)) {
    rest = rest.replace(/^\S+\s+/u, "");
    shown.textContent = `…${rest}`;
  }
  const cut = shown.textContent !== phrase;
  heard.hidden = words.scrollWidth > words.clientWidth + 1 || (cut && rest.split(/\s+/u).length < 3);
}
// After a resize the bar settles (its buttons shorten) before the line is fitted again; the clock's tick fits a line
// the bar squeezed later.
addEventListener("resize", () => requestAnimationFrame(callFitHeard));
function callHeardSqueezed() {
  const words = $("call-heard").querySelector(".heard-words");
  return !$("call-heard").hidden && words && words.scrollWidth > words.clientWidth + 1;
}
// The clock ticks every second; while stopped the whole bar does, for the countdown.
setInterval(() => {
  if (window.appState === undefined) return;
  if (currentStatus().kind === "stopped") renderShell();
  else renderCallBar(window.appState, Date.now());
  callTimes();
  if (callHeardSqueezed()) callFitHeard();
}, 1000);

// The dock's height, for More's menu above it and for scrolling to Earlier past it (as --bar-h for the bar).
const callDock = document.querySelector("#call .dock");
new ResizeObserver(() => document.documentElement.style.setProperty("--dock-h", `${Math.ceil(callDock.getBoundingClientRect().height)}px`))
  .observe(callDock);

// The transcript or the board (and the chat and notes tabs) opened as a panel over the feed. Focus goes to the
// panel's heading, and back to the control that opened it when the panel closes (an item of More: More itself).
let callOpener = null;
function openCallPanel(panel) {
  const body = document.body;
  const wasOpen = Boolean(body.dataset.callPanel);
  if (panel) {
    const active = document.activeElement;
    if (!wasOpen) callOpener = active === body ? null : active.closest("#call-more-menu") ? $("call-more") : active;
    body.dataset.callPanel = panel;
    if (panel !== "transcript") document.querySelector(`[data-content-view="${panel}"]`).click();
    // The tabs are hidden in Call: the transcript itself, never Frames left selected in After (J5).
    else document.querySelector('[data-transcript-view="transcript"]').click();
    if (panel === "board") renderCallBoard(currentCallPlan, currentJournal); // the Call form of the board (C1)
  } else {
    delete body.dataset.callPanel;
  }
  renderShell();
  // The tab bar is hidden in Call (C1): focus goes to the panel itself.
  const target = { transcript: "transcript-heading", board: "call-board", chat: "chat", notes: "journal", plan: "call-plan" }[panel];
  // Without scrolling: focusing the tall board scrolled its pane past Back to the call at 400 px (O3).
  if (target) { $(target).tabIndex = -1; $(target).focus({ preventScroll: true }); }
  else if (wasOpen) returnFocus(callOpener);
}

addEventListener("DOMContentLoaded", () => {
  $("call-earlier-open").addEventListener("click", () => {
    // Over Board or Transcript the dock's Earlier goes back to the feed with the list open.
    if (document.body.dataset.callPanel) return (callEarlierOpen = true), openCallPanel(null);
    callEarlierOpen = !callEarlierOpen;
    renderCall(window.appState);
  });
  $("call-transcript-open").addEventListener("click", () => openCallPanel("transcript"));
  $("call-board-open").addEventListener("click", () => openCallPanel("board"));
  // More (under 700 px) holds the dock's row: each item presses its control.
  for (const [item, control] of [["earlier", "earlier-open"], ["transcript", "transcript-open"], ["board", "board-open"]]) {
    $(`call-more-${item}`).addEventListener("click", () => $(`call-${control}`).click());
  }
  // Earlier opened from More can start below the dock: it scrolls into view.
  $("call-more-earlier").addEventListener("click", () => callEarlierOpen && $("call-earlier").scrollIntoView({ block: "nearest" }));
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
    if (!question) return;
    // One question waits at a time: a second stays in the field and the feed says why (J3).
    if (callPending?.queued) {
      callAskNote = t("call.ask_waiting");
      renderCall(window.appState);
      return;
    }
    callAskNote = null;
    // An analysis holds the line: the question waits in the slot and goes out when it ends (B3).
    const sent = window.callAsk(question);
    if (!sent && !requestBusy) return;
    callAskError = null;
    callPending = { question, at: Date.now(), queued: !sent, meeting: window.appState?.transcript?.meeting_id };
    field.value = "";
    renderCall(window.appState);
  });
});
// A failed Ask (app.js sendQuestion): the feed says so, and the question goes back into an empty field to try again.
// changed: the server refused it for another call (M4), which is the J3 note, not an error.
window.callAskFailed = (question, text, changed = false) => {
  if (callPending?.question === question) callPending = null;
  if (changed) callAskNote = t("call.ask_changed");
  else callAskError = { question, text, at: Date.now() };
  callGiveBack(question);
  if (document.body.dataset.view === "call") renderCall(window.appState);
};
// Escape closes the panel, unless a menu, a dialog or an overlay is open: that one closes first.
document.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !document.body.dataset.callPanel || document.querySelector(OVERLAYS)) return;
  event.preventDefault();
  openCallPanel(null);
}, true);
