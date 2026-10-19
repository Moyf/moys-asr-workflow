"""Generate/check version documents, then compose the GitHub Release body."""

from __future__ import annotations

import argparse
from datetime import date
import hashlib
import json
import posixpath
import re
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit, urlunsplit


ROOT = Path(__file__).resolve().parents[1]
REPO = "Moyf/moys-asr-workflow"
PLATFORMS = ("windows", "macos", "linux")
FAILED_MARK = "打包失败 😭"
VERSION = re.compile(r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?")
BASE_MARK = re.compile(r"^<!-- release-base: ([^\s]+) -->$", re.M)
DOCUMENT_PREFIX = "<!-- maw-release "


def parse_tag(tag: str) -> re.Match:
    match = VERSION.fullmatch(tag)
    if not match or (match[4] and any(part.isdigit() and len(part) > 1 and part[0] == "0" for part in match[4].split("."))):
        raise ValueError(f"invalid release tag: {tag!r}; expected v2.0.0-beta.1")
    return match


def extract_release_section(changelog: str, tag: str) -> str:
    """Return the changelog section for *tag*, excluding later releases."""
    normalized_tag = tag.strip()
    if not normalized_tag.startswith("v"):
        raise ValueError(f"release tag must start with v: {tag!r}")
    version = normalized_tag[1:]
    pattern = re.compile(
        r"(?ms)^## \[%s\][^\r\n]*\r?\n.*?(?=^## \[|\Z)" % re.escape(version)
    )
    matches = list(pattern.finditer(changelog.replace("\r\n", "\n")))
    if not matches:
        raise ValueError(f"CHANGELOG.md does not contain a release section for {version}.")
    if len(matches) != 1:
        raise ValueError(f"duplicate CHANGELOG.md release section for {version}.")
    return matches[0].group(0).strip()


def pinned_link(target: str, tag: str, image: bool = False) -> str:
    """Resolve repository-relative destinations from the root CHANGELOG at a tag."""
    parts = urlsplit(target)
    if parts.scheme or parts.netloc or target.startswith("#"):
        return target
    path = posixpath.normpath(unquote(parts.path).lstrip("/"))
    if path == ".." or path.startswith("../") or "\\" in path:
        raise ValueError(f"link outside the repository: {target!r}")
    image = image or Path(path).suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}
    base = f"https://raw.githubusercontent.com/{REPO}/{tag}/" if image else f"https://github.com/{REPO}/blob/{tag}/"
    return base + urlunsplit(("", "", quote(path, safe="/"), parts.query, parts.fragment))


def pin_repo_links(markdown: str, tag: str) -> str:
    """Convert inline/reference/HTML links, leaving code examples untouched."""
    lines, fence = [], None
    for line in markdown.splitlines():
        marker = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            lines.append(line)
            continue
        if marker:
            fence = marker[1]
            lines.append(line)
            continue
        # Preserve offsets so destinations can be replaced without touching inline code.
        visible = re.sub(r"(`+).*?\1", lambda m: " " * len(m[0]), line)
        replacements = []
        cursor = 0
        while (start := visible.find("](", cursor)) >= 0:
            begin = start + 2
            if begin < len(line) and line[begin] == "<":
                end = line.find(">", begin + 1)
                if end < 0:
                    break
                begin += 1
                cursor = end + 1
            else:
                depth, end = 1, begin
                while end < len(line):
                    char = line[end]
                    if char == "\\":
                        end += 2
                        continue
                    if char == "(":
                        depth += 1
                    elif char == ")":
                        depth -= 1
                        if not depth:
                            break
                    elif char.isspace() and depth == 1:
                        break
                    end += 1
                cursor = max(end + 1, begin + 1)
            image = bool(re.search(r"!\[[^\]]*$", visible[:start]))
            replacements.append((begin, end, pinned_link(line[begin:end], tag, image)))
        definition = re.match(r"^ {0,3}\[[^]]+\]:\s*(?:<([^>]+)>|(\S+))", visible)
        if definition:
            group = 1 if definition[1] is not None else 2
            begin, end = definition.span(group)
            replacements.append((begin, end, pinned_link(line[begin:end], tag)))
        for match in re.finditer(r'''\b(src|href)\s*=\s*["']([^"']+)["']''', visible, re.I):
            begin, end = match.span(2)
            replacements.append((begin, end, pinned_link(line[begin:end], tag, match[1].lower() == "src")))
        for begin, end, target in sorted(replacements, reverse=True):
            line = line[:begin] + target + line[end:]
        lines.append(line)
    return "\n".join(lines)


