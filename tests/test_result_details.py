"""Regression examples for the native Node and Playwright failure formats."""
import json
from pathlib import Path
import tempfile
import unittest

from scripts.test_result_details import collect_failures


class ResultDetailsTests(unittest.TestCase):
    def test_node_reads_every_failure_and_required_skip(self):
        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "node.xml"
            report.write_text(
                '<testsuites><testsuite name="selected">'
                '<testcase name="parent then child" classname="file"><failure message="summary">'
                'AssertionError: actual &lt; expected\n    at case.mjs:12</failure></testcase>'
                '<testcase name="dependency skip"><skipped message="missing capability"/></testcase>'
                '<testcase name="unhandled"><error message="another error"/></testcase>'
                '<testcase name="passing"/>'
                "</testsuite></testsuites>",
                encoding="utf-8",
            )
            result = {"gate": "node-selected", "status": "completed", "process_exit_code": 7, "exit_code": 7}
            details = collect_failures(result, node_report=report)
        self.assertTrue(details["complete"])
        self.assertEqual([(item["id"], item["kind"], item["error"]) for item in details["failures"]], [
            ("file::parent then child", "failure", "AssertionError: actual < expected\n    at case.mjs:12"),
            ("dependency skip", "skipped", "missing capability"),
            ("unhandled", "error", "another error"),
        ])

    def test_browser_lists_native_errors_and_cases_missing_from_execution(self):
        def spec(title, status, *errors):
            return {"file": "example.spec.mjs", "title": title, "tests": [{
                "projectName": "chromium", "results": [{"status": status, "retry": 0, "errors": list(errors)}],
                "expectedStatus": "passed", "status": "expected" if status == "passed" else "unexpected",
            }]}

        with tempfile.TemporaryDirectory() as directory:
            report = Path(directory) / "browser.json"
            listing = Path(directory) / "browser-list.json"
            failed = spec("first failure", "failed", {"message": "first full message", "stack": "first full stack"})
            timed_out = spec("second failure", "timedOut", {"message": "timed out"})
            executed = [failed, timed_out, spec("already passed", "passed")]
            report.write_text(json.dumps({"errors": [{"message": "worker error"}],
                                          "suites": [{"specs": executed}]}), encoding="utf-8")
            listing.write_text(json.dumps({"suites": [{"specs": [*executed, spec("never ran", "passed")]}]}), encoding="utf-8")
            details = collect_failures(
                {"gate": "browser-regressions", "status": "completed", "process_exit_code": 1, "exit_code": 1},
                browser_report=report, browser_listing=listing,
            )
        self.assertFalse(details["complete"])
        self.assertEqual([item["kind"] for item in details["failures"]], ["error", "browser", "browser", "not_run"])
        self.assertEqual(details["failures"][1]["error"]["errors"][0]["stack"], "first full stack")
        self.assertEqual(details["failures"][3]["id"], "example.spec.mjs::never ran [chromium]")
