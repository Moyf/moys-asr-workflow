"""Read-only documentation navigation, local links and consumer checks.

Uses only Python's standard library. Baseline exceptions identify historical
links, not permission to introduce additional missing targets. Their default
treatment stays tolerant; ``--strict`` also fails while any of them remain.
"""
from __future__ import annotations

import argparse
from collections import Counter
import html
import io
import json
from pathlib import Path
import posixpath
import re
import subprocess
import tarfile
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.I)
HTML_TARGET = re.compile(r'''\b(?:href|src)\s*=\s*["']([^"']+)["']''', re.I)
EXPLICIT_ID = re.compile(r'''\b(?:id|name)\s*=\s*["']([^"']+)["']''', re.I)
INLINE_CODE = re.compile(r"(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)")


def inline_code_spans(text: str):
    cursor = 0
    while match := INLINE_CODE.search(text, cursor):
        before = match.start() - 1
        while before >= 0 and text[before] == "\\":
            before -= 1
        if (match.start() - before - 1) % 2:
            cursor = match.start() + len(match[1])
        else:
            yield match.span()
            cursor = match.end()


def visible_text(text: str) -> str:
    """Drop fenced code and comments while preserving source line numbers."""
    code_spans = list(inline_code_spans(text))
    result, fence, comment, offset = [], None, False, 0
    for raw in text.splitlines(keepends=True):
        line = raw.rstrip("\r\n")
        match = re.match(r"^ {0,3}(`{3,}|~{3,})(.*)$", line)
        if fence:
            if match and match[1][0] == fence[0] and len(match[1]) >= len(fence) and not match[2].strip():
                fence = None
            result.append("")
        elif match and not comment:
            fence = match[1]
            result.append("")
        else:
            visible, cursor = [], 0
            while cursor < len(line):
                if comment:
                    end = line.find("-->", cursor)
                    if end < 0:
                        break
                    cursor, comment = end + 3, False
                elif line.startswith("<!--", cursor) and not any(
                    start <= offset + cursor < end for start, end in code_spans
                ):
                    cursor, comment = cursor + 4, True
                else:
                    visible.append(line[cursor])
                    cursor += 1
            result.append("".join(visible))
        offset += len(raw)
    return "\n".join(result)


def anchors(text: str) -> set[str]:
    text = visible_text(text)
    result = {html.unescape(value) for value in EXPLICIT_ID.findall(text)}
    seen: Counter[str] = Counter()
    lines = text.splitlines()
    for number, line in enumerate(lines):
        match = re.match(r"^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$", line)
        title = match[1] if match else None
        if title is None and line.strip() and number + 1 < len(lines) and re.fullmatch(r" {0,3}(?:=+|-+)\s*", lines[number + 1]):
            title = line.strip()
        if title is None:
            continue
        title = re.sub(r"<[^>]+>", "", title).lower()
        title = re.sub(r"\[([^]]+)\]\([^)]*\)", r"\1", title)
        slug = "".join(c for c in title if c.isalnum() or c in " _-").replace(" ", "-")
        occurrence = seen[slug]
        seen[slug] += 1
        result.add(slug if occurrence == 0 else f"{slug}-{occurrence}")
    return result


def links(text: str):
    """Recognize Markdown destinations, reference definitions and HTML media.

    Balanced parentheses and angle destinations permit filenames with spaces.
    Wiki image embeds in preserved feedback also have a local file target.
    """
    text = visible_text(text)
    characters = list(text)
    for start, end in inline_code_spans(text):
        characters[start:end] = ["\n" if c == "\n" else " " for c in text[start:end]]
    text = "".join(characters)
    for number, line in enumerate(text.splitlines(), 1):
        for match in HTML_TARGET.finditer(line):
            yield number, html.unescape(match[1])
        for match in re.finditer(r"!?\[\[([^]|]+)(?:\|[^]]+)?\]\]", line):
            yield number, match[1]
        definition = re.match(r"^\s{0,3}\[[^]]+\]:\s*(<[^>]+>|\S+)", line)
        if definition:
            yield number, definition[1].strip("<>")
        cursor = 0
        while (start := line.find("](", cursor)) >= 0:
            begin = start + 2
            if begin < len(line) and line[begin] == "<":
                end = line.find(">", begin + 1)
                if end < 0:
                    break
                yield number, line[begin + 1:end]
                cursor = end + 1
                continue
            depth, end = 1, begin
            while end < len(line) and depth:
                if line[end] == "\\":
                    end += 2
                    continue
                if line[end] == "(":
                    depth += 1
                elif line[end] == ")":
                    depth -= 1
                end += 1
            if depth:
                break
            target = line[begin:end - 1].strip()
            target = re.sub(r'''\s+["'][^"']*["']$''', "", target)
            yield number, target
            cursor = end


