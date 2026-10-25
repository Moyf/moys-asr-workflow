"""Windows must verify real silence-boundary tests in its existing full report."""
from __future__ import annotations

from contextlib import redirect_stdout
import copy
import io
import json
import os
from pathlib import Path
import re
import tempfile
import textwrap
import unittest


class WindowsEnergyGateTests(unittest.TestCase):
    def test_windows_release_verifies_the_same_full_report_with_test_dependencies(self):
        root = Path(__file__).resolve().parents[1]
        workflows = root / ".github/workflows"
        preview = (workflows / "pr-release-windows.yml").read_text(encoding="utf-8")
        release = (workflows / "release.yml").read_text(encoding="utf-8")
        windows = release.split("  build-aux:", 1)[0]
        marker = r"# windows-energy-valley-report-check\n(.*?)\n          '@"
        preview_script = re.search(marker, preview, re.S)
        release_script = re.search(marker, windows, re.S)
        self.assertIsNotNone(release_script, "Windows release must verify silence boundaries before packaging")
        self.assertIsNotNone(preview_script)
        self.assertEqual(textwrap.dedent(release_script.group(1)), textwrap.dedent(preview_script.group(1)))
        self.assertIn("uv sync --group build --frozen --group test", windows)
        self.assertIn("scripts/run_tests.py --report .artifacts/windows-python.json", windows)
        self.assertNotIn("scripts/run_tests.py tests.test_energy_valley", windows)
        preserve = windows[windows.index("- name: Preserve complete Python report"):]
        preserve = preserve.split("\n      - name:", 1)[0]
        self.assertIn("if: always()", preserve)
        self.assertIn(".artifacts/windows-python.json", preserve)
        self.assertIn(".artifacts/windows-python.log", preserve)

    def test_same_run_gate_requires_real_algorithms_and_rejects_dependency_skips(self):
        root = Path(__file__).resolve().parents[1]
        workflow = (root / ".github/workflows/pr-release-windows.yml").read_text(encoding="utf-8")
        match = re.search(r"# windows-energy-valley-report-check\n(.*?)\n          '@", workflow, re.S)
        self.assertIsNotNone(match, "Windows preview must verify silence-boundary coverage from its full report")
        script = compile(textwrap.dedent(match.group(1)), "windows-energy-valley-report-check", "exec")
        classes = ("RmsEnvelopeTests", "SnapBoundaryTests", "AudioDependencyDegradationTests")
        selected = [f"tests.test_energy_valley.{name}.test_behavior" for name in classes]
        good = {"selected_ids": selected, "run": len(selected), "exit_code": 0,
                "failures": 0, "errors": 0, "expected_failures": 0, "unexpected_successes": 0, "skips": []}
        scenarios = [("complete", good, True)]
        for name in classes:
            report = copy.deepcopy(good)
            report["selected_ids"] = [identity for identity in selected if f".{name}." not in identity]
            report["run"] = len(report["selected_ids"])
            scenarios.append((f"missing {name}", report, False))
        for label, key, value in (
            ("missing module", "selected_ids", []), ("duplicate IDs", "selected_ids", selected + selected[:1]),
            ("empty run", "run", 0), ("failed exit", "exit_code", 1),
            *[(key, key, 1) for key in ("failures", "errors", "expected_failures", "unexpected_successes")],
            ("dependency skip", "skips", [{"id": selected[0], "reason": "numpy and soundfile are required"}]),
            ("class skip", "skips", [{"id": "setUpClass (tests.test_energy_valley.SnapBoundaryTests)"}]),
            ("module skip", "skips", [{"id": "unittest.loader.ModuleSkipped.test_energy_valley"}]),
        ):
            report = copy.deepcopy(good)
            report[key] = value
            scenarios.append((label, report, False))
        cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            artifacts = Path(directory) / ".artifacts"
            artifacts.mkdir()
            try:
                os.chdir(directory)
                for label, report, accepted in scenarios:
                    with self.subTest(label=label):
                        (artifacts / "windows-python.json").write_text(json.dumps(report), encoding="utf-8")
                        with redirect_stdout(io.StringIO()):
                            try:
                                exec(script, {"__name__": "__main__"})
                            except AssertionError:
                                actual = False
                            else:
                                actual = True
                        self.assertEqual(actual, accepted, label)
            finally:
                os.chdir(cwd)
