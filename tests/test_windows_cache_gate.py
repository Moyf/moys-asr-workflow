from __future__ import annotations

import copy
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import textwrap
import unittest


class WindowsCacheGateTests(unittest.TestCase):
    def test_same_run_report_requires_cache_modules_and_rejects_incomplete_results(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/pr-release-windows.yml").read_text(encoding="utf-8")
        match = re.search(r"# windows-cache-report-check\n(.*?)\n          '@", workflow, re.S)
        self.assertIsNotNone(match, "Windows preview must verify its full-run cache report")
        script = textwrap.dedent(match.group(1))
        namespace = "test_thumbnail_cache.ThumbnailCacheTests.test_symlink_registration_matches_resolved_source_namespace"
        modules = ("test_thumbnail_cache", "test_thumbnail_jobs_integration", "test_thumbnail_server", "test_reapeaks_fixture")
        generated = ["test_reapeaks_fixture.GeneratedFixtureTests.test_" + source + "_generated_matches_fixture"
                     for source in ("tone30", "tone_dual", "tone_48k")]
        selected = ["tests." + namespace, *[m + ".Contract.test_valid" for m in modules[1:]], *generated]
        good = {"selected_ids": selected,
                "run": len(selected), "exit_code": 0, "failures": 0, "errors": 0, "expected_failures": 0,
                "unexpected_successes": 0, "skips": [{"id": "test_unrelated.Platform.test_posix", "reason": "platform"}]}
        scenarios = [("complete", good, True)]
        unrelated_class_skip = copy.deepcopy(good)
        unrelated_class_skip["selected_ids"].append("test_unrelated.Platform.test_other")
        unrelated_class_skip["skips"] = [{"id": "setUpClass (tests.test_unrelated.Platform)"}]
        scenarios.append(("unrelated class skip", unrelated_class_skip, True))
        for label, key, value in (("namespace skip", "skips", [{"id": "tests." + namespace}]),
                                  ("class skip", "skips", [{"id": "setUpClass (tests.test_reapeaks_fixture.GeneratedFixtureTests)"}]),
                                  ("module skip", "skips", [{"id": "unittest.loader.ModuleSkipped.test_thumbnail_server"}]),
                                  ("empty run", "run", 0), ("excess run", "run", len(selected) + 1), ("failed exit", "exit_code", 1),
                                  *[(field, field, 1) for field in ("failures", "errors", "expected_failures", "unexpected_successes")]):
            report = copy.deepcopy(good)
            report[key] = value
            scenarios.append((label, report, False))
        for label, ids in (("missing module", [item for item in selected if not item.startswith("test_thumbnail_server.")]),
                           ("missing generation", [item for item in selected if item != generated[0]]), ("empty selection", []),
                           ("missing namespace", ["test_thumbnail_cache.Other.test_valid", *good["selected_ids"][1:]]),
                           ("duplicate ids", [*good["selected_ids"], good["selected_ids"][0]])):
            report = copy.deepcopy(good)
            report["selected_ids"] = ids
            report["run"] = len(ids)
            scenarios.append((label, report, False))
        with tempfile.TemporaryDirectory() as directory:
            artifacts = Path(directory) / ".artifacts"
            artifacts.mkdir()
            for label, report, accepted in scenarios:
                with self.subTest(label=label):
                    (artifacts / "windows-python.json").write_text(json.dumps(report), encoding="utf-8")
                    result = subprocess.run([sys.executable, "-c", script], cwd=directory,
                                            capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode == 0, accepted, result.stderr[-1500:])
