"""Documentation checks catch broken targets without executing any consumer."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

from tests.compact_assertions import CompactContainerAssertions

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("docs_check", ROOT / "scripts/check_docs.py")
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


class DocumentationCheckTests(CompactContainerAssertions, unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
