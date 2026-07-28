"""Tests for maw/local_transcriber.py and maw/model_downloader.py."""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch
from pathlib import Path

from maw.local_transcriber import (
    QwenModelHandle,
    WhisperModelHandle,
    TranscriptionResult,
    transcribe_qwen,
    transcribe_whisper,
    write_output_files,
)
from maw.model_downloader import (
    DOWNLOADABLE_MODELS,
    is_model_downloaded,
    invalidate_cache,
)
from maw.utils import (
    SPLIT_GAP_MS,
    SPLIT_MAX_CHARS,
    SPLIT_MIN_CHARS,
)


class TestConstants(unittest.TestCase):
    """P2-5: Named constants exist and have expected values."""

    def test_split_constants(self):
        self.assertIsInstance(SPLIT_MAX_CHARS, int)
        self.assertIsInstance(SPLIT_MIN_CHARS, int)
        self.assertIsInstance(SPLIT_GAP_MS, int)
        self.assertGreater(SPLIT_MAX_CHARS, 0)
        self.assertGreater(SPLIT_MIN_CHARS, 0)
        self.assertGreater(SPLIT_GAP_MS, 0)


class TestDownloadableModels(unittest.TestCase):
    """P1-6: Model cache and downloadable model definitions."""

    def test_has_expected_models(self):
        self.assertIn("qwen-0.6B", DOWNLOADABLE_MODELS)
        self.assertIn("qwen-1.7B", DOWNLOADABLE_MODELS)
        self.assertIn("whisper", DOWNLOADABLE_MODELS)

    def test_model_info_structure(self):
        for key, info in DOWNLOADABLE_MODELS.items():
            self.assertIn("label", info, f"{key} missing label")
            self.assertIn("model_id", info, f"{key} missing model_id")
            self.assertIn("local_dir", info, f"{key} missing local_dir")
            self.assertIn("source", info, f"{key} missing source")

    def test_is_model_downloaded_not_cached(self):
        invalidate_cache()
        # Unknown model key returns False
        result = is_model_downloaded("nonexistent-model-key")
        self.assertFalse(result)

    def test_is_model_downloaded_unknown_key(self):
        result = is_model_downloaded("nonexistent")
        self.assertFalse(result)


class TestQwenModelHandle(unittest.TestCase):
    """P2-8: Separate model handle with proper state management."""

    def setUp(self):
        self.handle = QwenModelHandle()

    def test_initial_state(self):
        status = self.handle.get_status()
        self.assertFalse(status["loaded"])
        self.assertFalse(status["loading"])
        self.assertEqual(status["error"], "")
        self.assertEqual(status["model_size"], "")

    def test_cancel_event(self):
        self.assertFalse(self.handle.cancel_event.is_set())
        self.handle.cancel()
        self.assertTrue(self.handle.cancel_event.is_set())
        self.handle.reset_cancel()
        self.assertFalse(self.handle.cancel_event.is_set())

    def test_unload_when_not_loaded(self):
        # Should not raise
        self.handle.unload()
        status = self.handle.get_status()
        self.assertFalse(status["loaded"])


class TestWhisperModelHandle(unittest.TestCase):
    """P2-8: Separate whisper handle with proper state management."""

    def setUp(self):
        self.handle = WhisperModelHandle()

    def test_initial_state(self):
        status = self.handle.get_status()
        self.assertFalse(status["loaded"])
        self.assertFalse(status["loading"])
        self.assertEqual(status["error"], "")

    def test_cancel_event(self):
        self.assertFalse(self.handle.cancel_event.is_set())
        self.handle.cancel()
        self.assertTrue(self.handle.cancel_event.is_set())
        self.handle.reset_cancel()
        self.assertFalse(self.handle.cancel_event.is_set())

    def test_unload_when_not_loaded(self):
        self.handle.unload()  # Should not raise
        status = self.handle.get_status()
        self.assertFalse(status["loaded"])


