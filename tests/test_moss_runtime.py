"""Tests for the MOSS runtime thin shim (maw.moss_runtime).

安装不联网：embedded Python 解压 / pip 安装 / verify 全部 mock，断言委托链
``install_local_runtime(engine="moss")`` → ``maw.runtimes.MOSS.install``
的嵌入安装流程（frozen txt + cu130 extra index + verify 自检）与状态机。
"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.local_runtime import LocalRuntimeError, install_local_runtime, managed_runtime_status
from maw.moss_runtime import (
    MOSS_PACKAGE_DIRS,
    MOSS_PYTHON_VERSION,
    MOSS_REQUIREMENTS,
    MOSS_RUNTIME_ROOT_NAME,
    MOSS_RUNTIME_VERSION,
    MOSS_VERIFY_IMPORT,
    default_runtime_root,
    runtime_python_path,
)
from maw.runtimes import MOSS
from maw.runtimes.moss_spec import PYTORCH_INDEX

_PYTHON_RELATIVE = Path("python") / "python.exe" if os.name == "nt" else Path("python") / "bin" / "python"


def _fake_extract(_zip_path: Path, target_dir: Path) -> None:
    python = target_dir / ("python.exe" if os.name == "nt" else "bin/python")
    python.parent.mkdir(parents=True, exist_ok=True)
    python.write_bytes(b"python")


class MossRuntimeConstantTests(unittest.TestCase):
    def test_constant_values(self) -> None:
        self.assertEqual(MOSS_RUNTIME_VERSION, "1")
        self.assertEqual(MOSS_PYTHON_VERSION, "3.11")
        self.assertEqual(MOSS_RUNTIME_ROOT_NAME, "local-runtime-moss")

    def test_requirements_pin_transformers_5x_and_moss_package(self) -> None:
        self.assertIn("transformers>=5.6.0,<6.0.0", MOSS_REQUIREMENTS)
        self.assertIn("av>=14.0", MOSS_REQUIREMENTS)
        self.assertIn("librosa>=0.11.0", MOSS_REQUIREMENTS)
        self.assertTrue(
            any(value.startswith("moss-transcribe-diarize @ https://github.com/OpenMOSS/MOSS-Transcribe-Diarize/archive/") for value in MOSS_REQUIREMENTS)
        )

    def test_package_dirs_cover_runtime_imports(self) -> None:
        self.assertEqual(MOSS_PACKAGE_DIRS, ("moss_transcribe_diarize", "transformers", "torch", "torchaudio"))
        self.assertIn("moss_transcribe_diarize", MOSS_VERIFY_IMPORT)
        self.assertIn("MAW_LOCAL_RUNTIME_READY", MOSS_VERIFY_IMPORT)


class MossRuntimePathTests(unittest.TestCase):
    def test_default_root_uses_dedicated_moss_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.dict(os.environ, {"MAW_APP_DATA_ROOT": str(Path(temp_dir) / "app")}):
                root = default_runtime_root()
        self.assertEqual(root.name, "local-runtime-moss")
        self.assertEqual(root.parent, (Path(temp_dir) / "app").resolve())

    def test_override_root_uses_own_env_variable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir) / "moss-runtime"
            with mock.patch.dict(os.environ, {"MAW_MOSS_RUNTIME_ROOT": str(base)}):
                root = default_runtime_root()
        self.assertEqual(root, base.resolve())

    def test_python_path_sits_inside_moss_root_embedded_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir) / "runtime"
            with mock.patch.dict(os.environ, {"MAW_MOSS_RUNTIME_ROOT": str(base)}):
                python = runtime_python_path()
        self.assertEqual(python, base.resolve() / _PYTHON_RELATIVE)


class MossRuntimeStatusTests(unittest.TestCase):
    def test_missing_moss_status_reports_missing_and_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            cache = Path(temp_dir) / "models"
            with mock.patch.dict(os.environ, {"MAW_MOSS_RUNTIME_ROOT": str(root), "MAW_MODEL_CACHE_ROOT": str(cache)}):
                status = managed_runtime_status(engine="moss")

        self.assertEqual(status.status, "missing")
        self.assertFalse(status.ready)
        self.assertEqual(status.runtime_version, MOSS_RUNTIME_VERSION)
        self.assertEqual(Path(status.path), root.resolve())
        self.assertEqual(Path(status.model_cache_path), cache.resolve())

    def test_ready_moss_status_requires_manifest_and_packages(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            python = runtime_python_path(root)
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_bytes(b"python")
            site_packages = root / "site-packages"
            for name in MOSS_PACKAGE_DIRS:
                (site_packages / name).mkdir(parents=True, exist_ok=True)
            (root / "runtime.json").write_text(
                '{"status": "ready", "runtimeVersion": "1"}\n',
                encoding="utf-8",
                newline="\n",
            )
            with mock.patch.dict(os.environ, {"MAW_MOSS_RUNTIME_ROOT": str(root)}):
                status = managed_runtime_status(engine="moss")

        self.assertTrue(status.ready)
        self.assertEqual(status.runtime_version, MOSS_RUNTIME_VERSION)
        self.assertEqual(status.to_payload()["runtimeVersion"], MOSS_RUNTIME_VERSION)

    def test_wrong_manifest_version_is_broken(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            python = runtime_python_path(root)
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_bytes(b"python")
            for name in MOSS_PACKAGE_DIRS:
                ((root / "site-packages") / name).mkdir(parents=True, exist_ok=True)
            (root / "runtime.json").write_text(
                '{"status": "ready", "runtimeVersion": "2"}\n',
                encoding="utf-8",
                newline="\n",
            )
            with mock.patch.dict(os.environ, {"MAW_MOSS_RUNTIME_ROOT": str(root)}):
                status = managed_runtime_status(engine="moss")

        self.assertEqual(status.status, "broken")
        self.assertFalse(status.ready)
        self.assertEqual(status.runtime_version, "2")


class MossRuntimeInstallTests(unittest.TestCase):
    def test_install_delegates_to_embedded_runtime_with_frozen_txt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime-moss"
            requirements_txt = Path(temp_dir) / "requirements-moss.txt"
            requirements_txt.write_text(
                "transformers==5.16.1\ntorch==2.13.0+cu130\nmoss-transcribe-diarize @ https://github.com/OpenMOSS/MOSS-Transcribe-Diarize/archive/e607537b1b870475e7898969d40b864de8b691b6.zip\n",
                encoding="utf-8",
            )
            calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                calls.append(command)
                if "install" in command:
                    site = root / "site-packages"
                    for name in MOSS_PACKAGE_DIRS:
                        (site / name).mkdir(parents=True, exist_ok=True)
                return 0

            with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]):
                with mock.patch("maw.runtimes.base._extract_embed_python", side_effect=_fake_extract):
                    with mock.patch.object(MOSS, "requirements_path", return_value=requirements_txt):
                        with mock.patch("maw.runtimes.base._has_cuda", return_value=True):
                            with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                                with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                                    with mock.patch.dict(os.environ, {"MAW_MOSS_RUNTIME_ROOT": str(root)}):
                                        status = install_local_runtime(engine="moss")

            install_command = calls[1]
            verify_command = calls[2]
            self.assertTrue(status.ready)
            self.assertTrue(status.path.endswith("local-runtime-moss"))
            self.assertIn("-r", install_command)
            self.assertTrue(any("requirements-moss.txt" in str(arg) for arg in install_command))
            self.assertIn("--index-url", install_command)
            self.assertIn("--extra-index-url", install_command)
            self.assertIn(PYTORCH_INDEX, install_command)
            self.assertTrue(any(MOSS_VERIFY_IMPORT in str(arg) for arg in verify_command))

    def test_install_without_bootstrap_assets_explains_packaged_requirement(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch("maw.runtimes.base._find_bootstrap_asset", return_value=None):
                with mock.patch.dict(os.environ, {"MAW_MOSS_RUNTIME_ROOT": str(Path(temp_dir) / "runtime")}):
                    with self.assertRaises(LocalRuntimeError) as context:
                        install_local_runtime(engine="moss")

        self.assertIn("安装资产", str(context.exception))
        self.assertIn("官方打包版", str(context.exception))


if __name__ == "__main__":
    unittest.main()