"""Verify that packaged ESM bundles and every recorded source file agree."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify(web_root: Path) -> list[str]:
    results = []
    for name in ("editor", "launcher"):
        bundle_path = web_root / name / "boot" / f"{name}-bundle.js"
        metadata_path = web_root / name / "boot" / f"{name}-bundle.meta.json"
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if sha256(bundle_path) != metadata["bundleHash"]:
            raise ValueError(f"{bundle_path}: bundle hash does not match metadata")
        inputs = metadata["inputs"]
        if not set(metadata["sourceFiles"]) <= set(inputs):
            raise ValueError(f"{metadata_path}: manifest sources are missing from inputs")
        for relative_path, expected_hash in inputs.items():
            source_path = Path(relative_path)
            if source_path.is_absolute() or ".." in source_path.parts:
                raise ValueError(f"{metadata_path}: unsafe input path {relative_path!r}")
            packaged_source = web_root / source_path
            if sha256(packaged_source) != expected_hash:
                raise ValueError(f"{packaged_source}: source hash does not match metadata")
        results.append(f"{name}: bundle and {len(inputs)} packaged source hashes match")
    return results


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("web_root", type=Path, help="packaged web directory")
    args = parser.parse_args()
    for result in verify(args.web_root):
        print(f"OK: {result}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
