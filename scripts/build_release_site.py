"""Build static release pages and update feeds from archives and publication facts.

Standard library only. This never edits CHANGELOG, publishes releases or installs updates.
"""
from __future__ import annotations

import argparse
from datetime import date, datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
from urllib.parse import unquote, urlsplit
from urllib.request import Request, urlopen
import uuid

try:
    from .prepare_release_notes import ROOT, REPO, document_parts, parse_tag
except ImportError:
    from prepare_release_notes import ROOT, REPO, document_parts, parse_tag

RAW_IMAGE = re.compile(r'https://raw\.githubusercontent\.com/' + re.escape(REPO)
                       + r'/([^/\s]+?)/([^\s<>"\')]+\.(?:png|jpe?g|gif|webp|svg|avif))(?:\?[^\s<>"\')]+)?', re.I)


def stable_key(version: str) -> tuple[int, int, int]:
    match = parse_tag('v' + version)
    if match[4]:
        raise ValueError(f'not a stable version: {version}')
    return tuple(int(match[i]) for i in (1, 2, 3))


def git_bytes(root: Path, ref: str, path: str) -> bytes:
    if not re.fullmatch(r'v[0-9A-Za-z.-]+|[0-9a-f]{40}', ref):
        raise ValueError('resource ref must be a fixed release tag or commit')
    clean = PurePosixPath(path)
    if clean.is_absolute() or '..' in clean.parts or '\\' in path or ':' in path:
        raise ValueError('resource path must stay inside the repository')
    result = subprocess.run(['git', 'show', f'{ref}:{path}'], cwd=root,
                            capture_output=True, timeout=30)
    if result.returncode:
        raise ValueError(f'missing fixed resource: {ref}:{path}; fetch release tags first')
    return result.stdout


def fetch_facts() -> list[dict]:
    """Fetch complete pagination; errors never become an empty release catalog."""
    releases = []
    for page in range(1, 101):
        headers = {'Accept': 'application/vnd.github+json', 'User-Agent': 'MAW-release-site',
                   'X-GitHub-Api-Version': '2022-11-28'}
        token = os.environ.get('GITHUB_TOKEN')
        if token:
            headers['Authorization'] = f'Bearer {token}'
        request = Request(f'https://api.github.com/repos/{REPO}/releases?per_page=100&page={page}',
                          headers=headers)
        with urlopen(request, timeout=30) as response:
            batch = json.load(response)
        if not isinstance(batch, list):
            raise ValueError('GitHub releases response is not a list')
        releases.extend(batch)
        if len(batch) < 100:
            return releases
    raise ValueError('release pagination exceeded 100 pages; refusing partial publication facts')


def downloads_for(release: dict, tag: str) -> list[dict]:
    expected = {
        f'MAW-Windows-x64-{tag}.zip': ('windows', 'x64', 'full'),
        f'MAW-lite-Windows-x64-{tag}.zip': ('windows', 'x64', 'lite'),
        f'MAW-macOS-arm64-{tag}.zip': ('macos', 'arm64', 'full'),
        f'MAW-lite-macOS-arm64-{tag}.zip': ('macos', 'arm64', 'lite'),
        f'MAW-Linux-x86_64-{tag}.AppImage': ('linux', 'x64', 'full'),
    }
    names = {asset.get('name') for asset in release.get('assets', [])}
    for platform, label, arch in (('windows', 'Windows-x64', 'x64'), ('macos', 'macOS-arm64', 'arm64')):
        legacy_full = f'MAWxFF-{label}-{tag}.zip'
        if legacy_full in names:
            expected[legacy_full] = (platform, arch, 'full')
            expected[f'MAW-{label}-{tag}.zip'] = (platform, arch, 'lite')
    downloads = []
    for asset in release.get('assets', []):
        name = asset.get('name')
        if name not in expected:
            continue
        url = asset.get('browser_download_url')
        canonical = f'https://github.com/{REPO}/releases/download/{tag}/{name}'
        size = asset.get('size', 0)
        if url != canonical or not isinstance(size, int) or isinstance(size, bool) or size <= 0:
            raise ValueError(f'invalid download attachment: {tag}/{name}')
        if asset.get('state') != 'uploaded':
            raise ValueError(f'attachment not uploaded: {tag}/{name}')
        platform, arch, variant = expected[name]
        if any(item['platform'] == platform and item['variant'] == variant for item in downloads):
            raise ValueError(f'duplicate attachment: {tag}/{name}')
        downloads.append(dict(platform=platform, arch=arch, variant=variant, url=url, size_bytes=size))
    return sorted(downloads, key=lambda item: (
        ('windows', 'macos', 'linux').index(item['platform']), item['variant'] != 'full'))


