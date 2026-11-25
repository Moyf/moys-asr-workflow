"""Run the real local server with the browser fixture built by Playwright."""

import runpy
import sys
from pathlib import Path

root = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(root))

import edit  # noqa: E402

bundle_arg, *args = sys.argv[1:]
bundle = Path(bundle_arg).read_text(encoding="utf-8").rstrip()
edit.build_editor_scripts = lambda: bundle
entry = root / "server-editor" / "serve.py"
sys.argv = [str(entry), *args]
runpy.run_path(str(entry), run_name="__main__")
