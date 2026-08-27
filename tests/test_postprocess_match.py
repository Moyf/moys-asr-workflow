from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess import OutputMode
from maw.postprocess_io import read_project
from maw.postprocess_match import ScriptMatchRequest, prepare_script_text, run_script_match


class ScriptMatchTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.project_path = self.root / "clip.mosp"
        self.script_path = self.root / "script.txt"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_match_uses_script_text_and_preserves_source_time_slots(self) -> None:
        self.project_path.write_text(
            json.dumps(
                {
                    "media": "clip.mp4",
                    "custom_metadata": {"keep": True},
                    "segments": [
                        {
                            "start": 0,
                            "end": 1000,
                            "text": "今天好",
                            "items": [{"start": 0, "end": 500, "text": "今天好"}],
                        },
                        {"start": 1000, "end": 2000, "text": "天氣"},
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.script_path.write_text("今天好，天气。", encoding="utf-8")

        result = run_script_match(
            ScriptMatchRequest(
                project_path=self.project_path,
                srt_path=None,
                script_path=self.script_path,
                output_mode=OutputMode.BOTH,
            )
        )

        self.assertIsNotNone(result.project_path)
        self.assertIsNotNone(result.srt_path)
        assert result.project_path is not None
        project = read_project(result.project_path)
        segments = project["segments"]
        self.assertEqual(project["custom_metadata"], {"keep": True})
        self.assertEqual(segments[0]["text"], "今天好，")
        self.assertEqual(segments[0]["items"], [{"start": 0, "end": 500, "text": "今天好，"}])
        self.assertEqual(segments[1]["text"], "天气。")
        self.assertEqual([(item["start"], item["end"]) for item in segments], [(0, 1000), (1000, 2000)])
        self.assertIn("今天好，", result.srt_path.read_text(encoding="utf-8"))

    def test_disabled_segments_are_not_consumed_by_script_match(self) -> None:
        self.project_path.write_text(
            json.dumps(
                {
                    "segments": [
                        {"start": 0, "end": 1000, "text": "保留这条", "disabled": True},
                        {"start": 1000, "end": 2000, "text": "错字"},
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.script_path.write_text("错字正确", encoding="utf-8")

        result = run_script_match(
            ScriptMatchRequest(self.project_path, None, self.script_path, OutputMode.JSON)
        )

        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual(segments[0]["text"], "保留这条")
        self.assertTrue(segments[0]["disabled"])
        self.assertEqual(segments[1]["text"], "错字正确")

    def test_disabled_segments_with_items_stay_untouched_during_character_matching(self) -> None:
        self.project_path.write_text(
            json.dumps(
                {
                    "segments": [
                        {
                            "start": 0,
                            "end": 1000,
                            "text": "保留",
                            "disabled": True,
                            "items": [{"start": 0, "end": 1000, "text": "保留"}],
                        },
                        {
                            "start": 1000,
                            "end": 2000,
                            "text": "错字",
                            "items": [
                                {"start": 1000, "end": 1500, "text": "错"},
                                {"start": 1500, "end": 2000, "text": "字"},
                            ],
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.script_path.write_text("错。字", encoding="utf-8")

        result = run_script_match(
            ScriptMatchRequest(self.project_path, None, self.script_path, OutputMode.JSON)
        )

        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual(segments[0]["text"], "保留")
        self.assertEqual(segments[0]["items"][0]["text"], "保留")
        self.assertEqual(segments[1]["text"], "错。")
        self.assertEqual(segments[2]["text"], "字")
        self.assertEqual(
            [(item["start"], item["end"]) for item in segments[1]["items"]],
            [(1000, 1500)],
        )

    def test_low_match_refuses_to_write_output(self) -> None:
        self.project_path.write_text(
            json.dumps({"segments": [{"start": 0, "end": 1000, "text": "字幕甲乙丙"}]}, ensure_ascii=False),
            encoding="utf-8",
        )
        self.script_path.write_text("文稿丁戊己", encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "match coverage is too low"):
            run_script_match(
                ScriptMatchRequest(self.project_path, None, self.script_path, OutputMode.BOTH)
            )

        self.assertEqual(list(self.root.glob("clip.matched*")), [])

    def test_srt_input_creates_a_project_and_srt(self) -> None:
        srt_path = self.root / "clip.srt"
        srt_path.write_text(
            "1\n00:00:00,000 --> 00:00:01,000\n旧文\n\n2\n00:00:01,000 --> 00:00:02,000\n内容\n",
            encoding="utf-8",
        )
        self.script_path.write_text("新文内容", encoding="utf-8")

        result = run_script_match(
            ScriptMatchRequest(None, srt_path, self.script_path, OutputMode.BOTH)
        )

        assert result.project_path is not None
        assert result.srt_path is not None
        self.assertEqual(result.project_path.suffix, ".mosp")
        self.assertIn("新文", result.srt_path.read_text(encoding="utf-8"))
        self.assertEqual(read_project(result.project_path)["segments"][0]["text"], "新文")

    def test_extra_punctuation_reports_configuration(self) -> None:
        text, warning = prepare_script_text("甲？乙！丙~", ("？", "！", "~"), ("？", "~"))

        self.assertEqual(text, "甲？乙！丙~")
        self.assertIn("额外断句符号：3 个", warning)

    def test_preserved_punctuation_must_be_declared_as_a_split_symbol(self) -> None:
        with self.assertRaisesRegex(ValueError, "保留符号"):
            prepare_script_text("甲？", ("！",), ("？",))

    def test_punctuation_segments_do_not_override_alignment_boundaries(self) -> None:
        self.project_path.write_text(
            json.dumps(
                {
                    "segments": [
                        {"start": 0, "end": 1000, "text": "甲乙"},
                        {"start": 1000, "end": 2000, "text": "丙丁"},
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.script_path.write_text("甲乙丙。丁", encoding="utf-8")

        result = run_script_match(
            ScriptMatchRequest(self.project_path, None, self.script_path, OutputMode.JSON)
        )

        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual([segment["text"] for segment in segments], ["甲乙", "丙。丁"])

    def test_text_only_mode_preserves_existing_cue_segmentation(self) -> None:
        self.project_path.write_text(
            json.dumps(
                {"segments": [
                    {"start": 0, "end": 1000, "text": "甲乙"},
                    {"start": 1000, "end": 2000, "text": "丙丁"},
                ]},
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.script_path.write_text("甲乙\n丙丁", encoding="utf-8")

        result = run_script_match(
            ScriptMatchRequest(self.project_path, None, self.script_path, OutputMode.JSON, match_mode="text")
        )

        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual([segment["text"] for segment in segments], ["甲乙", "丙丁"])

    def test_manuscript_line_breaks_are_used_as_segment_boundaries(self) -> None:
        self.project_path.write_text(
            json.dumps({"segments": [
                {"start": 0, "end": 1000, "text": "甲乙"},
                {"start": 1000, "end": 2000, "text": "丙丁"},
            ]}, ensure_ascii=False), encoding="utf-8"
        )
        self.script_path.write_text("甲乙\n丙丁", encoding="utf-8")

        result = run_script_match(ScriptMatchRequest(
            self.project_path, None, self.script_path, OutputMode.JSON,
        ))

        assert result.project_path is not None
        self.assertEqual([segment["text"] for segment in read_project(result.project_path)["segments"]], ["甲乙", "丙丁"])

    def test_manuscript_line_breaks_can_rebuild_a_different_cue_count(self) -> None:
        self.project_path.write_text(
            json.dumps({"segments": [
                {"start": 0, "end": 3000, "text": "甲乙丙丁"},
                {"start": 3000, "end": 6000, "text": "戊己庚"},
            ]}, ensure_ascii=False), encoding="utf-8"
        )
        self.script_path.write_text("甲乙\n丙丁\n戊己庚", encoding="utf-8")

        result = run_script_match(ScriptMatchRequest(
            self.project_path, None, self.script_path, OutputMode.JSON,
        ))

        assert result.project_path is not None
        project = read_project(result.project_path)
        self.assertEqual([segment["text"] for segment in project["segments"]], ["甲乙", "丙丁", "戊己庚"])
        self.assertEqual([(segment["start"], segment["end"]) for segment in project["segments"]], [(0, 1500), (1500, 3000), (3000, 6000)])

    def test_mosp_items_drive_character_timed_script_matching(self) -> None:
        self.project_path.write_text(
            json.dumps(
                {
                    "segments": [
                        {
                            "start": 0,
                            "end": 1000,
                            "text": "甲乙",
                            "items": [
                                {"start": 0, "end": 500, "text": "甲"},
                                {"start": 500, "end": 1000, "text": "乙"},
                            ],
                        },
                        {
                            "start": 1000,
                            "end": 2000,
                            "text": "丙丁",
                            "items": [
                                {"start": 1000, "end": 1500, "text": "丙"},
                                {"start": 1500, "end": 2000, "text": "丁"},
                            ],
                        },
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.script_path.write_text("甲。乙丙，丁", encoding="utf-8")

        result = run_script_match(
            ScriptMatchRequest(self.project_path, None, self.script_path, OutputMode.BOTH)
        )

        assert result.project_path is not None
        project = read_project(result.project_path)
        segments = project["segments"]
        self.assertEqual(
            [(segment["start"], segment["end"], segment["text"]) for segment in segments],
            [(0, 500, "甲。"), (500, 1500, "乙丙，"), (1500, 2000, "丁")],
        )
        self.assertEqual(
            [(item["start"], item["end"]) for item in segments[1]["items"]],
            [(500, 1000), (1000, 1500)],
        )


if __name__ == "__main__":
    unittest.main()
