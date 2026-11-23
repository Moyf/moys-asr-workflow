from __future__ import annotations

from tests.compact_assertions import CompactContainerAssertions

import json
import tempfile
import unittest
from pathlib import Path

from maw.postprocess import OutputMode
from maw.postprocess_io import read_project
from maw.postprocess_match import DEFAULT_EXTRA_SPLIT_PUNCTUATION, DEFAULT_PRESERVE_PUNCTUATION, MatchCoverageError, ScriptMatchRequest, prepare_script_text, processed_script_text, run_script_match
from scripts.mosp_match_text import clean_markdown_inline_symbols


class ScriptMatchTests(CompactContainerAssertions, unittest.TestCase):
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
        rendered = result.srt_path.read_text(encoding="utf-8")
        self.assertIn("今天好，\n", rendered)
        self.assertIn("天气。", rendered)

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

        with self.assertRaisesRegex(MatchCoverageError, "match coverage is too low"):
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

    def test_markdown_script_ignores_front_matter_and_heading_markers(self) -> None:
        markdown_path = self.root / "script.md"
        self.project_path.write_text(
            json.dumps(
                {
                    "segments": [
                        {"start": 0, "end": 1000, "text": "标题"},
                        {"start": 1000, "end": 2000, "text": "正文"},
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        markdown_path.write_text(
            "---\n"
            "title: 测试文稿\n"
            "aliases: []\n"
            "parent:\n"
            "- \"[[moys-asr-workflow]]\"\n"
            "---\n\n"
            "# 标题\n"
            "## 正文\n",
            encoding="utf-8",
        )

        result = run_script_match(
            ScriptMatchRequest(self.project_path, None, markdown_path, OutputMode.JSON)
        )

        assert result.project_path is not None
        self.assertEqual(
            [segment["text"] for segment in read_project(result.project_path)["segments"]],
            ["标题", "正文"],
        )

    def test_extra_punctuation_reports_configuration(self) -> None:
        text, warning = prepare_script_text("甲？乙！丙~", ("？", "！", "~"), ("？", "~"))

        self.assertEqual(text, "甲？乙！丙~")
        self.assertIn("断句符号：3 个", warning)

    def test_clean_markdown_inline_symbols_keeps_visible_text(self) -> None:
        self.assertEqual(
            clean_markdown_inline_symbols("**粗体** *斜体* ***粗斜体*** __粗体__ ___粗斜体___ _斜体_ ~~删除~~ ==高亮== `代码`"),
            "粗体 斜体 粗斜体 粗体 粗斜体 斜体 删除 高亮 代码",
        )

    def test_trailing_question_mark_is_stripped_when_configured_but_not_preserved(self) -> None:
        # 用户场景回归：问号在断句清单、不在保留清单 → 断句并从句尾删除。
        self.assertEqual(
            processed_script_text(
                "这个过程吗？好的",
                extra_split_punctuation=("？",),
                preserve_punctuation=(),
            ),
            "这个过程吗\n好的",
        )

    def test_processed_script_text_matches_default_split_and_punctuation_policy(self) -> None:
        # 默认清单继续断句，全部句尾标点保留。
        self.assertEqual(
            processed_script_text(
                "第一句，第二句？第三句。",
                extra_split_punctuation=DEFAULT_EXTRA_SPLIT_PUNCTUATION,
                preserve_punctuation=DEFAULT_PRESERVE_PUNCTUATION,
            ),
            "第一句，\n第二句？\n第三句。",
        )

    def test_default_semicolon_and_opt_in_enumeration_follow_shared_policy(self) -> None:
        self.assertEqual(processed_script_text(
            "这个、那个，都不错;下一项", extra_split_punctuation=DEFAULT_EXTRA_SPLIT_PUNCTUATION,
            preserve_punctuation=DEFAULT_PRESERVE_PUNCTUATION,
        ), "这个、那个，\n都不错;\n下一项")
        self.assertEqual(processed_script_text("这个、那个", extra_split_punctuation=("、",), preserve_punctuation=()),
                         "这个\n那个")
        self.assertEqual(processed_script_text("这个、那个", extra_split_punctuation=("、",), preserve_punctuation=("、",)),
                         "这个、\n那个")

    def test_processed_script_text_keeps_closing_quotes_after_split_punctuation(self) -> None:
        text = "但是也有地平论者在发力\n「你有没有自主意识？」\n「AI 会不会统治地球？」"

        self.assertEqual(
            processed_script_text(
                text,
                extra_split_punctuation=("？", "！", ","),
                preserve_punctuation=("？", "！"),
            ),
            text,
        )

    def test_default_preservation_keeps_repeated_marks_quotes_decimals_and_abbreviations(self) -> None:
        text = '你好，世界。真的吗？！\n“3.14，U.S.！”'
        processed = processed_script_text(
            text,
            extra_split_punctuation=DEFAULT_EXTRA_SPLIT_PUNCTUATION,
            preserve_punctuation=DEFAULT_PRESERVE_PUNCTUATION,
        )
        self.assertEqual(processed.replace("\n", ""), text.replace("\n", ""))
        self.assertGreater(processed.count("\n"), text.count("\n"))

    def test_multichar_script_separator_has_explicit_keep_and_delete_semantics(self) -> None:
        self.assertEqual(processed_script_text("甲<cut>乙\n丙", extra_split_punctuation=("<cut>",), preserve_punctuation=("<cut>",)), "甲<cut>\n乙\n丙")
        self.assertEqual(processed_script_text("甲<cut>乙\n丙", extra_split_punctuation=("<cut>",), preserve_punctuation=()), "甲\n乙\n丙")

    def test_processed_script_text_keeps_common_closing_marks(self) -> None:
        text = "\n".join((
            "「甲？」",
            "“乙？”",
            "《丙？》",
            "〈丁？〉",
            "（戊？）",
            "【己？】",
            "〔庚？〕",
            "«辛？»",
            "［壬？］",
            "｛癸？｝",
            "〘子？〙",
            "〖丑？〗",
            "〚寅？〛",
        ))

        self.assertEqual(
            processed_script_text(
                text,
                extra_split_punctuation=("？",),
                preserve_punctuation=("？",),
            ),
            text,
        )

    def test_script_match_without_item_timings_keeps_closing_quotes(self) -> None:
        self.project_path.write_text(
            json.dumps(
                {
                    "segments": [
                        {"start": 0, "end": 1000, "text": "但是也有地平论者在发力"},
                        {"start": 1000, "end": 2000, "text": "你有没有自主意识"},
                        {"start": 2000, "end": 3000, "text": "AI 会不会统治地球"},
                    ]
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        text = "但是也有地平论者在发力\n「你有没有自主意识？」\n「AI 会不会统治地球？」"
        self.script_path.write_text(text, encoding="utf-8")

        result = run_script_match(
            ScriptMatchRequest(
                self.project_path,
                None,
                self.script_path,
                OutputMode.JSON,
                extra_split_punctuation=("？", "！", ","),
                preserve_punctuation=("？", "！"),
            )
        )

        assert result.project_path is not None
        self.assertEqual(
            [segment["text"] for segment in read_project(result.project_path)["segments"]],
            [
                "但是也有地平论者在发力",
                "「你有没有自主意识？」",
                "「AI 会不会统治地球？」",
            ],
        )

    def test_script_match_can_disable_or_enable_markdown_cleanup(self) -> None:
        self.project_path.write_text(
            json.dumps({"segments": [{"start": 0, "end": 1000, "text": "这样"}]}, ensure_ascii=False),
            encoding="utf-8",
        )
        self.script_path.write_text("**这样**", encoding="utf-8")

        cleaned = run_script_match(
            ScriptMatchRequest(
                self.project_path,
                None,
                self.script_path,
                OutputMode.JSON,
                clean_markdown_symbols=True,
            )
        )
        assert cleaned.project_path is not None
        self.assertEqual(read_project(cleaned.project_path)["segments"][0]["text"], "这样")

        preserved = run_script_match(
            ScriptMatchRequest(
                self.project_path,
                None,
                self.script_path,
                OutputMode.JSON,
                clean_markdown_symbols=False,
            )
        )
        assert preserved.project_path is not None
        self.assertEqual(read_project(preserved.project_path)["segments"][0]["text"], "**这样**")

    def test_preserved_punctuation_requires_configured_split_symbols(self) -> None:
        # 没有隐式基础集：保留符号必须已配置为断句符号。
        with self.assertRaisesRegex(ValueError, "保留符号"):
            prepare_script_text("甲，乙。", (), ("，", "。"))

        text, warning = prepare_script_text("甲，乙。", ("，", "。"), ("，", "。"))

        self.assertEqual(text, "甲，乙。")
        self.assertIn("断句符号：2 个", warning)

    def test_empty_split_configuration_still_splits_at_newlines(self) -> None:
        text, warning = prepare_script_text("甲，乙。\n丙。", (), ())

        self.assertEqual(text, "甲，乙。\n丙。")
        self.assertIn("仅按换行断句", warning)

    def test_question_and_exclamation_must_be_declared_as_extra_split_symbols(self) -> None:
        with self.assertRaisesRegex(ValueError, "保留符号"):
            prepare_script_text("甲？乙！", (), ("？", "！"))

    def test_preserved_punctuation_must_be_declared_as_a_split_symbol(self) -> None:
        with self.assertRaisesRegex(ValueError, "保留符号"):
            prepare_script_text("甲～", ("！",), ("～",))

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

    def test_resegmenting_keeps_unmatched_source_cues_between_script_lines(self) -> None:
        self.project_path.write_text(
            json.dumps({"segments": [
                {"start": 0, "end": 1000, "text": "第一句文稿", "speaker": "script-1"},
                {"start": 1000, "end": 2000, "text": "录音时多说了第一句话", "speaker": "extra-1"},
                {"start": 2000, "end": 3000, "text": "录音时多说了第二句话", "speaker": "extra-2"},
                {"start": 3000, "end": 4000, "text": "第二句文稿", "speaker": "script-2"},
            ]}, ensure_ascii=False),
            encoding="utf-8",
        )
        self.script_path.write_text("第一句文稿。\n第二句文稿。", encoding="utf-8")

        result = run_script_match(ScriptMatchRequest(
            self.project_path, None, self.script_path, OutputMode.JSON,
        ))

        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual(
            [(segment["start"], segment["end"], segment["text"]) for segment in segments],
            [
                (0, 1000, "第一句文稿。"),
                (1000, 2000, "录音时多说了第一句话"),
                (2000, 3000, "录音时多说了第二句话"),
                (3000, 4000, "第二句文稿。"),
            ],
        )
        self.assertEqual([segment["speaker"] for segment in segments], ["script-1", "extra-1", "extra-2", "script-2"])

    def test_timed_matching_keeps_unmatched_source_cues_between_script_lines(self) -> None:
        def timed_segment(start: int, end: int, text: str) -> dict[str, object]:
            return {
                "start": start,
                "end": end,
                "text": text,
                "items": [{"start": start, "end": end, "text": text}],
            }

        self.project_path.write_text(
            json.dumps({"segments": [
                timed_segment(0, 1000, "第一句文稿"),
                timed_segment(1000, 2000, "录音时多说了第一句话"),
                timed_segment(2000, 3000, "录音时多说了第二句话"),
                timed_segment(3000, 4000, "第二句文稿"),
            ]}, ensure_ascii=False),
            encoding="utf-8",
        )
        self.script_path.write_text("第一句文稿。\n第二句文稿。", encoding="utf-8")

        result = run_script_match(ScriptMatchRequest(
            self.project_path, None, self.script_path, OutputMode.JSON,
        ))

        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual(
            [(segment["start"], segment["end"], segment["text"]) for segment in segments],
            [
                (0, 1000, "第一句文稿。"),
                (1000, 2000, "录音时多说了第一句话"),
                (2000, 3000, "录音时多说了第二句话"),
                (3000, 4000, "第二句文稿。"),
            ],
        )

    def test_timed_matching_uses_segment_bounds_for_missing_items(self) -> None:
        self.project_path.write_text(json.dumps({"segments": [
            {"start": 0, "end": 600, "text": "甲", "items": [{"start": 100, "end": 400, "text": "甲"}]},
            {"start": 1000, "end": 1600, "text": "乙丙", "items": []},
            {"start": 1800, "end": 1900, "text": ""},
            {"start": 2000, "end": 2700, "text": "丁", "items": [{"start": 2100, "end": 2600, "text": "丁"}]},
            {"start": 3000, "end": 3500, "text": "戊", "items": [{"start": 3100, "end": 3400, "text": "戊"}]},
        ]}, ensure_ascii=False), encoding="utf-8")
        self.script_path.write_text("甲\n乙\n丙\n丁\n戊", encoding="utf-8")

        result = run_script_match(ScriptMatchRequest(self.project_path, None, self.script_path, OutputMode.JSON))

        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual(
            [(segment["start"], segment["end"], segment["text"]) for segment in segments],
            [(100, 400, "甲"), (1000, 1300, "乙"), (1300, 1600, "丙"), (2100, 2600, "丁"), (3100, 3400, "戊")],
        )
        self.assertTrue(any("1 个字幕段缺少字词时间码" in warning for warning in result.warnings))

    def test_timed_matching_reports_all_overlapping_extras_even_when_none_survive(self) -> None:
        self.project_path.write_text(json.dumps({"segments": [
            {"start": start, "end": start + 500, "text": text,
             "items": [{"start": start, "end": start + 500, "text": text}], **metadata}
            for start, text, metadata in [
                (0, "开头正文", {}),
                (1000, "额外旁白", {}),
                (2000, "禁用内容", {"disabled": True}),
                (3000, "结尾正文", {}),
            ]
        ]}, ensure_ascii=False), encoding="utf-8")
        self.script_path.write_text("开头正文结尾正文", encoding="utf-8")

        result = run_script_match(ScriptMatchRequest(self.project_path, None, self.script_path, OutputMode.JSON))

        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual([(segment["start"], segment["end"], segment["text"]) for segment in segments], [
            (0, 3500, "开头正文结尾正文"),
        ])
        self.assertIn("1 个文稿之外的 ASR 字幕段与匹配结果完全重叠，未保留。", result.warnings)
        self.assertIn("1 个禁用字幕段与匹配结果完全重叠，未保留。", result.warnings)

    def test_text_mode_does_not_distribute_an_english_id_across_unrelated_cues(self) -> None:
        texts = ["欢迎各位来观看本场比赛", "他确实在拿到名局的时候", "在康康中表现得相当亮眼", "接下来我们一起回顾关键回合"]
        self.project_path.write_text(json.dumps({"segments": [
            {"start": index * 1000, "end": index * 1000 + 900, "text": text}
            for index, text in enumerate(texts)
        ]}, ensure_ascii=False), encoding="utf-8")
        self.script_path.write_text(f"{texts[0]}ZmjjKK{texts[-1]}。", encoding="utf-8")

        result = run_script_match(ScriptMatchRequest(
            self.project_path, None, self.script_path, OutputMode.JSON, match_mode="text",
        ))

        assert result.project_path is not None
        segments = read_project(result.project_path)["segments"]
        self.assertEqual([segment["text"] for segment in segments], [*texts[:-1], f"{texts[-1]}。"])
        self.assertEqual([(segment["start"], segment["end"]) for segment in segments], [
            (index * 1000, index * 1000 + 900) for index in range(len(texts))
        ])

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
