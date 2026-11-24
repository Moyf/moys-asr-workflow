"""Read Editor and shared source for source-level behavior contracts."""
from pathlib import Path

import edit


def editor_source_text() -> str:
    web = Path(edit.WEB_DIR)
    return "\n\n".join(
        edit.read_web_asset(path.relative_to(web).as_posix())
        for directory in ("editor", "shared")
        for path in sorted((web / directory).rglob("*.js"))
        if path.name != "editor-bundle.js"
    )
