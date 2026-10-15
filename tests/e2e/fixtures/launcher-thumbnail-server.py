"""Run the real Launcher editor entry inside the E2E process owner."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from maw.gui_web import LauncherApi, LauncherPaths  # noqa: E402

project, port = Path(sys.argv[1]), int(sys.argv[2])
api = LauncherApi(paths=LauncherPaths(root=ROOT, env_path=project.parent / "unused.env",
                                    launcher_html=ROOT / "web/launcher/index.html"), window_getter=lambda: None)
try:
    result = api.start_server({"jsonPath": str(project), "port": port, "guiLang": "zh"})
    print(json.dumps(result), flush=True)
    if not result.get("ok"):
        raise SystemExit(1)
    while True:
        time.sleep(1)
finally:
    api._stop_owned_server()
