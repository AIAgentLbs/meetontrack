// After: what was agreed and who gets the report, before it leaves (MEETONTRACK-163). The board comes from the
// /api/state poll (plan, journal, fact checks) and /api/after (memo check, removed items), the send block from /api/after.
// Journal, plan, memo check and AI text are untrusted: every value goes in through textContent.

// A moment of the call on the call's own clock (MM:SS or H:MM:SS), like every time in Call. Delivery times are wall clock.
function afterTime(atIso, startIso) {
  const at = Date.parse(atIso || "");
  return startIso && !Number.isNaN(at) ? callClock(startIso, at) : "";
}
const afterClock = iso => (Number.isNaN(Date.parse(iso || "")) ? "" : homeClock(iso));
// A quoted statement loses its own full stop: «...офисы.», or “...year.”, reads as a typo before the closing mark.
const afterBare = text => String(text || "").replace(/\.$/u, "");
// Where a fact check's correction comes from: a document by its title, a web page by its site.
function afterSource(item) {
  const source = item.sources?.[0];
  if (source?.title) return String(source.title);
  try {
    return new URL(source?.url || source?.location).hostname;
  } catch {
    return "";
  }
}
// The report has gone: its copy speaks in the past.
const afterWent = after => ["sent", "edited", "failed"].includes(after?.send?.state);
// A reason the memo check has no result, in words; one the page does not know reads as a failed check.
function afterReason(reason) {
  const key = `after.memo_reason.${reason}`;
  return t(key) === key ? t("after.memo_reason.error") : t(key);
}

// Four lanes, as in Call: memo questions and live asks, questions put to the person, risks, the fact check.
// Answered and confirmed rows fold under their lane; a removed row stays, marked, so it can be brought back.
function afterBoard(state, after) {
  const start = callStartIso(state);
  const removed = new Set(after?.removed || []);
  const memo = after?.memo_check || null;
  // A hint's line loses its verb (as in Call); what was said on the call keeps its own words (speakable: the first line).
  const row = (key, raw, tag, extra = {}, said = false) => ({ key, text: said ? speakable(raw) : callLine(raw).rest, tag, memo: false,
    quote: "", speaker: "", other: "", ...extra, at: afterTime(extra.at, start), removed: removed.has(key) });
  const lanes = Object.fromEntries(["ask", "asked", "risks", "facts"].map(lane => [lane, { lane, rows: [], folded: [] }]));
  const put = (lane, item, fold = false) => lanes[lane][fold ? "folded" : "rows"].push(item);

  // A memo question counts as answered only with the memo check's quote; before the check, the plan's own status.
  const questions = (state?.call_plan?.items || []).filter(item => item.kind === "question");
  const checked = memo?.state === "done" ? memo.questions || [] : null;
  // The check did not run or failed: the line says so, and no status under it pretends otherwise (critique 2, P2-3).
  const unchecked = Boolean(memo) && !checked && memo.state !== "waiting";
  for (const item of questions) {
    const found = checked?.find(entry => entry.id === item.id);
    const answered = !unchecked && (checked ? found?.status === "answered" : item.status === "resolved");
    const quote = answered && found ? { quote: String(found.quote || ""), speaker: String(found.speaker || ""), at: found.at } : {};
    put("ask", row(`memo:${item.id}`, item.text, unchecked ? "" : answered ? "answered" : "no_answer", { memo: true, ...quote }), answered);
  }

  // Removed journal items of a past meeting come only with /api/after.
  const journal = [...(state?.journal || [])];
  for (const item of after?.removed_journal || []) {
    if (!journal.some(entry => `journal:${entry.id}` === item.key)) journal.push({ id: item.key.slice(8), category: item.category, text: item.text });
  }
  for (const item of journal) {
    const key = `journal:${item.id}`;
    const open = item.status !== "resolved";
    const extra = { speaker: String(item.speaker || ""), at: item.created_at };
    if (item.category === "ASK") {
      // An ask that says a memo question again is that question (the board's own de-duplication in Call).
      if (open && !questions.some(question => callSame(callLine(question.text).rest, callLine(item.text).rest))) put("ask", row(key, item.text, "no_answer", extra));
    } else if (item.category === "INCOMING_QUESTION" || item.category === "OPEN_QUESTION") {
      put("asked", row(key, item.text, open ? "no_answer" : "answered", extra), !open);
    } else if (item.category === "RISK" || item.category === "OBJECTION") {
      put("risks", row(key, item.text, item.category.toLowerCase(), extra));
    } else if (item.category === "CONTRADICTION") {
      put("facts", row(key, item.text, "differs", extra));
    }
  }

  for (const item of state?.fact_checks?.items || []) {
    if (item.status !== "refuted" && item.status !== "confirmed") continue;
    const said = String(item.quote || item.claim || "");
    put("facts", row(`fact:${item.id}`, item.claim || said, item.status === "refuted" ? "differs" : "confirmed", { quote: said,
      speaker: String(item.segment?.speaker || item.segment?.speaker_label || ""), at: item.timestamp || item.checked_at,
      other: !item.fact ? "" : t(afterSource(item) ? "after.differs_fact" : "after.quoted", { source: afterSource(item), text: afterBare(item.fact) }) },
    true), item.status === "confirmed");
  }
  // What was said against what the memo says: `other` is the memo's whole line. The memo is the person's own note
  // for the call, never the client's document (critique 2, P2-4).
  for (const item of checked ? memo.differs || [] : []) {
    const said = String(item.quote || "");
    put("facts", row(String(item.key), said, "differs", { quote: said, speaker: String(item.speaker || ""), at: item.at,
      other: t("after.differs_memo", { text: afterBare(item.memo) }) }, true));
  }

  const memoLine = !memo ? "" : memo.state === "done" ? t("after.memo_checked") : memo.state === "waiting" ? t("after.memo_waiting")
    : t("after.memo_failed", { reason: afterReason(memo.reason) });
  return { lanes: Object.values(lanes), memoLine };
}