def destination(source: str, target: str) -> tuple[str, str] | None:
    target = re.sub(r"\\([!\"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])", r"\1", target)
    if not target or SCHEME.match(target) or target.startswith(("/", "//")):
        return None
    url = urlsplit(target)
    filename = unquote(url.path).replace("\\", "/")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(source), filename)) if filename else source
    return resolved, unquote(url.fragment)


def scan(texts: dict[str, str], paths: set[str]) -> list[dict]:
    issues = []
    anchor_cache = {}
    for source, text in sorted(texts.items()):
        if not (source.endswith(".md") or (source.startswith("docs/") and source.endswith(".html"))):
            continue
        # Astro routes are checked by sync/build; they are not filesystem links.
        if source.startswith("website/src/pages/"):
            continue
        for number, target in links(text):
            resolved = destination(source, target)
            if resolved is None:
                continue
            path, fragment = resolved
            exists = path in paths or any(p.startswith(path.rstrip("/") + "/") for p in paths)
            reason = "missing-file" if not exists else None
            if exists and fragment and path.endswith((".md", ".html")):
                if path not in anchor_cache:
                    anchor_cache[path] = anchors(texts.get(path, ""))
                if fragment not in anchor_cache[path]:
                    reason = "missing-anchor"
            if reason:
                issues.append({"source": source, "line": number, "target": target, "resolved": path,
                               "fragment": fragment, "reason": reason})
    return issues


def signature(issue: dict) -> tuple[str, str, str, str]:
    return issue["source"], issue["resolved"], issue.get("fragment", ""), issue["reason"]


def read_tree(root: Path, ref: str | None = None) -> tuple[dict[str, str], set[str]]:
    texts = {}
    if ref:
        archive = subprocess.check_output(["git", "archive", ref], cwd=root)
        with tarfile.open(fileobj=io.BytesIO(archive)) as stream:
            files = [m for m in stream.getmembers() if m.isfile()]
            paths = {m.name for m in files}
            for member in files:
                if member.name.endswith((".md", ".html", ".mjs", ".json")) and member.size < 4000000:
                    try:
                        texts[member.name] = stream.extractfile(member).read().decode("utf-8")
                    except UnicodeError:
                        pass
        return texts, paths
    listed = subprocess.check_output(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], cwd=root).decode("utf-8")
    paths = {p for p in listed.split("\0") if p and (root / p).is_file()}
    for p in paths:
        if p.endswith((".md", ".html", ".mjs", ".json")) and (root / p).stat().st_size < 4000000:
            try:
                texts[p] = (root / p).read_text(encoding="utf-8")
            except UnicodeError:
                pass
    return texts, paths


