"""Meaningful conflict / preservation fixtures. Disposable repositories remain in .worktrees."""
from __future__ import annotations

import importlib.util
from pathlib import Path
import subprocess
import unittest
import uuid


def module(name, file):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(file))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


replay = module("esm_replay", "rehearse-upstream.py")
objects = module("esm_git_objects", "fetch-github-objects.py")
production = module("esm_production", "rehearse-production.py")
ROOT = Path(__file__).resolve().parents[2]


class ReviewedProductionHunks(unittest.TestCase):
    def test_type_adapter_refuses_primary_workspace(self):
        result = subprocess.run(['node', ROOT / 'scripts/esm-mechanical/adapt-production-types.mjs', ROOT,
                                 '180', '40d8cca5288d0fd8890f71e54d248eb9ae856088'],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b'disposable', result.stderr)

    def test_exact_hunks_preserve_unrelated_content(self):
        text = 'before\n<<<<<<< ours\nold typed\n=======\nnew business\n>>>>>>> theirs\nafter\n'
        rules = [{"ours": "old typed\n", "theirs": "new business\n", "replacement": "new typed business\n"}]
        self.assertEqual(production.resolve_text(text, rules), 'before\nnew typed business\nafter\n')
        for changed in (text.replace('new business', 'different business'), text.replace('old typed', 'fork logic'), text + text):
            with self.assertRaises(RuntimeError):
                production.resolve_text(changed, rules)
        with self.assertRaises(RuntimeError):
            production.resolve_text(text, [])

    def test_resolutions_require_exact_head_and_all_conflict_paths(self):
        attempt = {"conflicts": ["web/one.js"]}
        for definition in ({"head": "wrong", "files": {"web/one.js": []}}, {"head": "expected", "files": {}}):
            with self.assertRaises(RuntimeError):
                production.resolve_reviewed(None, attempt, definition, 'expected')


