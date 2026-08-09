from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw.gui_config import provider_by_id  # noqa: E402
from maw.local_models import LocalModelStatus, inspect_local_model, prepare_local_model  # noqa: E402


class LocalModelDiscoveryTests(unittest.TestCase):
    def test_missing_runtime_is_reported_without_scanning_model_imports(self) -> None:
        model = provider_by_id("local").models[0]
        not_ready = mock.Mock(ready=False, python_path="", model_cache_path="")

        with mock.patch("maw.local_models.importlib.util.find_spec", return_value=None):
            with mock.patch("maw.local_models.managed_runtime_status", return_value=not_ready):
                status = inspect_local_model(model)

        self.assertEqual(status.status, "runtime_missing")
        self.assertFalse(status.runtime_available)

    def test_qwen_huggingface_cache_requires_forced_aligner_too(self) -> None:
        model = provider_by_id("local").models[0]
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir)
            main = cache / "models--Qwen--Qwen3-ASR-0.6B" / "snapshots" / "main"
            aligner = cache / "models--Qwen--Qwen3-ForcedAligner-0.6B" / "snapshots" / "align"
            main.mkdir(parents=True)
            (main / "model.safetensors").write_bytes(b"weights")

            with mock.patch.dict(os.environ, {"HF_HUB_CACHE": str(cache)}):
                with mock.patch("maw.local_models._huggingface_cache_roots", return_value=[cache]):
                    with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                        partial = inspect_local_model(model)
                        aligner.mkdir(parents=True)
                        (aligner / "model.safetensors").write_bytes(b"weights")
                        installed = inspect_local_model(model)

        self.assertEqual(partial.status, "partial")
        self.assertEqual(installed.status, "installed")
        self.assertEqual(installed.path, str(main.resolve()))

    def test_explicit_folder_is_used_without_persisting_it(self) -> None:
        model = provider_by_id("local").models[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "model.pt").write_bytes(b"weights")
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertEqual(status.path, str(Path(temp_dir).resolve()))

    def test_explicit_empty_folder_is_rejected(self) -> None:
        model = provider_by_id("local").models[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertFalse(status.installed)
        self.assertIn("为空", status.detail)

    def test_explicit_folder_without_weight_file_is_rejected(self) -> None:
        model = provider_by_id("local").models[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "README.md").write_text("not a model", encoding="utf-8")
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertFalse(status.installed)

    def test_fun_asr_does_not_accept_a_qwen_model_cache_folder(self) -> None:
        model = provider_by_id("local").models[1]
        with tempfile.TemporaryDirectory(prefix="models--Qwen--Qwen3-ASR-0.6B-") as temp_dir:
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "path_mismatch")
        self.assertFalse(status.installed)
        self.assertIn("Qwen3-ASR", status.detail)

    def test_funasr_hub_style_modelscope_cache_is_detected(self) -> None:
        model = provider_by_id("local").models[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir)
            snapshot = (
                cache
                / "models"
                / "iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
                / "snapshots"
                / "master"
            )
            snapshot.mkdir(parents=True)
            (snapshot / "model.pt").write_bytes(b"pt")

            with mock.patch("maw.local_models._modelscope_cache_roots", return_value=[cache]):
                with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                    status = inspect_local_model(model)

        self.assertEqual(status.status, "installed")
        self.assertTrue(status.installed)
        self.assertEqual(status.path, str(snapshot.resolve()))

    def test_funasr_legacy_modelscope_cache_is_detected_via_cache_refs(self) -> None:
        model = provider_by_id("local").models[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir)
            legacy = cache / "models" / "iic" / "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
            legacy.mkdir(parents=True)
            (legacy / "model.pt").write_bytes(b"pt")

            with mock.patch("maw.local_models._modelscope_cache_roots", return_value=[cache]):
                with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                    status = inspect_local_model(model)

        self.assertEqual(status.status, "installed")
        self.assertEqual(status.path, str(legacy.resolve()))

    def test_empty_modelscope_fallback_directory_is_not_detected(self) -> None:
        model = provider_by_id("local").models[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir)
            empty = cache / "models" / "iic--speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
            empty.mkdir(parents=True)

            with mock.patch("maw.local_models._modelscope_cache_roots", return_value=[cache]):
                with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                    status = inspect_local_model(model)

        self.assertEqual(status.status, "missing")
        self.assertFalse(status.installed)

    def test_prepare_reports_phase_and_component_messages(self) -> None:
        model = provider_by_id("local").models[0]
        missing = LocalModelStatus(model.id, model.engine, model.model_ref, "missing", True, False)
        installed = LocalModelStatus(model.id, model.engine, model.model_ref, "installed", True, True)
        events: list[str] = []

        with mock.patch("maw.local_models.inspect_local_model", side_effect=[missing, installed]):
            with mock.patch("maw.local_models.prepare_model_in_process", return_value=0) as prepare:
                result = prepare_local_model(model, on_event=events.append)

        self.assertEqual(result.status, "installed")
        self.assertTrue(any("正在准备" in event for event in events))
        self.assertTrue(any("模型组件" in event for event in events))
        prepare.assert_called_once()

    def test_managed_prepare_forwards_cancel_event_to_runtime_process(self) -> None:
        model = provider_by_id("local").models[0]
        missing = LocalModelStatus(
            model.id,
            model.engine,
            model.model_ref,
            "missing",
            True,
            False,
            runtime_source="managed",
        )
        installed = LocalModelStatus(
            model.id,
            model.engine,
            model.model_ref,
            "installed",
            True,
            True,
            runtime_source="managed",
        )
        cancel_event = Event()

        with mock.patch("maw.local_models.inspect_local_model", side_effect=[missing, installed]):
            with mock.patch("maw.local_models.prepare_model_in_runtime", return_value=0) as prepare:
                prepare_local_model(model, cancel_event=cancel_event)

        self.assertIs(prepare.call_args.kwargs["cancel_event"], cancel_event)


if __name__ == "__main__":
    unittest.main()
