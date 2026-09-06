from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.postprocess_io import _available_output, write_artifacts


class PostprocessOutputNamingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.project_path = self.root / "clip.mosp"
        self.project_path.write_text(
            json.dumps({"segments": [{"start": 0, "end": 1000, "text": "字幕"}]}, ensure_ascii=False),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_available_output_localizes_known_operations(self) -> None:
        source = self.project_path

        self.assertEqual(
            _available_output(source, "ocr-dedup", ".srt", lang="zh").name,
            "clip.OCR去重.srt",
        )
        self.assertEqual(
            _available_output(source, "ocr-dedup", ".srt", lang="en").name,
            "clip.ocr-dedup.srt",
        )
        self.assertEqual(
            _available_output(source, "postprocess", ".srt", lang="zh").name,
            "clip.后处理.srt",
        )
        self.assertEqual(
            _available_output(source, "postprocess", ".srt", lang="en").name,
            "clip.postprocess.srt",
        )
        self.assertEqual(
            _available_output(source, "match", ".srt", lang="zh").name,
            "clip.匹配.srt",
        )
        self.assertEqual(
            _available_output(source, "match", ".srt", lang="en").name,
            "clip.match.srt",
        )

    def test_available_output_unknown_operation_keeps_legacy_ascii_token(self) -> None:
        source = self.project_path
        for lang in ("zh", "en"):
            # 不在命名契约内、也不是翻译形态的 operation 两种界面都走 legacy ASCII。
            self.assertEqual(
                _available_output(source, "proofread", ".srt", lang=lang).name,
                "clip.proofread.srt",
            )
            self.assertEqual(
                _available_output(source, "custom-op", ".srt", lang=lang).name,
                "clip.custom-op.srt",
            )

    def test_available_output_localizes_hyphenated_translation_in_zh_only(self) -> None:
        source = self.project_path
        # zh 界面：纯翻译段与 bilingual/combined 组合都本地化（标记本地化并保留点分隔）。
        self.assertEqual(
            _available_output(source, "translate-zh", ".srt", lang="zh").name,
            "clip.翻译为中文.srt",
        )
        self.assertEqual(
            _available_output(source, "translate-en", ".srt", lang="zh").name,
            "clip.翻译为英文.srt",
        )
        self.assertEqual(
            _available_output(source, "translate-zh-bilingual", ".srt", lang="zh").name,
            "clip.翻译为中文.双语合一.srt",
        )
        self.assertEqual(
            _available_output(source, "translate-en-combined", ".mosp", lang="zh").name,
            "clip.翻译为英文.整合.mosp",
        )
        # 未知 target 原样保留英文段。
        self.assertEqual(
            _available_output(source, "translate-ja", ".srt", lang="zh").name,
            "clip.translate-ja.srt",
        )
        # en 界面：与改动前逐字节一致（连字符原样）。
        self.assertEqual(
            _available_output(source, "translate-zh", ".srt", lang="en").name,
            "clip.translate-zh.srt",
        )
        self.assertEqual(
            _available_output(source, "translate-en", ".srt", lang="en").name,
            "clip.translate-en.srt",
        )
        self.assertEqual(
            _available_output(source, "translate-zh-bilingual", ".srt", lang="en").name,
            "clip.translate-zh-bilingual.srt",
        )
        self.assertEqual(
            _available_output(source, "translate-en-combined", ".mosp", lang="en").name,
            "clip.translate-en-combined.mosp",
        )

    def test_available_output_localizes_underscore_bases_in_zh_and_keeps_legacy_in_en(self) -> None:
        source = self.project_path
        # zh 界面：下划线 base（工具箱 ID）与混合形态同样本地化。
        self.assertEqual(
            _available_output(source, "translate_zh", ".srt", lang="zh").name,
            "clip.翻译为中文.srt",
        )
        self.assertEqual(
            _available_output(source, "translate_en", ".mosp", lang="zh").name,
            "clip.翻译为英文.mosp",
        )
        self.assertEqual(
            _available_output(source, "translate_zh-bilingual", ".srt", lang="zh").name,
            "clip.翻译为中文.双语合一.srt",
        )
        # en 界面：沿用 legacy ASCII 清洗，输出与改动前逐字节一致。
        self.assertEqual(
            _available_output(source, "translate_zh", ".srt", lang="en").name,
            "clip.translate-zh.srt",
        )
        self.assertEqual(
            _available_output(source, "translate_en", ".mosp", lang="en").name,
            "clip.translate-en.mosp",
        )
        self.assertEqual(
            _available_output(source, "translate_zh-bilingual", ".srt", lang="en").name,
            "clip.translate-zh-bilingual.srt",
        )

    def test_conflict_counter_applies_to_localized_names(self) -> None:
        output_directory = self.root / "out"
        output_directory.mkdir()
        source = self.project_path

        first = _available_output(source, "ocr-dedup", ".srt", output_directory=output_directory, lang="zh")
        self.assertEqual(first.name, "clip.OCR去重.srt")
        first.touch()

        second = _available_output(source, "ocr-dedup", ".srt", output_directory=output_directory, lang="zh")
        self.assertEqual(second.name, "clip.OCR去重-2.srt")
        second.touch()

        third = _available_output(source, "ocr-dedup", ".srt", output_directory=output_directory, lang="zh")
        self.assertEqual(third.name, "clip.OCR去重-3.srt")

    def test_write_artifacts_localizes_known_operation_file_names(self) -> None:
        output_directory = self.root / "out"
        output_directory.mkdir()
        project = json.loads(self.project_path.read_text(encoding="utf-8"))

        with mock.patch("maw.output_naming.resolve_lang", return_value="zh"):
            zh = write_artifacts(
                project,
                source_project_path=self.project_path,
                source_srt_path=None,
                operation="ocr-dedup",
                write_project=True,
                write_srt=True,
                output_directory=output_directory,
            )
        self.assertEqual(zh.project_path.name, "clip.OCR去重.mosp")
        self.assertEqual(zh.srt_path.name, "clip.OCR去重.srt")

        with mock.patch("maw.output_naming.resolve_lang", return_value="en"):
            en = write_artifacts(
                project,
                source_project_path=self.project_path,
                source_srt_path=None,
                operation="ocr-dedup",
                write_project=True,
                write_srt=True,
                output_directory=output_directory,
            )
        self.assertEqual(en.project_path.name, "clip.ocr-dedup.mosp")
        self.assertEqual(en.srt_path.name, "clip.ocr-dedup.srt")

    def test_write_artifacts_unknown_operation_keeps_existing_file_names(self) -> None:
        output_directory = self.root / "out"
        output_directory.mkdir()
        project = json.loads(self.project_path.read_text(encoding="utf-8"))

        with mock.patch("maw.output_naming.resolve_lang", return_value="zh"):
            artifact = write_artifacts(
                project,
                source_project_path=self.project_path,
                source_srt_path=None,
                operation="proofread",
                write_project=True,
                write_srt=True,
                output_directory=output_directory,
            )
        self.assertEqual(artifact.project_path.name, "clip.proofread.mosp")
        self.assertEqual(artifact.srt_path.name, "clip.proofread.srt")

    def test_write_artifacts_localizes_translation_operation_file_names(self) -> None:
        output_directory = self.root / "out"
        output_directory.mkdir()
        project = json.loads(self.project_path.read_text(encoding="utf-8"))

        with mock.patch("maw.output_naming.resolve_lang", return_value="zh"):
            zh = write_artifacts(
                project,
                source_project_path=self.project_path,
                source_srt_path=None,
                operation="translate-zh-bilingual",
                write_project=True,
                write_srt=True,
                output_directory=output_directory,
            )
        self.assertEqual(zh.project_path.name, "clip.翻译为中文.双语合一.mosp")
        self.assertEqual(zh.srt_path.name, "clip.翻译为中文.双语合一.srt")

        with mock.patch("maw.output_naming.resolve_lang", return_value="en"):
            en = write_artifacts(
                project,
                source_project_path=self.project_path,
                source_srt_path=None,
                operation="translate-zh-bilingual",
                write_project=True,
                write_srt=True,
                output_directory=output_directory,
            )
        self.assertEqual(en.project_path.name, "clip.translate-zh-bilingual.mosp")
        self.assertEqual(en.srt_path.name, "clip.translate-zh-bilingual.srt")
