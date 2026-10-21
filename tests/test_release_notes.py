from __future__ import annotations

import unittest
import subprocess
import sys
import tempfile
from pathlib import Path
from tests.compact_assertions import CompactContainerAssertions

from scripts.prepare_release_notes import (
    ROOT, build_release_document, build_release_notes, check_all_documents,
    check_document, document_parts, extract_release_section, pin_repo_links,
)


class ReleaseNotesTests(unittest.TestCase):
    def test_extracts_only_the_requested_release_section(self) -> None:
        changelog = """## [1.0.0] - today

### 🐛 问题修复

- current

## [0.9.0] - yesterday

- older
"""

        section = extract_release_section(changelog, "v1.0.0")

        self.assertIn("- current", section)
        self.assertNotIn("- older", section)

    def test_builds_per_platform_download_links_and_usage_guide(self) -> None:
        notes = build_release_notes("## [1.0.0-beta.1] - 2026-10-10\n\n### ✨ 新增\n\n- feature\n", "v1.0.0-beta.1")

        self.assertIn("## 下载哪个版本？", notes)
        base = "https://github.com/Moyf/moys-asr-workflow/releases/download/v1.0.0-beta.1"
        self.assertIn("[MAW-Windows-x64-v1.0.0-beta.1.zip](%s/MAW-Windows-x64-v1.0.0-beta.1.zip)" % base, notes)
        self.assertIn("[MAW-lite-Windows-x64-v1.0.0-beta.1.zip](%s/MAW-lite-Windows-x64-v1.0.0-beta.1.zip)" % base, notes)
        self.assertIn("[MAW-macOS-arm64-v1.0.0-beta.1.zip](%s/MAW-macOS-arm64-v1.0.0-beta.1.zip)" % base, notes)
        self.assertIn("[MAW-lite-macOS-arm64-v1.0.0-beta.1.zip](%s/MAW-lite-macOS-arm64-v1.0.0-beta.1.zip)" % base, notes)
        self.assertIn("[MAW-Linux-x86_64-v1.0.0-beta.1.AppImage](%s/MAW-Linux-x86_64-v1.0.0-beta.1.AppImage)" % base, notes)
        self.assertIn("[MAW-lite-Linux-x86_64-v1.0.0-beta.1.AppImage](%s/MAW-lite-Linux-x86_64-v1.0.0-beta.1.AppImage)" % base, notes)
        self.assertIn("- **Windows 🪟**", notes)
        self.assertIn("- **macOS 🍎**", notes)
        self.assertIn("- **Linux 🐧**", notes)
        self.assertNotIn("打包失败", notes)
        self.assertIn("## 如何使用", notes)
        self.assertIn("1. 下载安装包后解压", notes)
        self.assertIn("2. 双击对应的 `MAW` 可执行文件，打开启动器", notes)
        self.assertIn("3. 在启动器中，可以执行字幕转写、生成工程等操作", notes)
        self.assertIn("4. 完成后，启动字幕编辑器，进行字幕精修", notes)
        self.assertIn("[完整使用文档](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/user/WORKFLOW.md)", notes)
        self.assertIn("[常见问题](https://github.com/Moyf/moys-asr-workflow/blob/main/docs/user/FAQ.md)", notes)
        self.assertIn("### ✨ 新增", notes)

    def test_failed_platforms_render_failure_marks_without_links(self) -> None:
        notes = build_release_notes(
            "## [1.0.0-beta.1] - 2026-10-10\n\n### ✨ 新增\n\n- feature\n",
            "v1.0.0-beta.1",
            failed_platforms=frozenset({"linux"}),
        )

        self.assertIn("- **Linux 🐧**\n    - 打包失败 😭", notes)
        self.assertNotIn("MAW-Linux-x86_64-v1.0.0-beta.1.AppImage", notes)
        self.assertNotIn("MAW-lite-Linux-x86_64-v1.0.0-beta.1.AppImage", notes)
        self.assertIn("[MAW-Windows-x64-v1.0.0-beta.1.zip]", notes)
        self.assertIn("[MAW-macOS-arm64-v1.0.0-beta.1.zip]", notes)

    def test_rejects_non_tag_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "must start with v"):
            extract_release_section("## [1.0.0]\n", "1.0.0")


class ReleaseDocumentTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.releases = self.root / "docs" / "releases"
        self.releases.mkdir(parents=True)

    def write_document(self, source: str, tag: str) -> Path:
        path = self.releases / f"{tag[1:]}.md"
        path.write_bytes(build_release_document(source, tag).encode("utf-8"))
        return path

    def test_beta_cannot_be_archived_and_notes_use_only_its_changelog_section(self) -> None:
        source = "## [2.0.0-beta.2] - 2026-10-12\n\n- 改进\n\n## [2.0.0-beta.1] - 2026-10-11\n\n- older\n"
        with self.assertRaisesRegex(ValueError, "only stable versions"):
            build_release_document(source, "v2.0.0-beta.2")
        notes = build_release_notes(source, "v2.0.0-beta.2", releases_dir=self.releases)
        self.assertIn("- 改进", notes)
        self.assertNotIn("- older", notes)
        self.assertFalse(list(self.releases.glob("2.0.0-beta*.md")))

    def test_stable_summary_does_not_automatically_append_beta_history(self) -> None:
        source = "## [2.0.0] - 2026-10-12\n\n- Complete summary\n\n## [2.0.0-beta.1] - 2026-10-11\n\n- obsolete wording\n"
        self.write_document(source, "v2.0.0")
        notes = build_release_notes(source, "v2.0.0", releases_dir=self.releases)
        self.assertIn("Complete summary", notes)
        self.assertNotIn("obsolete wording", notes)

    def test_patch_appends_stable_base_but_archives_only_delta(self) -> None:
        source = "## [2.0.2] - 2026-10-12\n\n<!-- release-base: 2.0.0 -->\n\n- Patch\n\n## [2.0.1] - 2026-10-11\n\n- Earlier patch\n\n## [2.0.0] - 2026-10-10\n\n- Major update\n![图](docs/assets/view.webp)\n"
        self.write_document(source, "v2.0.0")
        path = self.write_document(source, "v2.0.2")
        metadata, body = document_parts(path.read_text(encoding="utf-8"))
        self.assertEqual(metadata["base"], "2.0.0")
        self.assertNotIn("Major update", body)
        notes = build_release_notes(source, "v2.0.2", frozenset({"linux"}), self.releases)
        self.assertLess(notes.index("- Patch"), notes.index("## 2.0 系列主要更新"))
        self.assertEqual(notes.count("- Major update"), 1)
        self.assertNotIn("Earlier patch", notes)
        self.assertNotIn("maw-release", notes)
        self.assertNotIn("release-base", notes)
        self.assertIn("/v2.0.0/docs/assets/view.webp", notes)
        self.assertIn("打包失败 😭", notes)
        self.assertNotIn("MAW-Linux-x86_64-v2.0.2.AppImage", notes)

    def test_missing_stale_tampered_and_crlf_stable_documents_block_publication(self) -> None:
        source = "## [2.0.0] - 2026-10-12\n\n- Feature\n"
        with self.assertRaisesRegex(ValueError, "missing or stale"):
            build_release_notes(source, "v2.0.0", releases_dir=self.releases)
        path = self.write_document(source, "v2.0.0")
        with self.assertRaisesRegex(ValueError, "missing or stale"):
            check_document(source.replace("Feature", "Changed"), "v2.0.0", self.releases)
        original = path.read_bytes()
        for changed in (original.replace(b"Feature", b"Edited archive"), original.replace(b"\n", b"\r\n")):
            path.write_bytes(changed)
            with self.assertRaisesRegex(ValueError, "missing or stale"):
                check_document(source, "v2.0.0", self.releases)

    def test_other_changelog_sections_do_not_invalidate_an_archive(self) -> None:
        source = "## [2.0.0] - 2026-10-12\n\n- Summary\n"
        self.write_document(source, "v2.0.0")
        check_document("## [未发布]\n\n- Next feature\n\n" + source, "v2.0.0", self.releases)

    def test_base_requires_its_own_fresh_document(self) -> None:
        source = "## [2.0.1] - 2026-10-12\n\n<!-- release-base: 2.0.0 -->\n\n- Patch\n\n## [2.0.0] - 2026-10-10\n\n- Summary\n"
        self.write_document(source, "v2.0.1")
        with self.assertRaisesRegex(ValueError, "v2.0.0 --write-doc"):
            build_release_notes(source, "v2.0.1", releases_dir=self.releases)
        self.write_document(source, "v2.0.0")
        with self.assertRaisesRegex(ValueError, "missing or stale"):
            build_release_notes(source.replace("Summary", "Changed"), "v2.0.1", releases_dir=self.releases)

    def test_invalid_version_date_duplicate_section_and_base_are_rejected(self) -> None:
        for tag in ("v../../outside", "v2.0.0-beta.01", "v2.00.0", "2.0.0"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                build_release_document("", tag)
        for date_value in ("today", "2026-02-30"):
            with self.subTest(date=date_value), self.assertRaises(ValueError):
                build_release_document(f"## [2.0.0] - {date_value}\n\n- Summary", "v2.0.0")
        source = "## [2.0.1] - 2026-10-12\n\n- Patch\n"
        with self.assertRaisesRegex(ValueError, "duplicate"):
            build_release_document(source + source, "v2.0.1")
        for base in ("1.9.0", "2.0.1", "2.0.0-beta.1", "v2.0.0"):
            with self.subTest(base=base), self.assertRaises(ValueError):
                build_release_document(source + f"\n<!-- release-base: {base} -->", "v2.0.1")
        for marker in ("<!-- release-base: -->", "<!-- release-base: 2.0.0 -->\n<!-- release-base: 2.0.0 -->",
                       "<!-- release-base: 2.0.0 -->\n<!-- release-base: invalid extra -->"):
            with self.subTest(marker=marker), self.assertRaises(ValueError):
                build_release_document(source + marker, "v2.0.1")

    def test_check_all_requires_every_stable_section_and_ignores_beta_archives(self) -> None:
        source = "## [未发布]\n\n- WIP\n\n## [1.8.0-beta.1] - 2026-10-02\n\n- Older\n\n## [1.8.0] - 2026-10-03\n\n- Stable\n"
        with self.assertRaisesRegex(ValueError, "missing or stale"):
            check_all_documents(source, self.releases)
        (self.releases / "1.8.0-beta.1.md").write_text("old beta archive", encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "missing or stale"):
            check_all_documents(source, self.releases)
        self.write_document(source, "v1.8.0")
        self.assertEqual(check_all_documents(source, self.releases), 1)
        source = "## [2.0.0] - 2026-10-12\n\n- New\n\n" + source
        with self.assertRaisesRegex(ValueError, "missing or stale"):
            check_all_documents(source, self.releases)
        self.write_document(source, "v2.0.0")
        self.assertEqual(check_all_documents(source, self.releases), 2)

    def test_relative_links_pin_to_tag_and_code_examples_are_preserved(self) -> None:
        source = '''![图片](docs/assets/view.webp)
![无扩展名](assets/image)
[指南](<docs/user/a (1).md#开始> "说明")
[输入](docs/data/input(1).md)
[参考][ref]
[ref]: docs/user/WORKFLOW.md
<img src="docs/assets/view.webp"><a href="README.md">README</a>
[外链](https://example.test/x) [锚点](#here)
`[代码](docs/example.md)`
```md
[样例](docs/example.md)
```
'''
        result = pin_repo_links(source, "v2.0.0-beta.1")
        self.assertIn("https://raw.githubusercontent.com/Moyf/moys-asr-workflow/v2.0.0-beta.1/docs/assets/view.webp", result)
        self.assertIn("https://raw.githubusercontent.com/Moyf/moys-asr-workflow/v2.0.0-beta.1/assets/image", result)
        self.assertIn('docs/user/a%20%281%29.md#开始> "说明"', result)
        self.assertIn("docs/data/input%281%29.md)", result)
        self.assertIn("[ref]: https://github.com/Moyf/moys-asr-workflow/blob/v2.0.0-beta.1/docs/user/WORKFLOW.md", result)
        self.assertIn('href="https://github.com/Moyf/moys-asr-workflow/blob/v2.0.0-beta.1/README.md"', result)
        self.assertIn("[外链](https://example.test/x) [锚点](#here)", result)
        self.assertIn("`[代码](docs/example.md)`", result)
        self.assertIn("```md\n[样例](docs/example.md)\n```", result)
        with self.assertRaisesRegex(ValueError, "outside"):
            pin_repo_links("[bad](../secret.md)", "v2.0.0")

    def test_cli_generate_check_publish_and_stale_check_preserve_output(self) -> None:
        source = self.root / "CHANGELOG.md"
        source.write_text("## [2.0.0] - 2026-10-12\n\n- Feature\n\n## [2.0.0-beta.1] - 2026-10-11\n\n- Beta feature\n", encoding="utf-8")
        command = [sys.executable, str(ROOT / "scripts/prepare_release_notes.py"),
                   "--changelog", str(source), "--releases-dir", str(self.releases)]

        def run(*args):
            return subprocess.run(command + list(args), capture_output=True, text=True, encoding="utf-8", timeout=15)

        self.assertNotEqual(run("--tag", "v2.0.0-beta.1", "--write-doc").returncode, 0)
        path = self.write_document(source.read_text(encoding="utf-8"), "v2.0.0")
        for args in (("--tag", "v2.0.0", "--check-doc"), ("--check-all",)):
            result = run(*args)
            self.assertEqual(result.returncode, 0, result.stderr[:1000])
        output = self.root / "release-notes.md"
        result = run("--tag", "v2.0.0-beta.1", "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr[:1000])
        original = output.read_bytes()
        self.assertIn(b"Beta feature", original)
        self.assertNotIn(b"Feature", original)
        source.write_text(source.read_text(encoding="utf-8").replace("Feature", "Changed"), encoding="utf-8")
        result = run("--tag", "v2.0.0-beta.1", "--output", str(output))
        self.assertEqual(result.returncode, 0, result.stderr[:1000])
        source.write_text(source.read_text(encoding="utf-8").replace("- Changed", "- Feature"), encoding="utf-8")
        path.write_bytes(path.read_bytes().replace(b"Feature", b"Edited archive"))
        result = run("--tag", "v2.0.0", "--output", str(output))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing or stale", result.stderr)
        self.assertEqual(output.read_bytes(), original)
        self.assertNotEqual(run("--check-all", "--tag", "v2.0.0").returncode, 0)
        self.assertNotEqual(run("--tag", "v2.0.0", "--write-doc", "--failed", "linux").returncode, 0)

    def test_write_all_stable_generates_base_before_patch_and_ignores_prereleases(self) -> None:
        source = self.root / "CHANGELOG.md"
        source.write_text(
            "## [2.1.1] - 2026-10-12\n\n<!-- release-base: 2.1.0 -->\n\n- Patch\n\n"
            "## [2.1.0] - 2026-10-10\n\n- Summary\n\n"
            "## [2.1.1-rc.1] - 2026-10-11\n\n- Candidate\n",
            encoding="utf-8",
        )
        command = [sys.executable, str(ROOT / "scripts/prepare_release_notes.py"),
                   "--changelog", str(source), "--releases-dir", str(self.releases), "--write-all-stable"]
        result = subprocess.run(command, capture_output=True, text=True, encoding="utf-8", timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr[:1000])
        self.assertTrue((self.releases / "2.1.0.md").is_file())
        self.assertTrue((self.releases / "2.1.1.md").is_file())
        self.assertFalse((self.releases / "2.1.1-rc.1.md").exists())

    def test_release_ci_checks_before_packaging_and_regular_ci_checks_archives(self) -> None:
        release = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.assertLess(release.index("Verify release document and preview before packaging"), release.index("Install locked dependencies"))
        self.assertIn('--output .artifacts/release-preview.md', release)
        self.assertIn('python3 scripts/prepare_release_notes.py "${Args[@]}"', release)
        regular = (ROOT / ".github/workflows/editor-checks.yml").read_text(encoding="utf-8")
        self.assertIn("scripts/prepare_release_notes.py --check-all", regular)
        self.assertIn("scripts/run_tests.py tests/test_release_notes.py", regular)


if __name__ == "__main__":
    unittest.main()
