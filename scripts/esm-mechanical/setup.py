"""Create disposable, tracked-HEAD research copies; never overwrite a checkout."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination", help="New directory inside this repository's .worktrees")
    parser.add_argument("--dependencies", required=True, help="Existing node_modules containing esbuild and Playwright")
    args = parser.parse_args()
    source = Path(__file__).resolve().parents[2]
    destination = Path(args.destination).resolve()
    dependencies = Path(args.dependencies).resolve()
    workspace = (source / ".worktrees").resolve()
    if workspace not in destination.parents or destination.exists():
        raise SystemExit("Destination must be a new directory inside .worktrees")
    for package in ("esbuild", "acorn", "eslint-scope", "@playwright/test", "typescript"):
        if not (dependencies / package / "package.json").is_file():
            raise SystemExit(f"Missing dependency: {package}")
    ref = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    entries = subprocess.check_output(["git", "ls-tree", "-rz", "--name-only", ref], cwd=source).split(b"\0")
    destination.mkdir(parents=True)
    for name in ("baseline", "naive", "full"):
        target = destination / name
        target.mkdir()
        for entry in entries:
            if not entry:
                continue
            relative = entry.decode("utf-8")
            if Path(relative).name == ".env":
                continue
            output = target / relative
            output.parent.mkdir(parents=True, exist_ok=True)
            content = subprocess.check_output(["git", "show", f"{ref}:{relative}"], cwd=source)
            output.write_bytes(content)
        shutil.copytree(source / "scripts/esm-mechanical", target / "scripts/esm-mechanical", dirs_exist_ok=True)
        marker = {"purpose": "esm-mechanical-research", "baseline": ref}
        (target / ".esm-mechanical-sandbox.json").write_text(json.dumps(marker) + "\n", encoding="utf-8", newline="\n")
        if os.name == "nt":
            env = dict(os.environ, MAW_RESEARCH_LINK=str(target / "node_modules"), MAW_RESEARCH_DEPS=str(dependencies))
            subprocess.run(["powershell", "-NoProfile", "-Command",
                            "New-Item -ItemType Junction -Path $env:MAW_RESEARCH_LINK -Value $env:MAW_RESEARCH_DEPS | Out-Null"],
                           env=env, check=True)
        else:
            (target / "node_modules").symlink_to(dependencies, target_is_directory=True)
    print(json.dumps({"baseline": ref, "copies": ["baseline", "naive", "full"]}))


if __name__ == "__main__":
    main()
