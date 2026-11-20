"""Concrete selection reaches execution without widening or duplicate work."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import test_workflow as workflow


def selected():
    return {"mode": "targeted", "packs": ["common", "e2e"], "tools_scope": "all", "reasons": ["test input"],
            "python_tests": ["tests/test_project_contract.py"], "node_tests": ["tests/test_editor_utils.mjs"],
            "e2e_specs": ["tests/e2e/unified-tracks.spec.mjs"],
            "preparation": {"application": True, "real_media": True, "lint": False, "preview_windows": True}}


class ConcreteWorkflowTests(unittest.TestCase):
    def test_nonempty_browser_shards_must_partition_the_full_listing(self):
        def listing(cases, shard):
            return {
                "config": {"version": "test", "shard": shard},
                "errors": [],
                "suites": [{"title": "example.spec.mjs", "specs": [
                    {"file": "example.spec.mjs", "title": title, "tests": [{"projectName": "chromium"}]}
                    for title in cases
                ]}],
            }

        for second, error in ((["B", "C"], None), (["B"], "missing"), (["A", "B", "C"], "overlapping")):
            with self.subTest(second=second), tempfile.TemporaryDirectory() as directory:
                reports = []

                def discover(name, command, timeout, report):
                    assignment = next((arg for arg in command if arg.startswith("--shard=")), None)
                    if assignment is None:
                        data = listing(["A", "B", "C"], None)
                    else:
                        index = int(assignment.split("=")[1][0])
                        data = listing(["A"] if index == 1 else second, {"current": index, "total": 2})
                    report.write_text(json.dumps(data), encoding="utf-8")
                    return {"exit_code": 0, "log": "discovery.log"}

                with mock.patch.object(workflow, "execute_browser", side_effect=discover):
                    args = ("browser-regressions", ["node", "playwright", "--shard=1/2"],
                            Path(directory), [], "e2e", reports)
                    if error:
                        with self.assertRaisesRegex(ValueError, error):
                            workflow.prepare_browser(*args)
                    else:
                        self.assertEqual(workflow.prepare_browser(*args)["config"]["shard"]["current"], 1)

    def test_single_browser_shard_discovers_the_selected_cases_once(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ):
            reports = []

            def discover(name, command, timeout, *, log_root):
                Path(os.environ["PLAYWRIGHT_JSON_OUTPUT_FILE"]).write_text(json.dumps(
                    {"config": {"shard": None if "full-discover" in name else {"current": 1, "total": 1}},
                     "errors": []}), encoding="utf-8")
                return {"exit_code": 0, "log": "discovery.log"}

            with mock.patch.object(workflow, "execute", side_effect=discover) as execute:
                workflow.prepare_browser("browser-regressions", ["node", "playwright", "--shard=1/1"],
                                         Path(directory), [], "e2e", reports)
            self.assertEqual(execute.call_count, 1)
            self.assertEqual(len(reports), 1)

    def test_concrete_targets_are_executed_once_and_layers_do_not_rebuild(self):
        plan = selected()
        steps = list(workflow.commands(plan["packs"], Path("reports"), selection=plan, specs=plan["e2e_specs"]))
        python = next(command for name, command, _ in steps if name == "python-selected")
        self.assertIn("tests/test_project_contract.py", python)
        self.assertNotIn("--pack", python)
        self.assertEqual([name for name, _, _ in steps].count("browser-regressions"), 1)
        layer = list(workflow.commands(plan["packs"], Path("reports"), selection=plan, specs=plan["e2e_specs"],
                                       layer="browser", shard=(2, 3)))
        self.assertEqual([name for name, _, _ in layer], ["browser-regressions"])
        self.assertIn("--shard=2/3", layer[0][1])
        self.assertIn("tests/e2e/unified-tracks.spec.mjs", layer[0][1])

    def test_full_browser_replaces_the_same_smoke_cases(self):
        steps = list(workflow.commands(["smoke", "editor-e2e", "common", "browser", "lifecycle", "tools"], Path("reports")))
        self.assertNotIn("editor-http-smoke", [name for name, _, _ in steps])
        targets = [arg for name, command, _ in steps if name.startswith("node-")
                   for arg in command if arg.startswith("tests/") and arg.endswith(".mjs")]
        self.assertEqual(len(targets), len(set(targets)))

    def test_website_inputs_precede_their_browser_consumer(self):
        plan = selected()
        plan["packs"].append("website")
        plan["e2e_specs"] = ["tests/e2e/editor-entry-retirement.spec.mjs"]
        for selection in (plan, None):
            packs = plan["packs"] if selection else ["website", "editor-e2e"]
            steps = list(workflow.commands(packs, Path("reports"), selection=selection, specs=plan["e2e_specs"]))
            names = [name for name, _, _ in steps]
            self.assertLess(names.index("website-build"), names.index("browser-regressions"))

    def test_release_rejects_partial_browser_shard(self):
        with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as result:
            workflow.main(["--stage", "release", "--shard", "1/2", "--plan-only"])
        self.assertEqual(result.exception.code, 2)

    def test_document_checks_do_not_expand_into_release_checks(self):
        plan = selected()
        plan.update(packs=["docs"], python_tests=["tests/test_docs_check.py"], node_tests=[], e2e_specs=[])
        plan["preparation"]["application"] = False
        steps = list(workflow.commands(plan["packs"], Path("reports"), selection=plan))
        self.assertEqual([name for name, _, _ in steps], ["docs-navigation", "python-selected"])
        plan["packs"].append("release")
        names = [name for name, _, _ in workflow.commands(plan["packs"], Path("reports"), selection=plan)]
        self.assertEqual(names, ["docs-navigation", "release-docs", "release-site", "python-selected"])

    def test_saved_plan_rejects_stale_commit_and_unsafe_or_duplicate_targets(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "plan.json"
            plan = selected()
            plan["head"] = "a" * 40
            path.write_text(json.dumps(plan), encoding="utf-8")
            with mock.patch.object(workflow.subprocess, "check_output", return_value="b" * 40):
                with self.assertRaisesRegex(ValueError, "different commit"):
                    workflow.read_selection(path)
            del plan["head"]
            plan["python_tests"] = ["tests/../scripts/test_workflow.py"]
            path.write_text(json.dumps(plan), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "concrete test path"):
                workflow.read_selection(path)
            plan["python_tests"] = ["tests/test_project_contract.py"] * 2
            path.write_text(json.dumps(plan), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "duplicate"):
                workflow.read_selection(path)

    def test_dev_defaults_to_the_actual_impact_plan(self):
        before = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            spec = root / "tests/e2e/unified-tracks.spec.mjs"
            spec.parent.mkdir(parents=True)
            spec.write_text("// concrete spec fixture\n", encoding="utf-8")
            try:
                plan = selected()
                with mock.patch.object(workflow, "ROOT", root), mock.patch.object(workflow, "select_packs", return_value=plan), \
                        mock.patch.object(workflow.subprocess, "check_output", return_value="a" * 40), \
                        contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(workflow.main(["--changed", "tests/test_project_contract.py", "--plan-only"]), 0)
                saved = json.loads(next(root.glob(".artifacts/test-workflow/*/plan.json")).read_text(encoding="utf-8"))
                self.assertEqual(saved["packs"], ["common", "e2e"])
                self.assertEqual(saved["python_tests"], ["tests/test_project_contract.py"])
            finally:
                os.chdir(before)


if __name__ == "__main__":
    unittest.main()
