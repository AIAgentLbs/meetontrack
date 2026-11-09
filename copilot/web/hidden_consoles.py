"""Windows: no console window flashes for the service's helper programs.

The service runs under pythonw, which has no console, so every console program it starts
(cmd.exe for codex.cmd every few minutes, git, ffmpeg...) opens a window of its own. All
subprocess calls go through Popen, so the window is hidden there, once, instead of at each
call site. A caller that wants a console (sign-in) passes CREATE_NEW_CONSOLE and keeps it.
"""
import os
import subprocess

CREATE_NEW_CONSOLE = 0x00000010
CREATE_NO_WINDOW = 0x08000000


def hidden(flags):
    return flags if flags & CREATE_NEW_CONSOLE else flags | CREATE_NO_WINDOW


def install():
    if os.name != "nt" or getattr(subprocess.Popen.__init__, "hides_console", False):
        return
    original = subprocess.Popen.__init__

    def init(self, *args, creationflags=0, **kwargs):
        original(self, *args, creationflags=hidden(creationflags), **kwargs)

    init.hides_console = True
    subprocess.Popen.__init__ = init
