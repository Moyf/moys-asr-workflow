"""Documentation checks catch broken targets without executing any consumer."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from tests.compact_assertions import CompactContainerAssertions

ROOT = Path(__file__).resolve().parents[1]
NAVIGATION_FIXTURE = ROOT / "tests/fixtures/docs-navigation"
NAVIGATION_ENTRY = "docs/导航 入口.html"
NAVIGATION_GUIDE = "docs/带 空格/字幕 指南.html"
NAVIGATION_IMAGE = "docs/图片 素材/导航 示意.svg"
spec = importlib.util.spec_from_file_location("docs_check", ROOT / "scripts/check_docs.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class DocumentationCheckTests(CompactContainerAssertions, unittest.TestCase):
    def run_navigation_fixture(self, *, missing_image=False, bad_anchor=False):
        scratch = ROOT / ".artifacts/docs-navigation-tests"
        scratch.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=scratch) as directory:
            root = Path(directory)
            for source in NAVIGATION_FIXTURE.rglob("*"):
                if not source.is_file():
                    continue
                relative = source.relative_to(NAVIGATION_FIXTURE)
                if missing_image and relative.as_posix() == NAVIGATION_IMAGE:
                    continue
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            if bad_anchor:
                entry = root / NAVIGATION_ENTRY
                text = entry.read_text(encoding="utf-8").replace("#字幕设置", "#不存在的锚点")
                entry.write_text(text, encoding="utf-8", newline="\n")
            subprocess.run(["git", "init", "-q"], cwd=root, check=True, capture_output=True)
            result = run_docs_check(root, "--scan-only", "--json")
            self.assertEqual(result.stderr, "")
            return result.returncode, json.loads(result.stdout)

    def test_fixed_navigation_fixture_passes(self):
        code, result = self.run_navigation_fixture()
        self.assertEqual(code, 0)
        self.assertEqual(result["issues"], [])
        self.assertEqual(result["new_links"], [])

    def test_fixed_navigation_fixture_rejects_missing_image(self):
        code, result = self.run_navigation_fixture(missing_image=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["new_links"], result["issues"])
        self.assertEqual(
            [(i["source"], i["reason"], i["resolved"], i["fragment"]) for i in result["issues"]],
            [(NAVIGATION_GUIDE, "missing-file", NAVIGATION_IMAGE, "")],
        )

    def test_fixed_navigation_fixture_rejects_bad_anchor(self):
        code, result = self.run_navigation_fixture(bad_anchor=True)
        self.assertEqual(code, 1)
        self.assertEqual(result["new_links"], result["issues"])
        self.assertEqual(
            [(i["source"], i["reason"], i["resolved"], i["fragment"]) for i in result["issues"]],
            [(NAVIGATION_ENTRY, "missing-anchor", NAVIGATION_GUIDE, "不存在的锚点")],
        )

    def test_local_images_and_chinese_anchors_resolve_through_index(self):
        texts = {
            "README.md": "[编辑](docs/INDEX.md#user-editor)",
            "docs/INDEX.md": '<a name="user-editor"></a>\n[指南](user/editor.md#字幕设置)',
            "docs/user/editor.md": "# 编辑\n## 字幕设置\n![图](../assets/view.webp)",
        }
        self.assertEqual(checker.scan(texts, set(texts) | {"docs/assets/view.webp"}), [])
        del texts["docs/user/editor.md"]
        issues = checker.scan(texts, set(texts))
        self.assertEqual([(i["source"], i["reason"]) for i in issues], [("docs/INDEX.md", "missing-file")])

    def test_reference_links_html_wiki_and_balanced_parentheses(self):
        texts = {"docs/log.md": '[输入][data]\n[data]: <data (1).md>\n<img src="shot.webp">\n![[shot.webp]]\n[同目录](data%20(1).md#section)',
                 "docs/data (1).md": "# Section"}
        self.assertEqual(checker.scan(texts, set(texts) | {"docs/shot.webp"}), [])
        issues = checker.scan(texts, set(texts))
        self.assertEqual(len(issues), 2)
        self.assertEqual({i["resolved"] for i in issues}, {"docs/shot.webp"})

    def test_code_examples_comments_and_remote_urls_are_not_local_links(self):
        text = '```md\n[example](missing.md)\n```\n<!-- [example](missing.md) -->\n`[example](missing.md)`\n[web](https://example.test/a)\n[route](/docs/)'
        self.assertEqual(checker.scan({"README.md": text}, {"README.md"}), [])

    def test_html_character_references_follow_browser_meaning_but_markdown_stays_literal(self):
        texts = {
            "docs/source.md": (
                '<a href="guide.html#part&#45;one">Guide</a>\n'
                '<a href="guide&#46;html#named-anchor">Named</a>\n'
                '<img src="../assets/photo&#46;webp">\n'
                '[Markdown](guide&amp;literal.html)'
            ),
            "docs/guide.html": '<h1 id="part-one">Guide</h1><a name="named&#45;anchor"></a>',
        }
        paths = set(texts) | {"assets/photo.webp", "docs/guide&amp;literal.html"}
        self.assertEqual(checker.scan(texts, paths), [])

    def test_fence_closer_with_non_whitespace_suffix_does_not_close(self):
        text = "```md\n[example](missing.md)\n```suffix\n[still code](missing-too.md)\n```\n[visible](exists.md)"
        self.assertEqual(list(checker.links(text)), [(6, "exists.md")])

    def test_comment_tokens_inside_code_do_not_hide_real_links(self):
        text = "```html\n<!--\n```\n[visible](missing.md)\n<!-- hidden -->\n"
        self.assertEqual(list(checker.links(text)), [(4, "missing.md")])
        self.assertEqual(list(checker.links("`<!--` [visible](missing.md)\n")), [(1, "missing.md")])
        text = "<!--\n```\n[hidden](hidden.md)\n-->\n[visible](missing.md)"
        self.assertEqual(list(checker.links(text)), [(5, "missing.md")])

    def test_multiline_code_spans_keep_real_link_line_numbers(self):
        text = "before ``code\n[hidden](missing.md)\n`` after\n[visible](exists.md)"
        self.assertEqual(list(checker.links(text)), [(4, "exists.md")])

    def test_escaped_ticks_and_paragraph_breaks_do_not_hide_links(self):
        text = r"\` literal [visible](missing.md) `code`"
        self.assertEqual(list(checker.links(text)), [(1, "missing.md")])
        text = "unmatched ` code\n\n[visible](missing.md)\n`"
        self.assertEqual(list(checker.links(text)), [(3, "missing.md")])

    def test_escaped_markdown_path_punctuation_resolves(self):
        text = r"![image](figure\(1\).webp)"
        self.assertEqual(checker.scan({"README.md": text}, {"README.md", "figure(1).webp"}), [])

    def test_setext_headings_share_the_same_anchor_counter(self):
        text = "Section\n-------\n# Section\n[heading](#section-1)"
        self.assertEqual(checker.anchors(text), {"section", "section-1"})
        self.assertEqual(checker.scan({"README.md": text}, {"README.md"}), [])

    def test_anchor_duplicates_use_github_numbered_suffixes(self):
        self.assertEqual(checker.anchors("# Repeat\n# Repeat\n# Repeat"), {"repeat", "repeat-1", "repeat-2"})
        issues = checker.scan({"README.md": "[bad](#missing)\n# Repeat"}, {"README.md"})
        self.assertEqual(issues[0]["reason"], "missing-anchor")

    def test_baseline_mapping_compares_sources_and_destinations(self):
        before = {"source": "docs/old.md", "resolved": "docs/missing.md", "fragment": "a", "reason": "missing-file"}
        after = {**before, "source": "docs/logs/old.md", "resolved": "docs/logs/missing.md"}
        mapping = {"docs/old.md": "docs/logs/old.md", "docs/missing.md": "docs/logs/missing.md"}
        self.assertEqual(checker.compare([after], [before], mapping), [])
        self.assertEqual(checker.compare([{**after, "fragment": "new"}], [before], mapping), [{**after, "fragment": "new"}])

    def test_structure_catches_unindexed_documents_consumers_and_artifacts(self):
        texts = {
            "AGENTS.md": "", "docs/README.md": '<a name="doc-policy"></a>',
            "docs/INDEX.md": '<a name="topic"></a>\n<a name="topic"></a>',
            "docs/logs/INDEX.md": "[record](unversioned/undated/log.md)", "docs/logs/CURRENT.md": "",
            "docs/logs/unversioned/undated/log.md": "[attachment](data/input.md)",
            "docs/logs/unversioned/undated/data/input.md": "evidence", "docs/user/new.md": "new guide",
            "website/scripts/sync-maw-docs.mjs": "const documents = [{source: 'docs/user/missing.md'}];",
            "scripts/docs-consumers.json": json.dumps({"paths": ["scripts/doc-examples/missing.js"]}),
        }
        errors = checker.structure(texts, set(texts) | {".artifacts/task/output.json"})
        self.assertTrue(any("duplicate topic ID" in e for e in errors))
        self.assertTrue(any("docs/user/new.md" in e for e in errors))
        self.assertTrue(any("website source missing" in e for e in errors))
        self.assertTrue(any("consumer input missing" in e for e in errors))
        self.assertTrue(any(".artifacts/" in e for e in errors))
        self.assertFalse(any("log missing" in e for e in errors))

    def test_read_tree_includes_new_files_without_modifying_git_or_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            subprocess.run(["git", "init", "-q", directory], check=True)
            (root / "README.md").write_text("[new](new.md)", encoding="utf-8")
            (root / "new.md").write_text("# New", encoding="utf-8")
            subprocess.run(["git", "add", "README.md"], cwd=root, check=True)
            status = subprocess.check_output(["git", "status", "--porcelain"], cwd=root)
            texts, paths = checker.read_tree(root)
            self.assertEqual(paths, {"README.md", "new.md"})
            self.assertEqual(checker.scan(texts, paths), [])
            self.assertEqual(subprocess.check_output(["git", "status", "--porcelain"], cwd=root), status)

    def test_unindexed_log_warns_without_failing_default_or_strict(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_docs_fixture(root, "docs/logs/release1.8.0-beta.1/字幕排查.md", "# 共享记录\n")
            for extra in ((), ("--strict",)):
                result = run_docs_check(root, *extra, "--json")
                self.assertEqual(result.returncode, 0, result.stdout)
                data = json.loads(result.stdout)
                self.assertEqual(data["structure_errors"], [])
                self.assertEqual(len(data["warnings"]), 1)
                self.assertIn("log missing from log navigation", data["warnings"][0])

    def test_key_document_still_requires_main_index(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_docs_fixture(root, "docs/plans/字幕方案.md", "# 方案\n")
            result = run_docs_check(root, "--json")
            self.assertEqual(result.returncode, 1)
            self.assertIn("independent document missing", result.stdout)

    def test_unindexed_log_with_broken_link_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_docs_fixture(root, "docs/logs/release1.8.0-beta.1/字幕排查.md", "[证据](missing.json)\n")
            result = run_docs_check(root, "--json")
            self.assertEqual(result.returncode, 1)
            data = json.loads(result.stdout)
            self.assertEqual(len(data["warnings"]), 1)
            self.assertEqual(len(data["new_links"]), 1)

    def test_topic_ids_detect_duplicates_after_html_entity_decoding(self):
        texts = {
            "AGENTS.md": "", "docs/README.md": '<a name="doc-policy"></a>',
            "docs/INDEX.md": '<a name="topic"></a>\n<a id="to&#112;ic"></a>',
            "docs/logs/INDEX.md": "", "docs/logs/CURRENT.md": "",
        }
        self.assertEqual(checker.structure(texts, set(texts)), ["duplicate topic ID: topic"])

    def test_strict_mode_fails_on_registered_historical_links_only(self):
        """用法：`python scripts/check_docs.py --strict`。

        已登记的历史断链在严格模式下同样让检查失败，并以 `strict:` 行说明数量；
        默认模式只拦截新断链，仍然通过。两种模式都会拦截新出现的断链。
        """
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_docs_fixture(root, "docs/archived/old.md", "[历史](missing.md)\n")
            default = run_docs_check(root)
            strict = run_docs_check(root, "--strict")
            self.assertEqual(default.returncode, 0, default.stdout + default.stderr)
            self.assertEqual(strict.returncode, 1, strict.stdout + strict.stderr)
            self.assertIn("strict:", strict.stdout)
            self.assertNotIn("strict:", default.stdout)
            default_json = json.loads(run_docs_check(root, "--json").stdout)
            strict_json = json.loads(run_docs_check(root, "--json", "--strict").stdout)
            self.assertEqual(default_json["existing_links"], 1)
            self.assertEqual(strict_json["existing_links"], 1)
            self.assertEqual(strict_json["new_links"], [])

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_docs_fixture(root, "docs/archived/old.md", "[历史](present.md)\n")
            (root / "docs/archived/present.md").write_text("# 存在\n", encoding="utf-8")
            strict = run_docs_check(root, "--strict")
            self.assertEqual(strict.returncode, 0, strict.stdout + strict.stderr)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            write_docs_fixture(root, "docs/archived/old.md", "[历史](missing.md)\n")
            (root / "docs/archived/new.md").write_text("[新断链](gone.md)\n", encoding="utf-8")
            for extra in ((), ("--strict",)):
                result = run_docs_check(root, *extra)
                self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                self.assertIn("gone.md", result.stdout)


def write_docs_fixture(root: Path, source: str, text: str) -> None:
    """Smallest tree whose only broken link is the registered historical one."""
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    files = {
        ".gitignore": ".artifacts/\n",
        "AGENTS.md": "",
        "docs/README.md": '<a name="doc-policy"></a>\n',
        "docs/INDEX.md": "# 索引\n",
        "docs/logs/INDEX.md": "",
        "docs/logs/CURRENT.md": "",
        source: text,
        "scripts/docs-link-exceptions.json": json.dumps({"issues": [{
            "source": source, "resolved": "docs/archived/missing.md",
            "fragment": "", "reason": "missing-file"}]}, ensure_ascii=False) + "\n",
    }
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")


def run_docs_check(root: Path, *extra: str) -> subprocess.CompletedProcess:
    """Invoke the real checker against a fixture tree, exactly as a contributor would."""
    env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    return subprocess.run([sys.executable, str(ROOT / "scripts/check_docs.py"), "--root", str(root), *extra],
                          capture_output=True, text=True, encoding="utf-8", errors="replace", env=env, timeout=30)


if __name__ == "__main__":
    unittest.main()
