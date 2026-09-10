# 从当前 manifest + 模块内容重建 test_editor_assets.py 的
# 清单元组与 payload markers 两个字面量块（每次拆分批次后运行）。
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
TEST = ROOT / "tests" / "test_editor_assets.py"

manifest = [
    line.split("#", 1)[0].strip()
    for line in (WEB / "editor-scripts.txt").read_text(encoding="utf-8").splitlines()
    if line.split("#", 1)[0].strip()
]

FIRST_MARKERS = {
    "editor-boot.js": "const DATA = __DATA_JSON__;",
    "editor-runtime.js": "// Shared frontend runtime registry.",
    "gap-remove-core.js": "// Shared gap-remove data and playback helpers",
    "editor-utils.js": "// Pure editor helpers kept separate",
    "editor-i18n.js": "(function initMaweI18n(global) {",
    "waveform.js": "// Framework-neutral waveform runtime.",
    "editor-onboarding.js": "const helpOnboardingButton = document.getElementById('help-onboarding');",
}

def marker_for(name: str) -> str:
    if name in FIRST_MARKERS:
        return FIRST_MARKERS[name]
    if name == "editor.js":
        # editor.js 首个非注释非空行（启动区错误监听器）
        for line in (WEB / name).read_text(encoding="utf-8").splitlines():
            s = line.strip()
            if s and not s.startswith("//"):
                return s
        raise ValueError("editor.js 为空？")
    text = (WEB / name).read_text(encoding="utf-8")
    m = re.search(r"\(function (init\w+)\(global\) \{", text)
    if not m:
        raise ValueError(f"{name} 缺少 IIFE init 标记")
    return f"(function {m.group(1)}(global) {{"

entries = "".join(f'                "{name}",\n' for name in manifest)
markers = "".join(f'            {repr(marker_for(name))},\n' for name in manifest)

t = TEST.read_text(encoding="utf-8")

t = re.sub(
    r"            edit\.read_editor_script_manifest\(\),\n            \(\n(?:                \"[^\"]+\",\n)+            \),",
    "            edit.read_editor_script_manifest(),\n            (\n" + entries + "            ),",
    t, count=1,
)

t = re.sub(
    r"        markers = \(\n(?:            .+\n)+?        \)\n        for asset_name",
    "        markers = (\n" + markers + "        )\n        for asset_name",
    t, count=1,
)

os.remove(TEST)
TEST.write_text(t, encoding="utf-8", newline="\n")
print(f"契约重建完成：{len(manifest)} 个文件")
