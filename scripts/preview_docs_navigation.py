"""Copy the fixed docs navigation fixture into an ignored browser preview."""
from pathlib import Path
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tests/fixtures/docs-navigation/docs"
OUTPUT = ROOT / ".artifacts/docs-navigation-preview"


def main() -> int:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    preview = Path(tempfile.mkdtemp(prefix="preview-", dir=OUTPUT))
    shutil.copytree(SOURCE, preview, dirs_exist_ok=True)
    print(f"Preview: {preview / '导航 入口.html'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
