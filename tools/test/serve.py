"""Local development server without stale module responses during performance tests.

    python3 tools/test/serve.py 8099      then open http://localhost:8099/

It serves the repository at the root of the origin, as the deployed site is served. Everything the engine imports is
inside it (the kernel at src/kernel/, the reconstruction at src/atlas/), so a plain `python3 -m http.server` works
too; this one adds no-store caching, so a rebuilt module is never served stale.
"""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
import os
import sys

ROOT = os.path.realpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def do_GET(self):
        if 'If-Modified-Since' in self.headers:
            del self.headers['If-Modified-Since']
        super().do_GET()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    def log_message(self, format, *args):
        if args and str(args[1] if len(args) > 1 else '').startswith(('4', '5')):
            super().log_message(format, *args)


ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 8126), Handler).serve_forever()
