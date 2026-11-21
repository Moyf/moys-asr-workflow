"""Blocking v2 selection. Unknown changes expand admission, never full inspection."""
from __future__ import annotations

import os
import argparse
import json
from pathlib import Path
import re
import subprocess

VERSION = 2
PROFILES = ("light", "stable")
CHECKS = ("docs", "website", "release", "tools", "build", "data", "editor", "launcher", "runtime", "ci")
WEBSITE_INPUT_EXCEPTIONS = {
    'docs/INDEX.md', 'docs/engineering/JSON_SCHEMA.md', 'docs/engineering/LLM_POSTPROCESS_PROTOCOL.md',
    'docs/engineering/MOSE.md', 'docs/engineering/DEVELOPMENT.md',
    'docs/logs/unversioned/2026-07-28/ASR_PROVIDER_RESEARCH.md',
}
# Only these implementation leaves have a narrower consumer boundary. Anything
# new (including new tests) takes the entire admitted set until reviewed.
DOMAIN_PATHS = {
    "editor": {"web/editor/io/editor-project-save.js", "web/editor/io/editor-export-srt.js",
               "web/editor/cues/editor-word-timing.js"},
    "launcher": {"web/launcher/local/launcher-local-models.js", "web/launcher/server/launcher-server-monitor.js",
                 "web/launcher/server/launcher-media-server.js"},
}
SHA = re.compile(r"[0-9a-f]{40}")

# Scoped browser admission: real autosave/recovery journeys block only when
# the storage-save implementation or the journey spec itself changes. This is
# deliberately narrower than DOMAIN_PATHS; unrelated editor leaves never pay
# the browser cost, and untrusted/unknown diffs stay browser-free.
RECOVERY_E2E_SOURCES = frozenset({
    'web/editor/io/editor-project-save.js',
    'tests/e2e/editor-save-recovery.spec.mjs',
})


def recovery_e2e_for(paths: list[str]) -> bool:
    return any(path in RECOVERY_E2E_SOURCES for path in paths)


def valid_paths(paths: list[str]) -> bool:
    return bool(paths) and all(isinstance(p, str) and p and not p.startswith("/")
        and "\\" not in p and ":" not in p and not any(ord(c) < 32 or ord(c) == 127 for c in p)
        and not any(part in {"", ".", ".."} for part in p.split("/")) for p in paths)


def consumers(path: str) -> set[str] | None:
    # Program inputs/fixtures must win over generic explanatory Markdown.
    if any(part in {"fixtures", "data"} for part in path.split("/")):
        return None
    if path.endswith('.checklist.md'):
        return {'docs', 'tools'}
    if path == 'docs/user/FAQ-常见问题.txt':
        return None  # Actual packaged runtime input, not a website guide.
    if path in WEBSITE_INPUT_EXCEPTIONS:
        return {'docs', 'website'}
    if path == "CHANGELOG.md" or path.startswith("docs/releases/"):
        return {"docs", "release"}
    if path.startswith("tools/") and path.endswith(".md"):
        return {"docs", "tools"}
    if path == "README.md" or path.startswith(("docs/user/", "docs/assets/", "website/")):
        return {"docs", "website"}
    if path.endswith(".md") and (path.startswith(("docs/engineering/", "docs/plans/", "docs/logs/"))
                               or path in {"AGENTS.md", "docs/AGENTS.md", "docs/README.md", "docs/INDEX.md"}):
        return {"docs"}
    for domain, registered in DOMAIN_PATHS.items():
        if path in registered:
            return {"build", "data", "editor", "runtime", domain}
    return None


def checks_for(paths: list[str]) -> list[str]:
    if not valid_paths(paths):
        return list(CHECKS)
    selected = set()
    for path in paths:
        owned = consumers(path)
        if owned is None:
            return list(CHECKS)
        selected.update(owned)
    return [check for check in CHECKS if check in selected]


def classify(paths: list[str]) -> tuple[str, str]:
    selected = checks_for(paths)
    if set(selected) <= {"docs", "website", "release", "tools"}:
        return "light", "documentation and declared consumers only"
    return "stable", "admitted code checks; unknown/shared inputs expand to all admitted checks"


