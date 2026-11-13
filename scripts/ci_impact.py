"""Versioned, fail-closed CI plan; only audited leaf paths can select a domain."""
from __future__ import annotations

import os
import argparse
import json
from pathlib import Path
import re
import subprocess

VERSION = 1
PROFILES = ("light", "editor", "launcher", "tools", "full")
# Deliberately NOT directory prefixes. Adding ownership requires an audit of the
# source and its registered browser consumers; shared wiring/config is full.
DOMAIN_PATHS = {
    "editor": {"web/editor/cues/editor-color-filter.js", "tests/e2e/cue-color-filter.spec.mjs"},
    "launcher": {"web/launcher/theme/launcher-theme-keys.js", "tests/e2e/launcher-zoom.spec.mjs"},
    "tools": {"tools/timestamp-compare.html", "tests/e2e/timestamp-compare.spec.mjs"},
}
BROWSER_FILES = {
    "editor": ["tests/e2e/cue-color-filter.spec.mjs"],
    "launcher": ["tests/e2e/launcher-zoom.spec.mjs"],
    "tools": ["tests/e2e/timestamp-compare.spec.mjs"],
    "full": [],
    "light": [],
}
SHA = re.compile(r"[0-9a-f]{40}")


def classify(paths: list[str]) -> tuple[str, str]:
    if not paths or any(not p or p.startswith("/") or "\\" in p or any(c in p for c in "\n\r")
                        or any(part in {"", ".", ".."} for part in p.split("/")) for p in paths):
        return "full", "empty or malformed diff"
    if all(light_path(p) for p in paths):
        return "light", "documentation/website-only PR"
    for profile, registered in DOMAIN_PATHS.items():
        if all(p in registered for p in paths):
            return profile, "audited same-domain leaves"
    return "full", "shared, unknown, dependency/configuration, or mixed-domain paths"


def plan(profile: str, reason: str, *, base: str = "", head: str = "", trusted: bool = False) -> dict:
    if profile not in PROFILES:
        raise ValueError("unknown CI profile")
    mode = profile if profile in {"light", "full"} else "domain"
    return {"version": VERSION, "mode": mode, "profile": profile,
            "light": profile == "light", "reason": reason,
            "base": base, "head": head, "trusted_diff": trusted}


def select(event: str, base: str, cwd: Path | None = None) -> dict:
    def git(*args: str) -> bytes:
        return subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.PIPE)
    head = ""
    try:
        head = git("rev-parse", "HEAD").decode("ascii").strip()
        if not SHA.fullmatch(head):
            raise ValueError("invalid HEAD")
        if event != "pull_request":
            return plan("full", "non-PR event", head=head)
        if not SHA.fullmatch(base):
            return plan("full", "invalid PR base", head=head)
        parent = git("rev-parse", "HEAD^1").decode("ascii").strip()
        if parent != base:
            return plan("full", "merge parent differs from PR base", head=head)
        # --no-renames exposes BOTH old and new names. Deleted known leaves are
        # safe only when every changed name is registered in the same domain.
        raw = git("diff", "--name-only", "--no-renames", "-z", base, "HEAD")
        if raw and not raw.endswith(b"\0"):
            raise ValueError("unterminated diff")
        paths = [p.decode("utf-8") for p in raw.split(b"\0")[:-1]]
        profile, reason = classify(paths)
        return plan(profile, reason, base=base, head=head, trusted=True)
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError):
        return plan("full", "unavailable or malformed git diff", head=head)


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
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args()
    selected = select(os.environ.get("GITHUB_EVENT_NAME", ""), os.environ.get("PR_BASE_SHA", ""))
    encoded = json.dumps(selected, separators=(",", ":"))
    if args.plan:
        args.plan.parent.mkdir(parents=True, exist_ok=True)
        args.plan.write_text(encoded + "\n", encoding="utf-8", newline="\n")
    print(encoded)
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with Path(output).open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(f"light={str(selected['light']).lower()}\n")
            stream.write(f"mode={selected['mode']}\nprofile={selected['profile']}\nversion={VERSION}\nplan={encoded}\n")


if __name__ == "__main__":
    main()
