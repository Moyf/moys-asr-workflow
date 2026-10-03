"""Refresh the explicit manifest tuple; payload checks read source content directly."""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import edit  # noqa: E402

TEST = ROOT / "tests" / "test_editor_assets.py"
manifest = edit.read_editor_script_manifest()
entries = "".join(f'                "{name}",\n' for name in manifest)
source = TEST.read_text(encoding="utf-8")
updated, count = re.subn(
    r'(            edit\.read_editor_script_manifest\(\),\n            \(\n).*?(            \),)',
    lambda match: match[1] + entries + match[2],
    source,
    count=1,
    flags=re.S,
)
if count != 1:
    raise ValueError("Expected one explicit manifest contract tuple")
TEST.write_text(updated, encoding="utf-8", newline="\n")
print(f"契约重建完成：{len(manifest)} 个文件")
