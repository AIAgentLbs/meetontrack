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
const callAskOrSay = text => t(text.endsWith("?") ? "call.ask" : "call.say");

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
        text: speakable(item.reply), ...callParts(item.reply, item) });
    } else if (item.category === "CONTRADICTION" && open) {
      hints.push({ kind: "check", tier: 2, at, label: callLabel(t("call.clarify"), at), question: "",
        text: speakable(item.text), ...callParts(item.text, item) });
    } else if (["ASK", "RISK", "OBJECTION"].includes(item.category) && open) {
      const text = speakable(item.text);
      hints.push({ kind: "signal", tier: 3, at, label: callLabel(callAskOrSay(text), at), question: "", text, ...callParts(item.text, item) });
    }
  }
  for (const item of state?.fact_checks?.items || []) {
    if (item.status !== "refuted") continue;
    const at = callAt(item.checked_at);
    const speaker = String(item.segment?.speaker || item.segment?.speaker_label || "").trim();
    const said = item.quote || item.claim || "";
    const quote = uiLanguage === "ru" ? `«${said}»` : `“${said}”`;
    hints.push({ kind: "check", tier: 2, at, label: callLabel(t("call.clarify"), at), question: "",
      text: speakable(item.fact), source: speaker ? `${speaker}: ${quote}` : quote, detail: [] });
  }
  const questions = (state?.call_plan?.items || []).filter(item => item.kind === "question");
  const next = questions.findIndex(item => item.status !== "resolved");
  if (next >= 0) {
    const text = speakable(questions[next].text);
    const label = state.call_plan.source_label;
    hints.push({ kind: "memo", tier: 4, at: null, label: callAskOrSay(text), question: "", text,
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
  return { current, earlier: events.filter(hint => hint !== current).slice(0, 20) };
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

function renderCall(state) {} // the feed and the dock (Task 6)
