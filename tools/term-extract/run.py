"""term-extract 独立工具入口引导：python tools/term-extract/run.py <video> …"""

from __future__ import annotations

import sys
from pathlib import Path

_TOOL_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _TOOL_DIR.parents[1]

for _path in (str(_REPO_ROOT), str(_TOOL_DIR)):
    if _path not in sys.path:
        sys.path.insert(0, _path)

from term_extract.__main__ import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
