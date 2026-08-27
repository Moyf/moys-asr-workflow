"""Generate CPU variants of runtime requirements files.

构建期调用（build-windows.ps1 / build-appimage.sh / release.yml macOS job）：
从 uv export / uv pip compile 生成的主清单构建 requirements-{key}-cpu.txt，
随包分发；无 NVIDIA GPU 的机器由 maw.runtimes.base 在首装时直接使用，
避免先安装完整 cu130 wheel 与 nvidia-* 依赖再覆盖。

CPU 变体相对主清单的差异（全部服务于"pip 必须能装通"）：
- 去掉 ``+cuXXX`` 本地版本号，让 pip 从普通镜像索引解析 CPU wheel；
- 整块剔除 cu 构建专属的 ``nvidia-*`` 依赖（CPU wheel 不依赖它们）；
- 删除 ``--hash=...`` 续行：哈希锁属于 cu130 wheel，对 CPU wheel 必然
  校验失败。完整性由版本 pin 与 HTTPS 镜像承担（与 requirements-moss.txt
  的现状一致；如需恢复强校验，应在 CI 联网取 CPU wheel 真实哈希）。
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / "build"
# 含 cuXXX local version 的清单需要 CPU 变体（ocr 无 Torch 依赖，不需要）。
KEYS = ("local", "moss")

_CUDA_LOCAL_VERSION = re.compile(r"\+cu\d+(?![A-Za-z0-9])")
_REQUIREMENT_NAME = re.compile(r"^([A-Za-z0-9][A-Za-z0-9_.-]*)")
_HASH_CONTINUATION = re.compile(r"^\s*--hash=")


def freeze_cpu_requirements_text(text: str) -> str:
    """把主清单文本变换为可安装的 CPU 版清单文本。

    输入必须符合 uv export / uv pip compile 的 requirements 布局：顶格行是
    requirement 首行或注释，缩进行是前一个 requirement 的续行（``--hash=``
    或 ``# via ...`` 注释）。任何不符合该结构的输入都抛 ValueError 拒绝
    处理，避免静默生成损坏清单。
    """
    output: list[str] = []
    statement: str | None = None
    continuations: list[str] = []

    def flush() -> None:
        nonlocal statement, continuations
        if statement is None:
            return
        try:
            _emit_cpu_block(output, statement, continuations)
        finally:
            statement = None
            continuations = []

    for raw_line in text.splitlines():
        if not raw_line.strip():
            flush()
            output.append("")
            continue
        if raw_line[0].isspace():
            if statement is None:
                raise ValueError(f"清单以缩进行开头，块结构无法解析：{raw_line!r}")
            continuations.append(raw_line)
            continue
        flush()
        if raw_line.startswith("#"):
            output.append(raw_line)
            continue
        statement = raw_line.rstrip()
    flush()
    while output and output[-1] == "":
        output.pop()
    return "\n".join(output) + "\n"


def _emit_cpu_block(
    output: list[str], statement: str, continuations: list[str]
) -> None:
    """按 CPU 变体规则输出（或跳过）一个 requirement 块。"""
    name_match = _REQUIREMENT_NAME.match(statement)
    if name_match is None:
        raise ValueError(f"无法识别 requirement 行：{statement!r}")
    if name_match.group(1).casefold().startswith("nvidia-"):
        # nvidia-* 只服务于 cu130 构建（且多为 Linux marker）；CPU wheel 不依赖。
        return
    body = re.sub(r"\s*\\\s*$", "", statement).rstrip()
    block = [_CUDA_LOCAL_VERSION.sub("", body)]
    for line in continuations:
        if _HASH_CONTINUATION.match(line):
            continue
        if not line.lstrip().startswith("#"):
            raise ValueError(
                f"{block[0]!r} 出现未预期的非注释续行"
                f"（请检查上游 uv export / uv pip compile 格式）：{line!r}"
            )
        block.append(_CUDA_LOCAL_VERSION.sub("", line.rstrip()))
    output.extend(block)


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
        frozen = freeze_cpu_requirements_text(source.read_text(encoding="utf-8"))
        target.write_text(frozen, encoding="utf-8", newline="\n")
        print(f"生成 {target.name}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
