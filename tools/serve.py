"""Serve the repo root locally with caching off, for tools/cast-test.html.

`python -m http.server` sends no Cache-Control, so the browser caches files
heuristically and a test run can quietly use yesterday's scripts. This adds
`Cache-Control: no-store` to every response.

    python tools/serve.py          # then open http://localhost:8000/tools/cast-test.html
    python tools/serve.py 8123     # another port
"""
import functools
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    handler = functools.partial(NoStoreHandler, directory=str(ROOT))
    with http.server.ThreadingHTTPServer(('127.0.0.1', port), handler) as httpd:
        print(f'Serving {ROOT} at http://localhost:{port}/  (cast test: /tools/cast-test.html)')
        httpd.serve_forever()


if __name__ == '__main__':
    main()
