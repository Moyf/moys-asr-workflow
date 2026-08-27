"""Tests for the shared managed-runtime abstraction (maw.runtimes).

安装过程不联网：embedded Python 解压 / pip 安装 / verify 全部 mock，只断言
构造出的命令参数（-r / 镜像 / extra index / CUDA 兜底）与状态机迁移。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import maw.runtimes as runtimes  # noqa: F401  (intentionally imported for registry coverage)
from maw.runtime_manifest import STATUS_INSTALLING, write_runtime_manifest
from maw.runtimes import LOCAL, MOSS, OCR, get_runtime
from maw.runtimes.base import ManagedRuntime, RuntimeSpec
from maw.runtimes.local_spec import LOCAL_SPEC, PYTORCH_INDEX
from maw.runtimes.ocr_spec import OCR_MODEL_ID, OCR_SPEC

PYTHON_RELATIVE = "python/python.exe" if os.name == "nt" else "python/bin/python"


def _fake_extract(_zip_path: Path, target_dir: Path) -> None:
    """假解压：在运行时目录里制造一个可执行的 python 占位。"""
    python = target_dir / ("python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_bytes(b"python")


class RuntimeRegistryTests(unittest.TestCase):
    def test_builtin_instances_expose_spec_key_and_get_runtime_resolves(self) -> None:
        self.assertEqual(LOCAL.spec.key, "local")
        self.assertEqual(OCR.spec.key, "ocr")
        self.assertEqual(MOSS.spec.key, "moss")
        self.assertIs(get_runtime("local"), LOCAL)
        self.assertIs(get_runtime("ocr"), OCR)
        self.assertIs(get_runtime("moss"), MOSS)

    def test_get_runtime_unknown_key_raises(self) -> None:
        with self.assertRaises(KeyError):
            get_runtime("nonsense")

    def test_specs_are_frozen_declarations(self) -> None:
        for spec in (LOCAL_SPEC, OCR_SPEC):
            self.assertIsInstance(spec, RuntimeSpec)
            self.assertIsInstance(spec.package_dirs, tuple)
            self.assertTrue(spec.verify_command)
            self.assertTrue(spec.requirements_key)
        self.assertIsInstance(LOCAL, ManagedRuntime)

    def test_moss_spec_is_placeholder_marked_for_uv_migration(self) -> None:
        self.assertTrue(MOSS.spec.install_uv)
        self.assertIsNotNone(MOSS.spec.requirements)
        self.assertIn("torch", MOSS.spec.requirements)
        with self.assertRaises(NotImplementedError):
            MOSS.install(runtime_root=Path(tempfile.mkdtemp()))


class RuntimeInstallCommandTests(unittest.TestCase):
    def test_local_install_uses_requirements_mirror_and_cu130_extra_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            requirements_txt = Path(temp_dir) / "requirements-local.txt"
            requirements_txt.write_text("funasr==1.4.2\nqwen-asr==0.0.6\njieba==0.42.1\n", encoding="utf-8")
            calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                calls.append(command)
                if "install" in command:
                    site = root / "site-packages"
                    for name in ("funasr", "qwen_asr", "jieba", "torch", "torchaudio", "reapeaks"):
                        (site / name).mkdir(parents=True, exist_ok=True)
                return 0

            with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]):
                with mock.patch("maw.runtimes.base._extract_embed_python", side_effect=_fake_extract):
                    with mock.patch.object(LOCAL, "requirements_path", return_value=requirements_txt):
                        with mock.patch("maw.runtimes.base._has_cuda", return_value=True):
                            with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                                with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                                    status = LOCAL.install(runtime_root=root)

            install_command = calls[1]
            verify_command = calls[2]
            self.assertTrue(status.ready)
            self.assertEqual(status.status, "ready")
            self.assertIn("-r", install_command)
            self.assertTrue(any("requirements-local.txt" in str(arg) for arg in install_command))
            self.assertIn("--index-url", install_command)
            self.assertIn("https://pypi.org/simple", install_command)
            self.assertIn("--extra-index-url", install_command)
            self.assertIn(PYTORCH_INDEX, install_command)
            # verify 命令是 python -c 自检
            self.assertTrue(any("import jieba" in str(arg) for arg in verify_command))

    def test_ocr_install_skips_cu130_extra_index(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "ocr-runtime"
            requirements_txt = Path(temp_dir) / "requirements-ocr.txt"
            requirements_txt.write_text("numpy==2.4.6\nonnxruntime==1.28.0\nrapidocr==3.9.2\nPillow==11.0.0\n", encoding="utf-8")
            calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                calls.append(command)
                if "install" in command:
                    site = root / "site-packages"
                    for name in ("numpy", "onnxruntime", "PIL", "rapidocr"):
                        (site / name).mkdir(parents=True, exist_ok=True)
                return 0

            with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]):
                with mock.patch("maw.runtimes.base._extract_embed_python", side_effect=_fake_extract):
                    with mock.patch.object(OCR, "requirements_path", return_value=requirements_txt):
                        with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                            with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                                status = OCR.install(runtime_root=root)

            install_command = calls[1]
            self.assertTrue(status.ready)
            manifest = json.loads((root / "runtime.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["modelId"], OCR_MODEL_ID)
            self.assertIn("-r", install_command)
            self.assertTrue(any("requirements-ocr.txt" in str(arg) for arg in install_command))
            self.assertIn("--index-url", install_command)
            self.assertNotIn("extra-index-url", install_command)

    def test_local_install_falls_back_to_cpu_torch_without_nvidia(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            requirements_txt = Path(temp_dir) / "requirements-local.txt"
            requirements_txt.write_text("funasr==1.4.2\n", encoding="utf-8")
            calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                calls.append(command)
                if "install" in command:
                    site = root / "site-packages"
                    for name in ("funasr", "qwen_asr", "jieba", "torch", "torchaudio", "reapeaks"):
                        (site / name).mkdir(parents=True, exist_ok=True)
                return 0

            with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]):
                with mock.patch("maw.runtimes.base._extract_embed_python", side_effect=_fake_extract):
                    with mock.patch.object(LOCAL, "requirements_path", return_value=requirements_txt):
                        with mock.patch("maw.runtimes.base._has_cuda", return_value=False):
                            with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                                with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                                    status = LOCAL.install(runtime_root=root)

            # 0=get-pip 1=依赖 2=CUDA 兜底 3=verify
            fallback_command = calls[2]
            self.assertTrue(status.ready)
            self.assertTrue(any("torch==2.13.0" in str(arg) for arg in fallback_command))
            self.assertNotIn("extra-index-url", fallback_command)
            self.assertTrue(any("import jieba" in str(arg) for arg in calls[3]))


class RuntimeStatusTransitionTests(unittest.TestCase):
    def test_installing_manifest_is_reported_installing_not_broken(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            python = root / PYTHON_RELATIVE
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_bytes(b"python")

            write_runtime_manifest(
                root,
                status=STATUS_INSTALLING,
                runtime_version=LOCAL_SPEC.runtime_version,
                python_version=LOCAL_SPEC.python_version,
            )

            status = LOCAL.status(runtime_root=root)
            self.assertEqual(status.status, "installing")
            self.assertFalse(status.ready)

    def test_missing_status_uses_empty_python_path_and_cache_separate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            cache = Path(temp_dir) / "models"
            status = LOCAL.status(runtime_root=root, model_cache_root=cache)

            self.assertEqual(status.status, "missing")
            self.assertFalse(status.ready)
            self.assertEqual(status.python_path, "")
            self.assertEqual(Path(status.model_cache_path), cache.resolve())
            self.assertNotEqual(Path(status.path), Path(status.model_cache_path))


if __name__ == "__main__":
    unittest.main()