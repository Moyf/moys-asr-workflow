import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from scripts import ci_impact, ci_matrix
from scripts.test_policy import python_pack
from scripts.run_tests import build_suite, cases, filter_pack
from tests.compact_assertions import CompactContainerAssertions

ROOT = Path(__file__).resolve().parents[1]


def gate_fixture(profile):
    plan = ci_impact.plan(profile, "test", base="a" * 40, head="b" * 40, trusted=True)
    needs = {"selection": {"result": "success", "outputs": {"mode": plan["mode"], "plan": json.dumps(plan)}},
             "full-tests": {"result": "success" if profile == "full" else "skipped"},
             "browser": {"result": "skipped" if profile == "light" else "success"}}
    receipts = [{"cell": cell["cell"], "fingerprint": ci_matrix.fingerprint(plan), "status": "success",
                 "reports": {name: {"validated": True, "required": required}
                             for name, required in (("python.json", False), ("media-required.json", True))}
                 if cell["layer"] == "python" else {}}
                for cell in ci_matrix.cells(plan)]
    return plan, needs, receipts


MEDIA_ID = "tests.test_fcp7_png.RenderTests.test_fixture"
COMMON_ID = "tests.test_common.Case.test_private_fixture"


def python_fixture(*, full=False):
    return {"selected_ids": [MEDIA_ID, COMMON_ID] if full else [MEDIA_ID], "run": 2 if full else 1,
            "failures": 0, "errors": 0, "expected_failures": 0, "unexpected_successes": 0,
            "exit_code": 0, "skips": []}


