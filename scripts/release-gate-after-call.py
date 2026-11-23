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
ARCHIVE = HOME / ".local/share/meeting-copilot/archive"
HEALTH = HOME / ".config/meeting-copilot/delivery-health.json"
BUNDLE = "com.aiagentlbs.meetingcopilot.capture"
STATE = Path(tempfile.gettempdir()) / "meetontrack-release-gate.json"


def read(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def result(ok: bool, step: str, detail: str) -> None:
    # Kept in the run state: a failure before a MANUAL hand-off still fails the run.
    if not ok:
        state(failed=sorted(set(state().get("failed", [])) | {step}))
    print(f"{'PASS' if ok else 'FAIL'}  {step}: {detail}", flush=True)


def failed() -> list[str]:
    return state().get("failed", [])


def manual(step: int, todo: str) -> None:
    print(f"MANUAL step {step}: {todo}\n        then run: python3 {sys.argv[0]} --from {step}", flush=True)
    sys.exit(1 if failed() else 2)


def state(**update) -> dict:
    saved = read(STATE)
    if update:
        saved.update(update)
        STATE.write_text(json.dumps(saved))
    return saved


def locations() -> RecordingLocations:
    return RecordingLocations(CONFIG, HOME / ".local/share/meeting-copilot/recordings")


def auto_record(key: str, default: float) -> float:
    value = read(CONFIG).get("auto_record", {}).get(key, default)
    return float(value) if isinstance(value, (int, float)) else default


def start_delay() -> float:
    return auto_record("start_delay_seconds", 12)


def report_for(session: Path) -> dict:
    """The report made from this recording, found through the archive's meeting.json."""
    for meeting in ARCHIVE.glob("*/meeting.json"):
        directory = read(meeting).get("recording_dir")
        if directory and Path(directory).resolve() == session.resolve():
            return read(REPORTS / meeting.parent.name / "report.json")
    return {}


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


def peak(track: Path, channel: int | None = None) -> float | None:
    """Loudest sample of one file, or of one channel of a shared multichannel file."""
    with tempfile.TemporaryDirectory() as scratch:
        out = Path(scratch) / "track.wav"
        if subprocess.run(["afconvert", "-f", "WAVE", "-d", "LEI16", str(track), str(out)],
                          capture_output=True).returncode != 0:
            return None
        top = 0
        with wave.open(str(out)) as audio:
            count = audio.getnchannels()
            while not top and (chunk := audio.readframes(1 << 16)):
                samples = array.array("h", chunk)
                if channel is not None:
                    samples = samples[channel::count]
                top = max(map(abs, samples), default=0)
        return top / 32768


def say_for(seconds: int) -> subprocess.Popen:
    text = "This is the release gate speaking into the microphone. " * (seconds // 3 + 1)
    return subprocess.Popen(["say", "-r", "170", text])


def step1() -> None:
    STATE.write_text(json.dumps({"issues": health_issues(), "began": time.time()}))
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
        def far_end_warning() -> bool:
            return any(item.get("reason") == "system-audio-lost" and item.get("cause") and not item.get("ended_at")
                       for item in read(LIVE).get("capture_warnings") or [])
        warned = wait_for(far_end_warning, 60)
        result(warned, "3 capture warning", "far-end warning in the live file within 60 s" if warned
               else "no open far-end warning within 60 s")
        speaker.wait(timeout=200)
    finally:
        speaker.kill()
    # The same recording, still running: its marker is there and no meta.json yet.
    still = (session / ".recording.json").exists() and not (session / "meta.json").exists()
    result(still, "3 no-call-audio veto", "still recording after 3 minutes of speech" if still
           else f"stopped ({read(session / 'meta.json').get('stop_reason') or 'unknown'})")
    manual(4, "grant System Audio Recording and stop the recording. Release the microphone in Chrome "
              "(leave the call or close the tab) for a minute, then take it again with a known WAV "
              "playing in that tab, and resume as soon as it plays.")


def step4() -> None:
    since = time.time()
    limit = start_delay() + 10
    found = wait_for(lambda: marker_since(since), limit)
    result(bool(found), "4 recording restarts", found.parent.name if found else f"none within {limit:.0f} s")
    if not found:
        sys.exit(1)
    state(recording=str(found.parent))
    # Long enough for the archive to deliver it: past the minimum recording length.
    speaker = say_for(int(max(60, auto_record("min_duration_seconds", 300) + 15)))
    speaker.wait()
    manual(5, "stop the recording (the WAV may keep playing), then resume right away.")


def step5() -> None:
    saved = state()
    session = Path(saved.get("recording", ""))
    stopped = time.time()

    # Measured as soon as meta.json lands: a transcribed session's tracks are
    # deleted or folded into one stereo file afterwards.
    meta = wait_for(lambda: read(session / "meta.json"), 60) or {}
    channels = meta.get("audio_channels") or {}
    peaks = {kind: peak(session / name, channels.get(kind)) for kind, name in (meta.get("files") or {}).items()}
    result(set(peaks) == {"mic", "system"} and all(peaks.values()), "5 both tracks heard",
           ", ".join(f"{kind} peak {value}" for kind, value in peaks.items()) or "no tracks")
    transcript = wait_for(lambda: read(session / "transcript.json"), 300) or {}
    meta = read(session / "meta.json") or meta
    speakers = {segment.get("speaker") for segment in transcript.get("segments", [])}
    result(len(speakers) >= 2, "5 two speakers", f"{len(speakers)} in transcript.json")
    problems = meta.get("capture_problems") or []
    result(not problems, "5 no capture problems", ", ".join(problems) or "none")

    def delivered() -> dict | None:
        report = report_for(session)
        done = (report.get("mail_status") == "sent" and report.get("telegram_status") == "sent"
                and report.get("drive_status") == "uploaded")
        return report if done else None

    report = wait_for(delivered, max(0, 300 - (time.time() - stopped)))
    result(bool(report), "5 report delivered", "mail sent, Telegram sent, Drive uploaded" if report
           else "this recording's report not delivered on all three channels within 5 minutes of the stop")
    # The server rewrites delivery-health.json about once a minute: wait for a
    # snapshot taken after this delivery before trusting it.
    checked = time.time()
    wait_for(lambda: HEALTH.exists() and HEALTH.stat().st_mtime > checked, 90)
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
    if failed():
        print("FAIL  gate: " + ", ".join(failed()), flush=True)
    sys.exit(1 if failed() else 0)


if __name__ == "__main__":
    main()