const AFTER_WAITS = ["draft", "preparing", "showing", "changes"]; // states in which a change still holds the report
// Once it is being sent nothing can stop it: no Send now, no Do not send.
const AFTER_ACTIONS = Object.fromEntries(AFTER_WAITS.map(state => [state, ["send_now", "hold"]]));
Object.assign(AFTER_ACTIONS, { held: ["send_now"], edited: ["send_again"], failed: ["retry"] });
const AFTER_RESEND = new Set(["email", "telegram", "drive"]); // what Send again and Retry can send; the CRM note stays
const AFTER_RETRY = new Set(["failed", "unknown"]); // Retry resends these; "unknown" says it may already have arrived

// The send block: the headline from the server's send state (the gate), the rules, who gets it, what can be done.
function afterSend(after) {
  const send = after?.send || { state: "draft" };
  const { state } = send;
  const channels = send.channels || [];
  const resend = channels.filter(row => AFTER_RESEND.has(row.channel));
  // Send again needs a channel it can resend (ruling C11); Retry resends only the failed ones (ruling C9).
  const stuck = state === "edited" ? !resend.length : state === "failed" && !resend.some(row => AFTER_RETRY.has(row.status));
  // The pause is over: the report goes within seconds and a Hold can no longer stop it (final review I1).
  const due = ["showing", "changes"].includes(state) && Date.parse(send.send_at || "") <= Date.now();
  // Once it went, the sentence names only where it arrived (critique 2, P2-2).
  const went = afterWent(after);
  // Telegram without a chat is Saved messages; e-mail without an address reads plainly, never "e-mail " and nothing.
  const parts = channels.filter(row => !went || row.status === "sent").map(row => (row.channel === "telegram" && !row.to ? t("after.to.telegram_me")
    : row.channel === "email" && !row.to ? t("after.to.email_plain")
    : t(`after.to.${row.channel}${row.channel === "twenty" && row.to ? "_named" : ""}`, { to: row.to })));
  return {
    state,
    headline: t(state === "draft" && send.send_now ? "after.send.send_now_pending" : `after.send.${state}`),
    // The refined summary has landed from "showing" on: its rule would be stale there (critique 2, P3-7).
    rules: AFTER_WAITS.includes(state) ? [t("after.rule.changes"), ...(["draft", "preparing"].includes(state) ? [t("after.rule.keep")] : [])] : [],
    recipients: state === "no_channels" || !parts.length ? "" : t(went ? "after.to_sent" : "after.to", { list: parts.join(", ") }),
    actions: stuck || due ? [] : AFTER_ACTIONS[state] || [],
    // Held says it once, in the headline (critique 2, P3-1).
    channels: ["sent", "edited", "failed"].includes(state) ? channels.map(row => {
      // A line never ends on "at": without a time the time clause goes.
      const time = afterClock(row.status === "failed" ? row.retry_at : row.at);
      const plain = !time && (row.status === "sent" || row.status === "failed");
      return t(`after.ch.${row.status}${plain ? "_plain" : ""}`, { channel: t(`after.channel.${row.channel}`), time });
    }) : [],
  };
}

