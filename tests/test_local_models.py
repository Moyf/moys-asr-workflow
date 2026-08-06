from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
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

            with mock.patch.dict(os.environ, {"HF_HUB_CACHE": str(cache)}):
                with mock.patch("maw.local_models._huggingface_cache_roots", return_value=[cache]):
                    with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                        partial = inspect_local_model(model)
                        aligner.mkdir(parents=True)
                        installed = inspect_local_model(model)

        self.assertEqual(partial.status, "partial")
        self.assertEqual(installed.status, "installed")
        self.assertEqual(installed.path, str(main.resolve()))

    def test_explicit_folder_is_used_without_persisting_it(self) -> None:
        model = provider_by_id("local").models[1]
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertEqual(status.path, str(Path(temp_dir).resolve()))

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

            with mock.patch("maw.local_models._modelscope_cache_roots", return_value=[cache]):
                with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                    status = inspect_local_model(model)

        self.assertEqual(status.status, "installed")
        self.assertEqual(status.path, str(legacy.resolve()))

    def test_prepare_reports_phase_and_component_messages(self) -> None:
        model = provider_by_id("local").models[0]
        missing = LocalModelStatus(model.id, model.engine, model.model_ref, "missing", True, False)
        installed = LocalModelStatus(model.id, model.engine, model.model_ref, "installed", True, True)
        events: list[str] = []

        class FakeEngine:
            def _load(self, on_event):
                on_event("[local] fake loader returned")

        with mock.patch("maw.local_models.inspect_local_model", side_effect=[missing, installed]):
            with mock.patch("maw.local_asr.create_local_engine", return_value=FakeEngine()):
                result = prepare_local_model(model, on_event=events.append)

        self.assertEqual(result.status, "installed")
        self.assertTrue(any("正在准备" in event for event in events))
        self.assertTrue(any("模型组件" in event for event in events))
        self.assertTrue(any("fake loader returned" in event for event in events))


if __name__ == "__main__":
    unittest.main()
