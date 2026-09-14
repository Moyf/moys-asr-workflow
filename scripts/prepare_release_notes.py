"""Build one consistent GitHub Release body from the matching changelog section."""

from __future__ import annotations

import argparse
import re
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
REPO = "Moyf/moys-asr-workflow"
PLATFORMS = ("windows", "macos", "linux")
FAILED_MARK = "打包失败 😭"


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


def asset_download_url(tag: str, asset: str) -> str:
    """Return the deterministic release-asset URL; it resolves once CI uploads the file."""
    return f"https://github.com/{REPO}/releases/download/{tag}/{asset}"


def _platform_lines(
    tag: str,
    failed_platforms: frozenset[str],
    platform: str,
    label: str,
    assets: list[tuple[str, str]],
) -> list[str]:
    """Render one platform block; a failed platform gets a failure mark instead of links."""
    lines = [f"- **{label}**"]
    if platform in failed_platforms:
        lines.append(f"    - {FAILED_MARK}")
        return lines
    for purpose, asset in assets:
        lines.append(f"    - {purpose}：[{asset}]({asset_download_url(tag, asset)})")
    return lines


def build_download_section(tag: str, failed_platforms: frozenset[str]) -> str:
    """Build the per-platform download list; asset names mirror the CI workflow."""
    sections = [
        ("windows", "Windows 🪟", [
            ("默认下载", f"MAW-Windows-x64-{tag}.zip"),
            ("装有 ffmpeg 时，可下载轻量版", f"MAW-lite-Windows-x64-{tag}.zip"),
        ]),
        ("macos", "macOS 🍎", [
            ("默认下载", f"MAW-macOS-arm64-{tag}.zip"),
            ("装有 ffmpeg 时，可下载轻量版", f"MAW-lite-macOS-arm64-{tag}.zip"),
        ]),
        ("linux", "Linux 🐧", [
            ("默认下载", f"MAW-Linux-x86_64-{tag}.AppImage"),
        ]),
    ]
    lines = ["## 下载哪个版本？", ""]
    for platform, label, assets in sections:
        lines += _platform_lines(tag, failed_platforms, platform, label, assets)
    return "\n".join(lines)


USAGE_SECTION = """## 如何使用

1. 下载安装包后解压
2. 双击对应的 `MAW` 可执行文件，打开启动器
3. 在启动器中，可以执行字幕转写、生成工程等操作
4. 完成后，启动字幕编辑器，进行字幕精修

详细文档参阅：[完整使用文档](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/WORKFLOW.md)
遇到问题可以参见：[常见问题](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/FAQ.md)"""


def build_release_notes(
    changelog: str,
    tag: str,
    failed_platforms: frozenset[str] = frozenset(),
) -> str:
    """Build the shared download and usage guide followed by release notes."""
    guide = build_download_section(tag, failed_platforms) + "\n\n" + USAGE_SECTION
    return guide + "\n\n" + extract_release_section(changelog, tag) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True, help="release tag, for example v1.4.0-beta.6")
    parser.add_argument("--output", type=Path, required=True, help="output Markdown path")
    parser.add_argument(
        "--failed",
        default="",
        help="comma-separated platforms whose packaging failed, for example macos,linux",
    )
    args = parser.parse_args()

    failed = {part.strip() for part in args.failed.split(",") if part.strip()}
    unknown = failed - set(PLATFORMS)
    if unknown:
        parser.error(
            f"unknown platform(s): {', '.join(sorted(unknown))}; known: {', '.join(PLATFORMS)}"
        )

    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    notes = build_release_notes(changelog, args.tag, failed_platforms=frozenset(failed))
    args.output.write_bytes(notes.encode("utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
