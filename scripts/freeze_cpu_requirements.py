"""Generate CPU variants of runtime requirements files (drop +cuXXX local versions).

构建期调用（build-windows.ps1 / build-appimage.sh / release.yml macOS job）：
从 uv export / uv pip compile 生成的主清单构建 requirements-{key}-cpu.txt，
随包分发；无 NVIDIA GPU 的机器由 maw.runtimes.base 在首装时直接使用，
避免先安装完整 cu130 wheel 与 nvidia-* 依赖再覆盖。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
# 含 cuXXX local version 的清单需要 CPU 变体（ocr 无 Torch 依赖，不需要）。
KEYS = ("local", "moss")


def main() -> int:
    missing = [
        f"requirements-{key}.txt"
        for key in KEYS
        if not (BUILD / f"requirements-{key}.txt").is_file()
    ]
    if missing:
        print(
            f"缺少主清单：{', '.join(missing)}（先运行 uv export / uv pip compile）",
            file=sys.stderr,
        )
        return 1
    for key in KEYS:
        source = BUILD / f"requirements-{key}.txt"
        target = BUILD / f"requirements-{key}-cpu.txt"
        text = source.read_text(encoding="utf-8")
        target.write_text(
            re.sub(r"\+cu\d+(?![A-Za-z0-9])", "", text),
            encoding="utf-8",
            newline="\n",
        )
        print(f"生成 {target.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())