def structure(texts: dict[str, str], paths: set[str], warnings: list[str] | None = None) -> list[str]:
    errors = []
    for required in ("AGENTS.md", "docs/README.md", "docs/INDEX.md", "docs/logs/INDEX.md", "docs/logs/CURRENT.md"):
        if required not in paths:
            errors.append(f"missing entry: {required}")
    if "doc-policy" not in anchors(texts.get("docs/README.md", "")):
        errors.append("docs/README.md needs the stable doc-policy anchor")
    ids = [html.unescape(value) for value in EXPLICIT_ID.findall(visible_text(texts.get("docs/INDEX.md", "")))]
    for topic, count in Counter(ids).items():
        if count > 1:
            errors.append(f"duplicate topic ID: {topic}")
    graph = {}
    for source, text in texts.items():
        if source.endswith(".md"):
            graph[source] = {resolved[0] for _, target in links(text) if (resolved := destination(source, target))}
    entries = graph.get("docs/INDEX.md", set())
    for path in sorted(paths):
        if path.startswith(("docs/user/", "docs/engineering/", "docs/plans/")) and path.endswith(".md") and path not in entries:
            errors.append(f"independent document missing from docs/INDEX.md: {path}")
    visited, pending = set(), ["docs/logs/INDEX.md", "docs/logs/CURRENT.md"]
    while pending:
        source = pending.pop()
        if source in visited:
            continue
        visited.add(source)
        pending.extend(graph.get(source, set()) - visited)
    for path in sorted(paths):
        if path.startswith("docs/logs/") and path.endswith(".md") and path not in visited:
            if warnings is not None:
                warnings.append(f"log missing from log navigation: {path}")
        if path.startswith(("docs/temp/", "docs/reports/", "docs/dev/", "docs/verifications/", ".artifacts/")):
            errors.append(f"source or evidence in retired/temporary location: {path}")
    sync = texts.get("website/scripts/sync-maw-docs.mjs", "")
    for source in re.findall(r"source:\s*['\"]([^'\"]+)['\"]", sync):
        if source not in paths:
            errors.append(f"website source missing: {source}")
    for path in json.loads(texts.get("scripts/docs-consumers.json", '{"paths":[]}'))["paths"]:
        if path not in paths:
            errors.append(f"consumer input missing: {path}")
    return errors


def baseline_signatures(baseline: list[dict], mapping: dict[str, str] | None = None) -> set[tuple[str, str, str, str]]:
    mapping = mapping or {}
    return {(mapping.get(i["source"], i["source"]), mapping.get(i["resolved"], i["resolved"]),
             i.get("fragment", ""), i["reason"]) for i in baseline}


def compare(issues: list[dict], baseline: list[dict], mapping: dict[str, str] | None = None) -> list[dict]:
    known = baseline_signatures(baseline, mapping)
    return [issue for issue in issues if signature(issue) not in known]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--base-ref", help="Compare links with a locally available Git snapshot")
    parser.add_argument("--mapping", type=Path, help="JSON old-to-new path mapping for migration comparison")
    parser.add_argument("--scan-only", action="store_true", help="Inventory links without requiring the new structure")
    parser.add_argument("--strict", action="store_true", help="Also fail on registered historical broken links")
    parser.add_argument("--json", action="store_true", help="Emit machine-readable results to stdout; never write files")
    args = parser.parse_args(argv)
    texts, paths = read_tree(args.root)
    issues = scan(texts, paths)
    mapping = {}
    if args.base_ref:
        before, old_paths = read_tree(args.root, args.base_ref)
        baseline = scan(before, old_paths)
        if args.mapping:
            mapping = json.loads(args.mapping.read_text(encoding="utf-8"))
    else:
        baseline = json.loads(texts.get("scripts/docs-link-exceptions.json", '{"issues":[]}'))["issues"]
    known = baseline_signatures(baseline, mapping)
    registered = [issue for issue in issues if signature(issue) in known]
    new = [issue for issue in issues if signature(issue) not in known]
    warnings: list[str] = []
    errors = [] if args.scan_only else structure(texts, paths, warnings)
    if not args.scan_only:
        ignored = subprocess.run(["git", "check-ignore", "--no-index", "-q", ".artifacts/docs-check/probe.txt"], cwd=args.root).returncode == 0
        if not ignored:
            errors.append("/.artifacts/ is not ignored")
    result = {"files": len(paths), "existing_links": len(registered), "new_links": new, "structure_errors": errors, "warnings": warnings, "issues": issues}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"docs: {len(paths)} files; {len(registered)} known historical links; {len(new)} new broken links; {len(errors)} structure errors")
        if args.strict:
            print(f"strict: {len(registered)} registered historical broken links fail in this mode")
        for error in errors:
            print(error)
        for warning in warnings[:30]:
            print(f"WARNING: {warning}")
        for issue in (new + registered if args.strict else new)[:30]:
            print(f'{issue["source"]}:{issue["line"]}: {issue["reason"]}: {issue["target"]}')
    return int(bool(new or errors or (args.strict and registered)))


if __name__ == "__main__":
    raise SystemExit(main())
