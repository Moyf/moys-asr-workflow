from __future__ import annotations

import json
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
from maw.local_models import LocalModelStatus, _prepare_progress_payload, inspect_local_model, local_model_payload, prepare_local_model  # noqa: E402


def local_model(model_id: str):
    return next(model for model in provider_by_id("local").models if model.id == model_id)


class LocalModelDiscoveryTests(unittest.TestCase):
    def test_firered_asr_ctc_is_ready_without_optional_punc(self) -> None:
        model = local_model("firered-asr2-ctc-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            ctc = root / "aligners" / "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25"
            ctc.mkdir(parents=True)
            (ctc / "model.int8.onnx").write_bytes(b"onnx")
            (ctc / "tokens.txt").write_text("a 1\n", encoding="utf-8")

            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                with mock.patch("maw.local_models._modelscope_cache_roots", return_value=[root / "modelscope"]):
                    partial = inspect_local_model(model, model_cache_root=root)
                    punc = (
                        root
                        / "modelscope"
                        / "models"
                        / "iic--punc_ct-transformer_cn-en-common-vocab471067-large"
                        / "snapshots"
                        / "main"
                    )
                    punc.mkdir(parents=True)
                    (punc / "model.pt").write_bytes(b"weights")
                    ready = inspect_local_model(model, model_cache_root=root)

        self.assertEqual(partial.status, "installed")
        self.assertIn("可选 FunASR ct-punc", partial.detail)
        self.assertTrue(partial.installed)
        self.assertEqual(ready.status, "installed")
        self.assertTrue(ready.installed)

    def test_missing_runtime_is_reported_without_scanning_model_imports(self) -> None:
        model = local_model("qwen3-asr-local")
        not_ready = mock.Mock(ready=False, python_path="", model_cache_path="")

        with mock.patch("maw.local_models.importlib.util.find_spec", return_value=None):
            with mock.patch("maw.local_models.managed_runtime_status", return_value=not_ready):
                status = inspect_local_model(model)

        self.assertEqual(status.status, "runtime_missing")
        self.assertFalse(status.runtime_available)

    def test_qwen_huggingface_cache_requires_forced_aligner_too(self) -> None:
        model = local_model("qwen3-asr-local")
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
        self.assertEqual(Path(installed.path).resolve(), main.resolve())

    def test_qwen_modelscope_cache_is_detected_with_huggingface_aligner(self) -> None:
        model = local_model("qwen3-asr-1.7b-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            modelscope = root / "modelscope"
            main = modelscope / "models" / "Qwen" / "Qwen3-ASR-1.7B"
            main.mkdir(parents=True)
            (main / "model.safetensors").write_bytes(b"weights")
            huggingface = root / "huggingface"
            aligner = huggingface / "models--Qwen--Qwen3-ForcedAligner-0.6B" / "snapshots" / "main"
            aligner.mkdir(parents=True)
            (aligner / "model.safetensors").write_bytes(b"aligner")

            with (
                mock.patch("maw.local_models._modelscope_cache_roots", return_value=[modelscope]),
                mock.patch("maw.local_models._huggingface_cache_roots", return_value=[huggingface]),
                mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()),
            ):
                status = inspect_local_model(model)

        self.assertEqual(status.status, "installed")
        self.assertTrue(status.installed)
        self.assertEqual(Path(status.path).resolve(), main.resolve())

    def test_whisper_huggingface_cache_is_detected(self) -> None:
        model = local_model("whisper-large-v3-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir)
            main = cache / "models--Systran--faster-whisper-large-v3" / "snapshots" / "main"
            main.mkdir(parents=True)

            with mock.patch.dict(os.environ, {"HF_HUB_CACHE": str(cache)}):
                with mock.patch("maw.local_models._huggingface_cache_roots", return_value=[cache]):
                    with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                        missing = inspect_local_model(model)
                        (main / "model.bin").write_bytes(b"weights")
                        installed = inspect_local_model(model)

        self.assertEqual(missing.status, "missing")
        self.assertEqual(installed.status, "installed")
        self.assertEqual(Path(installed.path).resolve(), main.resolve())

    def test_installed_model_size_is_reported_from_detected_directory(self) -> None:
        model = local_model("whisper-large-v3-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir)
            main = cache / "models--Systran--faster-whisper-large-v3" / "snapshots" / "main"
            main.mkdir(parents=True)
            (main / "model.bin").write_bytes(b"weights")
            (main / "config.json").write_bytes(b"{}")

            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, model_cache_root=cache)
                payload = local_model_payload(model, model_cache_root=cache)

        self.assertEqual(status.status, "installed")
        self.assertEqual(status.installed_size, "9 B")
        self.assertEqual(payload["installedSize"], "9 B")

    def test_whisper_flat_managed_cache_layout_is_detected(self) -> None:
        """download_root 曾被指向缓存根本体，models--* 仓库直接落在其下；
        缓存发现必须兼容这种扁平布局，避免已下载的权重被判「未检测到」。"""
        model = local_model("whisper-large-v3-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            managed_root = Path(temp_dir)
            main = managed_root / "models--Systran--faster-whisper-large-v3" / "snapshots" / "main"
            main.mkdir(parents=True)

            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                missing = inspect_local_model(model, model_cache_root=managed_root)
                (main / "model.bin").write_bytes(b"weights")
                installed = inspect_local_model(model, model_cache_root=managed_root)

        self.assertEqual(missing.status, "missing")
        self.assertEqual(installed.status, "installed")
        self.assertEqual(Path(installed.path).resolve(), main.resolve())

    def test_moss_modelscope_mirror_cache_is_detected(self) -> None:
        """MOSS 回退下载写入组织名不同的 ModelScope 镜像仓库（OpenMOSS），
        缓存发现必须按映射 ID 兼容，否则已安装会被判「未检测到」。"""
        model = local_model("moss-transcribe-diarize-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            modelscope = Path(temp_dir) / "modelscope"
            main = (
                modelscope
                / "models"
                / "OpenMOSS--MOSS-Transcribe-Diarize"
                / "snapshots"
                / "master"
            )
            main.mkdir(parents=True)

            with mock.patch.dict(os.environ, {"MODELSCOPE_CACHE": str(modelscope)}):
                with mock.patch("maw.local_models._huggingface_cache_roots", return_value=[]):
                    with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                        missing = inspect_local_model(model)
                        (main / "model.safetensors").write_bytes(b"weights")
                        installed = inspect_local_model(model)

        self.assertEqual(missing.status, "missing")
        self.assertEqual(installed.status, "installed")
        self.assertEqual(Path(installed.path).resolve(), main.resolve())

    def test_whisper_modelscope_cache_is_detected(self) -> None:
        model = local_model("whisper-large-v3-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            modelscope = Path(temp_dir) / "modelscope"
            main = (
                modelscope
                / "models"
                / "Systran--faster-whisper-large-v3"
                / "snapshots"
                / "master"
            )
            main.mkdir(parents=True)

            with mock.patch.dict(os.environ, {"MODELSCOPE_CACHE": str(modelscope)}):
                with mock.patch("maw.local_models._huggingface_cache_roots", return_value=[]):
                    with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                        missing = inspect_local_model(model)
                        (main / "model.bin").write_bytes(b"weights")
                        installed = inspect_local_model(model)

        self.assertEqual(missing.status, "missing")
        self.assertEqual(installed.status, "installed")
        self.assertEqual(Path(installed.path).resolve(), main.resolve())

    def test_prepare_watch_paths_cover_modelscope_fallback_caches(self) -> None:
        """准备进度监视必须覆盖 ModelScope 回退缓存，否则长时间 MS 下载
        会一直显示「尚未报告新的缓存写入」。"""
        from maw.local_models import _model_watch_paths

        model = local_model("moss-transcribe-diarize-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            modelscope = Path(temp_dir) / "modelscope"

            with mock.patch.dict(os.environ, {"MODELSCOPE_CACHE": str(modelscope)}):
                paths = _model_watch_paths(model, "", Path(temp_dir))

        joined = {str(path) for path in paths}
        self.assertTrue(any("OpenMOSS--MOSS-Transcribe-Diarize" in value for value in joined))
        self.assertTrue(any("models--OpenMOSS-Team--MOSS-Transcribe-Diarize" in value for value in joined))

    def test_explicit_folder_is_used(self) -> None:
        model = local_model("funasr-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "config.yaml").write_text("model: paraformer\n", encoding="utf-8")
            (Path(temp_dir) / "model.pt").write_bytes(b"weights")
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertEqual(Path(status.path).resolve(), Path(temp_dir).resolve())

    def test_explicit_empty_folder_is_rejected(self) -> None:
        model = local_model("funasr-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertFalse(status.installed)
        self.assertIn("为空", status.detail)

    def test_explicit_folder_without_weight_file_is_rejected(self) -> None:
        model = local_model("funasr-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "README.md").write_text("not a model", encoding="utf-8")
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertFalse(status.installed)

    def test_fun_asr_does_not_accept_a_qwen_model_cache_folder(self) -> None:
        model = local_model("funasr-local")
        with tempfile.TemporaryDirectory(prefix="models--Qwen--Qwen3-ASR-0.6B-") as temp_dir:
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "path_mismatch")
        self.assertFalse(status.installed)
        self.assertIn("Qwen3-ASR", status.detail)

    def test_whisper_does_not_accept_a_qwen_or_moss_model_cache_folder(self) -> None:
        whisper_model = local_model("whisper-large-v3-local")
        qwen_path = tempfile.TemporaryDirectory(prefix="models--Qwen--Qwen3-ForcedAligner-0.6B-")
        moss_path = tempfile.TemporaryDirectory(prefix="models--OpenMOSS--MOSS-Transcribe-Diarize-")
        try:
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                with_qwen = inspect_local_model(whisper_model, qwen_path.name)
                (Path(qwen_path.name) / "model.safetensors").write_bytes(b"w")
                with_moss = inspect_local_model(whisper_model, moss_path.name)

        finally:
            qwen_path.cleanup()
            moss_path.cleanup()

        # 前者被拒为家族误配；后者目录含权重但同样按误配拒绝
        self.assertEqual(with_qwen.status, "path_mismatch")
        self.assertIn("Qwen3-ASR 或 MOSS", with_qwen.detail)
        self.assertEqual(with_moss.status, "path_mismatch")
        self.assertIn("Qwen3-ASR 或 MOSS", with_moss.detail)

class ExplicitDirectoryStructureTests(unittest.TestCase):
    """显式目录要按引擎校验结构标志：runtime / 缓存根目录不能判「已安装」。

    v1.9.0 反馈：模型未下载时把整个 local-runtime 根目录选进「已有模型
    目录」，嵌套的杂散权重让它被误判为已安装（体积报整棵树），真跑时才
    在加载阶段报错。校验失败返回 path_invalid（can_prepare 保持 False），
    detail 写明「可能选了运行时/缓存根目录」。
    """

    def build_runtime_root(self, root: Path) -> None:
        """模拟 local-runtime/：嵌套的真实模型缓存 + 根层杂散权重文件。"""
        hf = root / "huggingface" / "hub" / "models--Qwen--Qwen3-ASR-0.6B" / "snapshots" / "main"
        hf.mkdir(parents=True)
        (hf / "config.json").write_text(json.dumps({"model_type": "qwen3_asr"}), encoding="utf-8")
        (hf / "model.safetensors").write_bytes(b"weights")
        funasr = root / "modelscope" / "models" / "iic" / "SenseVoiceSmall"
        funasr.mkdir(parents=True)
        (funasr / "config.yaml").write_text("model: SenseVoiceSmall\n", encoding="utf-8")
        (funasr / "model.pt").write_bytes(b"pt")
        logs = root / "logs"
        logs.mkdir()
        (logs / "stray.bin").write_bytes(b"stray weight")

    def inspect(self, model_id: str, path: str | Path):
        model = local_model(model_id)
        with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
            return inspect_local_model(model, path)

    def test_runtime_root_is_rejected_for_hf_engine(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            self.build_runtime_root(Path(temp_dir))
            status = self.inspect("qwen3-asr-local", temp_dir)
            payload = local_model_payload(local_model("qwen3-asr-local"), temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertFalse(status.installed)
        self.assertIn("运行时/缓存根目录", status.detail)
        self.assertFalse(payload["installed"])
        self.assertFalse(payload["canPrepare"])

    def test_runtime_root_is_rejected_for_funasr_engine(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            self.build_runtime_root(Path(temp_dir))
            status = self.inspect("sensevoice-small-local", temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertFalse(status.installed)
        self.assertIn("运行时/缓存根目录", status.detail)

    def test_runtime_root_without_weights_is_rejected_as_empty(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            Path(temp_dir, "logs").mkdir()
            status = self.inspect("qwen3-asr-local", temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertIn("为空", status.detail)

    def test_explicit_hf_directory_with_matching_config_is_installed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "config.json").write_text(
                json.dumps({"model_type": "qwen3_asr", "architectures": ["Qwen3ASRForConditionalGeneration"]}),
                encoding="utf-8",
            )
            (Path(temp_dir) / "model.safetensors").write_bytes(b"weights")
            status = self.inspect("qwen3-asr-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertTrue(status.installed)
        self.assertEqual(status.detail, "已使用指定的模型目录。")

    def test_explicit_hf_snapshot_parent_resolves_path_to_revision(self) -> None:
        """选中 models--* 仓库根（snapshots 的上一级）合法，但 status.path
        必须解析到实际存放模型的修订目录：loader 原样使用显式目录，
        指到仓库根会「已安装」却在加载时失败。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshot = Path(temp_dir) / "snapshots" / "main"
            snapshot.mkdir(parents=True)
            (snapshot / "config.json").write_text(json.dumps({"model_type": "whisper"}), encoding="utf-8")
            (snapshot / "model.bin").write_bytes(b"weights")
            status = self.inspect("whisper-large-v3-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertTrue(status.installed)
        self.assertEqual(Path(status.path).resolve(), snapshot.resolve())

    def test_explicit_funasr_snapshot_parent_resolves_path_to_revision(self) -> None:
        """ModelScope hub 式仓库根（snapshots/master 的上一级）同理解析到修订层。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshot = Path(temp_dir) / "snapshots" / "master"
            snapshot.mkdir(parents=True)
            (snapshot / "config.yaml").write_text("model: SenseVoiceSmall\n", encoding="utf-8")
            (snapshot / "model.pt").write_bytes(b"weights")
            status = self.inspect("sensevoice-small-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertTrue(status.installed)
        self.assertEqual(Path(status.path).resolve(), snapshot.resolve())

    def test_explicit_hf_snapshot_parent_prefers_newest_revision(self) -> None:
        """仓库根里有多个修订时按修改时间取最新，与缓存发现行为一致。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshots = Path(temp_dir) / "snapshots"
            older = snapshots / "aaaaaaaa"
            newer = snapshots / "bbbbbbbb"
            for revision in (older, newer):
                revision.mkdir(parents=True)
                (revision / "config.json").write_text(json.dumps({"model_type": "whisper"}), encoding="utf-8")
                (revision / "model.bin").write_bytes(b"weights")
            os.utime(older, (1000, 1000))
            os.utime(newer, (2000, 2000))
            status = self.inspect("whisper-large-v3-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertEqual(Path(status.path).resolve(), newer.resolve())

    def test_explicit_mixed_snapshots_skip_weightless_revision(self) -> None:
        """最新的修订只有 config.json（中断下载残留）时跳过它，解析到
        次新的完整修订：旁边有可用模型就不能给死路径。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshots = Path(temp_dir) / "snapshots"
            complete = snapshots / "aaaaaaaa"
            incomplete = snapshots / "bbbbbbbb"
            complete.mkdir(parents=True)
            (complete / "config.json").write_text(json.dumps({"model_type": "whisper"}), encoding="utf-8")
            (complete / "model.bin").write_bytes(b"weights")
            incomplete.mkdir(parents=True)
            (incomplete / "config.json").write_text(json.dumps({"model_type": "whisper"}), encoding="utf-8")
            os.utime(complete, (1000, 1000))
            os.utime(incomplete, (2000, 2000))
            status = self.inspect("whisper-large-v3-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertTrue(status.installed)
        self.assertEqual(Path(status.path).resolve(), complete.resolve())

    def test_explicit_snapshot_validation_skips_broken_weightless_revision(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            complete = Path(temp_dir) / "snapshots" / "older"
            incomplete = Path(temp_dir) / "snapshots" / "newer"
            complete.mkdir(parents=True)
            incomplete.mkdir(parents=True)
            (complete / "config.json").write_text(json.dumps({"model_type": "whisper"}), encoding="utf-8")
            (complete / "model.bin").write_bytes(b"weights")
            (incomplete / "config.json").write_text("{incomplete", encoding="utf-8")
            os.utime(complete, (1000, 1000))
            os.utime(incomplete, (2000, 2000))
            status = self.inspect("whisper-large-v3-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertEqual(Path(status.path).resolve(), complete.resolve())

    def test_explicit_snapshot_validates_the_revision_with_weights(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            complete = Path(temp_dir) / "snapshots" / "older"
            incomplete = Path(temp_dir) / "snapshots" / "newer"
            complete.mkdir(parents=True)
            incomplete.mkdir(parents=True)
            (complete / "config.json").write_text(json.dumps({"model_type": "qwen3_asr"}), encoding="utf-8")
            (complete / "model.bin").write_bytes(b"weights")
            (incomplete / "config.json").write_text(json.dumps({"model_type": "whisper"}), encoding="utf-8")
            os.utime(complete, (1000, 1000))
            os.utime(incomplete, (2000, 2000))
            status = self.inspect("whisper-large-v3-local", temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertFalse(status.installed)
        self.assertIn("不匹配", status.detail)

    def test_explicit_funasr_snapshot_validates_the_revision_with_weights(self) -> None:
        yaml_module = mock.Mock()
        yaml_module.safe_load.return_value = {"framework": "Pytorch"}
        with tempfile.TemporaryDirectory() as temp_dir:
            complete = Path(temp_dir) / "snapshots" / "older"
            incomplete = Path(temp_dir) / "snapshots" / "newer"
            complete.mkdir(parents=True)
            incomplete.mkdir(parents=True)
            (complete / "configuration.json").write_text("{}", encoding="utf-8")
            (complete / "model.pt").write_bytes(b"weights")
            (incomplete / "config.yaml").write_text("framework: Pytorch\n", encoding="utf-8")
            os.utime(complete, (1000, 1000))
            os.utime(incomplete, (2000, 2000))
            with mock.patch.dict("sys.modules", {"yaml": yaml_module}):
                status = self.inspect("sensevoice-small-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertEqual(Path(status.path).resolve(), complete.resolve())

    def test_explicit_weightless_snapshots_are_rejected(self) -> None:
        """所有候选修订都缺权重时不返回假 installed：仓库根的杂散权重
        让权重探测通过，但没有任何「配置 + 权重」同层的目录可交给
        loader，必须报 path_invalid 而不是指向加载必败的目录。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            snapshot = Path(temp_dir) / "snapshots" / "main"
            snapshot.mkdir(parents=True)
            (snapshot / "config.json").write_text(json.dumps({"model_type": "whisper"}), encoding="utf-8")
            (Path(temp_dir) / "model.bin").write_bytes(b"stray weight")
            status = self.inspect("whisper-large-v3-local", temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertFalse(status.installed)
        self.assertIn("同时包含模型配置与权重文件", status.detail)

    def test_explicit_hf_directory_with_mismatched_model_type_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "config.json").write_text(json.dumps({"model_type": "qwen3_asr"}), encoding="utf-8")
            (Path(temp_dir) / "model.safetensors").write_bytes(b"weights")
            status = self.inspect("whisper-large-v3-local", temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertFalse(status.installed)
        self.assertIn("运行时/缓存根目录", status.detail)
        self.assertIn("不匹配", status.detail)

    def test_explicit_hf_directory_without_judgeable_fields_is_accepted(self) -> None:
        """config.json 缺少 model_type / architectures 时保守放行。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "config.json").write_text(json.dumps({"custom": "layout"}), encoding="utf-8")
            (Path(temp_dir) / "model.safetensors").write_bytes(b"weights")
            status = self.inspect("qwen3-asr-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertTrue(status.installed)

    def test_explicit_hf_directory_with_broken_config_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "config.json").write_text("{not json", encoding="utf-8")
            (Path(temp_dir) / "model.safetensors").write_bytes(b"weights")
            status = self.inspect("qwen3-asr-local", temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertIn("config.json", status.detail)

    def test_explicit_funasr_directory_with_config_yaml_is_installed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "config.yaml").write_text("model: paraformer\n", encoding="utf-8")
            (Path(temp_dir) / "model.pt").write_bytes(b"weights")
            status = self.inspect("funasr-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertTrue(status.installed)

    def test_explicit_funasr_directory_with_configuration_json_is_installed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "configuration.json").write_text("{}", encoding="utf-8")
            (Path(temp_dir) / "model.pt").write_bytes(b"weights")
            status = self.inspect("sensevoice-small-local", temp_dir)

        self.assertEqual(status.status, "installed")
        self.assertTrue(status.installed)

    def test_explicit_funasr_weight_only_directory_is_rejected(self) -> None:
        """只有权重的目录不能被 FunASR 加载，也不该判「已安装」。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "model.pt").write_bytes(b"weights")
            status = self.inspect("sensevoice-small-local", temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertIn("运行时/缓存根目录", status.detail)

    def test_explicit_funasr_config_yaml_model_field_is_checked_when_yaml_is_readable(self) -> None:
        """读得到 config.yaml 时校验 model 字段；读不到（无 yaml 库/解析失败）仅查存在性。"""
        yaml_module = mock.Mock()
        yaml_module.safe_load = mock.Mock(side_effect=[{"framework": "Pytorch"}, {"model": "SenseVoiceSmall"}])
        with tempfile.TemporaryDirectory() as temp_dir:
            (Path(temp_dir) / "config.yaml").write_text("framework: Pytorch\n", encoding="utf-8")
            (Path(temp_dir) / "model.pt").write_bytes(b"weights")
            with mock.patch.dict("sys.modules", {"yaml": yaml_module}):
                rejected = self.inspect("sensevoice-small-local", temp_dir)
                (Path(temp_dir) / "config.yaml").write_text("model: SenseVoiceSmall\n", encoding="utf-8")
                accepted = self.inspect("sensevoice-small-local", temp_dir)

        self.assertEqual(rejected.status, "path_invalid")
        self.assertIn("config.yaml", rejected.detail)
        self.assertEqual(accepted.status, "installed")

    def test_firered_explicit_directory_keeps_its_own_checklist(self) -> None:
        """firered 维持原有文件清单校验，不叠加 HF / FunASR 标志文件要求。"""
        model = local_model("firered-asr2-ctc-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                status = inspect_local_model(model, temp_dir)

        self.assertEqual(status.status, "path_invalid")
        self.assertIn("FireRedASR2-CTC", status.detail)


    def test_funasr_hub_style_modelscope_cache_is_detected(self) -> None:
        model = local_model("funasr-local")
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
        self.assertEqual(Path(status.path).resolve(), snapshot.resolve())

    def test_funasr_legacy_modelscope_cache_is_detected_via_cache_refs(self) -> None:
        model = local_model("funasr-local")
        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir)
            legacy = cache / "models" / "iic" / "speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch"
            legacy.mkdir(parents=True)
            (legacy / "model.pt").write_bytes(b"pt")

            with mock.patch("maw.local_models._modelscope_cache_roots", return_value=[cache]):
                with mock.patch("maw.local_models.importlib.util.find_spec", return_value=mock.Mock()):
                    status = inspect_local_model(model)

        self.assertEqual(status.status, "installed")
        self.assertEqual(Path(status.path).resolve(), legacy.resolve())

    def test_empty_modelscope_fallback_directory_is_not_detected(self) -> None:
        model = local_model("funasr-local")
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
        model = local_model("qwen3-asr-local")
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

    def test_prepare_forwards_model_specific_loader_options(self) -> None:
        model = local_model("sensevoice-small-local")
        missing = LocalModelStatus(model.id, model.engine, model.model_ref, "missing", True, False)
        installed = LocalModelStatus(model.id, model.engine, model.model_ref, "installed", True, True)

        with mock.patch("maw.local_models.inspect_local_model", side_effect=[missing, installed]):
            with mock.patch("maw.local_models.prepare_model_in_process", return_value=0) as prepare:
                prepare_local_model(model)

        self.assertEqual(prepare.call_args.kwargs["vad_model"], "fsmn-vad")
        self.assertFalse(prepare.call_args.kwargs["trust_remote_code"])

        model = local_model("fun-asr-nano-local")
        missing = LocalModelStatus(model.id, model.engine, model.model_ref, "missing", True, False)
        installed = LocalModelStatus(model.id, model.engine, model.model_ref, "installed", True, True)
        with mock.patch("maw.local_models.inspect_local_model", side_effect=[missing, installed]):
            with mock.patch("maw.local_models.prepare_model_in_process", return_value=0) as prepare:
                prepare_local_model(model)

        self.assertEqual(prepare.call_args.kwargs["vad_model"], "fsmn-vad")
        self.assertTrue(prepare.call_args.kwargs["trust_remote_code"])

        model = local_model("moss-transcribe-diarize-local")
        missing = LocalModelStatus(model.id, model.engine, model.model_ref, "missing", True, False)
        installed = LocalModelStatus(model.id, model.engine, model.model_ref, "installed", True, True)
        with mock.patch("maw.local_models.inspect_local_model", side_effect=[missing, installed]):
            with mock.patch("maw.local_models.prepare_model_in_process", return_value=0) as prepare:
                prepare_local_model(model)

        self.assertTrue(prepare.call_args.kwargs["trust_remote_code"])

        model = local_model("whisper-large-v3-local")
        missing = LocalModelStatus(model.id, model.engine, model.model_ref, "missing", True, False)
        installed = LocalModelStatus(model.id, model.engine, model.model_ref, "installed", True, True)
        with mock.patch("maw.local_models.inspect_local_model", side_effect=[missing, installed]):
            with mock.patch("maw.local_models.prepare_model_in_process", return_value=0) as prepare:
                prepare_local_model(model)

        # Whisper 无 VAD/对齐器组件，也不需要 trust_remote_code
        self.assertEqual(prepare.call_args.kwargs["vad_model"], "")
        self.assertFalse(prepare.call_args.kwargs["trust_remote_code"])

    def test_prepare_progress_includes_a_broad_cache_estimate(self) -> None:
        model = local_model("qwen3-asr-local")

        payload = _prepare_progress_payload(model, "05:01", 22, int(2.92 * 1024**3))

        self.assertEqual(payload["fileCount"], 22)
        self.assertEqual(payload["currentBytes"], int(2.92 * 1024**3))
        self.assertEqual(payload["estimatedMinBytes"], int(2.5 * 1024**3))
        self.assertEqual(payload["estimatedMaxBytes"], int(4.5 * 1024**3))
        self.assertGreater(payload["percentMax"], payload["percentMin"])
        self.assertIn("预计总量约", payload["message"])

    def test_prepare_progress_includes_a_whisper_cache_estimate(self) -> None:
        model = local_model("whisper-large-v3-local")

        payload = _prepare_progress_payload(model, "05:01", 6, int(3.0 * 1024**3))

        self.assertEqual(payload["estimatedMinBytes"], int(2.5 * 1024**3))
        self.assertEqual(payload["estimatedMaxBytes"], int(4.0 * 1024**3))
        self.assertIn("预计总量约", payload["message"])

    def test_managed_prepare_forwards_cancel_event_to_runtime_process(self) -> None:
        model = local_model("qwen3-asr-local")
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
