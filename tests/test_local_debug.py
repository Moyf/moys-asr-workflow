from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw.local_debug import LocalDebugWriter, debug_json_value, local_debug_manifest_path


class LocalDebugWriterTests(unittest.TestCase):
    def test_debug_json_value_keeps_model_result_attributes(self) -> None:
        value = debug_json_value(SimpleNamespace(text="原始", timestamps=[(0, 100)]))

        self.assertEqual(value, {"text": "原始", "timestamps": [[0, 100]]})

    def test_writes_stage_files_and_manifest_next_to_output(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            output = Path(temp_dir) / "clip.firered-local.srt"
            writer = LocalDebugWriter(output, engine="firered", model="firered-asr2-ctc")
            transcription = SimpleNamespace(
                text="你好。",
                language="zh",
                language_source="detected",
                split_mode="continuous",
                timestamp_granularity="char",
                model="firered-asr2-ctc",
                preserve_punctuation=True,
                items=[{"text": "你", "start": 0, "end": 100}],
                segments=[{"text": "你好。", "start": 0, "end": 500}],
            )

            stage = writer.write_transcription("local-transcription", transcription)
            manifest = writer.write_manifest(outputs={"srt": output})

            self.assertEqual(stage.name, "clip.firered-local.local-debug.local-transcription.json")
            self.assertEqual(manifest, local_debug_manifest_path(output))
            self.assertEqual(json.loads(stage.read_text(encoding="utf-8"))["payload"]["text"], "你好。")
            payload = json.loads(manifest.read_text(encoding="utf-8"))
            self.assertEqual(payload["schema"], "moy.asr.local_debug.v1")
            self.assertEqual(payload["artifacts"]["local-transcription"], str(stage))

    def test_writes_debug_files_under_configured_debug_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir).resolve()
            media = root / "clip.mp4"
            output = root / "clip.srt"
            config = SimpleNamespace(
                gui_lang="zh",
                output_subfolder=True,
                per_video_subfolder=True,
            )

            with mock.patch("maw.gui_config.effective_config", return_value=config):
                writer = LocalDebugWriter(
                    output,
                    engine="firered",
                    model="firered-asr2-ctc",
                    media_path=media,
                    explicit_output=True,
                )
                stage = writer.write("ct-punc", {"text": "你好。"})
                manifest = writer.write_manifest(outputs={"srt": output})

            debug_dir = root / "clip_maw" / "调试"
            self.assertEqual(stage.parent, debug_dir)
            self.assertEqual(manifest, debug_dir / "clip.local-debug.json")
            self.assertTrue(stage.exists())
            self.assertTrue(manifest.exists())
