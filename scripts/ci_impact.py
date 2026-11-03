"""Select a conservative documentation/website-only PR scope."""
from __future__ import annotations

import os
from pathlib import Path
import re
import subprocess


def light_path(path: str) -> bool:
    if path in {"README.md", "docs/INDEX.md", "website/README.md"}:
        return True
    if path.startswith("docs/user/") and path.endswith(".md"):
        return True
    # Website synchronization and release generation overwrite these paths.
    generated = ("website/src/pages/docs/", "website/src/pages/releases/",
                 "website/src/generated/", "website/public/docs-assets/",
                 "website/public/releases/", "website/public/release-assets/")
    if path.startswith(generated):
        return False
    return path.startswith(("website/src/", "website/public/", "website/docs/"))


def main() -> None:
    light = False
    reason = "full gates: non-PR event, unavailable diff or unrecognized paths"
    base = os.environ.get("PR_BASE_SHA", "")
    if os.environ.get("GITHUB_EVENT_NAME") == "pull_request" and re.fullmatch(r"[0-9a-f]{40}", base):
        try:
            parent = subprocess.check_output(["git", "rev-parse", "HEAD^1"], text=True).strip()
            if parent == base:
                raw = subprocess.check_output(
                    ["git", "diff", "--name-only", "--no-renames", "-z", base, "HEAD"]
                )
                paths = [p.decode("utf-8") for p in raw.split(b"\0") if p]
                light = bool(paths) and all(light_path(path) for path in paths)
                reason = f"{'website/documentation' if light else 'full'} gates: {len(paths)} changed paths"
        except (OSError, subprocess.SubprocessError, UnicodeError):
            pass
    print(reason)
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with Path(output).open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(f"light={str(light).lower()}\n")


if __name__ == "__main__":
    main()
