"""Map unavailable preparation to its concrete consumers."""
from __future__ import annotations

from pathlib import Path
import re

if __package__:
    from .local_test_impact import select_packs
    from .test_impact_graph import node_uses_packages
else:
    from local_test_impact import select_packs
    from test_impact_graph import node_uses_packages

PREPARATIONS = ("node-runtime", "node-dependencies", "python-dependencies", "ffmpeg", "chromium",
                "build", "build-launcher", "website")
_NODE_PACKAGES = {"@playwright/test", "acorn", "acorn-walk", "esbuild", "playwright", "typescript"}


def target_path(target):
    path = target.replace("\\", "/")
    if path.startswith("tests/") and path.endswith((".py", ".mjs")):
        return path
    if path.startswith("tests.test_"):
        return f'tests/{path.split(".")[1]}.py'
    return None


def test_requirements(path, root):
    flags = select_packs([path])["preparation"]
    needed = set()
    if flags.get("python_dependencies"):
        needed.add("python-dependencies")
    if flags.get("real_media"):
        needed.add("ffmpeg")
    if flags.get("node_browser"):
        needed.update(("node-dependencies", "chromium"))
    if flags.get("editor_bundle"):
        needed.add("build")
    if flags.get("launcher_bundle"):
        needed.add("build-launcher")
    try:
        source = (root / path).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return needed
    # These are actual runner inputs that also have no equivalent flag in the
    # impact plan. Unknown dynamic dependencies remain visible at execution.
    if path.endswith(".mjs") and (
        node_uses_packages(root, path, _NODE_PACKAGES)
        or any(fragment in source for fragment in ("scripts/build-editor.mjs", "scripts/build-launcher.mjs"))
        or path == "tests/test_type_gate.mjs"
    ):
        needed.add("node-dependencies")
    if path.endswith(".py") and re.search(r'''subprocess\.\w+\(\s*\[["']node["']''', source):
        needed.add("node-runtime")
    if path == "tests/e2e/editor-entry-retirement.spec.mjs":
        needed.update(("website", "website-build"))
    return needed


def command_requirements(name, command):
    needed = set()
    program = Path(command[0]).stem
    if program in {"node", "pnpm"}:
        needed.add("node-runtime")
    if name in {"build", "build-launcher", "typecheck"}:
        needed.add("node-dependencies")
    if name in {"website-build", "website-check"}:
        needed.update(("website", "website-docs", "website-releases"))
    if name == "python-lint":
        needed.add("python-dependencies")
    if name in {"browser-regressions", "editor-http-smoke"}:
        needed.update(("node-dependencies", "chromium"))
    return needed


def partition_command(name, command, unavailable, root, requirements):
    """Retain the original batch on success and narrow it only after failed prep."""
    unavailable = unavailable & {*PREPARATIONS, "website-docs", "website-releases", "website-build"}
    if not unavailable:
        return command, {}, []
    required = command_requirements(name, command) & unavailable
    if required:
        return None, {name: sorted(required)}, []
    blocked = {}
    if "--pack" in command:
        pack = command[command.index("--pack") + 1]
        if pack in {"media", "long-media"} and "ffmpeg" in unavailable:
            return None, {name: ["ffmpeg"]}, []
        if not unavailable & {"python-dependencies", "ffmpeg", "build", "build-launcher", "node-runtime"}:
            return command, {}, []
        available = []
        for file in sorted((root / "tests").rglob("test_*.py")):
            path = file.relative_to(root).as_posix()
            required = requirements(path) & unavailable
            if required:
                blocked[path] = sorted(required)
            else:
                available.append(path)
        if blocked:
            # The selected discovery is blocked. Concrete files can supply partial
            # evidence without changing the selected pack's normal discovery.
            return None, blocked, available
        return command, {}, []

    browser = name in {"browser-regressions", "editor-http-smoke"}
    # Filtering a multi-shard Playwright command would redistribute the cases.
    # Its common prerequisites still apply; its original shard runs as selected.
    if browser and any(arg.startswith("--shard=") and arg != "--shard=1/1" for arg in command):
        return command, {}, []
    targets = {arg: path for arg in command if (path := target_path(arg))}
    if browser and not targets:
        targets = {path.relative_to(root).as_posix(): path.relative_to(root).as_posix()
                   for path in sorted((root / "tests/e2e").rglob("*.spec.mjs"))}
        command = [*command, *targets]
    for arg, path in targets.items():
        required = requirements(path) & unavailable
        if required:
            blocked[arg] = sorted(required)
    if blocked.keys() == targets.keys() and targets:
        return None, blocked, []
    return [arg for arg in command if arg not in blocked], blocked, []
