"""Prepare only the supported editor artifact in a fresh website build directory."""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw.editor_entry_policy import RETIREMENT_MESSAGE, standalone_editor_supported  # noqa: E402


def prepare_editor_pages(output: Path) -> None:
    editor = output / "editor"
    if not standalone_editor_supported():
        # Never delete a historical/user page. A reused build directory must be
        # cleaned by its owner, not silently uploaded with a retired editor.
        if editor.exists():
            raise ValueError("Retired editor found in Pages output; use a fresh website build directory.")
        print(RETIREMENT_MESSAGE)
    else:
        from edit import build_blank_html

        editor.mkdir(parents=True, exist_ok=True)
        (editor / "index.html").write_text(build_blank_html(), encoding="utf-8", newline="\n")
    output.mkdir(parents=True, exist_ok=True)
    (output / ".nojekyll").touch()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "website" / "dist")
    args = parser.parse_args()
    try:
        prepare_editor_pages(args.output)
    except ValueError as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