def build_release_document(changelog: str, tag: str) -> str:
    version = parse_tag(tag)
    if version[4]:
        raise ValueError(f"{tag}: only stable versions can be archived in docs/releases")
    section = extract_release_section(changelog, tag)
    heading = re.fullmatch(r"## \[[^]]+\] - (\d{4}-\d{2}-\d{2})", section.splitlines()[0])
    if not heading:
        raise ValueError(f"{tag}: release heading needs an ISO date: ## [{tag[1:]}] - YYYY-MM-DD")
    date.fromisoformat(heading[1])
    bases = BASE_MARK.findall(section)
    if len(bases) > 1 or "<!-- release-base:" in BASE_MARK.sub("", section):
        raise ValueError(f"{tag}: expected at most one <!-- release-base: X.Y.0 --> marker")
    base = bases[0] if bases else None
    if base:
        base_version = parse_tag("v" + base)
        if base_version[4] or base_version[3] != "0" or base_version.groups()[:2] != version.groups()[:2] or int(version[3]) == 0:
            raise ValueError(f"{tag}: base must be the stable X.Y.0 of the same patch series")
    metadata = {
        "schema": "maw.release.v1", "version": tag[1:], "date": heading[1],
        "channel": version[4].split(".")[0] if version[4] else "stable",
        "base": base, "source_sha256": hashlib.sha256(section.encode("utf-8")).hexdigest(),
    }
    body = BASE_MARK.sub("", section)
    body = re.sub(r"\n{3,}", "\n\n", body).strip()
    return DOCUMENT_PREFIX + json.dumps(metadata, ensure_ascii=False, sort_keys=True) + " -->\n\n" + pin_repo_links(body, tag) + "\n"


def document_parts(document: str) -> tuple[dict, str]:
    header, separator, body = document.partition("\n\n")
    if not separator or not header.startswith(DOCUMENT_PREFIX) or not header.endswith(" -->"):
        raise ValueError("invalid release document header")
    metadata = json.loads(header[len(DOCUMENT_PREFIX):-4])
    return metadata, body.strip()


def check_document(changelog: str, tag: str, releases_dir: Path) -> tuple[dict, str]:
    parse_tag(tag)
    path = releases_dir / f"{tag[1:]}.md"
    expected = build_release_document(changelog, tag).encode("utf-8")
    stored = path.read_bytes() if path.is_file() else None
    if stored != expected:
        raise ValueError(f"missing or stale release document: {path}; run --tag {tag} --write-doc")
    return document_parts(stored.decode("utf-8"))


def release_body(changelog: str, tag: str, releases_dir: Path) -> str:
    """Stable releases use their archived CHANGELOG snapshot; prereleases use CHANGELOG directly."""
    version = parse_tag(tag)
    if version[4]:
        return pin_repo_links(extract_release_section(changelog, tag), tag)
    metadata, body = check_document(changelog, tag, releases_dir)
    if metadata["base"]:
        _, base_body = check_document(changelog, "v" + metadata["base"], releases_dir)
        # X.Y.0 is a full summary: never append beta history or earlier patches.
        body += f"\n\n## {version[1]}.{version[2]} 系列主要更新\n\n" + base_body
    return body


def check_all_documents(changelog: str, releases_dir: Path) -> int:
    tags = set()
    for path in releases_dir.glob("*.md"):
        if path.name == "README.md":
            continue
        tag = "v" + path.stem
        if not parse_tag(tag)[4]:
            tags.add(tag)
    for heading in re.findall(r"^## \[([^]]+)\]", changelog, re.M):
        if heading != "未发布":
            tag = "v" + heading
            if not parse_tag(tag)[4]:
                tags.add(tag)
    for tag in sorted(tags):
        check_document(changelog, tag, releases_dir)
        release_body(changelog, tag, releases_dir)
    return len(tags)


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

