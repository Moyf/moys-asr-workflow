from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw import moss_runtime
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

_PYTHON_RELATIVE = Path("Scripts") / "python.exe" if os.name == "nt" else Path("bin") / "python"


class MossRuntimeConstantTests(unittest.TestCase):
    def test_constant_values(self) -> None:
        self.assertEqual(MOSS_RUNTIME_VERSION, "1")
        self.assertEqual(MOSS_PYTHON_VERSION, "3.12")
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

    def test_override_root_keeps_moss_suffix(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir) / "runtime"
            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": str(base)}):
                root = default_runtime_root()
        self.assertEqual(root.name, "runtime-moss")
        self.assertEqual(root.parent, base.parent.resolve())

    def test_python_path_sits_inside_moss_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir) / "runtime"
            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": str(base)}):
                python = runtime_python_path()
        self.assertEqual(python, base.with_name(f"{base.name}-moss") / _PYTHON_RELATIVE)


class MossRuntimeStatusTests(unittest.TestCase):
    def test_missing_moss_status_reports_missing_and_version(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            cache = Path(temp_dir) / "models"
            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": str(root), "MAW_MODEL_CACHE_ROOT": str(cache)}):
                status = moss_runtime.managed_runtime_status()
                delegated = managed_runtime_status(engine="moss")

        self.assertEqual(status.status, "missing")
        self.assertFalse(status.ready)
        self.assertEqual(status.runtime_version, MOSS_RUNTIME_VERSION)
        self.assertEqual(Path(status.path), root.with_name("runtime-moss").resolve())
        self.assertEqual(Path(status.model_cache_path), cache.resolve())
        self.assertEqual(delegated, status)

    def test_ready_moss_status_requires_manifest_and_packages(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            moss_root = root.with_name(f"{root.name}-moss")
            python = runtime_python_path(moss_root)
            python.parent.mkdir(parents=True, exist_ok=True)
            python.touch()
            site_packages = (
                moss_root / "Lib" / "site-packages"
                if os.name == "nt"
                else moss_root / "lib" / f"python{sys.version_info.major}.{sys.version_info.minor}" / "site-packages"
            )
            for name in MOSS_PACKAGE_DIRS:
                (site_packages / name).mkdir(parents=True, exist_ok=True)
            (moss_root / "runtime.json").write_text(
                '{"status": "ready", "runtimeVersion": "1"}\n',
                encoding="utf-8",
                newline="\n",
            )
            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": str(root)}):
                status = managed_runtime_status(engine="moss")

        self.assertTrue(status.ready)
        self.assertEqual(status.runtime_version, MOSS_RUNTIME_VERSION)
        self.assertEqual(status.to_payload()["runtimeVersion"], MOSS_RUNTIME_VERSION)

    def test_wrong_manifest_version_is_broken(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            moss_root = root.with_name(f"{root.name}-moss")
            python = runtime_python_path(moss_root)
            python.parent.mkdir(parents=True, exist_ok=True)
            python.touch()
            for name in MOSS_PACKAGE_DIRS:
                ((moss_root / "Lib" / "site-packages") / name).mkdir(parents=True, exist_ok=True)
            (moss_root / "runtime.json").write_text(
                '{"status": "ready", "runtimeVersion": "2"}\n',
                encoding="utf-8",
                newline="\n",
            )
            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": str(root)}):
                status = managed_runtime_status(engine="moss")

        self.assertEqual(status.status, "broken")
        self.assertFalse(status.ready)
        self.assertEqual(status.runtime_version, "2")


class MossRuntimeInstallTests(unittest.TestCase):
    def test_install_uses_moss_root_venv_and_requirements(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.dict(os.environ, {"MAW_APP_DATA_ROOT": str(Path(temp_dir) / "app")}):
                with mock.patch("maw.moss_runtime._find_uv", return_value=Path("uv.exe")):
                    with mock.patch("maw.moss_runtime._run_process", return_value=0) as run_process:
                        moss_root = Path(temp_dir) / "app" / "local-runtime-moss"

                        def fake_run(command: list[str], **_kwargs: object) -> int:
                            if command[1] == "venv":
                                python = runtime_python_path(moss_root)
                                python.parent.mkdir(parents=True, exist_ok=True)
                                python.touch()
                            if command[1:3] == ["pip", "install"]:
                                packages = moss_root / "Lib" / "site-packages"
                                for name in MOSS_PACKAGE_DIRS:
                                    (packages / name).mkdir(parents=True, exist_ok=True)
                            return 0

                        run_process.side_effect = fake_run
                        status = install_local_runtime(engine="moss")

        self.assertTrue(status.ready)
        self.assertIn("local-runtime-moss", status.path)
        venv_command = run_process.call_args_list[0].args[0]
        self.assertIn("--python", venv_command)
        self.assertIn(MOSS_PYTHON_VERSION, venv_command)
        install_command = run_process.call_args_list[1].args[0]
        self.assertIn("--extra-index-url", install_command)
        self.assertTrue(any("transformers>=5.6.0" in value for value in install_command))
        verify_command = run_process.call_args_list[2].args[0]
        self.assertIn(MOSS_VERIFY_IMPORT, verify_command)

    def test_install_without_uv_explains_packaged_bootstrap_requirement(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.dict(os.environ, {"MAW_APP_DATA_ROOT": str(Path(temp_dir) / "app")}):
                with mock.patch("maw.moss_runtime._find_uv", return_value=None):
                    with self.assertRaises(LocalRuntimeError) as context:
                        install_local_runtime(engine="moss")

        self.assertIn("uv", str(context.exception))


if __name__ == "__main__":
    unittest.main()