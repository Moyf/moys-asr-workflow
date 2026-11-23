from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess import OutputMode
from maw.project_tracks import get_main_track, get_tracks_by_role, make_project
from maw.postprocess_io import SubtitleArtifact, read_project
from maw.postprocess_match import MatchCoverageError, ScriptMatchRequest, run_script_match
from maw.project_preview import JsonDict


def cue(start: int, end: int, text: str, *, timed: bool = False) -> JsonDict:
    segment: JsonDict = {"start": start, "end": end, "text": text}
    if timed:
        segment["items"] = [dict(segment)]
    return segment


def speaker_labels(artifact):
    original = artifact.project_path.parent / "original.mosp"
    legacy = json.loads(original.read_text(encoding="utf-8"))["segments"]
    normalized = get_main_track(read_project(original))["segments"]
    labels = {cue["speaker"]: old["speaker"] for cue, old in zip(normalized, legacy, strict=True) if old.get("speaker")}
    return [(cue["text"], labels.get(cue.get("speaker")))
            for cue in get_main_track(read_project(artifact.project_path))["segments"]]


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

    def test_timed_matching_accepts_zero_duration_punctuation(self) -> None:
        result = self.match([
            {**cue(0, 1000, "你好。"), "items": [cue(100, 900, "你好"), cue(900, 900, "。")]},
            cue(2000, 3000, "再见", timed=True),
        ], "你好。\n再见。")
        assert result.project_path is not None
        first = get_main_track(read_project(result.project_path))["segments"][0]
        self.assertEqual((first["start"], first["end"], first["text"]), (100, 900, "你好。"))

    def test_zero_duration_word_routes_to_segment_match(self) -> None:
        result = self.match([
            {**cue(0, 900, "Hello world"), "items": [cue(100, 500, "Hello"), cue(500, 500, "world")]},
            cue(1000, 1500, "and"), cue(2000, 3000, "goodbye", timed=True),
        ], "Hello world\nand\ngoodbye")
        assert result.project_path is not None
        self.assertEqual([s["start"] for s in get_main_track(read_project(result.project_path))["segments"]], [0, 1000, 2000])

    def test_incomplete_word_coverage_keeps_original_cue_span(self) -> None:
        original = [{**cue(0, 1000, "ABCD"), "items": [cue(0, 100, "A")]},
                    cue(2000, 3000, "EFGH", timed=True), cue(4000, 5000, "IJKL")]
        result = self.match(original, "ABCD\nEFGH\nIJKL")
        first = get_main_track(read_project(result.project_path))["segments"][0]
        self.assertEqual((first["text"], first["start"], first["end"], first["items"]),
                         ("ABCD", 0, 1000, original[0]["items"]))

    def test_one_matching_character_cannot_replace_a_whole_sentence(self):
        first, middle, last = "开场信息逐字对应", "这句话包含较多原文内容", "收尾信息也逐字对应"
        result = self.match([cue(0, 1000, first), cue(1500, 3000, middle), cue(4000, 5000, last)],
                            first + "这" + last, mode="text")
        self.assertEqual(get_main_track(read_project(result.project_path))["segments"][1]["text"], middle)

    def test_same_boundaries_keep_ids_partial_word_data_and_full_sentence_times(self):
        original = [{**cue(0, 1000, "ABCD", timed=True), "id":"a", "extra":{"note":"keep"}},
                    {**cue(2000, 3000, "EFGH"), "id":"b"}, {**cue(4000, 5000, "IJKL"), "id":"c"}]
        result = self.match(original, "ABCD\nEFXH\nIJKX")
        actual = get_main_track(read_project(result.project_path))["segments"]
        self.assertEqual([(c["id"], c["start"], c["end"], c["text"]) for c in actual],
                         [("a",0,1000,"ABCD"),("b",2000,3000,"EFXH"),("c",4000,5000,"IJKX")])
        self.assertEqual(actual[0]["items"], original[0]["items"])
        self.assertEqual(actual[0]["extra"], original[0]["extra"])

    def overlapping_disabled_project(self):
        disabled = {**cue(1200, 1600, "保留", timed=True), "id": "archived", "disabled": True,
                    "start_frame": 30, "end_frame": 40, "custom": {"review": "保留"}}
        return make_project([cue(0, 1000, "甲乙", timed=True), disabled, cue(2000, 3000, "丙丁", timed=True)])

    def match_document(self, project):
        source, script = self.root / "input.mosp", self.root / "draft.txt"
        source.write_text(json.dumps(project), encoding="utf-8")
        script.write_text("甲乙丙丁", encoding="utf-8")
        return run_script_match(ScriptMatchRequest(source, None, script, OutputMode.BOTH))

    def test_overlapping_disabled_cue_moves_intact_to_overlay(self):
        for existing in (False, True):
            with self.subTest(existing=existing):
                project = self.overlapping_disabled_project()
                old = {"id": "old", **cue(0, 500, "覆盖")}
                if existing:
                    project["tracks"].append({"id":"notes", "role":"overlay", "name":"已有叠加", "enabled":True,
                                              "preview_visible":False, "segments":[old]})
                result = self.match_document(project)
                saved = read_project(result.project_path)
                overlay, = get_tracks_by_role(saved, "overlay")
                disabled = get_main_track(project)["segments"][1]
                self.assertEqual(overlay["segments"], ([old] if existing else []) + [disabled])
                self.assertEqual([(c["start"], c["end"], c["text"]) for c in get_main_track(saved)["segments"]],
                                 [(0, 3000, "甲乙丙丁")])
                self.assertTrue(any("叠加轨" in warning for warning in result.warnings))
                self.assertNotIn("保留", result.srt_path.read_text(encoding="utf-8"))
                if existing:
                    self.assertFalse(overlay["preview_visible"])
                    self.assertEqual(overlay["id"], "notes")
                self.assertEqual(json.loads((self.root / "input.mosp").read_text(encoding="utf-8")), project)

    def test_full_overlay_refuses_to_discard_or_shift_disabled_cue(self):
        project = self.overlapping_disabled_project()
        project["tracks"].append({"id":"notes", "role":"overlay", "name":"叠加", "enabled":True,
                                  "segments":[{"id":"occupied", **cue(1300, 1900, "已有")} ]})
        with self.assertRaisesRegex(ValueError, "叠加轨"):
            self.match_document(project)
        self.assertEqual(list(self.root.glob("*.mosp")), [self.root / "input.mosp"])

    def test_bound_disabled_cue_cannot_leave_the_main_track(self):
        project = self.overlapping_disabled_project()
        project["tracks"].append({"id":"translated", "role":"secondary", "name":"译文", "enabled":True,
                                  "segments":[{"id":"translation", **cue(1200, 1600, "Translation")}]})
        project["bilingual"]["active_track_id"] = "translated"
        project["bindings"] = [{"id":"link", "source":{"track_id":"main", "segment_id":"archived"},
                                "target":{"track_id":"translated", "segment_id":"translation"},
                                "start_offset_ms":0, "end_offset_ms":0}]
        with self.assertRaisesRegex(ValueError, "禁用字幕带有主副轨绑定"):
            self.match_document(project)
        self.assertEqual(list(self.root.glob("*.mosp")), [self.root / "input.mosp"])

    def test_fully_covered_unmatched_speech_is_reported_separately_from_disabled_overlay(self):
        project = self.overlapping_disabled_project()
        get_main_track(project)["segments"].insert(1, {**cue(1000, 1100, "旁白", timed=True), "id":"extra"})
        result = self.match_document(project)
        saved = read_project(result.project_path)
        self.assertEqual([s["id"] for s in get_tracks_by_role(saved, "overlay")[0]["segments"]], ["archived"])
        self.assertTrue(any("1 个文稿之外" in w and "完全重叠" in w for w in result.warnings))

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
        self.assertEqual(get_main_track(read_project(result.project_path))["segments"][1]["text"], "猫在沙发睡觉")

    def test_segment_only_matching_keeps_gap_at_source_boundary(self) -> None:
        result = self.match([cue(0, 1000, "甲乙"), cue(5000, 6000, "丙丁")], "甲乙\n丙\n丁")
        assert result.project_path is not None
        segments = get_main_track(read_project(result.project_path))["segments"]
        self.assertEqual([(s["start"], s["end"]) for s in segments], [(0, 1000), (5000, 5500), (5500, 6000)])

    def test_timed_matching_does_not_fill_gap_with_unanchored_line(self) -> None:
        result = self.match([cue(0, 1000, "甲乙", timed=True), cue(5000, 6000, "丙丁", timed=True)], "甲乙\n额外说明\n丙丁")
        assert result.project_path is not None
        segments = get_main_track(read_project(result.project_path))["segments"]
        self.assertEqual([(s["start"], s["end"], s["text"]) for s in segments], [(0, 1000, "甲乙"), (5000, 6000, "丙丁")])
        self.assertIn("1 个文稿段没有对应的原字幕字符，未生成字幕。", result.warnings)
        self.assertIn("覆盖率：文稿 50%，原字幕 100%（按可匹配字符计算）。", result.warnings)

    def test_timed_matching_keeps_fully_replaced_source_cue_without_anchor(self) -> None:
        original = [cue(0, 900, "欢迎", timed=True), cue(1000, 1900, "猫猫", timed=True), cue(2500, 3000, "再见", timed=True)]
        result = self.match(original, "欢迎\n狗狗\n再见")
        assert result.project_path is not None
        segments = get_main_track(read_project(result.project_path))["segments"]
        self.assertEqual([(s["start"], s["end"], s["text"]) for s in segments], [
            (0, 900, "欢迎"), (1000, 1900, "猫猫"), (2500, 3000, "再见"),
        ])
        self.assertEqual(segments[1]["items"], original[1]["items"])
        self.assertIn("1 个文稿段没有对应的原字幕字符，未生成字幕。", result.warnings)

    def test_resegmented_cues_inherit_speaker_by_character_majority_not_position(self) -> None:
        for timed in (False, True):
            for first, second, expected in (("甲乙", "丙丁", "B"), ("甲乙丙", "丁", "A")):
                with self.subTest(timed=timed, first=first):
                    result = self.match([
                        {**cue(0, 3000, first, timed=timed), "speaker": "A"},
                        {**cue(5000, 6000, second, timed=timed), "speaker": "B"},
                    ], "甲\n乙丙丁")
                    assert result.project_path is not None
                    self.assertEqual(speaker_labels(result), [("甲", "A"), ("乙丙丁", expected)])

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
                        segments = get_main_track(read_project(result.project_path))["segments"]
                        self.assertEqual(speaker_labels(result)[0][1], "A")
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
                self.assertEqual(speaker_labels(result), [("甲乙额外丙", "A"), ("丁己庚", "C")])