详细文档参阅：[完整使用文档](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/user/WORKFLOW.md)
遇到问题可以参见：[常见问题](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/user/FAQ.md)"""


def build_release_notes(
    changelog: str,
    tag: str,
    failed_platforms: frozenset[str] = frozenset(),
    releases_dir: Path = ROOT / "docs" / "releases",
) -> str:
    """Build the shared download and usage guide followed by release notes."""
    guide = build_download_section(tag, failed_platforms) + "\n\n" + USAGE_SECTION
    return guide + "\n\n" + release_body(changelog, tag, releases_dir) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", help="release tag, for example v2.0.0-beta.1")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--output", type=Path, help="compose the final GitHub Release body")
    mode.add_argument("--write-doc", action="store_true", help="generate docs/releases/<version>.md from CHANGELOG")
    mode.add_argument("--check-doc", action="store_true", help="check the document and its base without writing")
    mode.add_argument("--check-all", action="store_true", help="check all stable archives and require one for every stable CHANGELOG section")
    mode.add_argument("--write-all-stable", action="store_true", help="generate all stable release documents in base order")
    parser.add_argument("--changelog", type=Path, default=ROOT / "CHANGELOG.md", help="source CHANGELOG (default: repository root)")
    parser.add_argument("--releases-dir", type=Path, default=ROOT / "docs" / "releases", help="version documents directory")
    parser.add_argument(
        "--failed",
        default="",
        help="comma-separated platforms whose packaging failed, for example macos,linux",
    )
    args = parser.parse_args()

    if (args.check_all or args.write_all_stable) and args.tag:
        parser.error("--check-all and --write-all-stable do not take --tag")
    if not (args.check_all or args.write_all_stable) and not args.tag:
        parser.error("--tag is required for this mode")
    if args.failed and not args.output:
        parser.error("--failed is only used with --output")

    failed = {part.strip() for part in args.failed.split(",") if part.strip()}
    unknown = failed - set(PLATFORMS)
    if unknown:
        parser.error(
            f"unknown platform(s): {', '.join(sorted(unknown))}; known: {', '.join(PLATFORMS)}"
        )

    try:
        changelog = args.changelog.read_text(encoding="utf-8")
        if args.check_all:
            count = check_all_documents(changelog, args.releases_dir)
            print(f"Release documents checked: {count}")
        elif args.write_all_stable:
            tags = []
            for heading in re.findall(r"^## \[([^]]+)\]", changelog, re.M):
                if heading == "未发布":
                    continue
                tag = "v" + heading
                if not parse_tag(tag)[4]:
                    tags.append(tag)
            tags = sorted(set(tags), key=lambda value: tuple(int(part) for part in value[1:].split(".")))
            for tag in tags:
                document = build_release_document(changelog, tag)
                metadata, _ = document_parts(document)
                if metadata["base"]:
                    check_document(changelog, "v" + metadata["base"], args.releases_dir)
                path = args.releases_dir / f"{tag[1:]}.md"
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(document.encode("utf-8"))
                print(f"Generated: {path}")
            count = check_all_documents(changelog, args.releases_dir)
            print(f"Release documents checked: {count}")
        elif args.write_doc:
            document = build_release_document(changelog, args.tag)
            metadata, _ = document_parts(document)
            if metadata["base"]:
                check_document(changelog, "v" + metadata["base"], args.releases_dir)
            path = args.releases_dir / f"{args.tag[1:]}.md"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(document.encode("utf-8"))
            print(f"Generated: {path}")
            print(f"Log-folder reminder: after publication update docs/logs/INDEX.md to release{args.tag[1:]}/")
        elif args.check_doc:
            release_body(changelog, args.tag, args.releases_dir)
            # An explicit archive check never accepts prerelease publication fallback.
            check_document(changelog, args.tag, args.releases_dir)
            print(f"Release document is fresh: {args.tag}")
        else:
            notes = build_release_notes(changelog, args.tag, frozenset(failed), args.releases_dir)
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_bytes(notes.encode("utf-8"))
            print(f"Prepared release notes: {args.output}")
    except (ValueError, OSError) as error:
        parser.error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