class TestMatrixTests(CompactContainerAssertions, unittest.TestCase):
    def test_finite_plans_and_explicit_intentional_skips(self):
        for profile in ci_impact.PROFILES:
            plan, needs, receipts = gate_fixture(profile)
            ci_matrix.gate(plan, needs, receipts)
            self.assertEqual(len(receipts), 12 if profile == "full" else 0 if profile == "light" else 2)

    def test_gate_negative_controls(self):
        for profile in ci_impact.PROFILES:
            for job in ("selection", "full-tests", "browser"):
                for bad in ("failure", "cancelled", "", "skipped", "success"):
                    plan, needs, receipts = gate_fixture(profile)
                    if needs[job]["result"] == bad:
                        continue
                    needs[job]["result"] = bad
                    with self.subTest(profile=profile, job=job, bad=bad), self.assertRaises(ValueError):
                        ci_matrix.gate(plan, needs, receipts)
        for mutate in (lambda r: r.pop(), lambda r: r.append(copy.deepcopy(r[0])),
                       lambda r: r[0].update(status="skipped"), lambda r: r[0].update(fingerprint="other"),
                       lambda r: r[0].pop("reports")):
            plan, needs, receipts = gate_fixture("full")
            mutate(receipts)
            with self.assertRaises(ValueError):
                ci_matrix.gate(plan, needs, receipts)

    def test_bad_selector_cannot_green(self):
        for key, value in (("mode", "domain"), ("profile", "unknown"), ("version", 2),
                           ("head", "bad"), ("light", "false"), ("trusted_diff", False)):
            plan, needs, receipts = gate_fixture("editor")
            plan[key] = value
            if key == "mode":
                plan[key] = "full"
            with self.subTest(key=key), self.assertRaises(ValueError):
                ci_matrix.gate(plan, needs, receipts)
        plan, needs, receipts = gate_fixture("light")
        needs["selection"]["outputs"]["plan"] = "{}"
        with self.assertRaises(ValueError):
            ci_matrix.gate(plan, needs, receipts)

    def test_public_gate_rejects_missing_receipts_bad_plan_and_bad_workflow_head(self):
        script = Path(ci_matrix.__file__).resolve()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            plan, needs, receipts = gate_fixture("full")
            ci_matrix.write_json(root / "plan.json", plan)
            command = [sys.executable, str(script), "gate", "--plan", str(root / "plan.json"), "--root", str(root)]
            env = {**os.environ, "CI_NEEDS": json.dumps(needs), "GITHUB_SHA": plan["head"]}
            self.assertNotEqual(subprocess.run(command, env=env, capture_output=True, timeout=10).returncode, 0)
            for n, receipt in enumerate(receipts):
                ci_matrix.write_json(root / str(n) / "receipt.json", receipt)
            self.assertEqual(subprocess.run(command, env=env, capture_output=True, timeout=10).returncode, 0)
            env["GITHUB_SHA"] = "c" * 40
            self.assertNotEqual(subprocess.run(command, env=env, capture_output=True, timeout=10).returncode, 0)
            ci_matrix.write_json(root / "plan.json", {"mode": "light"})
            self.assertNotEqual(subprocess.run(command, env=env, capture_output=True, timeout=10).returncode, 0)

    def test_fcp7_real_render_ownership_preserves_standard_discovery(self):
        suite = build_suite(["tests.test_fcp7_png", "tests.test_fcp7_png_api"], str(ROOT / "tests"), "test_*.py")
        ids = [c.id() for c in cases(suite)]
        media = [c.id() for c in cases(filter_pack(suite, "media"))]
        expected = [i for i in ids if ".RenderTests." in i or i.endswith(
            ".PngJobHttpTests.test_render_publish_and_repeated_export_preserve_prior_package")]
        self.assertTrue(expected)
        self.assertEqual(media, expected)
        self.assertEqual(len(ids), len(set(ids)))
        self.assertEqual(python_pack("tests.test_fcp7_png.MatteTests.test_missing_glyph_stops_render_before_publishing_boxes"), "common")
        self.assertEqual(python_pack("tests.test_new.NewTests.test_new"), "common")
        self.assertEqual(python_pack("tests.test_other.RenderTests.test_fake"), "common")

    def test_public_consumer_rechecks_non_pr_event_not_only_selector_or_sha(self):
        script = Path(ci_matrix.__file__).resolve()
        with tempfile.TemporaryDirectory() as temporary:
            for profile in ("full", "tools", "light"):
                root = Path(temporary) / profile
                plan, needs, receipts = gate_fixture(profile)
                ci_matrix.write_json(root / "plan.json", plan)
                for n, receipt in enumerate(receipts):
                    ci_matrix.write_json(root / str(n) / "receipt.json", receipt)
                for event in ("pull_request", "push", "schedule", "workflow_dispatch", "release", ""):
                    env = {**os.environ, "GITHUB_EVENT_NAME": event, "GITHUB_SHA": plan["head"],
                           "CI_NEEDS": json.dumps(needs), "GITHUB_OUTPUT": str(root / "outputs")}
                    for action in ("gate", "expand"):
                        command = [sys.executable, str(script), action, "--plan", str(root / "plan.json"), "--root", str(root)]
                        outcome = subprocess.run(command, env=env, capture_output=True, timeout=10)
                        with self.subTest(profile=profile, event=event, action=action):
                            self.assertEqual(outcome.returncode == 0,
                                             profile == "full" or event in {"", "pull_request"},
                                             outcome.stderr.decode()[-700:])
                            if outcome.returncode:
                                self.assertIn(b"non-PR workflow event requires a full CI plan", outcome.stderr)

    def test_workflow_keeps_additive_cross_platform_discovery(self):
        workflow = (ROOT / ".github/workflows/test-matrix.yml").read_text(encoding="utf-8")
        self.assertIn("schedule:", workflow)
        self.assertIn("tags: ['v*']", workflow)
        self.assertEqual(workflow.count("timeout-minutes: 15"), 2)
        self.assertEqual(workflow.count("fail-fast: false"), 2)
        self.assertIn("needs: [selection, full-tests, browser]", workflow)
        self.assertIn("if: always()", workflow)
        release = (ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")
        self.assertEqual(release.count("--report .artifacts/release-python.json --github-summary"), 2)
        self.assertIn("needs: [build-windows, build-aux]", release)
        self.assertNotIn("test-matrix-required", release)
        self.assertIn("install-browser: ${{ matrix.layer != 'python' && 'true' || 'false' }}", workflow)
        setup = (ROOT / ".github/actions/test-environment/action.yml").read_text(encoding="utf-8")
        self.assertIn("default: 'true'", setup)
        self.assertIn("if: inputs.install-browser == 'true'", setup)

    def test_python_report_accounting_and_required_platform_recalculation(self):
        full = python_fixture(full=True)
        full["skips"] = [{"id": COMMON_ID, "reason": "private fixture", "platform_not_applicable": False}]
        self.assertEqual(ci_matrix.validate_python_report(full, required=False)["skips"], 1)
        with self.assertRaises(ValueError):
            ci_matrix.validate_python_report(full, required=True)
        full["skips"][0]["platform_not_applicable"] = True
        with self.assertRaises(ValueError):
            ci_matrix.validate_python_report(full, required=True)
        full["skips"] = []
        full["expected_failures"] = 1
        self.assertEqual(ci_matrix.validate_python_report(full, required=False)["expected_failures"], 1)
        with self.assertRaises(ValueError):
            ci_matrix.validate_python_report(full, required=True)
        if os.name == "nt":
            guard = "tests.test_gui_web.GuiWebBridgeTests.test_open_existing_path_uses_external_opener_for_file_and_folder"
            reason = "Non-Windows paths use the external opener"
        else:
            guard = "tests.test_ffmpeg.FfmpegResolverTests.test_windows_python_module_does_not_shadow_path_executables"
            reason = "Windows PATHEXT resolution"
        report = python_fixture()
        report["selected_ids"] = [guard]
        report["skips"] = [{"id": guard, "reason": reason, "platform_not_applicable": False}]
        self.assertEqual(ci_matrix.validate_python_report(report, required=True)["skips"], 1)
        report["skips"][0].update(reason="missing libass", platform_not_applicable=True)
        with self.assertRaises(ValueError):
            ci_matrix.validate_python_report(report, required=True)

    def test_python_invalid_collections_counts_and_outcomes_rejected(self):
        mutations = [lambda r: r.update(selected_ids=[]), lambda r: r["selected_ids"].append(MEDIA_ID),
                     lambda r: r.update(selected_ids=[None]), lambda r: r.update(selected_ids=["\n"]),
                     lambda r: r.update(run=0), lambda r: r.update(run=3), lambda r: r.update(run=True),
                     lambda r: r.update(run=1), lambda r: r.update(exit_code=1),
                     lambda r: r.update(expected_failures=3), lambda r: r.update(skips=None),
                     lambda r: r.update(skips=[{"id": "outside", "reason": "missing"}]),
                     lambda r: r.update(skips=[{"id": COMMON_ID, "reason": ""}]),
                     *[lambda r, key=key: r.update({key: 1}) for key in ("failures", "errors", "unexpected_successes")]]
        for n, mutate in enumerate(mutations):
            report = python_fixture(full=True)
            mutate(report)
            with self.subTest(mutation=n), self.assertRaises(ValueError):
                ci_matrix.validate_python_report(report, required=False)

    def test_real_unittest_fixture_and_subtest_skips_keep_full_accounting(self):
        from scripts.run_tests import CompactTextTestResult, _CapturedStream, result_report

        class Guarded(unittest.TestCase):
            @classmethod
            def setUpClass(cls):
                raise unittest.SkipTest("private fixture unavailable")

            def test_one(self): pass
            def test_two(self): pass

        class Active(unittest.TestCase):
            def test_subtest_skip(self):
                with self.subTest(label="optional"):
                    self.skipTest("optional case")

        suite = unittest.TestSuite([Guarded("test_one"), Guarded("test_two"), Active("test_subtest_skip")])
        selected = [case.id() for case in cases(suite)]
        result = CompactTextTestResult(_CapturedStream(), False, 0)
        suite.run(result)
        report = {**result_report(result, selected), "exit_code": 0}
        self.assertEqual(ci_matrix.validate_python_report(report, required=False)["run"], 1)
        with self.assertRaises(ValueError):
            ci_matrix.validate_python_report(report, required=True)

    def test_python_cell_rejects_stale_reports_and_media_collection_mismatch(self):
        plan, _, _ = gate_fixture("full")
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            ci_matrix.write_json(root / "python.json", python_fixture(full=True))
            ci_matrix.write_json(root / "media-required.json", python_fixture(full=True))
            with self.assertRaises(ValueError):
                ci_matrix.python_evidence(root)
            with mock.patch.object(ci_matrix.subprocess, "run") as run:
                with self.assertRaises(ValueError):
                    ci_matrix.run_cell(plan, "windows-latest-python", root)
            run.assert_not_called()
            self.assertFalse((root / "receipt.json").exists())

    def test_real_repeated_subtest_skips_are_full_compatible_but_not_required(self):
        from scripts.run_tests import CompactTextTestResult, _CapturedStream, report_code, result_report

        class Repeated(unittest.TestCase):
            def test_optional_checks(self):
                for _ in range(2):
                    with self.subTest():
                        self.skipTest("optional check unavailable")

        case = Repeated("test_optional_checks")
        result = CompactTextTestResult(_CapturedStream(), False, 0)
        unittest.TestSuite([case]).run(result)
        self.assertTrue(result.wasSuccessful())
        report = result_report(result, [case.id()])
        report["exit_code"] = report_code(report, required=False)
        self.assertEqual(report["exit_code"], 0)
        self.assertEqual(report["run"], 1)
        self.assertEqual(len(report["skips"]), 2)
        self.assertEqual(report["skips"][0]["id"], report["skips"][1]["id"])
        self.assertEqual(ci_matrix.validate_python_report(report, required=False)["skips"], 2)
        self.assertEqual(report_code(report, required=True), 1)
        with self.assertRaisesRegex(ValueError, "unsupported required outcomes"):
            ci_matrix.validate_python_report(report, required=True)

    def test_real_case_and_fixture_skip_duplicates_still_fail(self):
        from scripts.run_tests import CompactTextTestResult, _CapturedStream, report_code, result_report

        class CaseSkip(unittest.TestCase):
            def test_optional(self): self.skipTest("optional case unavailable")

        class FixtureSkip(unittest.TestCase):
            @classmethod
            def setUpClass(cls): raise unittest.SkipTest("private fixture unavailable")

            def test_optional(self): pass

        class Pass(unittest.TestCase):
            def test_present(self): pass

        for skipped in (CaseSkip("test_optional"), FixtureSkip("test_optional")):
            suite = unittest.TestSuite([skipped, Pass("test_present")])
            selected = [case.id() for case in cases(suite)]
            result = CompactTextTestResult(_CapturedStream(), False, 0)
            suite.run(result)
            report = result_report(result, selected)
            report["exit_code"] = report_code(report, required=False)
            self.assertEqual(ci_matrix.validate_python_report(report, required=False)["skips"], 1)
            report["skips"].append(copy.deepcopy(report["skips"][0]))
            with self.subTest(identity=skipped.id()), self.assertRaisesRegex(ValueError, "duplicate Python"):
                ci_matrix.validate_python_report(report, required=False)

    def test_real_cli_exit_zero_commands_cannot_forge_python_success_receipt(self):
        # A real child CLI calls the real main()/run_cell(); only its test
        # commands are controlled to return zero and optionally emit reports.
        wrapper = '''import json, sys
from pathlib import Path
from unittest import mock
sys.path.insert(0, sys.argv.pop(1))
payload = json.loads(Path(sys.argv.pop(1)).read_text(encoding="utf-8"))
from scripts import ci_matrix
attempted = []
def command(args, **kwargs):
    path = Path(args[args.index("--report") + 1])
    attempted.append(path.name)
    if path.name in payload:
        path.write_text(payload[path.name], encoding="utf-8")
try:
    with mock.patch.object(ci_matrix.subprocess, "run", side_effect=command):
        ci_matrix.main()
finally:
    output = Path(sys.argv[sys.argv.index("--root") + 1])
    (output.parent / "attempted.json").write_text(json.dumps({"attempted": attempted,
        "receipt": (output / "receipt.json").exists()}), encoding="utf-8")
'''
        good = {"python.json": python_fixture(full=True), "media-required.json": python_fixture()}
        scenarios = [("positive", copy.deepcopy(good), True), ("missing-both", {}, False),
                     ("missing-full", {"media-required.json": python_fixture()}, False),
                     ("missing-required", {"python.json": python_fixture(full=True)}, False),
                     ("corrupt-full", {**copy.deepcopy(good), "python.json": "{broken"}, False),
                     ("empty-required", {**copy.deepcopy(good), "media-required.json": {}}, False)]
        for name, field, value in (("reported-exit", "exit_code", 1), ("failure", "failures", 1),
                                   ("error", "errors", 1), ("unexpected-success", "unexpected_successes", 1),
                                   ("required-xfail", "expected_failures", 1), ("bad-run", "run", 0)):
            pair = copy.deepcopy(good)
            pair["media-required.json"][field] = value
            scenarios.append((name, pair, False))
        pair = copy.deepcopy(good)
        pair["media-required.json"]["skips"] = [{"id": MEDIA_ID, "reason": "missing libass",
                                                 "platform_not_applicable": True}]
        scenarios.append(("forged-platform-skip", pair, False))
        pair = copy.deepcopy(good)
        pair["python.json"]["skips"] = [{"id": COMMON_ID, "reason": "manual private fixture",
                                        "platform_not_applicable": False}]
        scenarios.append(("positive-full-skip", pair, True))
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "cli.py").write_text(wrapper, encoding="utf-8", newline="\n")
            plan, _, _ = gate_fixture("full")
            ci_matrix.write_json(root / "plan.json", plan)
            for name, pair, accepted in scenarios:
                scenario = root / name
                scenario.mkdir()
                ci_matrix.write_json(scenario / "payload.json", {k: json.dumps(v) if not isinstance(v, str) else v
                                                                 for k, v in pair.items()})
                command = [sys.executable, str(root / "cli.py"), str(ROOT), str(scenario / "payload.json"),
                           "run", "--plan", str(root / "plan.json"), "--cell", "windows-latest-python",
                           "--root", str(scenario / "output")]
                outcome = subprocess.run(command, env={**os.environ, "GITHUB_SHA": plan["head"]},
                                         capture_output=True, timeout=20)
                evidence = json.loads((scenario / "attempted.json").read_text(encoding="utf-8"))
                with self.subTest(scenario=name):
                    self.assertEqual(evidence["attempted"], ["python.json", "media-required.json"])
                    self.assertEqual(outcome.returncode == 0, accepted, outcome.stderr.decode()[-1000:])
                    self.assertEqual(evidence["receipt"], accepted)
                    if accepted:
                        receipt = json.loads((scenario / "output/receipt.json").read_text(encoding="utf-8"))
                        self.assertTrue(receipt["reports"]["python.json"]["validated"])
                        self.assertTrue(receipt["reports"]["media-required.json"]["required"])
                        self.assertEqual(len(receipt["reports"]["media-required.json"]["sha256"]), 64)


if __name__ == "__main__":
    unittest.main()
