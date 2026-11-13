"""CI scope rules plus real git diffs (including no-renames deletion/addition)."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import ci_impact
from tests.compact_assertions import CompactContainerAssertions

ROOT = Path(__file__).resolve().parents[1]
EDITOR = "web/editor/cues/editor-color-filter.js"


class ScopeTests(CompactContainerAssertions, unittest.TestCase):
    def test_finite_leaf_allowlist_not_directory_inference(self):
        for profile, paths in ci_impact.DOMAIN_PATHS.items():
            self.assertEqual(ci_impact.classify(sorted(paths))[0], profile)
        for paths in ([], ["web/editor/new.js"], ["web/shared/utils.js"], ["package.json"],
                      ["uv.lock"], ["tests/config/playwright.config.mjs"], ["web/editor-scripts.txt"],
                      [EDITOR, "README.md"], [EDITOR, "tools/timestamp-compare.html"],
                      ["tests/test_unknown.py"], ["web/editor/../README.md"], ["a\nb"]):
            with self.subTest(paths=paths):
                self.assertEqual(ci_impact.classify(paths)[0], "full")
        self.assertEqual(ci_impact.classify(["README.md", "docs/user/WORKFLOW.md"])[0], "light")
        self.assertEqual(ci_impact.classify(["website/public/releases/index.json"])[0], "full")

    def test_real_git_modify_delete_rename_unknown_mixed_empty_and_bad_base(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)

            def git(*args):
                return subprocess.check_output(["git", "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
                                                *args], cwd=root, stderr=subprocess.PIPE).decode().strip()

            def write(name, text):
                path = root / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(text, encoding="utf-8", newline="\n")

            def commit():
                git("add", "-A")
                git("commit", "--allow-empty", "-m", "test")
                return git("rev-parse", "HEAD")

            git("init")
            write(EDITOR, "initial\n")
            write("README.md", "initial\n")
            base = commit()
            write(EDITOR, "changed\n")
            head = commit()
            selected = ci_impact.select("pull_request", base, root)
            self.assertEqual((selected["mode"], selected["profile"], selected["base"], selected["head"], selected["trusted_diff"]),
                             ("domain", "editor", base, head, True))
            for event in ("push", "schedule", "workflow_dispatch", "release", ""):
                self.assertEqual(ci_impact.select(event, base, root)["mode"], "full")
            for invalid in ("", "HEAD", "bad", "0" * 40):
                self.assertEqual(ci_impact.select("pull_request", invalid, root)["mode"], "full")
            # Valid but stale base must not authorize a narrower matrix.
            commit()
            self.assertEqual(ci_impact.select("pull_request", base, root)["mode"], "full")
            base = git("rev-parse", "HEAD")
            commit()
            self.assertEqual(ci_impact.select("pull_request", base, root)["mode"], "full")
            base = git("rev-parse", "HEAD")
            git("mv", EDITOR, "unknown.js")
            commit()
            self.assertEqual(ci_impact.select("pull_request", base, root)["mode"], "full")
            base = git("rev-parse", "HEAD")
            write(EDITOR, "restored\n")
            commit()
            self.assertEqual(ci_impact.select("pull_request", base, root)["profile"], "editor")
            base = git("rev-parse", "HEAD")
            git("rm", EDITOR)
            commit()
            self.assertEqual(ci_impact.select("pull_request", base, root)["profile"], "editor")
            base = git("rev-parse", "HEAD")
            write(EDITOR, "mixed\n")
            write("README.md", "mixed\n")
            commit()
            self.assertEqual(ci_impact.select("pull_request", base, root)["mode"], "full")

            # Exercise the public output channel, preserving existing light.
            output = root / "output"
            plan = root / "plan.json"
            result = subprocess.run([sys.executable, str(ROOT / "scripts/ci_impact.py"), "--plan", str(plan)],
                                    cwd=root, env={**os.environ, "GITHUB_OUTPUT": str(output),
                                                   "GITHUB_EVENT_NAME": "pull_request", "PR_BASE_SHA": base},
                                    capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0)
            self.assertIn("light=false", output.read_text())
            self.assertEqual(json.loads(plan.read_text())["mode"], "full")

    def test_broken_git_and_invalid_utf8_or_unterminated_diff_are_full(self):
        for raw in (b"\xff\0", b"README.md", b"", b"\0"):
            with self.subTest(raw=raw), mock.patch.object(ci_impact.subprocess, "check_output", side_effect=[
                    b"b" * 40 + b"\n", b"a" * 40 + b"\n", raw]):
                self.assertEqual(ci_impact.select("pull_request", "a" * 40)["mode"], "full")
        with mock.patch.object(ci_impact.subprocess, "check_output", side_effect=OSError("git missing")):
            self.assertEqual(ci_impact.select("pull_request", "a" * 40)["mode"], "full")


if __name__ == "__main__":
    unittest.main()
