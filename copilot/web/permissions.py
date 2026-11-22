"""Whether the recorder may hear the microphone and the call, and the system page that changes it."""
from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from pathlib import Path

STATES = ("granted", "denied")
MIC_STORE = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone"
SETTINGS = {
    ("posix", "microphone"): "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    ("posix", "call_audio"): "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    ("posix", "sound_output"): "x-apple.systempreferences:com.apple.Sound-Settings.extension",
    ("nt", "microphone"): "ms-settings:privacy-microphone",
    ("nt", "sound_output"): "ms-settings:sound",
}


def _windows_registry(hive: str, path: str) -> str | None:
    import winreg  # Windows only
    try:
        with winreg.OpenKey(getattr(winreg, "HKEY_LOCAL_MACHINE" if hive == "HKLM" else "HKEY_CURRENT_USER"), path) as key:
            value = winreg.QueryValueEx(key, "Value")[0]
    except FileNotFoundError:  # missing key or value; no access raises
        return None
    return value if isinstance(value, str) else None


class RecorderProbe:
    def __init__(self, binary: Path, run=subprocess.run, os_name: str = os.name, read_registry=None, ttl: float = 30):
        self.binary, self.run, self.os_name, self.ttl = binary, run, os_name, ttl
        self.read_registry = read_registry or _windows_registry
        self.lock = threading.Lock()
        self.cached: tuple[float, dict] | None = None

    def snapshot(self) -> dict:
        with self.lock:
            if self.cached is None or time.monotonic() - self.cached[0] >= self.ttl:
                self.cached = (time.monotonic(), self._windows() if self.os_name == "nt" else self._macos())
            return dict(self.cached[1])

    def invalidate(self) -> None:
        """Forget the cached answer: the person may have just changed a permission."""
        with self.lock:
            self.cached = None

    def _json(self, *args: str) -> dict:
        """The recorder's JSON answer, or {} for anything else; its output goes nowhere but here."""
        try:
            result = self.run([str(self.binary), *args], capture_output=True, text=True, timeout=5, check=False)
            value = json.loads(result.stdout) if result.returncode == 0 else {}
        except (OSError, subprocess.SubprocessError, ValueError):
            return {}
        return value if isinstance(value, dict) else {}

    def _macos(self) -> dict:
        answer = self._json("permissions")

        def state(key: str) -> str:
            return answer[key] if answer.get(key) in STATES else "unknown"

        return {"microphone": state("microphone"), "call_audio": state("call_audio"),
                "skip_recording": answer.get("skip_recording") is True}

    def _windows(self) -> dict:
        """Same rule as windows/src/Amanu.App/Access.cs MicrophoneAccess.Read; loopback needs no permission."""
        try:
            user = self.read_registry("HKCU", MIC_STORE)
            values = (self.read_registry("HKLM", MIC_STORE), user, self.read_registry("HKCU", MIC_STORE + r"\NonPackaged"))
        except OSError:  # a key that cannot be read, as Access.cs answers Unknown
            microphone = "unknown"
        else:
            microphone = "denied" if "Deny" in values else "unknown" if user is None else "granted"
        return {"microphone": microphone, "call_audio": "unknown",
                "skip_recording": self._json("record", "status").get("skip_recording") is True}


def open_settings(which: str, os_name: str = os.name, opener=None) -> None:
    """Open the system page for one fixed permission; nothing from the caller reaches the command."""
    target = SETTINGS.get(("nt" if os_name == "nt" else "posix", which))
    if target is None:
        raise ValueError("Unknown permission.")
    if opener is None:
        opener = os.startfile if os_name == "nt" else _open_mac
    opener(target)


def _open_mac(url: str) -> None:
    subprocess.run(["/usr/bin/open", url], check=True, timeout=10)
