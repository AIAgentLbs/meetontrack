// After: what was agreed and who gets the report, before it leaves (MEETONTRACK-163). The board comes from the
// /api/state poll (plan, journal, fact checks) and /api/after (memo check, removed items), the send block from /api/after.
// Journal, plan, memo check and AI text are untrusted: every value goes in through textContent.

// A moment of the call on the call's own clock (MM:SS or H:MM:SS), like every time in Call. Delivery times are wall clock.
function afterTime(atIso, startIso) {
  const at = Date.parse(atIso || "");
  return startIso && !Number.isNaN(at) ? callClock(startIso, at) : "";
}
const afterClock = iso => (Number.isNaN(Date.parse(iso || "")) ? "" : homeClock(iso));
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
  for (const item of questions) {
    const found = checked?.find(entry => entry.id === item.id);
    const answered = checked ? found?.status === "answered" : item.status === "resolved";
    const quote = answered && found ? { quote: String(found.quote || ""), speaker: String(found.speaker || ""), at: found.at } : {};
    put("ask", row(`memo:${item.id}`, item.text, answered ? "answered" : "no_answer", { memo: true, ...quote }), answered);
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
      other: String(item.fact || "") }, true), item.status === "confirmed");
  }
  // What was said against what the memo says: `other` is the memo's whole line, with where the memo came from.
  const source = String(state?.call_plan?.source_label || "");
  for (const item of checked ? memo.differs || [] : []) {
    const said = String(item.quote || "");
    put("facts", row(String(item.key), said, "differs", { quote: said, speaker: String(item.speaker || ""), at: item.at,
      other: source ? t("after.differs_memo", { source, memo: item.memo }) : String(item.memo || "") }, true));
  }

  const memoLine = !memo ? "" : memo.state === "done" ? t("after.memo_checked") : memo.state === "waiting" ? t("after.memo_waiting")
    : t("after.memo_failed", { reason: afterReason(memo.reason) });
  return { lanes: Object.values(lanes), memoLine };
}

const AFTER_WAITS = ["draft", "preparing", "showing", "changes"]; // states in which a change still holds the report
const AFTER_ACTIONS = Object.fromEntries([...AFTER_WAITS, "sending"].map(state => [state, ["send_now", "hold"]]));
Object.assign(AFTER_ACTIONS, { held: ["send_now"], edited: ["send_again"], failed: ["retry"] });
const AFTER_RESEND = new Set(["email", "telegram", "drive"]); // what Send again and Retry can send; the CRM note stays

// The send block: the headline from the server's send state (the gate), the rules, who gets it, what can be done.
function afterSend(after) {
  const send = after?.send || { state: "draft" };
  const { state } = send;
  const channels = send.channels || [];
  const resend = channels.filter(row => AFTER_RESEND.has(row.channel));
  // Send again needs a channel it can resend (ruling C11); Retry resends only the failed ones (ruling C9).
  const stuck = state === "edited" ? !resend.length : state === "failed" && !resend.some(row => row.status === "failed");
  const parts = channels.map(row => (row.channel === "telegram" && !row.to ? t("after.to.telegram_me")
    : t(`after.to.${row.channel}${row.channel === "twenty" && row.to ? "_named" : ""}`, { to: row.to })));
  return {
    state,
    headline: t(state === "draft" && send.send_now ? "after.send.send_now_pending" : `after.send.${state}`),
    rules: AFTER_WAITS.includes(state) ? [t("after.rule.changes"), t("after.rule.keep")] : [],
    recipients: state === "no_channels" || !parts.length ? "" : t("after.to", { list: parts.join(", ") }),
    actions: stuck ? [] : AFTER_ACTIONS[state] || [],
    channels: ["sent", "edited", "failed", "held"].includes(state) ? channels.map(row => {
      // A line never ends on "at": without a time the time clause goes.
      const time = afterClock(row.status === "failed" ? row.retry_at : row.at);
      const plain = !time && (row.status === "sent" || row.status === "failed");
      return t(`after.ch.${row.status}${plain ? "_plain" : ""}`, { channel: t(`after.channel.${row.channel}`), time });
    }) : [],
  };
}

function renderAfter(_state) {} // the view itself: Task 6
