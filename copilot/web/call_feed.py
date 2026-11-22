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
    "Пиши эту строку собеседнику, а не заметку для себя: CONTRADICTION начинай с уточняющего вопроса "
    "(«Уточните: старт в марте или в апреле?»), RISK и OBJECTION с фразы, которую пользователь скажет. "
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


def analysed_watermark(segments: list[dict], latest_at: str) -> str:
    """The newest transcript time an analysis reads in final form: `latest_at`, or just before the first
    line still provisional. A provisional question cannot be captured, and a finalized line keeps its start
    time, so a watermark past it would hide a question the analysis never took up (B4)."""
    provisional = [at for item in segments if item.get("provisional")
                   if (at := _seconds(item.get("timestamp"))) is not None]
    latest = _seconds(latest_at) if latest_at else None
    if not provisional or (latest is not None and latest < min(provisional)):
        return latest_at
    return datetime.fromtimestamp(min(provisional) - 0.001).astimezone().isoformat()


def provisional_marks(segments: list[dict]) -> str:
    """Which lines are still provisional, by start time. Part of what an analysis read: a later line turning
    final while an earlier one stays provisional leaves the watermark where it was, not this (J4)."""
    return ",".join(str(item.get("timestamp") or "") for item in segments if item.get("provisional"))


def heard_question(segments: list[dict], journal: list[dict], *, analysed_until: str,
                   busy: bool, now: float) -> dict | None:
    """The newest recent question from the other side that the analysis has not taken up yet.

    `analysed_until` is the newest transcript time the last started analysis saw. A question
    spoken before that analysis started may reach the transcript only after it started, so the
    start time alone would hide a question the analysis never read."""
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
        words = f" {_words(text)} "
        if any(item.get("category") in {"INCOMING_QUESTION", "OPEN_QUESTION"}
               and (captured := f" {_words(item.get('text'))} ").strip()
               and (captured in words or words in captured)  # whole words: spaces on both ends
               for item in journal):
            return None
        seen = _seconds(analysed_until) if analysed_until else None
        if seen is not None and seen >= at and not busy:
            return None
        return {"text": text, "speaker": str(segment.get("speaker") or ""), "at": segment.get("timestamp")}
    return None
