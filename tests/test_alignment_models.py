import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.alignment_models import (
    FIRERED_ASR2_CTC_DIRECTORY,
    FIRERED_ASR2_CTC_MODEL_FILE,
    FIRERED_ASR2_CTC_TOKENS_FILE,
    QWEN_FORCED_ALIGNER_MODEL_ID,
    find_alignment_model_path,
    inspect_alignment_model,
    normalize_alignment_model_id,
)


class AlignmentModelRegistryTests(unittest.TestCase):
    def test_aliases_are_normalized_to_stable_ids(self) -> None:
        self.assertEqual(normalize_alignment_model_id("Qwen/Qwen3-ForcedAligner-0.6B"), QWEN_FORCED_ALIGNER_MODEL_ID)
        self.assertEqual(normalize_alignment_model_id("fire-red"), "firered-asr2-ctc")
        self.assertEqual(normalize_alignment_model_id("off"), "")

    def test_qwen_forced_aligner_reuses_qwen_local_huggingface_cache(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            snapshot = (
                root
                / "huggingface"
                / "hub"
                / "models--Qwen--Qwen3-ForcedAligner-0.6B"
                / "snapshots"
                / "revision"
            )
            snapshot.mkdir(parents=True)
            (snapshot / "model.safetensors").write_bytes(b"weights")
            (snapshot / "config.json").write_text("{}", encoding="utf-8")

            found = find_alignment_model_path(QWEN_FORCED_ALIGNER_MODEL_ID, model_cache_root=root)

            self.assertEqual(found, snapshot.resolve())
            self.assertEqual(
                inspect_alignment_model(
                    QWEN_FORCED_ALIGNER_MODEL_ID,
                    model_cache_root=root,
                    runtime_available=True,
                ).status,
                "installed",
            )

    def test_qwen_forced_aligner_reuses_modelscope_fallback_cache(self) -> None:
        """HF 回退下载写入 <缓存根>/modelscope 的对齐模型同样有效，
        否则下载完成后会误报「未通过完整性检查」。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            snapshot = (
                root
                / "modelscope"
                / "models"
                / "Qwen--Qwen3-ForcedAligner-0.6B"
                / "snapshots"
                / "master"
            )
            snapshot.mkdir(parents=True)
            (snapshot / "model.safetensors").write_bytes(b"weights")
            (snapshot / "config.json").write_text("{}", encoding="utf-8")
            (snapshot / "preprocessor_config.json").write_text("{}", encoding="utf-8")
            (snapshot / "tokenizer_config.json").write_text("{}", encoding="utf-8")

            # 隔离开发机真实的 HF home 缓存，确保命中的是 ModelScope 快照。
            with mock.patch(
                "maw.alignment_models._huggingface_cache_roots",
                return_value=[],
            ):
                found = find_alignment_model_path(QWEN_FORCED_ALIGNER_MODEL_ID, model_cache_root=root)
                status = inspect_alignment_model(
                    QWEN_FORCED_ALIGNER_MODEL_ID,
                    model_cache_root=root,
                    runtime_available=True,
                ).status

            self.assertEqual(found, snapshot.resolve())
            self.assertEqual(status, "installed")

    def test_firered_requires_both_onnx_model_and_tokens(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            model_dir = root / "aligners" / FIRERED_ASR2_CTC_DIRECTORY
            model_dir.mkdir(parents=True)
            (model_dir / FIRERED_ASR2_CTC_MODEL_FILE).write_bytes(b"onnx")

            incomplete = inspect_alignment_model("firered-asr2-ctc", model_cache_root=root, runtime_available=True)
            self.assertEqual(incomplete.status, "missing")
            self.assertFalse(incomplete.installed)

            (model_dir / FIRERED_ASR2_CTC_TOKENS_FILE).write_bytes(b"a 1\n")
            complete = inspect_alignment_model("firered-asr2-ctc", model_cache_root=root, runtime_available=True)
            self.assertEqual(complete.status, "installed")
            self.assertEqual(Path(complete.path), model_dir.resolve())
            self.assertEqual(complete.installed_size, "8 B")
            self.assertEqual(complete.to_payload()["installedSize"], "8 B")

if __name__ == "__main__":
    unittest.main()