def load_archives(root: Path) -> dict[str, tuple[dict, str]]:
    archives = {}
    for path in sorted((root / 'docs/releases').glob('*.md')):
        if path.name == 'README.md':
            continue
        if parse_tag('v' + path.stem)[4]:
            continue  # Historical prerelease files are retained, never exposed.
        metadata, body = document_parts(path.read_text(encoding='utf-8'))
        if (metadata.get('schema') != 'maw.release.v1' or metadata.get('version') != path.stem
                or metadata.get('channel') != 'stable'):
            raise ValueError(f'invalid archive metadata: {path.name}')
        date.fromisoformat(metadata['date'])
        if not re.fullmatch(r'[a-f0-9]{64}', metadata.get('source_sha256', '')):
            raise ValueError(f'missing source digest: {path.name}')
        archives[path.stem] = metadata, body
    return archives


def localize_images(body: str, root: Path, base: str, preview_version: str | None,
                    assets: dict[str, bytes]) -> str:
    def replace(match: re.Match) -> str:
        ref, source = match[1], unquote(match[2])
        try:
            raw = git_bytes(root, ref, source)
        except ValueError:
            if preview_version is None or ref != 'v' + preview_version:
                raise
            path = (root / source).resolve()
            if not path.is_relative_to(root.resolve()):
                raise ValueError('preview resource outside repository')
            raw = path.read_bytes()  # Candidate tag may not exist yet.
        name = hashlib.sha256(raw).hexdigest() + PurePosixPath(source).suffix.lower()
        assets[name] = raw
        return base + 'release-assets/' + name
    # Preserve fenced/inline examples. Actual links, reference definitions and HTML images
    # share the same pinned URL representation produced by the archive generator.
    lines, fence = [], None
    for line in body.splitlines():
        marker = re.match(r'^ {0,3}(`{3,}|~{3,})(.*)$', line)
        if fence:
            if marker and marker[1][0] == fence[0] and len(marker[1]) >= len(fence) and not marker[2].strip():
                fence = None
            lines.append(line)
        elif marker:
            fence = marker[1]
            lines.append(line)
        else:
            parts = re.split(r'(`+[^`]*`+)', line)
            lines.append(''.join(part if i % 2 else RAW_IMAGE.sub(replace, part)
                                 for i, part in enumerate(parts)))
    return '\n'.join(lines)


