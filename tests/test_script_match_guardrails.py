from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess import OutputMode
from maw.project_tracks import get_main_track
from maw.postprocess_io import SubtitleArtifact, read_project
from maw.postprocess_match import MatchCoverageError, ScriptMatchRequest, run_script_match
from maw.project_preview import JsonDict


def cue(start: int, end: int, text: str, *, timed: bool = False) -> JsonDict:
    segment: JsonDict = {"start": start, "end": end, "text": text}
    if timed:
        segment["items"] = [dict(segment)]
    return segment


class ScriptMatchGuardrailTests(unittest.TestCase):
    def setUp(self) -> None:
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)

    def match(self, segments: list[JsonDict], script: str, *, mode: str = "script", extra: JsonDict | None = None) -> SubtitleArtifact:
        source = self.root / "original.mosp"
        document = self.root / "script.txt"
        source.write_text(json.dumps({**(extra or {}), "segments": segments}, ensure_ascii=False), encoding="utf-8")
        document.write_text(script, encoding="utf-8")
        return run_script_match(ScriptMatchRequest(source, None, document, OutputMode.BOTH, match_mode=mode))

    def test_timed_matching_reuses_words_and_bounds_a_local_replacement(self) -> None:
        original = [
            {**cue(4160, 6840, "This is chapter number Two"), "items": [
                cue(4160, 5200, "This"), cue(5200, 5920, " is"),
                cue(5920, 6240, " chapter"), cue(6240, 6480, " number"), cue(6480, 6840, " Two"),
            ]},
            cue(7560, 9400, "Here is the next sentence", timed=True),
        ]
        for replacement in ("2", "兔"):
            with self.subTest(replacement=replacement):
                result = self.match(original, f"This is chapter number {replacement}\nHere is the next sentence")
                assert result.project_path is not None
                first, second = get_main_track(read_project(result.project_path))["segments"]
                self.assertEqual((first["start"], first["end"], second["start"]), (4160, 6840, 7560))
                self.assertEqual([(i["text"].strip(), i["start"], i["end"]) for i in first["items"]], [
                    ("This", 4160, 5200), ("is", 5200, 5920), ("chapter", 5920, 6240),
                    ("number", 6240, 6480), (replacement, 6480, 6840),
                ])
                self.assertEqual("".join(i["text"] for i in first["items"]), first["text"])

    def test_insertion_does_not_extend_or_move_either_cue(self) -> None:
        result = self.match([cue(0, 1000, "甲乙", timed=True), cue(5000, 6000, "丙丁", timed=True)], "甲乙额外\n丙丁")
        assert result.project_path is not None
        first, second = get_main_track(read_project(result.project_path))["segments"]
        self.assertEqual(first["items"], [cue(0, 1000, "甲乙额外")])
        self.assertEqual(second["items"], [cue(5000, 6000, "丙丁")])
        self.assertTrue(any("没有可靠的独立时间码" in warning for warning in result.warnings))

    def test_resegmentation_can_cut_inside_a_source_item(self) -> None:
        result = self.match([cue(100, 500, "甲乙丙丁", timed=True)], "甲乙\n丙丁")
        assert result.project_path is not None
        first, second = get_main_track(read_project(result.project_path))["segments"]
        self.assertEqual(first["items"], [cue(100, 300, "甲乙")])
        self.assertEqual(second["items"], [cue(300, 500, "丙丁")])

    def test_replacement_spanning_a_pause_does_not_claim_that_time(self) -> None:
        result = self.match([
            {**cue(0, 6000, "甲乙丙旧字丁戊己"), "items": [
                cue(0, 1000, "甲乙丙"), cue(1000, 1400, "旧"),
                cue(4500, 5000, "字"), cue(5000, 6000, "丁戊己"),
            ]},
        ], "甲乙丙新丁戊己")
        assert result.project_path is not None
        first = get_main_track(read_project(result.project_path))["segments"][0]
        self.assertEqual(first["items"], [cue(0, 1000, "甲乙丙新"), cue(5000, 6000, "丁戊己")])
