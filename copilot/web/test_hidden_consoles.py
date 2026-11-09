import unittest

import hidden_consoles as h


class HiddenConsoleTests(unittest.TestCase):
    def test_flags(self):
        self.assertEqual(h.hidden(0), h.CREATE_NO_WINDOW)
        self.assertEqual(h.hidden(0x200), 0x200 | h.CREATE_NO_WINDOW)  # process group keeps its flag
        self.assertEqual(h.hidden(h.CREATE_NEW_CONSOLE), h.CREATE_NEW_CONSOLE)  # sign-in console stays

    def test_installs_on_windows_only(self):
        import subprocess
        from unittest import mock
        plain = lambda self, *args, **kwargs: None
        with mock.patch.object(subprocess.Popen, "__init__", plain):
            with mock.patch.object(h.os, "name", "posix"):
                h.install()
                self.assertIs(subprocess.Popen.__init__, plain)
            with mock.patch.object(h.os, "name", "nt"):
                h.install()
                self.assertTrue(subprocess.Popen.__init__.hides_console)


if __name__ == "__main__":
    unittest.main()
