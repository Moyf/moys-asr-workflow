"""Build one consistent GitHub Release body from the matching changelog section."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def extract_release_section(changelog: str, tag: str) -> str:
    """Return the changelog section for *tag*, excluding later releases."""
    normalized_tag = tag.strip()
    if not normalized_tag.startswith("v"):
        raise ValueError(f"release tag must start with v: {tag!r}")
    version = normalized_tag[1:]
    pattern = re.compile(
        r"(?ms)^## \[%s\][^\r\n]*\r?\n.*?(?=^## \[|\Z)" % re.escape(version)
    )
    match = pattern.search(changelog)
    if not match:
        raise ValueError(f"CHANGELOG.md does not contain a release section for {version}.")
    return match.group(0).strip()


def build_release_notes(changelog: str, tag: str) -> str:
    """Build the shared download and usage guide followed by release notes."""
    guide = """## 下载哪个版本？

**如果你不知道 `FFMpeg` 是什么** ： 根据自己的平台，下载 `MAWxFF` 开头的版本。它内置了我们需要的视频处理模块。
**如果你本机环境装有 `ffmpeg`** ： 可以选择下载体积更小的纯 `MAW` 版本。

## 如何使用

1. 下载安装包后解压
2. 双击对应的 `MAW` 可执行文件，打开启动器
3. 在启动器中，可以执行字幕转写、生成工程等操作
4. 完成后，启动字幕编辑器，进行字幕精修

详细文档参阅：[完整使用文档](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/WORKFLOW.md)
遇到问题可以参见：[常见问题](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/FAQ.md)
"""
    return guide.strip() + "\n\n" + extract_release_section(changelog, tag) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="release tag, for example v1.4.0-beta.6")
    parser.add_argument("--output", type=Path, required=True, help="output Markdown path")
    args = parser.parse_args()

    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    notes = build_release_notes(changelog, args.tag)
    args.output.write_bytes(notes.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
