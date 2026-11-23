#!/usr/bin/env python3
"""After-call release gate (MEETONTRACK-189): the audit's end-to-end check.

Run on the Mac after installing the candidate, with `silence_stop_minutes: 1`.
Each step prints PASS or FAIL. A step that needs a person (a permission
reset, a grant, a click) prints MANUAL with what to do and how to resume,
then stops:

    python3 scripts/release-gate-after-call.py            # step 1
    python3 scripts/release-gate-after-call.py --from 2   # after doing what MANUAL said

This script never runs tccutil and never changes the app's config; it only
reads the recordings, the live file, the reports and delivery-health.json,
and speaks with `say`. Exit code: 0 all passed, 1 a check failed, 2 stopped
at a MANUAL step.
"""
from __future__ import annotations

import argparse
import array
import json
import subprocess
import sys
import tempfile
import time
import wave
from datetime import datetime
from pathlib import Path

HOME = Path.home()
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "copilot" / "web"))
from recording_health import RecordingLocations, epoch  # noqa: E402

CONFIG = HOME / ".config/meeting-copilot/config.json"
LIVE = HOME / ".local/share/meeting-copilot/meeting-copilot-live.json"
REPORTS = HOME / ".local/share/meeting-copilot/reports"
HEALTH = HOME / ".config/meeting-copilot/delivery-health.json"
BUNDLE = "com.aiagentlbs.meetingcopilot.capture"
STATE = Path(tempfile.gettempdir()) / "meetontrack-release-gate.json"
FAILED = False


def read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def result(ok: bool, step: str, detail: str) -> None:
    global FAILED
    FAILED |= not ok
    print(f"{'PASS' if ok else 'FAIL'}  {step}: {detail}", flush=True)


def manual(step: int, todo: str) -> None:
    print(f"MANUAL step {step}: {todo}\n        then run: python3 {sys.argv[0]} --from {step}", flush=True)
    sys.exit(1 if FAILED else 2)


def state(**update) -> dict:
    saved = read(STATE)
    if update:
        saved.update(update)
        STATE.write_text(json.dumps(saved))
    return saved


def locations() -> RecordingLocations:
    return RecordingLocations(CONFIG, HOME / ".local/share/meeting-copilot/recordings")


def start_delay() -> float:
    value = read(CONFIG).get("auto_record", {}).get("start_delay_seconds", 12)
    return float(value) if isinstance(value, (int, float)) else 12.0


def wait_for(check, seconds: float):
    deadline = time.time() + seconds
    while True:
        found = check()
        if found or time.time() >= deadline:
            return found
        time.sleep(1)


def marker_since(since: float) -> Path | None:
    for path in locations().markers():
        marker = read(path)
        if marker.get("trigger") == "mic-activity" and epoch(marker.get("started")) >= since - 2:
            return path
    return None


def health_issues() -> list[str]:
    return sorted(read(HEALTH).get("issues", {}))


def peak(track: Path) -> float | None:
    with tempfile.TemporaryDirectory() as scratch:
        out = Path(scratch) / "track.wav"
        if subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", str(track), str(out)],
                          capture_output=True).returncode != 0:
            return None
        top = 0
        with wave.open(str(out)) as audio:
            while not top and (chunk := audio.readframes(1 << 16)):
                top = max(map(abs, array.array("h", chunk)), default=0)
        return top / 32768