// ---- The view ----
// window.afterData = {id, seq, data}: the last /api/after answer (data null for a 404) and the meeting it asked for.
// Every POST names that same id: the server's cache that makes Hold instant is keyed by it.
const AFTER_POLL_MS = 3000;
const AFTER_SAVE_MS = 1000;
const AFTER_TOUCH_MS = 10000; // while typing, the report is told to wait this often: well inside its 30 s pause
const AFTER_JOB_MS = 1500;
const AFTER_FIELDS = { summary: "after-summary", next_steps: "after-next" };
const AFTER_TAGS = { answered: "ok", confirmed: "ok", no_answer: "open", differs: "diff", risk: "kind", objection: "kind" };
const AFTER_LANES = { ask: "call.board_mine", asked: "call.board_incoming", risks: "after.col_risks", facts: "after.col_facts" };
let afterRequest = null;
let afterAsked = null; // the meeting the view last asked about: a failed first answer waits for the next poll, never loops
let afterSeq = 0;
let afterSignature = "";
let afterSendSignature = "";
let afterError = "";
let afterSaveError = false; // the error line is a save's: the next good save clears it, and only then
let afterHolds = 0; // Do not send presses: one during a send's flush wins over it
let afterTouched = 0; // when the server was last told the person is typing
const afterBusy = new Set(); // focus keys of the controls whose POST is in flight: a second press posts nothing
const afterOpen = new Set(); // lanes whose answered or confirmed rows are shown
const afterDirty = new Set(); // fields typed in and not saved yet
const afterKeep = {}; // field -> the first request seq that already carries its saved text
const afterTimers = {};
const afterSaving = {}; // field -> its save in flight: one at a time per field, in order

