import io
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
import signal
import unittest
from unittest.mock import patch

import server


class ParentWatchTests(unittest.TestCase):
    def test_stdin_eof_stops_the_server_like_ctrl_c(self):
        # The app holds the write end of stdin; EOF means it is gone.
        with patch.object(server.os, "kill") as kill:
            server.watch_parent(io.BytesIO(b"noise")).join(5)
        kill.assert_called_once_with(server.os.getpid(), signal.SIGINT)

    @unittest.skipIf(os.name == "nt", "process groups are POSIX")
    def test_what_the_server_started_stops_with_it(self):
        """MEETONTRACK-114: a helper the server started does not outlive its shutdown."""
        code = ("import subprocess, server; assert server.own_process_group(); "
                "child = subprocess.Popen(['sleep', '60']); print(child.pid, flush=True); "
                "server.stop_process_group()")
        with tempfile.TemporaryDirectory() as home:
            result = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60,
                                    cwd=Path(server.__file__).parent, env={**os.environ, "HOME": home})
        self.assertEqual(result.returncode, 0, result.stderr[-2000:])
        child = int(result.stdout.split()[-1])
        for _ in range(40):
            try:
                os.kill(child, 0)
            except ProcessLookupError:
                break
            time.sleep(0.05)
        else:
            os.kill(child, signal.SIGKILL)
            self.fail("the helper outlived the server")


if __name__ == "__main__":
    unittest.main()
