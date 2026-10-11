"""Synthetic wrapper/server only: no application, settings, or browser access."""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

port = int(sys.argv[sys.argv.index('--port') + 1])
root = Path(os.environ['MAW_APP_DATA_ROOT']).parent
mode = (Path.cwd() / 'scenario.txt').read_text()
if '--leaf' not in sys.argv:
    child = subprocess.Popen([sys.executable, __file__, *sys.argv[1:], '--leaf'])
    (root / 'owned-pids.json').write_text(json.dumps([os.getpid(), child.pid]))
    if mode == 'wrapper-exit':
        sys.exit(7)
    child.wait()
else:
    # Last-resort bound even if the test runner itself is forcibly killed.
    threading.Timer(60, lambda: os._exit(91)).start()

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if mode == 'hang':
                threading.Event().wait(60)
                return
            self.send_response(200)
            self.end_headers()
            status = {'startup-error': 'error', 'wrapper-exit': 'loading'}.get(mode, 'ready')
            self.wfile.write(json.dumps({'status': status}).encode())

        def log_message(self, *_args):
            pass

    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