def preview_for(paths: list[str]) -> bool:
    return any(p.startswith(('maw/', 'server-editor/', 'web/launcher/', 'web/editor/boot/',
                              'web/shared/host/', 'scripts/packaging/'))
               or p in {'maw_gui.py', 'edit.py', 'pyproject.toml', 'uv.lock', 'package.json', 'pnpm-lock.yaml',
                        'web/editor-scripts.txt', 'web/launcher-scripts.txt', 'web/editor-modules.json',
                         'web/editor-template.html', 'docs/user/FAQ-常见问题.txt'}
               or p.startswith('scripts/build-') for p in paths)


def plan(profile: str, reason: str, *, base: str = "", head: str = "", trusted: bool = False,
         checks: list[str] | None = None, preview: bool | None = None, paths: list[str] | None = None) -> dict:
    if profile not in PROFILES:
        raise ValueError("unknown CI profile")
    if paths is None:
        paths = (["docs/plans/ci-scope.md"] if profile == "light" else ["unknown.py"]) if trusted else []
    if preview is None:
        # Unavailable scope expands blocking admission, not the old heavy
        # preview. Manual dispatch can explicitly request that advisory work.
        preview = preview_for(paths) if trusted else False
    return {"version": VERSION, "namespace": "blocking-v2", "mode": profile, "profile": profile,
            "light": profile == "light", "reason": reason,
            "base": base, "head": head, "trusted_diff": trusted,
            "checks": checks if checks is not None else (["docs"] if profile == "light" else list(CHECKS)),
            "preview": preview, "paths": paths}


def select(event: str, base: str, cwd: Path | None = None, *, before: str = "", after: str = "") -> dict:
    def git(*args: str) -> bytes:
        return subprocess.check_output(["git", *args], cwd=cwd, stderr=subprocess.PIPE)
    head = ""
    try:
        head = git("rev-parse", "HEAD").decode("ascii").strip()
        if not SHA.fullmatch(head):
            raise ValueError("invalid HEAD")
        if after and (not SHA.fullmatch(after) or head != after):
            raise ValueError("event after differs from HEAD")
        if event == "pull_request":
            if not SHA.fullmatch(base) or git("rev-parse", "HEAD^1").decode("ascii").strip() != base:
                raise ValueError("invalid PR merge base")
        elif event == "push":
            base = before
            if not after or not SHA.fullmatch(base) or base == "0" * 40:
                raise ValueError("invalid push before/after")
        else:
            raise ValueError("event has no trusted diff")
        if git("rev-parse", "--is-shallow-repository").strip() != b"false":
            raise ValueError("shallow history")
        git("merge-base", "--is-ancestor", base, head)
        # --no-renames exposes BOTH old and new names. Deleted known leaves are
        # safe only when every changed name is registered in the same domain.
        raw = git("diff", "--name-only", "--no-renames", "-z", base, "HEAD")
        if raw and not raw.endswith(b"\0"):
            raise ValueError("unterminated diff")
        paths = [p.decode("utf-8") for p in raw.split(b"\0")[:-1]]
        if not valid_paths(paths):
            raise ValueError('empty or malformed paths')
        profile, reason = classify(paths)
        selected = checks_for(paths)
        # Packaging/runtime/front-end payload changes affect a frozen preview.
        # Pure editor leaves and documentation consumers do not request a
        # packaged preview. Unknown scope requires manual preview review.
        preview = preview_for(paths)
        return plan(profile, reason, base=base, head=head, trusted=True, checks=selected, preview=preview,
                    paths=sorted(paths))
    except (OSError, subprocess.SubprocessError, UnicodeError, ValueError):
        return plan("stable", "WARNING: unavailable/untrusted diff; all admitted checks, manual risk review required", head=head)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", type=Path)
    args = parser.parse_args()
    selected = select(os.environ.get("GITHUB_EVENT_NAME", ""), os.environ.get("PR_BASE_SHA", ""),
                      before=os.environ.get("PUSH_BEFORE_SHA", ""), after=os.environ.get("GITHUB_SHA", ""))
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
            stream.write(f"preview={str(selected['preview']).lower()}\n")
            stream.write("matrix=" + json.dumps({"include": [{"check": c} for c in selected["checks"]]}) + "\n")


if __name__ == "__main__":
    main()