// One GET at a time; a 503 or a dropped answer keeps the last payload.
function afterFetch() {
  const id = window.appState?.transcript?.meeting_id;
  if (!id) return Promise.resolve();
  afterRequest ||= (async () => {
    const seq = ++afterSeq;
    try {
      const response = await fetch(`/api/after?meeting_id=${encodeURIComponent(id)}`, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      if (response.status === 404) window.afterData = { id, seq, data: null };
      else if (response.ok) window.afterData = { id, seq, data: await response.json() };
    } catch {}
  })().finally(() => {
    afterRequest = null;
    if (document.body.dataset.view === "after") renderAfter(window.appState);
  });
  return afterRequest;
}
// After a POST: a fresh answer, never one asked for before the change.
async function afterRefresh() {
  await afterRequest;
  await afterFetch();
}
setInterval(() => document.body.dataset.view === "after" && void afterFetch(), AFTER_POLL_MS);

// The server's codes are not for people: busy and a Hold that came too late have their own lines, any other refusal
// is the generic one.
const afterFailed = error => (error.message === "busy" ? t("after.busy") : error.message === "sending" ? t("after.sending")
  : error.status ? t("error.generic") : plainError(error));

// Send again and Retry run as one delivery job: wait for it, as the archive's resend does, and say why it did not go.
async function afterJob(job) {
  const id = job?.request_id;
  for (const end = Date.now() + 300000; job?.state === "sending" && job.request_id === id && Date.now() < end;) {
    await new Promise(resolve => setTimeout(resolve, AFTER_JOB_MS));
    job = (await getJSON("/api/delivery/job")).job;
  }
  if (job?.request_id !== id || !job.error) return "";
  return t(job.error === "report_not_ready" ? "after.not_ready" : "error.generic");
}

// A send sends what is on screen: typed text not saved yet goes first, and a save that fails sends nothing.
async function afterFlush() {
  for (const field of [...afterDirty]) {
    clearTimeout(afterTimers[field]);
    if (!(await afterSave(field))) return false;
  }
  return true;
}

async function afterPost(key, path, body = {}, flush = false) {
  if (afterBusy.has(key) || !window.afterData?.data) return;
  // The meeting clicked on, before anything is awaited: a call that loads meanwhile never gets this press.
  const id = window.afterData.id;
  afterBusy.add(key);
  if (key === "hold") afterHolds++;
  const holds = afterHolds;
  afterError = "";
  afterSaveError = false;
  try {
    if (!flush || ((await afterFlush()) && holds === afterHolds)) {
      const answer = await post(path, { meeting_id: id, ...body });
      if (answer.job) afterError = await afterJob(answer.job);
    }
  } catch (error) {
    afterError = afterFailed(error);
  }
  afterBusy.delete(key);
  renderAfter(window.appState);
  await afterRefresh();
}

// A field is saved 1 s after the last key. Until then, and while it has focus, no answer writes into it.
function afterInput(field) {
  afterDirty.add(field);
  // Typing pauses an automatic send at once, not only once the text is saved (Codex P2).
  const after = window.afterData?.data;
  if (after && [...AFTER_WAITS, "sending"].includes(after.send?.state) && Date.now() - afterTouched >= AFTER_TOUCH_MS) {
    afterTouched = Date.now();
    void post("/api/after/editing", { meeting_id: window.afterData.id }).catch(() => {});
  }
  clearTimeout(afterTimers[field]);
  afterTimers[field] = setTimeout(() => void afterSave(field), AFTER_SAVE_MS);
}
function afterSave(field) {
  afterSaving[field] = (afterSaving[field] || Promise.resolve()).then(() => afterSaveNow(field));
  return afterSaving[field];
}
async function afterSaveNow(field) {
  const node = $(AFTER_FIELDS[field]);
  const text = node.value;
  if (!afterDirty.has(field)) return true; // an earlier save in the queue already carried it (or the meeting changed)
  if (!window.afterData?.data) return false;
  let saved = false;
  try {
    await post("/api/after/edit", { meeting_id: window.afterData.id, field, text });
    afterKeep[field] = afterSeq + 1;
    if (node.value === text) afterDirty.delete(field);
    if (afterSaveError) afterError = "";
    afterSaveError = false;
    saved = true;
  } catch (error) {
    afterError = afterFailed(error);
    afterSaveError = true;
    clearTimeout(afterTimers[field]);
    afterTimers[field] = setTimeout(() => void afterSave(field), AFTER_POLL_MS); // kept, and tried again
  }
  await afterRefresh();
  return saved;
}

function afterButton(label, className, key, onClick) {
  const button = textNode("button", className, label);
  button.type = "button";
  button.dataset.focus = key;
  // Nothing to act on before the report exists (a 404). A press in flight stays enabled, so focus stays on it.
  button.disabled = !window.afterData?.data;
  button.addEventListener("click", onClick);
  return button;
}

// "«quote», speaker, time": a part that is missing leaves no empty comma behind.
function afterQuote(row) {
  if (!row.quote) return "";
  const quote = afterBare(row.quote);
  if (row.tag === "differs" && row.speaker && row.at) return t("after.differs_call", { speaker: row.speaker, time: row.at, quote });
  return t("after.quote", { quote, speaker: row.speaker, time: row.at }).replace(/, (?=, |$)/gu, "");
}

function afterRow(row) {
  const item = document.createElement("li");
  item.className = `bitem${row.removed ? " removed" : ""}`;
  const toggle = removed => () => void afterPost(`row:${row.key}`, "/api/after/remove", { key: row.key, removed });
  if (row.removed) {
    item.append(textNode("span", "", `${t("after.removed")} `),
      afterButton(t("after.bring_back"), "ql", `row:${row.key}`, toggle(false)));
    return item;
  }
  if (row.tag) item.append(textNode("p", `tag ${AFTER_TAGS[row.tag] || "kind"}`, t(`after.tag.${row.tag}`)));
  const quote = afterQuote(row);
  // A differing row is two quotes, what was said and what it differs from; any other row is its text.
  if (row.tag !== "differs" || !quote) item.append(textNode("p", "btext", row.text));
  if (quote) item.append(textNode("p", "bquote", quote));
  if (row.tag === "differs" && row.other) item.append(textNode("p", "bquote", row.other));
  const meta = document.createElement("p");
  meta.className = "bmeta";
  const said = quote ? "" : [row.speaker, row.at].filter(Boolean).join(", ");
  const note = [row.memo ? t("after.from_memo") : "", said].filter(Boolean).join(" · ");
  if (note) meta.append(textNode("span", "", `${note} · `));
  meta.append(afterButton(t("after.remove"), "ql", `row:${row.key}`, toggle(true)));
  item.append(meta);
  return item;
}

function afterLane(lane) {
  const column = document.createElement("div");
  column.className = "bcol";
  column.append(textNode("h4", "", t(AFTER_LANES[lane.lane])));
  const list = document.createElement("ul");
  list.append(...lane.rows.map(afterRow));
  column.append(list);
  if (lane.folded.length) {
    const open = afterOpen.has(lane.lane);
    const fold = afterButton(t(lane.lane === "facts" ? "after.confirmed_n" : "after.answered_n", { n: lane.folded.length }),
      "ql fold", `fold:${lane.lane}`, () => {
        if (afterOpen.has(lane.lane)) afterOpen.delete(lane.lane);
        else afterOpen.add(lane.lane);
        renderAfter(window.appState);
      });
    fold.disabled = false;
    fold.setAttribute("aria-expanded", String(open));
    fold.setAttribute("aria-controls", `after-fold-${lane.lane}`);
    const folded = document.createElement("ul");
    folded.id = `after-fold-${lane.lane}`;
    folded.hidden = !open;
    folded.append(...lane.folded.map(afterRow));
    column.append(fold, folded);
  } else if (!lane.rows.length) {
    column.append(textNode("p", "bempty", t("after.empty")));
  }
  return column;
}

function afterSendBlock(after, send) {
  const nodes = [textNode("p", "after-headline", send.headline)];
  // The channel lines of the state, or, in any other state, the CRM line that waits for a record (Task 4 carry).
  const lines = send.channels.length ? send.channels : (after?.send?.channels || []).filter(row => row.status === "needs_choice")
    .map(row => t("after.ch.needs_choice", { channel: t(`after.channel.${row.channel}`) }));
  if (lines.length) {
    const list = document.createElement("ul");
    list.className = "chan";
    list.append(...lines.map(line => textNode("li", "", line)));
    nodes.push(list);
  }
  nodes.push(...send.rules.map(rule => textNode("p", "after-rule", rule)));
  // Recipients and Change: hidden only while there is no report yet (a 404).
  const to = textNode("p", "to", send.recipients ? `${send.recipients} ` : "");
  to.id = "after-to";
  to.hidden = !after;
  const change = afterButton(t(send.state === "no_channels" ? "after.change_setup" : "after.change"), "ql", "change", openDeliverySettings);
  change.id = "after-change";
  change.disabled = false;
  to.append(change);
  nodes.push(to);
  if (afterError) nodes.push(textNode("p", "after-error fail", afterError));
  const row = document.createElement("div");
  row.className = "row-act";
  for (const action of send.actions) {
    if (action === "send_now") row.append(afterButton(t("after.send_now"), "", "send_now", () => void afterPost("send_now", "/api/after/send", {}, true)));
    if (action === "hold") row.append(afterButton(t("after.hold"), "ql", "hold", () => void afterPost("hold", "/api/after/hold")));
    if (action === "send_again") {
      nodes.push(textNode("p", "after-again", t("after.send_again_note")));
      row.append(afterButton(t("after.send_again"), "", "send_again", () => void afterPost("send_again", "/api/after/send-again", {}, true)));
    }
    if (action === "retry") {
      // Retry resends only what failed (ruling C9).
      const channels = after.send.channels.filter(item => AFTER_RETRY.has(item.status) && AFTER_RESEND.has(item.channel)).map(item => item.channel);
      row.append(afterButton(t("after.retry"), "", "retry", () => void afterPost("retry", "/api/after/send-again", { channels }, true)),
        afterButton(t("after.channel_settings"), "ql", "settings", openDeliverySettings));
    }
  }
  // Before the draft exists Send now is disabled: the line says why.
  if (!after && send.actions.includes("send_now")) row.append(textNode("span", "after-why", t("after.why_wait")));
  if (row.childElementCount) nodes.push(row);
  return nodes;
}

// Rebuilt only when what it shows changes; focus stays on the control it was on (by its key), or the block's first.
function afterReplace(container, nodes) {
  const active = container.contains(document.activeElement) ? document.activeElement.dataset.focus || "" : null;
  container.replaceChildren(...nodes);
  if (active === null) return;
  const again = [...container.querySelectorAll(".row-act [data-focus]"), ...container.querySelectorAll("[data-focus]")];
  (again.find(node => node.dataset.focus === active) || again.find(node => !node.disabled))?.focus();
}

function afterFields(after) {
  const final = Boolean(after?.summary?.final);
  const draft = final ? "" : ` · ${t("after.draft")}`;
  const updated = after?.send?.state === "showing" ? ` · ${t("after.updated")}` : "";
  for (const [field, id] of Object.entries(AFTER_FIELDS)) {
    const node = $(id);
    const label = `${t(field === "summary" ? "after.summary" : "after.next_steps")}${draft}${field === "summary" ? updated : ""}`;
    const tag = document.querySelector(`label[for="${id}"]`);
    if (tag.textContent !== label) tag.textContent = label;
    node.disabled = !window.afterData?.data;
    const placeholder = window.afterData?.data ? "" : t(field === "summary" ? "after.placeholder" : "after.placeholder_next");
    if (node.placeholder !== placeholder) node.placeholder = placeholder;
    const value = (after?.[field]?.lines || []).join("\n");
    const fresh = (window.afterData?.seq || 0) >= (afterKeep[field] || 0);
    if (fresh && !afterDirty.has(field) && document.activeElement !== node && node.value !== value) node.value = value;
  }
  const note = document.querySelector("#after .after-note");
  const line = t(after?.send?.state === "edited" ? "after.fields_note_edited" : afterWent(after) ? "after.fields_note_sent"
    : final ? "after.fields_note" : "after.refining");
  if (note.textContent !== line) note.textContent = line;
}

function renderAfter(state) {
  const transcript = state?.transcript || {};
  const id = transcript.meeting_id;
  if (window.afterData && window.afterData.id !== id) {
    // Another meeting: nothing typed, opened or failed carries over.
    window.afterData = undefined;
    afterAsked = null;
    for (const field of Object.keys(AFTER_FIELDS)) clearTimeout(afterTimers[field]);
    [afterDirty, afterOpen, afterBusy].forEach(set => set.clear());
    Object.keys(afterKeep).forEach(field => delete afterKeep[field]);
    afterError = "";
  }
  if (!window.afterData && id && afterAsked !== id) {
    afterAsked = id;
    void afterFetch();
  }
  const after = window.afterData?.data || null;

  const title = transcript.display_meeting || transcript.meeting || "";
  if ($("after-title").textContent !== title) $("after-title").textContent = title;
  const start = callStartIso(state);
  const stop = state?.recording_control?.last_stop;
  const stopped = Date.parse(stop?.meeting_id === id ? stop.stopped_at : transcript.ended_at || "");
  const clock = start && !Number.isNaN(stopped) ? callClock(start, stopped) : "";
  const meta = !start || Number.isNaN(Date.parse(start)) ? "" : [t("after.meta", { time: homeClock(start),
    day: new Date(start).toLocaleDateString(homeLocale(), { day: "numeric", month: "long" }) }),
  clock ? t("after.stopped", { time: clock }) : ""].filter(Boolean).join(" ");
  if ($("after-meta").textContent !== meta) $("after-meta").textContent = meta;
  afterFields(after);

  const send = afterSend(after);
  const board = afterBoard(state, after);
  // The send block and the board change apart: a board change or a cached (stale) answer leaves the send block as it is,
  // and the live line speaks only when the headline itself changes.
  const sendSignature = JSON.stringify([uiLanguage, window.afterData?.id, send, after?.send, Boolean(after), afterError]);
  if (sendSignature !== afterSendSignature) {
    afterSendSignature = sendSignature;
    afterReplace($("after-send"), afterSendBlock(after, send));
  }
  if ($("after-said").textContent !== send.headline) $("after-said").textContent = send.headline;
  const note = afterWent(after) ? "after.board_note_sent" : { no_channels: "after.board_note_none", sending: "after.board_note_sending" }[send.state]
    || "after.board_note";
  const signature = JSON.stringify([uiLanguage, window.afterData?.id, board, [...afterOpen], note]);
  if (signature === afterSignature) return;
  afterSignature = signature;
  const head = textNode("h3", "", t("after.board"));
  head.id = "after-board-title";
  afterReplace($("after-board"), [head, textNode("p", "board-head", [t(note), board.memoLine].filter(Boolean).join(" ")),
    ...board.lanes.map(afterLane)]);
}

addEventListener("DOMContentLoaded", () => {
  for (const field of Object.keys(AFTER_FIELDS)) $(AFTER_FIELDS[field]).addEventListener("input", () => afterInput(field));
  // The opener takes focus first: WebKit does not focus a clicked button, and Escape or Back returns to it.
  for (const [id, panel] of [["after-transcript", "transcript"], ["after-chat", "chat"]]) {
    $(id).addEventListener("click", event => {
      event.currentTarget.focus();
      openCallPanel(panel);
    });
  }
});
