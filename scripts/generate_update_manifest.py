"""Generate the small, hash-addressed asset manifest shipped with a Release."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from pathlib import Path


VERSION_RE = re.compile(
    r"^v?([0-9]+\.[0-9]+\.[0-9]+(?:(?:[-+][0-9A-Za-z.-]+)|(?:\.(?:dev|post)\d*))?)$"
)
PRERELEASE_RE = re.compile(
    r"(?i)(?:^|[.-])(?:a(?:lpha)?|b(?:eta)?|rc|pre(?:view)?|dev)[.-]?\d*"
    r"|\d(?:a(?:lpha)?|b(?:eta)?|rc|pre(?:view)?|dev)\d*"
)


def _asset_metadata(name: str) -> tuple[str, str, str, str, str] | None:
    if name == "update-manifest.json":
        return None
    patterns = (
        (r"^MAW-Setup-Windows-x64-v.+\.exe$", "windows", "x64", "installer", "standard"),
        (r"^MAW-Windows-x64-v.+\.zip$", "windows", "x64", "portable", "standard"),
        (r"^MAW-lite-Windows-x64-v.+\.zip$", "windows", "x64", "portable", "lite"),
        (r"^MAW-macOS-arm64-v.+\.zip$", "macos", "arm64", "portable", "standard"),
        (r"^MAW-lite-macOS-arm64-v.+\.zip$", "macos", "arm64", "portable", "lite"),
        (r"^MAW-Linux-x86_64-v.+\.AppImage$", "linux", "x64", "portable", "standard"),
    )
    for pattern, platform, arch, kind, flavor in patterns:
        if re.fullmatch(pattern, name):
            return platform, arch, kind, flavor
    return None


def build_manifest(root: Path, tag: str) -> dict[str, object]:
    match = VERSION_RE.fullmatch(tag.strip())
    if not match:
        raise ValueError(f"invalid release tag: {tag!r}")
    version = match.group(1)
    # Keep this release-job helper stdlib-only.  The updater itself uses
    # packaging for ordering; the manifest only needs to classify the common
    # PEP 440 prerelease spellings without installing project dependencies.
    # Ignore local build metadata (``+...``), which is not a prerelease in
    # PEP 440, while recognizing both repository spellings such as
    # ``1.5.0-beta.10`` and compact forms such as ``1.5.0b10`` / ``.dev1``.
    is_prerelease = bool(PRERELEASE_RE.search(version.split("+", 1)[0]))
    # Only include the exact filenames for this tag.  A staging directory can
    # contain artifacts from another build (for example v1.5.0 and
    # v1.5.0-beta.1); substring matching would silently publish the wrong one.
    expected_names = {
        f"MAW-Setup-Windows-x64-v{version}.exe",
        f"MAW-Windows-x64-v{version}.zip",
        f"MAW-lite-Windows-x64-v{version}.zip",
        f"MAW-macOS-arm64-v{version}.zip",
        f"MAW-lite-macOS-arm64-v{version}.zip",
        f"MAW-Linux-x86_64-v{version}.AppImage",
    }
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if path.name not in expected_names:
            continue
        files.append(path)
    if not files:
        raise ValueError(f"no MAW release assets found under {root}")
    assets: list[dict[str, object]] = []
    seen_names: set[str] = set()
    for path in sorted(files, key=lambda item: item.name):
        if path.name in seen_names:
            raise ValueError(f"duplicate release asset filename: {path.name}")
        seen_names.add(path.name)
        platform, arch, kind, flavor = _asset_metadata(path.name) or ("", "", "", "")
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 20), b""):
                digest.update(chunk)
        assets.append(
            {
                "name": path.name,
                "platform": platform,
                "arch": arch,
                "kind": kind,
                "type": kind,
                "flavor": flavor,
                "size": path.stat().st_size,
                "sha256": digest.hexdigest(),
            }
        )
    return {
        "schemaVersion": 1,
        "version": version,
        "tag": f"v{version}",
        "prerelease": is_prerelease,
        "assets": assets,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="downloaded Release artifact directory")
    parser.add_argument("--tag", required=True, help="Release tag, for example v1.5.0")
    parser.add_argument("--output", type=Path, default=None)
    args = parser.parse_args()
    output = args.output or args.root / "update-manifest.json"
    manifest = build_manifest(args.root, args.tag)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Generated {output} with {len(manifest['assets'])} assets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
