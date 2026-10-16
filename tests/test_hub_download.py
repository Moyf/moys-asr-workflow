"""Tests for the Hugging Face → ModelScope fallback download helper."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw.hub_download import HubSnapshot, modelscope_repo_id, prepare_hub_snapshot  # noqa: E402


class ModelScopeRepoIdTests(unittest.TestCase):
    def test_identity_mapping_by_default(self) -> None:
        self.assertEqual(modelscope_repo_id("Qwen/Qwen3-ASR-0.6B"), "Qwen/Qwen3-ASR-0.6B")
        self.assertEqual(modelscope_repo_id("Systran/faster-whisper-large-v3"), "Systran/faster-whisper-large-v3")

    def test_moss_mirror_uses_modelscope_org(self) -> None:
        self.assertEqual(
            modelscope_repo_id("OpenMOSS-Team/MOSS-Transcribe-Diarize"),
            "OpenMOSS/MOSS-Transcribe-Diarize",
        )


class PrepareHubSnapshotTests(unittest.TestCase):
    def setUp(self) -> None:
        cache = tempfile.TemporaryDirectory()
        self.addCleanup(cache.cleanup)
        self.hf_cache = Path(cache.name) / "huggingface"
        self.ms_cache = Path(cache.name) / "modelscope"
        # Keep actual snapshot discovery, but never inspect developer caches.
        self.enterContext(mock.patch("maw.local_models._huggingface_cache_roots", return_value=[self.hf_cache]))
        self.enterContext(mock.patch("maw.local_models._modelscope_cache_roots", return_value=[self.ms_cache]))

    def test_rejects_values_that_are_not_repo_ids(self) -> None:
        with self.assertRaises(ValueError):
            prepare_hub_snapshot("large-v3")

    def test_existing_huggingface_cache_is_reused_without_downloading(self) -> None:
        snapshot = self.hf_cache / "models--Qwen--Qwen3-ASR-0.6B" / "snapshots" / "main"
        snapshot.mkdir(parents=True)
        (snapshot / "model.safetensors").write_bytes(b"weights")
        with mock.patch("maw.hub_download._huggingface_snapshot_download", side_effect=AssertionError("must reuse cache")) as hf_download, \
                mock.patch("maw.hub_download._modelscope_snapshot_download", side_effect=AssertionError("must reuse cache")) as ms_download:
            result = prepare_hub_snapshot("Qwen/Qwen3-ASR-0.6B")

        self.assertEqual(result.source, "cache")
        self.assertEqual(result.path.resolve(), snapshot.resolve())
        hf_download.assert_not_called()
        ms_download.assert_not_called()

    def test_existing_modelscope_cache_is_reused_including_mirrored_org(self) -> None:
        snapshot = self.ms_cache / "models" / "OpenMOSS--MOSS-Transcribe-Diarize" / "snapshots" / "master"
        snapshot.mkdir(parents=True)
        (snapshot / "model.safetensors").write_bytes(b"weights")
        with mock.patch("maw.hub_download._huggingface_snapshot_download", side_effect=AssertionError("must reuse cache")) as hf_download, \
                mock.patch("maw.hub_download._modelscope_snapshot_download", side_effect=AssertionError("must reuse cache")) as ms_download:
            result = prepare_hub_snapshot("OpenMOSS-Team/MOSS-Transcribe-Diarize")

        self.assertEqual(result.source, "cache")
        self.assertEqual(result.path.resolve(), snapshot.resolve())
        hf_download.assert_not_called()
        ms_download.assert_not_called()

    def test_huggingface_cache_has_priority_when_both_hubs_contain_the_model(self) -> None:
        hf = self.hf_cache / "models--OpenMOSS-Team--MOSS-Transcribe-Diarize" / "snapshots" / "main"
        ms = self.ms_cache / "models" / "OpenMOSS--MOSS-Transcribe-Diarize" / "snapshots" / "master"
        for snapshot in (hf, ms):
            snapshot.mkdir(parents=True)
            (snapshot / "model.safetensors").write_bytes(b"weights")
        with mock.patch("maw.hub_download._huggingface_snapshot_download", side_effect=AssertionError("must reuse cache")) as hf_download, \
                mock.patch("maw.hub_download._modelscope_snapshot_download", side_effect=AssertionError("must reuse cache")) as ms_download:
            result = prepare_hub_snapshot("OpenMOSS-Team/MOSS-Transcribe-Diarize")
        self.assertEqual(result.source, "cache")
        self.assertEqual(result.path.resolve(), hf.resolve())
        hf_download.assert_not_called()
        ms_download.assert_not_called()

    def test_huggingface_failure_falls_back_to_modelscope(self) -> None:
        events: list[str] = []
        fallback = HubSnapshot(Path("/tmp/ms-snapshot"), "modelscope")

        with mock.patch("maw.hub_download._find_cached_snapshot", return_value=None):
            with mock.patch(
                "maw.hub_download._huggingface_snapshot_download",
                side_effect=ConnectionError("connection timed out"),
            ) as hf_download:
                with mock.patch(
                    "maw.hub_download._modelscope_snapshot_download",
                    return_value=fallback.path,
                ) as ms_download:
                    result = prepare_hub_snapshot(
                        "OpenMOSS-Team/MOSS-Transcribe-Diarize",
                        emit=events.append,
                    )

        self.assertEqual(result.source, "modelscope")
        hf_download.assert_called_once()
        self.assertEqual(ms_download.call_args.args[0], "OpenMOSS-Team/MOSS-Transcribe-Diarize")
        self.assertTrue(any("ModelScope" in event for event in events))

    def test_double_failure_reports_both_errors(self) -> None:
        # 隔离开发机真实的 ~/.cache 缓存，确保走到下载分支。
        with mock.patch("maw.hub_download._find_cached_snapshot", return_value=None):
            with mock.patch(
                "maw.hub_download._huggingface_snapshot_download",
                side_effect=ConnectionError("hf unreachable"),
            ):
                with mock.patch(
                    "maw.hub_download._modelscope_snapshot_download",
                    side_effect=RuntimeError("ms unreachable"),
                ):
                    with self.assertRaises(RuntimeError) as context:
                        prepare_hub_snapshot("Qwen/Qwen3-ASR-0.6B")

        message = str(context.exception)
        self.assertIn("hf unreachable", message)
        self.assertIn("ms unreachable", message)

    def test_cancellation_between_attempts_is_preserved(self) -> None:
        cancel = Event()
        cancel.set()
        with self.assertRaisesRegex(RuntimeError, "取消"):
            prepare_hub_snapshot("Qwen/Qwen3-ASR-0.6B", cancel_event=cancel)


class HubSnapshotRevisionTests(unittest.TestCase):
    def test_revision_is_only_forwarded_to_huggingface_download(self) -> None:
        events: list[str] = []
        with mock.patch("maw.hub_download._find_cached_snapshot", return_value=None):
            with mock.patch(
                "maw.hub_download._huggingface_snapshot_download",
                side_effect=ConnectionError("down"),
            ) as hf_download:
                with mock.patch(
                    "maw.hub_download._modelscope_snapshot_download",
                    return_value=Path("/tmp/ms"),
                ) as ms_download:
                    prepare_hub_snapshot(
                        "OpenMOSS-Team/MOSS-Transcribe-Diarize",
                        emit=events.append,
                        revision="e8681d68",
                    )

        self.assertEqual(hf_download.call_args.kwargs["revision"], "e8681d68")
        self.assertNotIn("revision", ms_download.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