def say_for(seconds: int) -> subprocess.Popen:
    text = "This is the release gate speaking into the microphone. " * (seconds // 3 + 1)
    return subprocess.Popen(["say", "-r", "170", text])


def step1() -> None:
    state(issues=health_issues(), began=time.time())
    manual(2, f"run `tccutil reset All {BUNDLE}` yourself (the gate never does), install the candidate "
              "and open it; leave the calendar prompt unanswered. Then open a Chrome tab that holds the "
              "microphone (for example a call page) and resume the moment it takes the microphone.")


def step2() -> None:
    since = time.time()
    limit = start_delay() + 10
    found = wait_for(lambda: marker_since(since), limit)
    result(bool(found), "2 auto-record starts", f"{found.parent.name if found else 'no recording'} "
                                                 f"within {limit:.0f} s of the microphone")
    if not found:
        sys.exit(1)
    state(recording=str(found.parent))
    manual(3, "make sure System Audio Recording is denied for MeetOnTrack (deny the prompt or switch it off "
              "in System Settings) while that recording keeps running.")


def step3() -> None:
    session = Path(state().get("recording", ""))
    speaker = say_for(180)
    try:
        warned = wait_for(lambda: bool(read(LIVE).get("capture_warnings")), 60)
        result(warned, "3 capture warning", "capture_warnings in the live file within 60 s" if warned
               else "no capture_warnings within 60 s")
        speaker.wait(timeout=200)
    finally:
        speaker.kill()
    meta = read(session / "meta.json")
    still = (session / ".recording.json").exists() or meta.get("stop_reason") != "no-call-audio"
    result(still, "3 no-call-audio veto", "still recording after 3 minutes of speech" if still
           else "stopped with no-call-audio")
    manual(4, "grant System Audio Recording, stop the recording, then play a known WAV in the Chrome tab "
              "and resume as soon as it plays.")


def step4() -> None:
    since = time.time()
    limit = start_delay() + 10
    found = wait_for(lambda: marker_since(since), limit)
    result(bool(found), "4 recording restarts", found.parent.name if found else f"none within {limit:.0f} s")
    if not found:
        sys.exit(1)
    state(recording=str(found.parent))
    speaker = say_for(60)
    speaker.wait()
    manual(5, "stop the recording (the WAV may keep playing), then resume right away.")


def step5() -> None:
    saved = state()
    session = Path(saved.get("recording", ""))
    stopped = time.time()

    def finished() -> dict | None:
        meta = read(session / "meta.json")
        transcript = read(session / "transcript.json")
        return {"meta": meta, "transcript": transcript} if meta and transcript else None

    done = wait_for(finished, 300) or {"meta": read(session / "meta.json"), "transcript": {}}
    meta = done["meta"]
    peaks = {kind: peak(session / name) for kind, name in (meta.get("files") or {}).items()}
    result(bool(peaks) and all(value for value in peaks.values()), "5 both tracks heard",
           ", ".join(f"{kind} peak {value}" for kind, value in peaks.items()) or "no tracks")
    speakers = {segment.get("speaker") for segment in done["transcript"].get("segments", [])}
    result(len(speakers) >= 2, "5 two speakers", f"{len(speakers)} in transcript.json")
    problems = meta.get("capture_problems") or []
    result(not problems, "5 no capture problems", ", ".join(problems) or "none")

    def delivered() -> dict | None:
        for path in sorted(REPORTS.glob("*/report.json"), key=lambda p: p.stat().st_mtime, reverse=True):
            if path.stat().st_mtime < stopped - 60:
                break
            report = read(path)
            if (report.get("mail_status") == "sent" and report.get("telegram_status") == "sent"
                    and report.get("drive_status") == "uploaded"):
                return report
        return None

    report = wait_for(delivered, max(0, 300 - (time.time() - stopped)))
    result(bool(report), "5 report delivered", "mail sent, Telegram sent, Drive uploaded" if report
           else "no report with all three channels done within 5 minutes of the stop")
    new = sorted(set(health_issues()) - set(saved.get("issues", [])))
    result(not new, "5 no new delivery issue", ", ".join(new) or "none")


STEPS = {1: step1, 2: step2, 3: step3, 4: step4, 5: step5}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--from", dest="start", type=int, default=1, choices=sorted(STEPS))
    args = parser.parse_args()
    print(f"after-call release gate, step {args.start}, {datetime.now():%Y-%m-%d %H:%M:%S}", flush=True)
    for number in range(args.start, max(STEPS) + 1):
        STEPS[number]()
    sys.exit(1 if FAILED else 0)


if __name__ == "__main__":
    main()
