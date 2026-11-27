"""Render a browser contract fixture, never a supported/distributable editor entry.

Local Server and the desktop host still depend on browser file APIs and fallback
downloads after 2.0. Exercise those with the shared renderer without invoking the
retired production CLI or adding a production version override.
"""

from pathlib import Path
import json
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
import edit

output = Path(sys.argv[1])
if len(sys.argv) > 2:
    bundle = Path(sys.argv[2]).read_text(encoding="utf-8").rstrip()
    edit.build_editor_scripts = lambda: bundle
output.write_text(
    edit.render_empty_editor_page(json.dumps(edit.ninja_sfx_base_url(output))),
    encoding="utf-8", newline="\n",
)