def build(root: Path, facts: list[dict] | None, site_url: str, base: str,
          expected_tag: str | None = None) -> tuple[dict, dict[str, str], dict[str, bytes], dict[str, dict]]:
    parts = urlsplit(site_url)
    if parts.scheme not in ('https', 'http') or not parts.netloc or parts.username:
        raise ValueError('site URL needs an http(s) origin')
    origin = f'{parts.scheme}://{parts.netloc}'
    base = '/' + base.strip('/') + '/' if base.strip('/') else '/'
    archives = load_archives(root)
    preview = facts is None
    selected, notices = {}, []
    if preview:
        selected = {version: None for version in archives}
    else:
        if not isinstance(facts, list):
            raise ValueError('publication facts must be a complete GitHub releases list')
        for fact in facts:
            tag = fact.get('tag_name', '')
            if fact.get('draft') is not False or fact.get('prerelease') is not False:
                continue
            try:
                stable_key(tag.removeprefix('v'))
                if not tag.startswith('v'):
                    raise ValueError('tag needs v prefix')
            except ValueError:
                continue
            version = tag[1:]
            if version not in archives:
                raise ValueError(f'published release has no archive: {tag}; merge its archive before deployment')
            downloads = downloads_for(fact, tag)
            if not any(d['platform'] == 'windows' and d['variant'] == 'full' for d in downloads):
                notices.append(f'{tag}: omitted; required Windows full attachment is unavailable')
                continue
            published = fact.get('published_at')
            if not isinstance(published, str):
                raise ValueError(f'missing publication timestamp: {tag}')
            timestamp = datetime.fromisoformat(published.replace('Z', '+00:00'))
            if timestamp.tzinfo is None:
                raise ValueError(f'publication timestamp needs timezone: {tag}')
            if version in selected:
                raise ValueError(f'duplicate published release: {tag}')
            selected[version] = (published, downloads)
    assets, pages, notes, entries = {}, {}, {}, []
    for version in sorted(selected, key=stable_key, reverse=True):
        metadata, body = archives[version]
        series_base = metadata.get('base')
        if series_base and series_base not in selected:
            raise ValueError(f'{version}: base {series_base} is not available for this catalog')
        localized = localize_images(body, root, base, version if preview else None, assets)
        content = re.sub(r'^## \[[^]]+\][^\n]*\n*', '', localized, count=1)
        summary_lines = [line for line in content.splitlines()
                         if line.strip() and not line.startswith(('#', '!', '<', '|', '```'))]
        summary = re.sub(r'[*_`]|^-\s*', '', summary_lines[0]) if summary_lines else '查看本版本更新内容。'
        summary = re.sub(r'\[([^]]+)\]\([^)]*\)', r'\1', summary)[:180]
        published, downloads = selected[version] or (None, [])
        entry = dict(version=version, date=metadata['date'], published_at=published, summary=summary,
                     base=series_base, notes_url=origin + base + f'releases/{version}/',
                     notes_json_url=origin + base + f'releases/{version}/notes.json',
                     github_url=f'https://github.com/{REPO}/releases/tag/v{version}', downloads=downloads)
        entries.append(entry)
        frontmatter = dict(layout='../../layouts/ReleaseLayout.astro', title=f'MAW {version} 更新', version=version)
        pages[version] = '---\n' + json.dumps(frontmatter, ensure_ascii=False) + '\n---\n\n' + content + '\n'
        if not preview:
            notes[version] = dict(schema_version=1, version=version, base=series_base,
                                 body_markdown=localized.replace(base + 'release-assets/', origin + base + 'release-assets/'))
    if expected_tag and (not expected_tag.startswith('v') or expected_tag[1:] not in selected):
        raise ValueError(f'expected published version missing from catalog: {expected_tag}')
    catalog = dict(schema_version=1, mode='preview' if preview else 'published',
                   generated_at=datetime.now(timezone.utc).isoformat(),
                   latest_stable=entries[0]['version'] if entries and not preview else None,
                   releases=entries, notices=notices)
    return catalog, pages, assets, notes


def write_outputs(root: Path, catalog: dict, pages: dict, assets: dict, notes: dict) -> None:
    """Move previous owned generated files aside; keep source templates untouched."""
    website = root / 'website'
    previous = root / '.artifacts/release-site-previous' / uuid.uuid4().hex
    page_dir = website / 'src/pages/releases'
    owned = [website / 'public/releases', website / 'public/release-assets']
    owned.extend(page_dir.glob('*.md'))
    for path in owned:
        if path.exists():
            target = previous / path.relative_to(website)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(path), str(target))
    def write(relative: str, value: str | bytes):
        path = website / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value.encode('utf-8') if isinstance(value, str) else value)
    def encoded(value):
        return json.dumps(value, ensure_ascii=False, indent=2) + '\n'
    write('src/generated/releases.json', encoded(catalog))
    public = {key: catalog[key] for key in ('schema_version', 'generated_at', 'latest_stable', 'releases')}
    if catalog['mode'] == 'preview':
        public['releases'] = []  # Candidate previews never advertise software updates.
    write('public/releases/index.json', encoded(public))
    for version, markdown in pages.items():
        write(f'src/pages/releases/{version}.md', markdown)
    for name, raw in assets.items():
        write('public/release-assets/' + name, raw)
    for version, note in notes.items():
        write(f'public/releases/{version}/notes.json', encoded(note))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--preview', action='store_true', help='local candidate preview; public update feed stays empty')
    mode.add_argument('--github', action='store_true', help='fetch complete GitHub publication facts')
    mode.add_argument('--facts', type=Path, help='complete saved GitHub releases response (offline verification)')
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--site-url', default=os.environ.get('SITE_URL', 'https://moyf.github.io'))
    parser.add_argument('--base-path', default=os.environ.get('BASE_PATH', '/'))
    parser.add_argument('--expected-tag', default='')
    args = parser.parse_args()
    try:
        facts = fetch_facts() if args.github else json.loads(args.facts.read_text(encoding='utf-8')) if args.facts else None
        result = build(args.root.resolve(), facts, args.site_url, args.base_path, args.expected_tag or None)
        write_outputs(args.root.resolve(), *result)
        print(f'Release site: {len(result[1])} versions, {len(result[2])} unique images; {result[0]["mode"]}')
        for notice in result[0]['notices']:
            print('WARNING: ' + notice)
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        print(f'Release site failed: {type(error).__name__}: {error}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