class MergeFixtures(unittest.TestCase):
    def setUp(self):
        self.folder = ROOT / ".worktrees" / ("esm-merge-fixture-" + uuid.uuid4().hex)
        self.repository = self.folder / "objects"
        self.repository.mkdir(parents=True)
        replay.run(["git", "init", "--initial-branch=codex/fixture", self.repository])
        for key in ("user.name", "user.email"):
            value = replay.decode(replay.git(ROOT, "config", "--get", key))
            replay.git(self.repository, "config", key, value)
        replay.git(self.repository, "commit", "--allow-empty", "-m", "Isolated merge fixture")
        self.initial = replay.decode(replay.git(self.repository, "rev-parse", "HEAD"))

    def commit(self, content, parent=None, extra=None):
        target = self.folder / ("case-" + uuid.uuid4().hex)
        replay.export_tree(self.repository, parent or self.initial, target)
        path = target / "web/example.js"
        path.parent.mkdir(exist_ok=True)
        path.write_text(content, encoding="utf-8", newline="\n")
        for name, text in (extra or {}).items():
            p = target / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding="utf-8", newline="\n")
        # Reuse the real separate-index path, with the consumer files absent in
        # this small fixture: stage exactly the fixture paths ourselves.
        import os
        env = dict(os.environ, GIT_INDEX_FILE=str(target / "fixture.index"))
        command = ["git", f"--git-dir={self.repository / '.git'}", f"--work-tree={target}"]
        replay.run(command + ["read-tree", parent or self.initial], env=env)
        replay.run(command + ["add", "-A", "--", "web"], env=env)
        tree = replay.decode(replay.run(command + ["write-tree"], env=env))
        return replay.commit_tree(self.repository, tree, parent or self.initial, "Isolated merge fixture version")

    def test_transformation_conflict_disappears_at_same_representation(self):
        classic = self.commit("function value() { return 1; }\n")
        ours = self.commit("export function value() { return 1; }\n", classic)
        incoming = self.commit("function value() { return 2; }\n", classic)
        self.assertEqual(replay.merge(self.repository, ours, incoming)["conflicts"], ["web/example.js"])
        projected = self.commit("export function value() { return 2; }\n", classic,
                                {"web/added.js": "export const added = true;\n"})
        result = replay.project_merge(self.repository, ours, ours, projected, "project")
        self.assertTrue(result["clean"])
        self.assertIn("return 2", replay.decode(replay.git(self.repository, "show", result["tree"] + ":web/example.js")))
        self.assertIn("added", replay.decode(replay.git(self.repository, "show", result["tree"] + ":web/added.js")))

    def test_nonoverlapping_fork_changes_survive_and_bundle_is_not_text_merged(self):
        text = "export function upstream() { return 1; }\n" + "\n" * 10 + "export function fork() { return 1; }\n"
        base = self.commit(text, extra={"web/editor/boot/editor-bundle.js": "old generated\n"})
        fork = self.commit(text.replace("fork() { return 1", "fork() { return 3"), base,
                           {"web/editor/boot/editor-bundle.js": "fork generated\n"})
        incoming = self.commit(text.replace("upstream() { return 1", "upstream() { return 2"), base,
                               {"web/editor/boot/editor-bundle.js": "incoming generated\n"})
        result = replay.project_merge(self.repository, base, fork, incoming, "preserve")
        self.assertTrue(result["clean"])
        merged = replay.decode(replay.git(self.repository, "show", result["tree"] + ":web/example.js"))
        self.assertIn("upstream() { return 2", merged)
        self.assertIn("fork() { return 3", merged)
        self.assertEqual(replay.decode(replay.git(self.repository, "ls-tree", result["tree"], "web/editor/boot/editor-bundle.js")), "")

    def test_same_logic_changed_on_both_sides_stays_a_conflict(self):
        base = self.commit("export function value() { return 1; }\n")
        fork = self.commit("export function value() { return 3; }\n", base)
        incoming = self.commit("export function value() { return 2; }\n", base)
        result = replay.project_merge(self.repository, base, fork, incoming, "real-conflict")
        self.assertFalse(result["clean"])
        self.assertEqual(result["conflicts"], ["web/example.js"])

    def test_original_classic_conflict_is_not_hidden(self):
        base = self.commit("function value() { return 1; }\n")
        fork = self.commit("function value() { return 3; }\n", base)
        incoming = self.commit("function value() { return 2; }\n", base)
        self.assertFalse(replay.merge(self.repository, fork, incoming)["clean"])

    def test_sequential_replays_keep_both_parents_and_do_not_invent_conflicts(self):
        base = self.commit("function value() { return 1; }\n")
        first = self.commit("function value() { return 2; }\n", base)
        second = self.commit("function value() { return 3; }\n", first)
        attempt = replay.merge(self.repository, base, first)
        wrong = replay.commit_tree(self.repository, attempt["tree"], base, "Isolated counterexample without upstream parent")
        self.assertFalse(replay.merge(self.repository, wrong, second)["clean"])
        correct = replay.commit_tree(self.repository, attempt["tree"], [base, first], "Isolated merge preserving both parents")
        self.assertEqual(replay.decode(replay.git(self.repository, "merge-base", correct, second)), first)
        self.assertTrue(replay.merge(self.repository, correct, second)["clean"])

    def test_export_refuses_overwrite(self):
        target = self.folder / "existing"
        target.mkdir()
        sentinel = target / "sentinel.txt"
        sentinel.write_text("keep\n", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            replay.export_tree(self.repository, self.initial, target)
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep\n")

    def test_repository_guard_rejects_shared_git_directory(self):
        from unittest.mock import patch
        replay.validate_isolated_repository(self.repository)
        fake = subprocess.CompletedProcess([], 0, stdout=str(ROOT / '.git').encode(), stderr=b'')
        with patch.object(replay, 'git', return_value=fake), self.assertRaises(RuntimeError):
            replay.validate_isolated_repository(self.repository)

    def test_manifest_is_validated_before_source_content_reads(self):
        root = self.folder / "manifest-case"
        web = root / "web"
        web.mkdir(parents=True)
        (web / "a.js").write_text("const a = 1;\n", encoding="utf-8")
        manifest = web / "editor-scripts.txt"
        manifest.write_text("a.js\n", encoding="utf-8")
        self.assertEqual(replay.validate_editor_manifest(root), ["a.js"])
        for value in ("", "a.js\na.js\n", "../outside.js\n", ".env\n", "absent.js\n"):
            manifest.write_text(value, encoding="utf-8")
            with self.subTest(value=value), self.assertRaises(RuntimeError):
                replay.validate_editor_manifest(root)


class SafetyFixtures(unittest.TestCase):
    def test_additive_python_merge_keeps_both_new_tests_and_old_body(self):
        base = "class Tests:\n    def old(self):\n        return 1\n"
        ours = base.replace("    def old", "    def first(self):\n        return 2\n\n    def old")
        theirs = base.replace("    def old", "    def second(self):\n        return 3\n\n    def old")
        merged = replay.additive_text(base, ours, theirs, "tests/a.py")
        self.assertIn("def first", merged)
        self.assertIn("def second", merged)
        self.assertIn("def old(self):\n        return 1", merged)

    def test_additive_merge_refuses_replacing_existing_logic(self):
        base = "def old():\n    return 1\n"
        with self.assertRaises(RuntimeError):
            replay.additive_text(base, base.replace("return 1", "return 2"), base, "tests/a.py")

    def test_additive_merge_refuses_inserting_into_old_function_or_duplicate_names(self):
        base = "def old():\n    return 1\n"
        with self.assertRaises(RuntimeError):
            replay.additive_text(base, base.replace("    return", "    print('changed')\n    return"), base, "tests/a.py")
        with self.assertRaises(RuntimeError):
            replay.additive_text(base, "def added():\n    return 2\n" + base,
                                "def added():\n    return 3\n" + base, "tests/a.py")

    def test_additive_markdown_keeps_both_features_and_refuses_js(self):
        merged = replay.additive_text("# Features\n", "# Features\n- A\n", "# Features\n- B\n", "CHANGELOG.md")
        self.assertEqual(merged, "# Features\n- A\n- B\n")
        with self.assertRaises(RuntimeError):
            replay.additive_text("", "one", "two", "web/a.js")

    def test_sensitive_and_escaping_paths_are_rejected_before_content_reads(self):
        for path in (".env", "nested/.env", "../outside", "/outside"):
            with self.subTest(path=path), self.assertRaises(RuntimeError):
                replay.validate_export_paths([path])
        replay.validate_export_paths(["web/a.js", "tests/a.mjs"])

    def test_rest_timezone_recovery_requires_exact_original_hash(self):
        meta = {"tree": {"sha": "1" * 40}, "parents": [], "message": "fixture",
                "author": {"name": "Maintainer", "email": "fixture@example.invalid", "date": "2026-10-08T00:00:00Z"},
                "committer": {"name": "Maintainer", "email": "fixture@example.invalid", "date": "2026-10-08T00:00:00Z"}}
        raw = ("tree " + "1" * 40 + "\nauthor Maintainer <fixture@example.invalid> 1791417600 +0800\n"
               "committer Maintainer <fixture@example.invalid> 1791417600 -0700\n\nfixture\n").encode()
        meta["sha"] = objects.object_hash("commit", raw)
        self.assertEqual(objects.commit_payload(meta), raw)
        meta["sha"] = "0" * 40
        with self.assertRaises(RuntimeError):
            objects.commit_payload(meta)


if __name__ == "__main__":
    unittest.main()
