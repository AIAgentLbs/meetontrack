"""The memo check: a finished call compared with its memo, once, offline (MEETONTRACK-163).

The one AI choice reads the memo questions, the memo text and the numbered transcript and
names which questions were answered and which memo statements the call contradicts. Nothing
it says is kept unless its quote is found word for word in the line it names.
"""

from __future__ import annotations

import hashlib
import json
from typing import Callable

from ai_providers import AIChoiceError

TIMEOUT = 90
MAX_PROMPT = 200_000
MEMO_CHARS = 6000
MAX_DIFFERS = 10


def _norm(text) -> str:
    return " ".join(str(text or "").casefold().split())


def memo_questions(plan: dict | None) -> list[dict]:
    return [item for item in (plan or {}).get("items") or []
            if isinstance(item, dict) and item.get("kind") == "question"
            and item.get("id") and str(item.get("text") or "").strip()]


def _memo(plan: dict) -> str:
    return str(plan.get("memo_markdown") or "")[:MEMO_CHARS]


def prompt(plan: dict, segments: list[dict]) -> str:
    questions = "\n".join(f"{item['id']}: {' '.join(str(item['text']).split())}" for item in memo_questions(plan))
    lines = "\n".join(f"[{index}] {' '.join(str(segment.get('speaker') or 'Speaker').split())}: "
                      f"{' '.join(str(segment.get('text') or '').split())}" for index, segment in enumerate(segments))
    text = (
        "Compare a finished call with the memo prepared before it. Use only the text below.\n\n"
        f"Memo questions (id: text):\n{questions}\n\n"
        f"Memo:\n{_memo(plan)}\n\n"
        f"Call transcript, one numbered line per utterance ([index] speaker: text):\n{lines}\n\n"
        "Answer with one JSON object and nothing else:\n"
        '{"questions": [{"id": "<question id>", "status": "answered" or "open", "segment": <line index>, '
        '"quote": "<words copied word for word from that one line>"}], '
        '"differs": [{"memo": "<statement copied word for word from the memo>", "segment": <line index>, '
        '"quote": "<words copied word for word from that one line>"}]}\n'
        "A question is answered only when one transcript line answers it; quote the answer from that line. "
        "Put in differs only a statement made on the call that contradicts a statement in the memo. "
        "Leave a list empty when nothing applies."
    )
    if len(text) > MAX_PROMPT:
        raise ValueError("too_long")
    return text


def parse(text: str, plan: dict, segments: list[dict]) -> dict:
    start, end = text.find("{"), text.rfind("}")
    try:
        data = json.loads(text[start:end + 1]) if 0 <= start < end else None
    except ValueError:
        data = None
    if not isinstance(data, dict):
        raise ValueError("ai_no_answer")

    def found(entry) -> tuple[str, dict] | None:
        """The quote and the line it was copied from, or None when it is not in that line."""
        if not isinstance(entry, dict):
            return None
        try:
            index = int(entry.get("segment"))
        except (TypeError, ValueError):
            return None
        quote = " ".join(str(entry.get("quote") or "").split())
        if not quote or not 0 <= index < len(segments) or _norm(quote) not in _norm(segments[index].get("text")):
            return None
        return quote, segments[index]

    def where(segment: dict) -> dict:
        return {"speaker": str(segment.get("speaker") or ""), "at": str(segment.get("timestamp") or "")}

    answers: dict[str, dict] = {}
    for entry in data.get("questions") if isinstance(data.get("questions"), list) else []:
        if isinstance(entry, dict):
            answers.setdefault(str(entry.get("id")), entry)
    questions = []
    for item in memo_questions(plan):
        entry = answers.get(str(item["id"])) or {}
        hit = found(entry) if entry.get("status") == "answered" else None
        questions.append({"id": item["id"], "text": str(item["text"]), "status": "answered" if hit else "open",
                          "quote": hit[0] if hit else "", **(where(hit[1]) if hit else {"speaker": "", "at": ""})})

    memo_text, differs = _norm(_memo(plan)), {}
    for entry in data.get("differs") if isinstance(data.get("differs"), list) else []:
        hit = found(entry)
        memo = " ".join(str(entry.get("memo") or "").split()) if hit else ""
        if not hit or not memo or _norm(memo) not in memo_text or len(differs) >= MAX_DIFFERS:
            continue
        key = "differs:" + hashlib.sha1((memo + hit[0]).encode("utf-8")).hexdigest()[:12]
        differs.setdefault(key, {"key": key, "memo": memo, "quote": hit[0], **where(hit[1])})
    return {"state": "done", "questions": questions, "differs": list(differs.values())}


def check(detail: dict, plan: dict | None, run: Callable[[str], str]) -> dict | None:
    """None without memo questions (no AI call); otherwise the outcome to keep with the report."""
    if not memo_questions(plan):
        return None
    segments = list(detail.get("transcript") or [])
    try:
        result = parse(str(run(prompt(plan, segments)) or ""), plan, segments)
    except AIChoiceError:
        result = {"state": "unavailable", "reason": "ai_needs_choice"}
    except TimeoutError:
        result = {"state": "failed", "reason": "timeout"}
    except ValueError as error:
        reason = error.args[0] if error.args and error.args[0] in {"too_long", "ai_no_answer"} else "error"
        result = {"state": "failed", "reason": reason}
    except Exception:  # noqa: BLE001 - any other failure is a failed check, never a lost report
        result = {"state": "failed", "reason": "error"}
    print(f"memo check {detail.get('meeting_id')}: {result['state']}", flush=True)
    return result
