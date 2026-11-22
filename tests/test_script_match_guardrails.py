from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess import OutputMode
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

    def test_wrong_manuscript_does_not_bypass_coverage_for_equal_counts(self) -> None:
        with self.assertRaises(MatchCoverageError) as raised:
            self.match([cue(0, 900, "甲乙"), cue(2000, 2900, "丙丁")], "天地\n玄黄")
        self.assertEqual(raised.exception.coverage, 0)
        self.assertEqual(list(self.root.glob("*.mosp")), [self.root / "original.mosp"])
        self.assertEqual(list(self.root.glob("*.srt")), [])

    def test_resegment_does_not_bypass_low_coverage(self) -> None:
        with self.assertRaises(MatchCoverageError):
            self.match([cue(0, 900, "甲乙丙丁戊己庚辛")], "甲荒\n海玄\n日辛")
        self.assertEqual(list(self.root.glob("*.mosp")), [self.root / "original.mosp"])
        self.assertEqual(list(self.root.glob("*.srt")), [])

    def test_equal_length_unanchored_text_does_not_replace_cue(self) -> None:
        result = self.match([
            cue(0, 1000, "欢迎各位来到现场"), cue(1000, 2000, "猫在沙发睡觉"), cue(2000, 3000, "接下来公布最终结果"),
        ], "欢迎各位来到现场天气预报警报接下来公布最终结果", mode="text")
        assert result.project_path is not None
        self.assertEqual(read_project(result.project_path)["segments"][1]["text"], "猫在沙发睡觉")

    def test_segment_only_matching_keeps_gap_at_source_boundary(self) -> None:
        result = self.match([cue(0, 1000, "甲乙"), cue(5000, 6000, "丙丁")], "甲乙\n丙\n丁")
        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual([(s["start"], s["end"]) for s in segments], [(0, 1000), (5000, 5500), (5500, 6000)])

    def test_timed_matching_does_not_fill_gap_with_unanchored_line(self) -> None:
        result = self.match([cue(0, 1000, "甲乙", timed=True), cue(5000, 6000, "丙丁", timed=True)], "甲乙\n额外说明\n丙丁")
        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual([(s["start"], s["end"], s["text"]) for s in segments], [(0, 1000, "甲乙"), (5000, 6000, "丙丁")])
        self.assertIn("1 个文稿段没有对应的原字幕字符，未生成字幕。", result.warnings)
        self.assertIn("覆盖率：文稿 50%，原字幕 100%（按可匹配字符计算）。", result.warnings)

    def test_timed_matching_keeps_fully_replaced_source_cue_without_anchor(self) -> None:
        original = [cue(0, 900, "欢迎", timed=True), cue(1000, 1900, "猫猫", timed=True), cue(2500, 3000, "再见", timed=True)]
        result = self.match(original, "欢迎\n狗狗\n再见")
        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual([(s["start"], s["end"], s["text"]) for s in segments], [
            (0, 900, "欢迎"), (1000, 1900, "猫猫"), (2500, 3000, "再见"),
        ])
        self.assertEqual(segments[1]["items"], original[1]["items"])
        self.assertIn("1 个文稿段没有对应的原字幕字符，未生成字幕。", result.warnings)

    def test_timed_matching_keeps_styles_and_remaps_style_heads_after_narrowing(self) -> None:
        styles = {"color": {"name": "红色"}, "sticker": {"name": "贴图"}}
        result = self.match([
            cue(0, 900, "起头两句", timed=True),
            {**cue(1000, 2000, "你好"), **styles, "items": [cue(1100, 1900, "你好")],
             "start_frame": 25, "end_frame": 50, "id": "style-head"},
            {**cue(2100, 3000, "再见", timed=True), "start_frame": 53, "end_frame": 75,
             "color_ref": {"headIdx": 1, "name": "红色"}, "sticker_ref": {"headIdx": 1, "name": "贴图"}},
            {**cue(3100, 4000, "回头见"), "items": [cue(3200, 3900, "回头见")],
             "color_ref": {"headIdx": 1, "name": "红色"}, "sticker_ref": {"headIdx": 1, "name": "贴图"}},
        ], "起头\n两句\n你好！\n再见\n回头见")
        assert result.project_path is not None
        _intro1, _intro2, head, unchanged, narrowed = read_project(result.project_path)["segments"]
        self.assertEqual((head["id"], head["start"], head["end"]), ("style-head", 1100, 1900))
        for key, style in styles.items():
            self.assertEqual(head[key], style)
            for follower in (unchanged, narrowed):
                self.assertEqual(follower[f"{key}_ref"], {"headIdx": 2, "name": style["name"]})
        self.assertNotIn("start_frame", head)
        self.assertNotIn("end_frame", head)
        self.assertEqual((unchanged["start_frame"], unchanged["end_frame"]), (53, 75))

    def test_timed_matching_does_not_copy_styles_to_split_outputs(self) -> None:
        result = self.match([{**cue(0, 1200, "甲乙丙丁", timed=True), "color": {"name": "红色"}}], "甲乙\n丙丁")
        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual(len(segments), 2)
        self.assertTrue(all("color" not in segment for segment in segments))

    def test_timed_matching_accepts_zero_duration_punctuation(self) -> None:
        result = self.match([
            {**cue(0, 1000, "你好。"), "items": [cue(100, 900, "你好"), cue(900, 900, "。")]},
            cue(2000, 3000, "再见", timed=True),
        ], "你好。\n再见。")
        assert result.project_path is not None
        first = read_project(result.project_path)["segments"][0]
        self.assertEqual((first["start"], first["end"], first["text"]), (100, 900, "你好。"))

    def test_punctuation_only_source_segment_is_preserved_or_reported(self) -> None:
        segments = [cue(0, 900, "Hello", timed=True), cue(1000, 1200, "…"), cue(1500, 2100, "World", timed=True)]
        result = self.match(segments, "Hello\nWorld")
        assert result.project_path is not None
        self.assertEqual([s["text"] for s in read_project(result.project_path)["segments"]], ["Hello", "…", "World"])
        self.assertIn("已保留 1 个文稿之外的 ASR 字幕段。", result.warnings)
        overlapped = self.match(segments, "Hello World")
        self.assertIn("1 个文稿之外的 ASR 字幕段与匹配结果完全重叠，未保留。", overlapped.warnings)

    def test_zero_duration_word_routes_to_segment_match(self) -> None:
        result = self.match([
            {**cue(0, 900, "Hello world"), "items": [cue(100, 500, "Hello"), cue(500, 500, "world")]},
            cue(1000, 1500, "and"), cue(2000, 3000, "goodbye", timed=True),
        ], "Hello world\nand\ngoodbye")
        assert result.project_path is not None
        self.assertEqual([s["start"] for s in read_project(result.project_path)["segments"]], [0, 1000, 2000])

    def test_bound_tracks_keep_original_segmentation_and_references(self) -> None:
        result = self.match([
            {**cue(0, 900, "Hello"), "id": "main-a", "items": [cue(100, 800, "Hello")]},
            cue(1000, 1500, "and"), cue(2000, 3000, "goodbye", timed=True),
        ], "Hello!\nand goodbye", extra={"multi_subtitle": {
            "tracks": [{"id": "translation", "segments": [{**cue(10, 910, "你好"), "id": "translated-a"}]}],
            "bindings": [{"track_id": "translation", "main_segment_ids": ["main-a"], "extension_segment_ids": ["translated-a"]}],
        }})
        assert result.project_path is not None
        match = read_project(result.project_path)
        self.assertEqual([s["start"] for s in match["segments"]], [0, 1000, 2000])
        binding = match["multi_subtitle"]["bindings"][0]
        self.assertEqual(binding["main_segment_ids"], ["main-a"])
        self.assertEqual(binding["start_offset_ms"], 10)
        self.assertTrue(any("主副轨字幕绑定" in warning for warning in result.warnings))

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
                first, second = read_project(result.project_path)["segments"]
                self.assertEqual((first["start"], first["end"], second["start"]), (4160, 6840, 7560))
                self.assertEqual([(i["text"].strip(), i["start"], i["end"]) for i in first["items"]], [
                    ("This", 4160, 5200), ("is", 5200, 5920), ("chapter", 5920, 6240),
                    ("number", 6240, 6480), (replacement, 6480, 6840),
                ])
                self.assertEqual("".join(i["text"] for i in first["items"]), first["text"])

    def test_insertion_does_not_extend_or_move_either_cue(self) -> None:
        result = self.match([cue(0, 1000, "甲乙", timed=True), cue(5000, 6000, "丙丁", timed=True)], "甲乙额外\n丙丁")
        assert result.project_path is not None
        first, second = read_project(result.project_path)["segments"]
        self.assertEqual(first["items"], [cue(0, 1000, "甲乙额外")])
        self.assertEqual(second["items"], [cue(5000, 6000, "丙丁")])
        self.assertTrue(any("没有可靠的独立时间码" in warning for warning in result.warnings))

    def test_resegmentation_can_cut_inside_a_source_item(self) -> None:
        result = self.match([cue(100, 500, "甲乙丙丁", timed=True)], "甲乙\n丙丁")
        assert result.project_path is not None
        first, second = read_project(result.project_path)["segments"]
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
        first = read_project(result.project_path)["segments"][0]
        self.assertEqual(first["items"], [cue(0, 1000, "甲乙丙新"), cue(5000, 6000, "丁戊己")])

    def test_resegmented_cues_inherit_speaker_by_character_majority_not_position(self) -> None:
        for timed in (False, True):
            for first, second, expected in (("甲乙", "丙丁", "B"), ("甲乙丙", "丁", "A")):
                with self.subTest(timed=timed, first=first):
                    result = self.match([
                        {**cue(0, 3000, first, timed=timed), "speaker": "A"},
                        {**cue(5000, 6000, second, timed=timed), "speaker": "B"},
                    ], "甲\n乙丙丁")
                    assert result.project_path is not None
                    segments = read_project(result.project_path)["segments"]
                    self.assertEqual([(s["text"], s.get("speaker")) for s in segments], [("甲", "A"), ("乙丙丁", expected)])

    def test_tied_or_mostly_unknown_speakers_leave_combined_cue_unlabelled(self) -> None:
        for timed in (False, True):
            with self.subTest(timed=timed):
                for second, second_speaker in (("丙", "B"), ("丙丁", None)):
                    with self.subTest(second=second):
                        other = cue(5000, 6000, second, timed=timed)
                        if second_speaker is not None:
                            other["speaker"] = second_speaker
                        result = self.match([
                            {**cue(0, 3000, "甲乙", timed=timed), "speaker": "A"}, other,
                        ], f"甲\n乙{second}")
                        assert result.project_path is not None
                        segments = read_project(result.project_path)["segments"]
                        self.assertEqual(segments[0].get("speaker"), "A")
                        self.assertNotIn("speaker", segments[1])

    def test_votes_are_combined_across_cues_and_ignore_unmatched_characters(self) -> None:
        for timed in (False, True):
            with self.subTest(timed=timed):
                result = self.match([
                    {**cue(0, 1000, "甲", timed=timed), "speaker": "A"},
                    {**cue(1000, 2000, "乙", timed=timed), "speaker": "B"},
                    {**cue(2000, 3000, "丙", timed=timed), "speaker": "A"},
                    {**cue(3000, 4000, "丁", timed=timed), "speaker": "C"},
                    {**cue(4000, 5000, "戊己", timed=timed), "speaker": "C"},
                    {**cue(5000, 6000, "庚", timed=timed), "speaker": "A"},
                ], "甲乙额外丙\n丁己庚")
                assert result.project_path is not None
                segments = read_project(result.project_path)["segments"]
                self.assertEqual([(s["text"], s.get("speaker")) for s in segments], [("甲乙额外丙", "A"), ("丁己庚", "C")])
