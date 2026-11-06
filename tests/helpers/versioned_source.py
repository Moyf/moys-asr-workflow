"""Small source snapshot for real-version subprocess tests, without user config."""

from pathlib import Path
import argparse
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]


def create_versioned_source(output: Path, *, synchronize: bool = True) -> Path:
    output.mkdir(parents=True, exist_ok=True)
    for source in ROOT.glob("*.py"):
        shutil.copy2(source, output / source.name)
    for directory in ("maw", "server-editor", "scripts"):
        for source in (ROOT / directory).rglob("*.py"):
            if "__pycache__" in source.parts:
                continue
            target = output / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
    shutil.copytree(ROOT / "web", output / "web", ignore=shutil.ignore_patterns(".env*", "__pycache__"))
    spec = Path("scripts/packaging/MAW.spec")
    (output / spec).parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / spec, output / spec)
    for name in ("package.json", "pnpm-lock.yaml", "scripts/build-editor.mjs", "scripts/build-launcher.mjs"):
        shutil.copy2(ROOT / name, output / name)
    # Maintained browser probes use the same owned-process lifecycle helpers.
    for name in ("helpers.mjs", "server-process.mjs", "output-tail.mjs", "windows-server-job.ps1"):
        target = output / "tests" / "e2e" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / "tests" / "e2e" / name, target)
    (output / "pyproject.toml").write_text('[project]\nversion = "2.0.0-beta.1"\n', encoding="utf-8")
    if synchronize:
        subprocess.run([sys.executable, "scripts/sync_launcher_version.py", "--write"],
                       cwd=output, check=True, capture_output=True, text=True)
    return output


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    create_versioned_source(args.output)
