"""Run the real Launcher editor entry inside the E2E process owner."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT))

from maw.gui_web import LauncherApi, LauncherPaths  # noqa: E402
from maw.gui_platform import process_group_kwargs  # noqa: E402


def owned_fixture_group_kwargs():
    options = process_group_kwargs()
    if sys.platform != "win32":
        # The E2E owner already created the POSIX group. A nested session would
        # escape its SIGKILL cleanup, including on an abrupt fixture exit where
        # finally cannot run. Keep the real Server and FFmpeg in that group.
        options.pop("start_new_session", None)
    return options

project, port = Path(sys.argv[1]), int(sys.argv[2])
api = LauncherApi(paths=LauncherPaths(root=ROOT, env_path=project.parent / "unused.env",
                                    launcher_html=ROOT / "web/launcher/index.html"), window_getter=lambda: None)
try:
    with mock.patch("maw.gui_web.process_group_kwargs", side_effect=owned_fixture_group_kwargs):
        result = api.start_server({"jsonPath": str(project), "port": port, "guiLang": "zh"})
    print(json.dumps({**result, "fixtureServerPid": getattr(api.server_process, "pid", None)}), flush=True)
    if not result.get("ok"):
        raise SystemExit(1)
    if "--exit-after-start" in sys.argv:
        os._exit(71)  # Exercise owner cleanup when Python finally cannot run.
    while True:
        time.sleep(1)
finally:
    api._stop_owned_server()