class TestTranscriptionResult(unittest.TestCase):
    """P1-1: Explicit result tracking."""

    def test_speed_tag(self):
        r = TranscriptionResult([], "", "qwen3-asr-local-0.6B", "zh", 100.0, 50.0)
        self.assertEqual(r.speed_tag, "2.0x")

    def test_speed_tag_zero_elapsed(self):
        r = TranscriptionResult([], "", "qwen3-asr-local-0.6B", "zh", 100.0, 0)
        self.assertEqual(r.speed_tag, "na")

    def test_to_json_structure(self):
        segments = [
            {"start": 0, "end": 1000, "text": "hello", "items": [{"text": "hello", "start": 0, "end": 1000}]}
        ]
        r = TranscriptionResult(segments, "1\n00:00:00,000 --> 00:00:01,000\nhello\n", "qwen3-asr-local-0.6B", "en", 1.0, 0.5)
        data = r.to_json("/path/media.mp3")
        self.assertEqual(data["media"], "/path/media.mp3")
        self.assertEqual(data["language"], "en")
        self.assertEqual(data["model"], "qwen3-asr-local-0.6B")
        self.assertEqual(len(data["segments"]), 1)
        self.assertEqual(data["segments"][0]["text"], "hello")


class TestWriteOutputFiles(unittest.TestCase):
    """P1-1, P0-6: Output files created without modifying input."""

    def setUp(self):
        self.tmpdir = tempfile.TemporaryDirectory()
        self.out_dir = Path(self.tmpdir.name)

    def tearDown(self):
        self.tmpdir.cleanup()

    def test_write_output_creates_files(self):
        media_path = str(self.out_dir / "test.mp3")
        Path(media_path).write_text("fake audio", encoding="utf-8")
        segments = [{"start": 0, "end": 1000, "text": "test"}]
        r = TranscriptionResult(segments, "1\n00:00:00,000 --> 00:00:01,000\ntest\n", "qwen3-asr-local-0.6B", "zh", 1.0, 0.5)
        json_path = write_output_files(r, media_path, out_dir=self.out_dir, generate_html=False)
        self.assertTrue(json_path.exists())
        self.assertEqual(json_path.suffix, ".json")
        # Verify JSON structure
        with open(json_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        self.assertIn("media", data)
        self.assertIn("segments", data)
        self.assertEqual(len(data["segments"]), 1)
        # SRT should exist too
        srt_path = json_path.with_suffix(".srt")
        self.assertTrue(srt_path.exists())

    def test_write_output_no_existing_file_modification(self):
        """P0-6: Never modify input file."""
        media_path = str(self.out_dir / "existing.mp4")
        Path(media_path).write_text("original content", encoding="utf-8")
        mtime_before = os.path.getmtime(media_path)

        segments = [{"start": 0, "end": 1000, "text": "test"}]
        r = TranscriptionResult(segments, "SRT", "qwen3-asr-local-0.6B", "zh", 1.0, 0.5)
        write_output_files(r, media_path, out_dir=self.out_dir, generate_html=False)

        mtime_after = os.path.getmtime(media_path)
        content = Path(media_path).read_text(encoding="utf-8")
        self.assertEqual(content, "original content")
        self.assertEqual(mtime_before, mtime_after)


class TestUtilsImport(unittest.TestCase):
    """P2-4: All util functions importable from maw.utils."""

    def test_all_exports_available(self):
        from maw.utils import (
            extract_audio,
            format_timestamp,
            generate_srt,
            get_duration_sec,
            is_cjk_char,
            is_cjk_dominant,
            load_hotwords,
            parse_duration,
            repair_nonpositive_duration_segments,
            split_by_silence,
            split_segments_auto,
            split_words_to_segments,
            split_words_to_segments_western,
        )
        # Verify functions are callable
        self.assertTrue(callable(generate_srt))
        self.assertTrue(callable(format_timestamp))
        self.assertTrue(callable(parse_duration))
        self.assertTrue(callable(is_cjk_char))
        self.assertTrue(callable(split_by_silence))

    def test_generate_srt(self):
        from maw.utils import generate_srt
        segments = [{"start": 1000, "end": 2000, "text": "hello world"}]
        srt = generate_srt(segments)
        self.assertIn("00:00:01,000", srt)
        self.assertIn("00:00:02,000", srt)
        self.assertIn("hello world", srt)

    def test_format_timestamp(self):
        from maw.utils import format_timestamp
        self.assertEqual(format_timestamp(0), "00:00:00,000")
        self.assertEqual(format_timestamp(1000), "00:00:01,000")
        self.assertEqual(format_timestamp(61000), "00:01:01,000")
        self.assertEqual(format_timestamp(3661000), "01:01:01,000")

    def test_parse_duration(self):
        from maw.utils import parse_duration
        self.assertAlmostEqual(parse_duration("10s"), 10.0)
        self.assertAlmostEqual(parse_duration("5m"), 300.0)
        self.assertAlmostEqual(parse_duration("1h"), 3600.0)
        self.assertAlmostEqual(parse_duration("90"), 90.0)
        with self.assertRaises(Exception):
            parse_duration("invalid")

    def test_is_cjk_char(self):
        from maw.utils import is_cjk_char
        self.assertTrue(is_cjk_char("中"))
        self.assertTrue(is_cjk_char("文"))
        self.assertFalse(is_cjk_char("a"))
        self.assertFalse(is_cjk_char("1"))
        self.assertFalse(is_cjk_char(" "))

    def test_split_by_silence(self):
        from maw.utils import split_by_silence
        items = [
            {"text": "a", "start": 0, "end": 100},
            {"text": "b", "start": 500, "end": 600},
            {"text": "c", "start": 700, "end": 800},
        ]
        # Gap 500-0=500 >= 300, so split
        groups = split_by_silence(items, 300)
        self.assertEqual(len(groups), 2)
        self.assertEqual(len(groups[0]), 1)
        self.assertEqual(len(groups[1]), 2)

    def test_split_by_silence_no_gap(self):
        from maw.utils import split_by_silence
        items = [
            {"text": "a", "start": 0, "end": 100},
            {"text": "b", "start": 150, "end": 200},
        ]
        groups = split_by_silence(items, 300)
        self.assertEqual(len(groups), 1)

    def test_repair_nonpositive_duration(self):
        from maw.utils import repair_nonpositive_duration_segments
        segs = [
            {"start": 0, "end": 1000, "text": "first", "items": []},
            {"start": 1000, "end": 1000, "text": "zero", "items": []},  # zero duration
            {"start": 2000, "end": 3000, "text": "third", "items": []},
        ]
        repaired = repair_nonpositive_duration_segments(segs)
        self.assertEqual(len(repaired), 2)
        # zero-duration gets merged into the next valid segment
        self.assertIn("zero", repaired[1]["text"])

    def test_repair_all_zero(self):
        from maw.utils import repair_nonpositive_duration_segments
        segs = [
            {"start": 0, "end": 0, "text": "a", "items": []},
            {"start": 0, "end": 0, "text": "b", "items": []},
        ]
        repaired = repair_nonpositive_duration_segments(segs)
        self.assertEqual(len(repaired), 1)
        self.assertEqual(repaired[0]["text"], "ab")


class TestLoadHotwords(unittest.TestCase):
    """P2-2: Hotwords loaded from file, ignore comments."""

    def test_load_hotwords_example(self):
        from maw.utils import load_hotwords
        result = load_hotwords()
        self.assertIsInstance(result, list)


class TestQwenHandleLocking(unittest.TestCase):
    """P2-8: Loading twice raises error."""

    def test_load_twice_not_allowed(self):
        handle = QwenModelHandle()
        # Not loaded, so get_model returns None - not an error
        self.assertIsNone(handle.get_model())
        # load would require actual model, but that's OK - we just check the locking
        handle._loading = True  # Simulate loading state
        with self.assertRaises(RuntimeError):
            handle.load("0.6B")


class TestCacheInvalidation(unittest.TestCase):
    """P1-6: Cache can be invalidated."""

    def test_invalidate_all(self):
        from maw.model_downloader import _model_exists_cache
        _model_exists_cache["test"] = True
        invalidate_cache()
        self.assertNotIn("test", _model_exists_cache)

    def test_invalidate_single(self):
        from maw.model_downloader import _model_exists_cache
        _model_exists_cache["test1"] = True
        _model_exists_cache["test2"] = True
        invalidate_cache("test1")
        self.assertNotIn("test1", _model_exists_cache)
        self.assertIn("test2", _model_exists_cache)
        invalidate_cache()


class TestTranscribeQwenWithMock(unittest.TestCase):
    """Mock 层测试 transcribe_qwen 的参数传递和错误处理。"""

    @patch("maw.local_transcriber.extract_audio")
    @patch("maw.local_transcriber.get_duration_sec")
    @patch("maw.local_transcriber.split_words_to_segments")
    @patch("maw.local_transcriber.generate_srt")
    def test_transcribe_qwen_basic(self, mock_srt, mock_split, mock_dur, mock_extract):
        mock_dur.return_value = 10.0
        mock_srt.return_value = "1\n00:00:00,000 --> 00:00:05,000\\ntest\\n"

        # Mock the model's transcribe return
        mock_model = MagicMock()
        mock_result = MagicMock()
        mock_result.language = "zh"
        mock_result.text = "test audio"
        mock_result.time_stamps = [
            type("ts", (), {"text": "test", "start_time": 0.0, "end_time": 1.0})(),
            type("ts", (), {"text": "audio", "start_time": 1.0, "end_time": 2.0})(),
        ]
        mock_model.transcribe.return_value = [mock_result]
        mock_split.return_value = [
            {"start": 0, "end": 2000, "text": "test audio", "items": []}
        ]

        handle = QwenModelHandle()
        handle._model = mock_model
        handle._model_size = "0.6B"

        result = transcribe_qwen(
            "test.mp4", handle,
            language="zh",
            keep_punct=True,
            progress_cb=lambda msg: None,
        )
        self.assertEqual(result.detected_language, "zh")
        self.assertEqual(result.model_tag, "qwen3-asr-local-0.6B")
        mock_extract.assert_called_once()
        mock_dur.assert_called_once()

    @patch("maw.local_transcriber.extract_audio")
    @patch("maw.local_transcriber.get_duration_sec")
    def test_transcribe_qwen_model_not_loaded(self, mock_dur, mock_extract):
        mock_dur.return_value = 10.0
        handle = QwenModelHandle()
        with self.assertRaises(RuntimeError) as ctx:
            transcribe_qwen("test.mp4", handle)
        self.assertIn("not loaded", str(ctx.exception))

    @patch("maw.local_transcriber.extract_audio")
    @patch("maw.local_transcriber.get_duration_sec")
    def test_transcribe_qwen_no_result(self, mock_dur, mock_extract):
        mock_dur.return_value = 10.0
        mock_model = MagicMock()
        mock_model.transcribe.return_value = []

        handle = QwenModelHandle()
        handle._model = mock_model
        handle._model_size = "0.6B"

        with self.assertRaises(RuntimeError) as ctx:
            transcribe_qwen("test.mp4", handle)
        self.assertIn("No result", str(ctx.exception))

    @patch("maw.local_transcriber.extract_audio")
    @patch("maw.local_transcriber.get_duration_sec")
    @patch("maw.local_transcriber.generate_srt")
    def test_transcribe_qwen_cancelled(self, mock_srt, mock_dur, mock_extract):
        mock_dur.return_value = 10.0
        mock_srt.return_value = ""
        mock_model = MagicMock()
        mock_result = MagicMock()
        mock_result.language = "en"
        mock_result.text = "test"
        mock_result.time_stamps = []
        # Set cancel event after transcribe returns (simulates user cancelling mid-flight)
        handle_for_side = QwenModelHandle()
        def _side(*a, **kw):
            handle_for_side.cancel()
            return [mock_result]
        mock_model.transcribe.side_effect = _side

        handle = QwenModelHandle()
        handle._model = mock_model
        handle._model_size = "0.6B"
        # Share cancel event so transcribe_qwen sees it
        handle._cancel_event = handle_for_side._cancel_event

        with self.assertRaises(RuntimeError) as ctx:
            transcribe_qwen("test.mp4", handle)
        self.assertIn("Cancelled", str(ctx.exception))

    @patch("maw.local_transcriber.extract_audio")
    @patch("maw.local_transcriber.get_duration_sec")
    def test_transcribe_qwen_keep_punct_false(self, mock_dur, mock_extract):
        """P2-5: keep_punct=False strips trailing punctuation."""
        mock_dur.return_value = 10.0
        mock_model = MagicMock()
        mock_result = MagicMock()
        mock_result.language = "zh"
        mock_result.text = "test，"
        mock_result.time_stamps = [
            type("ts", (), {"text": "test，", "start_time": 0.0, "end_time": 1.0})(),
        ]
        mock_model.transcribe.return_value = [mock_result]

        from maw.local_transcriber import split_words_to_segments
        with patch("maw.local_transcriber.split_words_to_segments") as mock_split:
            mock_split.return_value = [{"start": 0, "end": 1000, "text": "test，", "items": [{"text": "test，", "start": 0, "end": 1000}]}]

            handle = QwenModelHandle()
            handle._model = mock_model
            handle._model_size = "0.6B"

            result = transcribe_qwen("test.mp4", handle, keep_punct=False)
            # The comma should be stripped from the segment text
            seg = result.segments[0]
            self.assertFalse(seg["text"].endswith("，"))


class TestTranscribeWhisperWithMock(unittest.TestCase):
    """Mock 层测试 transcribe_whisper。"""

    @patch("maw.local_transcriber.extract_audio")
    @patch("maw.local_transcriber.get_duration_sec")
    @patch("maw.local_transcriber.generate_srt")
    def test_transcribe_whisper_basic(self, mock_srt, mock_dur, mock_extract):
        mock_dur.return_value = 5.0
        mock_srt.return_value = "1\n00:00:00,000 --> 00:00:02,000\\ntest\\n"

        # Mock WhisperModel return
        mock_seg = MagicMock()
        mock_seg.start = 0.0
        mock_seg.end = 2.0
        mock_seg.text = "test audio"

        mock_info = MagicMock()
        mock_info.language = "en"

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_seg], mock_info)

        handle = WhisperModelHandle()
        handle._model = mock_model

        result = transcribe_whisper("test.mp4", handle, language="en")
        self.assertEqual(result.detected_language, "en")
        self.assertIn("test audio", result.segments[0]["text"])
        mock_extract.assert_called_once()

    @patch("maw.local_transcriber.extract_audio")
    @patch("maw.local_transcriber.get_duration_sec")
    def test_transcribe_whisper_model_not_loaded(self, mock_dur, mock_extract):
        mock_dur.return_value = 5.0
        handle = WhisperModelHandle()
        with self.assertRaises(RuntimeError) as ctx:
            transcribe_whisper("test.mp4", handle)
        self.assertIn("not loaded", str(ctx.exception))

    @patch("maw.local_transcriber.extract_audio")
    @patch("maw.local_transcriber.get_duration_sec")
    def test_transcribe_whisper_no_segments(self, mock_dur, mock_extract):
        mock_dur.return_value = 5.0
        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([], None)

        handle = WhisperModelHandle()
        handle._model = mock_model

        with self.assertRaises(RuntimeError) as ctx:
            transcribe_whisper("test.mp4", handle)
        self.assertIn("No transcription", str(ctx.exception))

    @patch("maw.local_transcriber.extract_audio")
    @patch("maw.local_transcriber.get_duration_sec")
    @patch("maw.local_transcriber.generate_srt")
    def test_transcribe_whisper_native_segments(self, mock_srt, mock_dur, mock_extract):
        """P2-6: Whisper uses native segment boundaries, no re-split."""
        mock_dur.return_value = 5.0
        mock_srt.return_value = ""

        mock_seg1 = MagicMock()
        mock_seg1.start = 0.0; mock_seg1.end = 2.0; mock_seg1.text = "first sentence."
        mock_seg2 = MagicMock()
        mock_seg2.start = 2.5; mock_seg2.end = 4.0; mock_seg2.text = "second sentence."

        mock_info = MagicMock()
        mock_info.language = "en"

        mock_model = MagicMock()
        mock_model.transcribe.return_value = ([mock_seg1, mock_seg2], mock_info)

        handle = WhisperModelHandle()
        handle._model = mock_model

        result = transcribe_whisper("test.mp4", handle)
        # Should have 2 segments matching the original native boundaries
        self.assertEqual(len(result.segments), 2)
        self.assertEqual(result.segments[0]["start"], 0)
        self.assertEqual(result.segments[0]["end"], 2000)
        self.assertEqual(result.segments[1]["start"], 2500)
