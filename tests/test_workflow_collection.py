"""A failed group leaves evidence and does not short-circuit independent work."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import local_test_impact, test_workflow as workflow
from scripts.test_prerequisites import partition_command, test_requirements


class WorkflowCollectionTests(unittest.TestCase):
    def test_only_consumed_bundles_are_built_or_blocked(self):
        launcher_paths = [
            "tests/e2e/launcher-interactions.spec.mjs", "tests/e2e/launcher-zoom.spec.mjs",
            "tests/e2e/launcher-script-match-cancel.spec.mjs", "tests/e2e/shared-tooltip.spec.mjs",
            "tests/test_asr_presets_browser.mjs", "tests/test_launcher_bundle.mjs",
        ]
        editor = "tests/e2e/filmstrip-real.spec.mjs"
        mixed = "tests/e2e/layout-feedback.spec.mjs"
        static = ["tests/test_asr_presets.py", "tests/test_gui_web.py", "tests/test_packaging_contract.py"]
        cases = [(path, {"build-launcher"}) for path in launcher_paths] + [
            (editor, {"build"}), (mixed, {"build", "build-launcher"}),
            *((path, set()) for path in static),
        ]
        for path, expected in cases:
            with self.subTest(path=path):
                plan = local_test_impact.select_packs([path])
                self.assertEqual(plan["preparation"]["application"], bool(expected))
                steps = workflow.commands(plan["packs"], Path("reports"), selection=plan, specs=plan["e2e_specs"])
                self.assertEqual({name for name, _, _ in steps if name in {"build", "build-launcher"}}, expected)
                self.assertEqual(test_requirements(path, workflow.ROOT) & {"build", "build-launcher"}, expected)

    def test_launcher_path_used_only_for_text_needs_no_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = "tests/e2e/status.spec.mjs"
            (root / path).parent.mkdir(parents=True)
            (root / path).write_text(
                "const expected = 'web/launcher/index.html';\n"
                "expect(docs).toContain(expected);\n"
                "await page.goto('https://example.test');\n",
                encoding="utf-8",
            )
            with mock.patch.object(local_test_impact, "ROOT", root):
                self.assertFalse(local_test_impact.select_packs([path])["preparation"]["application"])
                self.assertNotIn("build-launcher", test_requirements(path, root))

    def test_browser_media_preparation_matches_the_selected_commands(self):
        paths = [f"tests/e2e/{name}.spec.mjs" for name in (
            "ass-cue-position", "ass-frame-preview", "ass-position-hit-order",
            "ass-preview-geometry", "sticker-preview-lifecycle",
        )]
        tool = "tests/e2e/tool-markdown.spec.mjs"
        for path in paths:
            with self.subTest(path=path):
                plan = local_test_impact.select_packs([path])
                self.assertEqual(plan["e2e_specs"], [path])
                self.assertTrue(plan["preparation"]["real_media"])
        self.assertFalse(local_test_impact.select_packs([tool])["preparation"]["real_media"])
        command = ["node", "node_modules/@playwright/test/cli.js", "test", *paths, tool]

        def requirements(path):
            return test_requirements(path, workflow.ROOT)

        runnable, blocked, _ = partition_command("browser-regressions", command, {"ffmpeg"}, workflow.ROOT, requirements)
        self.assertEqual(runnable, [*command[:3], tool])
        self.assertEqual(blocked, {path: ["ffmpeg"] for path in paths})
        runnable, blocked, _ = partition_command("browser-regressions", command, set(), workflow.ROOT, requirements)
        self.assertEqual(runnable, command)
        self.assertEqual(blocked, {})

    def test_ffmpeg_override_used_only_for_diagnostics_needs_no_media_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = "tests/e2e/status.spec.mjs"
            (root / path).parent.mkdir(parents=True)
            (root / path).write_text(
                "import { execFileSync } from 'node:child_process';\n"
                "const configured = process.env.FFMPEG_PATH || 'ffmpeg';\n"
                "const example = \"execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', [])\";\n"
                "console.log(configured);\n"
                "execFileSync('node', ['--version']);\n",
                encoding="utf-8",
            )
            with mock.patch.object(local_test_impact, "ROOT", root):
                self.assertFalse(local_test_impact.select_packs([path])["preparation"]["real_media"])
                self.assertNotIn("ffmpeg", test_requirements(path, root))

    def test_independent_real_processes_and_complete_python_failures(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            report = Path(directory)
            (report / "test_collection_fixture.py").write_text(
                "import unittest\n"
                "class Cases(unittest.TestCase):\n"
                "    def test_assertion(self):\n"
                "        self.fail('A' * 5000 + 'full assertion payload')\n"
                "    def test_exception(self):\n"
                "        raise RuntimeError('separate exception')\n",
                encoding="utf-8",
            )
            steps = [
                ("probe", [sys.executable, "-c", "raise SystemExit(37)"], 15),
                ("python-selected", [sys.executable, "scripts/run_tests.py", "--start-dir", directory], 30),
                ("later", [sys.executable, "-c", "print('ran after both failures')"], 15),
            ]

            summary = workflow.run_steps(steps, report, {}, metadata={})
            details = json.loads((report / "failures.json").read_text(encoding="utf-8"))
            self.assertEqual(summary["exit_code"], 1)
            self.assertEqual(summary["failed"], ["probe", "python-selected"])
            self.assertEqual(summary["not_run"], [])
            self.assertEqual([r["process_exit_code"] for r in summary["results"]], [37, 1, 0])
            self.assertEqual(details["report_errors"], [])
            by_id = {failure["id"]: failure for failure in details["failures"]}
            self.assertEqual(set(by_id), {"probe", "test_collection_fixture.Cases.test_assertion",
                                          "test_collection_fixture.Cases.test_exception"})
            assertion = by_id["test_collection_fixture.Cases.test_assertion"]
            self.assertTrue(assertion["error"].endswith("A" * 5000 + "full assertion payload\n"))
            self.assertTrue(Path(assertion["log"]).is_file())

    def test_preparation_only_blocks_consumers_and_report_failure_preserves_exit(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            report = Path(directory)
            invoked = []

            def execute(name, command, timeout, *, log_root):
                invoked.append(name)
                if name == "node-selected":
                    self.assertEqual([arg for arg in command if arg.startswith("tests/")], ["tests/test_browser_evidence_workflow.mjs"])
                    (report / "node-selected.xml").write_text("<testsuites/>", encoding="utf-8")
                return {"gate": name, "command": command, "status": "completed", "exit_code": 0}

            steps = [
                ("build", ["node", "scripts/build-editor.mjs", "--write"], 60),
                ("node-selected", ["node", "--test", "tests/test_type_gate.mjs", "tests/test_browser_evidence_workflow.mjs"], 60),
                ("last", [sys.executable, "-c", "pass"], 15),
            ]
            with mock.patch.object(workflow, "execute", side_effect=execute):
                summary = workflow.run_steps(steps, report, {}, metadata={}, blocked_preparation=["node-dependencies"])
            self.assertEqual(invoked, ["node-selected", "last"])
            self.assertEqual(summary["blocked"], ["build", "node-selected-blocked"])
            self.assertEqual(summary["failed"], ["node-selected"])
            self.assertEqual(summary["results"][1]["blocked_tests"], {"tests/test_type_gate.mjs": ["node-dependencies"]})
            invalid = summary["results"][2]
            self.assertEqual((invalid["process_exit_code"], invalid["exit_code"], invalid["status"]),
                             (0, 1, "invalid-required-report"))
            self.assertEqual(summary["exit_code"], 1)

    def test_partial_pack_uses_concrete_files_and_normal_discovery_reports_all_import_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            blocked = root / "test_collection_blocked.py"
            blocked.write_text("raise RuntimeError('Blocked files must not be imported')\n", encoding="utf-8")
            (root / "test_collection_load_error.py").write_text(
                "raise RuntimeError('Nonblocked import error is visible')\n", encoding="utf-8")
            (root / "test_collection_load_hook.py").write_text(
                "import unittest\n"
                "class HookCases(unittest.TestCase):\n"
                "    def test_selected(self):\n"
                "        pass\n"
                "def load_tests(loader, tests, pattern):\n"
                "    assert pattern in {None, 'test_*.py'}\n"
                "    return tests\n",
                encoding="utf-8",
            )
            report = root / "report.json"
            command = [sys.executable, "scripts/run_tests.py", "--pack", "common", "--start-dir", directory,
                       "--report", str(report)]
            environment = {**os.environ, "PYTHONPATH": str(root)}
            failed = subprocess.run([*command, "--partial-discovery", "test_collection_load_error",
                                     "test_collection_load_hook"], env=environment, capture_output=True, check=False)
            self.assertEqual(failed.returncode, 1)
            result = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(result["run"], 2)
            self.assertEqual(result["selected_ids"][1], "test_collection_load_hook.HookCases.test_selected")
            self.assertEqual([d["id"] for d in result["failure_details"]],
                             ["unittest.loader._FailedTest.test_collection_load_error"])
            unfiltered = subprocess.run(command, capture_output=True, check=False)
            self.assertEqual(unfiltered.returncode, 1)
            result = json.loads(report.read_text(encoding="utf-8"))
            self.assertEqual(result["run"], 3)
            self.assertEqual(len(result["failure_details"]), 2)

    def test_term_report_uses_prepared_python_without_blocking_static_tool_page(self):
        report = "tests/e2e/term-report.spec.mjs"
        static = "tests/e2e/tool-markdown.spec.mjs"
        plan = local_test_impact.select_packs([report, static])
        self.assertTrue(plan["preparation"]["python_dependencies"])
        self.assertFalse(plan["preparation"]["application"])
        command = ["node", "node_modules/@playwright/test/cli.js", "test", "--shard=1/1", report, static]
        runnable, blocked, _ = partition_command(
            "browser-regressions", command, {"python-dependencies"}, workflow.ROOT,
            lambda path: test_requirements(path, workflow.ROOT),
        )
        self.assertEqual(runnable, [arg for arg in command if arg != report])
        self.assertEqual(blocked, {report: ["python-dependencies"]})

    def test_node_preparation_follows_imported_helper(self):
        consumer = "tests/test_init_module_source.mjs"
        standard_library = "tests/test_browser_evidence_workflow.mjs"
        command = ["node", "--test", consumer, standard_library]
        runnable, blocked, _ = partition_command(
            "node-selected", command, {"node-dependencies"}, workflow.ROOT,
            lambda path: test_requirements(path, workflow.ROOT),
        )
        self.assertEqual(runnable, ["node", "--test", standard_library])
        self.assertEqual(blocked, {consumer: ["node-dependencies"]})

    def test_blocked_pack_reports_partial_execution_separately(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.redirect_stdout(io.StringIO()):
            root = Path(directory)
            (root / "tests").mkdir()
            for name in ("test_editor_assets.py", "test_docs_check.py"):
                (root / "tests" / name).touch()

            def requirements(path, root):
                return {"build"} if path == "tests/test_editor_assets.py" else set()

            def execute(name, command, timeout, *, log_root):
                self.assertEqual(name, "python-tools-partial")
                self.assertEqual(command[-2:], ["--partial-discovery", "tests/test_docs_check.py"])
                Path(command[command.index("--report") + 1]).write_text(
                    '{"selected_ids":["probe"],"run":1,"failure_details":[],"skips":[]}', encoding="utf-8")
                return {"gate": name, "command": command, "status": "completed", "exit_code": 0}

            steps = [("python-tools", [sys.executable, "scripts/run_tests.py", "--pack", "tools", "--report",
                                       str(root / "python-tools.json")], 90)]
            with mock.patch.object(workflow, "ROOT", root), \
                    mock.patch.object(workflow, "test_requirements", side_effect=requirements), \
                    mock.patch.object(workflow, "execute", side_effect=execute):
                summary = workflow.run_steps(steps, root, {"mode": "full"}, metadata={},
                                             blocked_preparation=["build"])
            self.assertEqual(summary["blocked"], ["python-tools-discovery"])
            self.assertEqual(summary["results"][0]["blocked_discovery"], {"tests/test_editor_assets.py": ["build"]})
            self.assertNotIn("blocked_tests", summary["results"][0])
            self.assertEqual(summary["results"][1]["partial_for"], "python-tools")
            self.assertEqual(summary["exit_code"], 1)

    def test_evidence_directory_uses_resolved_root_name_and_allows_external_path(self):
        before = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "workspace"
            (root / "alias").mkdir(parents=True)
            plan = {"mode": "targeted", "packs": [], "e2e_specs": [], "preparation": {}}
            try:
                with mock.patch.object(workflow, "ROOT", root / "alias" / ".."), \
                        mock.patch.object(workflow, "select_packs", return_value=plan), \
                        mock.patch.object(workflow.subprocess, "check_output", return_value="a" * 40), \
                        contextlib.redirect_stdout(io.StringIO()) as output:
                    self.assertEqual(workflow.main(["--changed", "README.md", "--plan-only"]), 0)
                    self.assertEqual(workflow.main(["--changed", "README.md", "--plan-only",
                                                    "--report-dir", str(Path(directory) / "outside")]), 0)
                lines = [line for line in output.getvalue().splitlines() if line.startswith("Evidence: ")]
                self.assertTrue(lines[0].startswith(f"Evidence: {Path('.artifacts/test-workflow')}{os.sep}"))
                self.assertEqual(lines[1], f"Evidence: {(Path(directory) / 'outside').resolve()}")
            finally:
                os.chdir(before)
