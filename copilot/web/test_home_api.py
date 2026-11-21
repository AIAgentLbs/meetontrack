import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer

import server


class StaticFilesTests(unittest.TestCase):
    def test_shell_files_served_with_csp(self):
        httpd = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        try:
            for path, content_type in (('/shell.js', 'text/javascript; charset=utf-8'),
                                       ('/home.js', 'text/javascript; charset=utf-8'),
                                       ('/screens.css', 'text/css; charset=utf-8')):
                connection = http.client.HTTPConnection('127.0.0.1', httpd.server_port, timeout=3)
                connection.request('GET', path)
                response = connection.getresponse()
                response.read()
                connection.close()
                with self.subTest(path=path):
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.getheader('Content-Type'), content_type)
                    self.assertIn("script-src 'self'", response.getheader('Content-Security-Policy') or '')
        finally:
            httpd.shutdown()
            httpd.server_close()


if __name__ == '__main__':
    unittest.main()
