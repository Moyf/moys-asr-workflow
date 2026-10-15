"""Local matching cancellation, commit races and legacy entry points."""

from __future__ import annotations

import difflib
import json
import random
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from maw import postprocess_match
from maw.gui_web import LauncherApi, LauncherPaths, _PostprocessOperation
from maw.postprocess import OutputMode
from maw.postprocess_io import read_project
from maw.postprocess_match import ScriptMatchRequest, run_script_match
from scripts import mosp_match_text
from scripts.mosp_match_text import MatchCancelledError, cancellable_sequence_matcher


class ScriptMatchCancellationTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.project = self.root / "source.mosp"
        self.script = self.root / "script.txt"
        self.events = []
        self.api = LauncherApi(
            paths=LauncherPaths(root=self.root, env_path=self.root / "unused.env", launcher_html=self.root / "launcher.html"),
            window_getter=lambda: None,
        )
        self.api.pump.start = lambda: None
        self.api._emit = self.events.append
        preferences = mock.patch("maw.output_naming.subfolder_prefs", return_value=(False, False))
        preferences.start()
        self.addCleanup(preferences.stop)

    def input(self, timed: bool, text: str = "今天开始测试") -> dict[str, object]:
        segment = {"start": 0, "end": max(1000, len(text) * 2), "text": text}
        if timed:
            segment["items"] = [{"start": 0, "end": segment["end"], "text": text}]
        self.project.write_text(json.dumps({"segments": [segment]}, ensure_ascii=False), encoding="utf-8")
        self.script.write_text(text + "。", encoding="utf-8")
        return {"projectPath": str(self.project), "scriptPath": str(self.script), "outputMode": "both", "operationId": "match-test"}

    def assert_inputs_only(self, original: bytes) -> None:
        self.assertEqual(self.project.read_bytes(), original)
        self.assertEqual(sorted(path.name for path in self.root.iterdir()), ["script.txt", "source.mosp"])

    def test_real_matching_loop_cancels_both_paths_and_can_restart(self) -> None:
        base = self.root
        for timed in (False, True):
            with self.subTest(timed=timed):
                self.root = base / str(timed)
                self.root.mkdir()
                self.project = self.root / "source.mosp"
                self.script = self.root / "script.txt"
                payload = self.input(timed, "甲乙" * 6000)
                original = self.project.read_bytes()
                started = threading.Event()
                finished = threading.Event()
                results = []
                errors = []
                factory = cancellable_sequence_matcher

                def observe_search(*args, **kwargs):
                    matcher = factory(*args, **kwargs)
                    longest = matcher.find_longest_match

                    def search(*args, **kwargs):
                        started.set()
                        return longest(*args, **kwargs)

                    matcher.find_longest_match = search
                    return matcher

                def run():
                    try:
                        results.append(self.api.run_script_match(payload))
                    except BaseException as error:
                        errors.append(error)
                    finally:
                        finished.set()

                module = mosp_match_text if timed else postprocess_match
                with mock.patch.object(module, "cancellable_sequence_matcher", side_effect=observe_search):
                    worker = threading.Thread(target=run, daemon=True)
                    worker.start()
                    self.assertTrue(started.wait(3), "real difflib search must start")
                    self.assertEqual(self.api.cancel_postprocess({"operationId": "match-test"}), {"ok": True, "active": True, "cancelled": True})
                    self.assertTrue(finished.wait(2), "cancel must interrupt the quadratic search")
                    worker.join(1)
                self.assertEqual(errors, [])
                self.assertEqual(results[0]["code"], "postprocess_cancelled")
                self.assert_inputs_only(original)
                self.assertEqual(self.api._postprocess_operations, {})
                payload = self.input(timed)
                result = self.api.run_script_match(payload)
                self.assertTrue(result["ok"], result)
                self.assertTrue(Path(result["projectPath"]).is_file())

    def test_cancellation_wins_immediately_before_commit_for_both_paths(self) -> None:
        original_begin = _PostprocessOperation.begin_commit
        for timed in (False, True):
            with self.subTest(timed=timed):
                payload = self.input(timed)
                original = self.project.read_bytes()

                def cancel_then_commit(operation):
                    self.assertEqual(self.api.cancel_postprocess({"operationId": operation.operation_id})["cancelled"], True)
                    return original_begin(operation)

                with mock.patch.object(_PostprocessOperation, "begin_commit", cancel_then_commit):
                    result = self.api.run_script_match(payload)
                self.assertEqual(result["code"], "postprocess_cancelled")
                self.assert_inputs_only(original)

    def test_commit_rejects_cancel_and_returns_actual_artifacts(self) -> None:
        for timed in (False, True):
            with self.subTest(timed=timed):
                payload = self.input(timed)
                original_write = postprocess_match.write_artifacts

                def write(*args, **kwargs):
                    for _ in range(2):
                        self.assertEqual(self.api.cancel_postprocess({"operationId": "match-test"}), {"ok": True, "active": True, "cancelled": False})
                    return original_write(*args, **kwargs)

                with mock.patch.object(postprocess_match, "write_artifacts", side_effect=write):
                    result = self.api.run_script_match(payload)
                self.assertTrue(result["ok"], result)
                self.assertTrue(Path(result["projectPath"]).is_file())
                self.assertTrue(Path(result["srtPath"]).is_file())
                self.assertEqual(self.api._postprocess_operations, {})

    def test_admission_precedes_reading_and_duplicate_id_is_rejected(self) -> None:
        payload = self.input(False)
        original = self.project.read_bytes()
        original_emit = self.api._emit

        def emit(event):
            original_emit(event)
            if event.get("stage") == "admitted":
                duplicate = self.api.run_script_match(payload)
                self.assertEqual(duplicate["code"], "postprocess_operation_conflict")
                self.assertTrue(self.api.cancel_postprocess({"operationId": "match-test"})["cancelled"])

        self.api._emit = emit
        with mock.patch.object(postprocess_match, "_load_input", side_effect=AssertionError("must not read after cancelled admission")):
            result = self.api.run_script_match(payload)
        self.assertEqual(result["code"], "postprocess_cancelled")
        self.assert_inputs_only(original)
        self.assertEqual(self.events[0]["operationId"], "match-test")

    def test_failure_releases_id_and_old_call_without_operation_id_works(self) -> None:
        payload = self.input(False)
        self.script.write_text("完全不同文稿", encoding="utf-8")
        result = self.api.run_script_match(payload)
        self.assertFalse(result["ok"])
        self.assertEqual(self.api._postprocess_operations, {})
        payload = self.input(False)
        payload.pop("operationId")
        self.assertTrue(self.api.run_script_match(payload)["ok"])

    def test_core_default_call_preserves_cli_pipeline_compatibility(self) -> None:
        self.input(True)
        artifact = run_script_match(ScriptMatchRequest(self.project, None, self.script, OutputMode.JSON))
        self.assertEqual(read_project(artifact.project_path)["segments"][0]["text"], "今天开始测试。")

    def test_status_events_carry_operation_identity_in_stage_order(self) -> None:
        result = self.api.run_script_match(self.input(False))
        self.assertTrue(result["ok"])
        self.assertEqual([event["key"] for event in self.events], ["toolbox_status_starting", "toolbox_status_reading", "toolbox_status_matching", "toolbox_status_writing"])
        self.assertTrue(all(event["operationId"] == "match-test" for event in self.events))

    def test_cancellable_difflib_matches_unmodified_algorithm(self) -> None:
        rng = random.Random(20261011)
        pairs = [("甲乙" * 100, "甲乙" * 99 + "丙乙"), ("", "甲"), ("甲", "")]
        pairs += [("".join(rng.choices("甲乙丙丁", k=80)), "".join(rng.choices("甲乙丙丁", k=90))) for _ in range(30)]
        for source, target in pairs:
            self.assertEqual(cancellable_sequence_matcher(source, target, is_cancelled=lambda: False).get_opcodes(), difflib.SequenceMatcher(None, source, target, autojunk=False).get_opcodes())

    def test_core_cancel_before_input_or_failed_commit_writes_nothing(self) -> None:
        self.input(True)
        request = ScriptMatchRequest(self.project, None, self.script, OutputMode.BOTH)
        original = self.project.read_bytes()
        for callbacks in ({"is_cancelled": lambda: True}, {"begin_commit": lambda: False}):
            with self.assertRaises(MatchCancelledError):
                run_script_match(request, **callbacks)
            self.assert_inputs_only(original)


if __name__ == "__main__":
    unittest.main()
