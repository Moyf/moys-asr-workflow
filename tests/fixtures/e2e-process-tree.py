"""Synthetic wrapper/server only: no application, settings, or browser access."""
import http.server
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time

port = int(sys.argv[sys.argv.index('--port') + 1])
root = Path(os.environ['MAW_APP_DATA_ROOT']).parent
mode = (Path.cwd() / 'scenario.txt').read_text()
if '--leaf' not in sys.argv:
    (root / 'runtime-environment.json').write_text(json.dumps({
        'localAppData': os.environ.get('LOCALAPPDATA'),
        'parentOnlyMarker': 'MAW_LIFECYCLE_PARENT_ONLY' in os.environ,
    }))
    child = subprocess.Popen([sys.executable, __file__, *sys.argv[1:], '--leaf'])
    pids_temp = root / 'owned-pids.tmp'
    pids_temp.write_text(json.dumps([os.getpid(), child.pid]))
    pids_temp.replace(root / 'owned-pids.json')
    if mode == 'wrapper-exit':
        sys.exit(7)
    child.wait()
else:
    # Last-resort bound even if the test runner itself is forcibly killed.
    threading.Timer(60, lambda: os._exit(91)).start()
    # The wrapper may be stopped as soon as the server responds. Publish the
    # complete ownership evidence atomically before the leaf starts listening.
    while not (root / 'owned-pids.json').is_file():
        time.sleep(0.01)

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            if mode == 'hang':
                threading.Event().wait(60)
                return
            if mode == 'slow-root' and self.path == '/':
                time.sleep(2)
            self.send_response(200)
            self.end_headers()
            status = {'startup-error': 'error', 'wrapper-exit': 'loading'}.get(mode, 'ready')
            self.wfile.write(json.dumps({'status': status}).encode())

        def log_message(self, *_args):
            pass

    http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
