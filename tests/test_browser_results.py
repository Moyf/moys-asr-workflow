import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from scripts import browser_results


def fixture(file="example.spec.mjs", title="passes", *, skip=False):
    test = {"projectName": "chromium", "expectedStatus": "skipped" if skip else "passed",
            "status": "skipped" if skip else "expected", "annotations": [],
            "results": [{"retry": 0, "status": "skipped" if skip else "passed"}]}
    if skip:
        test["annotations"] = [{"type": "skip", "description": browser_results.PORTABLE_REASON}]
    actual = {"config": {"shard": {"current": 1, "total": 4}}, "errors": [],
              "suites": [{"title": file, "line": 0, "specs": [{"file": file, "title": title, "tests": [test]}]}],
              "stats": {"expected": int(not skip), "skipped": int(skip), "unexpected": 0, "flaky": 0}}
    listed = copy.deepcopy(actual)
    listed_test = listed["suites"][0]["specs"][0]["tests"][0]
    listed_test.update(results=[], expectedStatus="passed", annotations=[])
    return listed, actual


class BrowserResultsTests(unittest.TestCase):
    def test_same_job_collection_and_exact_five_portable_skips(self):
        self.assertEqual(browser_results.validate(*fixture(), 1, 4)["passed"], 1)
        self.assertEqual(len(browser_results.PORTABLE_SKIPS), 5)
        for file, title in browser_results.PORTABLE_SKIPS:
            result = browser_results.validate(*fixture(file, title[0], skip=True), 1, 4)
            self.assertEqual(len(result["skips"]), 1)

    def test_positive_stats_cannot_hide_semantically_bad_outcomes(self):
        mutations = {
            "missing": lambda r, t: r["suites"].clear(),
            "duplicate": lambda r, t: r["suites"].append(copy.deepcopy(r["suites"][0])),
            "wrong-case": lambda r, t: r["suites"][0]["specs"][0].update(title="other"),
            "global-error": lambda r, t: r["errors"].append({"message": "worker crash"}),
            "wrong-shard": lambda r, t: r["config"].update(shard={"current": 2, "total": 4}),
            "flaky": lambda r, t: t.update(status="flaky"),
            "retry": lambda r, t: t["results"][0].update(retry=1),
            "repeat": lambda r, t: t["results"].append(copy.deepcopy(t["results"][0])),
            "missing-result": lambda r, t: t["results"].clear(),
            "xfail": lambda r, t: t.update(expectedStatus="failed"),
            "fixme": lambda r, t: t["annotations"].append({"type": "fixme"}),
            "failure": lambda r, t: t["results"][0].update(status="failed"),
            "stats-lie": lambda r, t: r["stats"].update(expected=2),
            "capability-skip": lambda r, t: t.update(expectedStatus="skipped", status="skipped",
                results=[{"status": "skipped", "retry": 0}],
                annotations=[{"type": "skip", "description": "Requires a libass-enabled FFmpeg"}]),
        }
        for name, mutate in mutations.items():
            with self.subTest(name=name):
                listed, actual = fixture()
                mutate(actual, actual["suites"][0]["specs"][0]["tests"][0])
                with self.assertRaises(ValueError):
                    browser_results.validate(listed, actual, 1, 4)

    def test_portable_exemption_is_not_a_file_title_or_reason_wildcard(self):
        file, title = next(iter(browser_results.PORTABLE_SKIPS))
        for f, t in (("other.spec.mjs", title[0]), (file, "nested " + title[0])):
            with self.assertRaises(ValueError):
                browser_results.validate(*fixture(f, t, skip=True), 1, 4)
        listed, actual = fixture(file, title[0], skip=True)
        actual["suites"][0]["specs"][0]["tests"][0]["annotations"][0]["description"] += " extra"
        with self.assertRaises(ValueError):
            browser_results.validate(listed, actual, 1, 4)

    def test_nested_titles_are_part_of_identity(self):
        listed, actual = fixture()
        for report in (listed, actual):
            suite = report["suites"][0]
            suite["suites"] = [{"title": "describe", "line": 1, "specs": suite.pop("specs")}]
        self.assertEqual(browser_results.validate(listed, actual, 1, 4)["passed"], 1)
        actual["suites"][0]["suites"][0]["title"] = "wrong describe"
        with self.assertRaises(ValueError):
            browser_results.validate(listed, actual, 1, 4)

    def test_real_cli_missing_or_corrupt_report_cannot_pass(self):
        script = Path(browser_results.__file__).resolve()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            listed, actual = fixture()
            (root / "list.json").write_text(json.dumps(listed), encoding="utf-8")
            command = [sys.executable, str(script), str(root / "list.json"), str(root / "actual.json"),
                       "--current", "1", "--total", "4"]
            for contents in (None, "{broken", json.dumps(actual)):
                if contents is not None:
                    (root / "actual.json").write_text(contents, encoding="utf-8")
                outcome = subprocess.run(command, capture_output=True, timeout=10)
                self.assertEqual(outcome.returncode == 0, contents == json.dumps(actual))


if __name__ == "__main__":
    unittest.main()
