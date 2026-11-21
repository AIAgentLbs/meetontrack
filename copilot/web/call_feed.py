"""What the Call view shows next to the hints: the other side's question still waiting, and the
prompt rule that makes every hint start with a line the person can say aloud."""
from __future__ import annotations

import re
from datetime import datetime

from question_quality import useful_question

HEARD_FOR = 120  # seconds a heard question stays on screen

SPEAKABLE_RULE = (
    "\nКаждый ASK, RISK, OBJECTION и CONTRADICTION начинай с одной строки, которую пользователь "
    "может сказать вслух как есть: около восьми слов, читается за две секунды. Рассуждение, "
    "цитата и источник идут на следующих строках. "
    'Для QUESTION_CAPTURE с direction incoming добавь поле "reply": одну такую же строку, '
    "которой пользователь может ответить сейчас, только по разговору, подготовке к встрече или "
    'источникам. Если ответ нечем подкрепить, поле "reply" не добавляй.'
)


def _words(text: object) -> str:
    return " ".join(re.findall(r"\w+", str(text or "").casefold()))


def _seconds(value: object) -> float | None:
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def heard_question(segments: list[dict], journal: list[dict], *, analysis_started_at: float,
                   busy: bool, now: float) -> dict | None:
    """The newest recent question from the other side that the analysis has not taken up yet."""
    for segment in reversed(segments):
        text = str(segment.get("text") or "").strip()
        if (segment.get("source") != "system" or segment.get("provisional")
                or not text.endswith("?") or not useful_question(text)):
            continue
        at = _seconds(segment.get("timestamp"))
        if at is None:
            continue
        if now - at > HEARD_FOR:
            return None  # segments are in time order: every older question is older still
        words = _words(text)
        if any(item.get("category") in {"INCOMING_QUESTION", "OPEN_QUESTION"}
               and (captured := _words(item.get("text"))) and (captured in words or words in captured)
               for item in journal):
            return None
        if analysis_started_at > at and not busy:
            return None
        return {"text": text, "speaker": str(segment.get("speaker") or ""), "at": segment.get("timestamp")}
    return None
