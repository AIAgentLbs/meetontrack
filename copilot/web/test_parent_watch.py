import io
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


if __name__ == "__main__":
    unittest.main()
