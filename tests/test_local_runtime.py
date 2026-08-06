from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


from maw.local_runtime import (
    LocalRuntimeError,
    default_model_cache_root,
    install_local_runtime,
    managed_runtime_status,
    model_cache_environment,
    runtime_python_path,
)


class LocalRuntimeTests(unittest.TestCase):
    def test_runtime_worker_imports_maw_when_started_by_file_path(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            bundle_root = temp_root / "bundle"
            package_root = bundle_root / "maw"
            package_root.mkdir(parents=True)
            (package_root / "__init__.py").write_text("\n", encoding="utf-8")
            (package_root / "local_asr.py").write_text(
                "def create_local_engine(*_args, **_kwargs):\n"
                "    class Engine:\n"
                "        def _load(self, emit):\n"
                "            emit('fake model loaded')\n"
                "    return Engine()\n",
                encoding="utf-8",
            )
            shutil.copyfile(
                Path(__file__).resolve().parents[1] / "maw" / "local_runtime_worker.py",
                package_root / "local_runtime_worker.py",
            )
            work_dir = temp_root / "work"
            work_dir.mkdir()
            environment = dict(os.environ)
            environment.pop("PYTHONPATH", None)

            result = subprocess.run(
                [
                    sys.executable,
                    str(package_root / "local_runtime_worker.py"),
                    "prepare",
                    "--engine",
                    "fake",
                    "--model",
                    "fake-model",
                ],
                cwd=work_dir,
                capture_output=True,
                text=True,
                env=environment,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("fake model loaded", result.stdout)

    def test_missing_runtime_is_user_scoped_and_keeps_model_cache_separate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            cache = Path(temp_dir) / "models"
            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": str(root), "MAW_MODEL_CACHE_ROOT": str(cache)}):
                status = managed_runtime_status()
                environment = model_cache_environment()

        self.assertEqual(status.status, "missing")
        self.assertEqual(Path(status.path), root.resolve())
        self.assertEqual(Path(status.model_cache_path), cache.resolve())
        self.assertNotEqual(Path(status.path), Path(status.model_cache_path))
        self.assertEqual(Path(environment["HF_HUB_CACHE"]), cache.resolve() / "huggingface" / "hub")

    def test_install_creates_manifest_after_venv_and_dependency_steps(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            cache = Path(temp_dir) / "models"
            events: list[tuple[str, int, str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if command[1] == "venv":
                    python = runtime_python_path(root)
                    python.parent.mkdir(parents=True, exist_ok=True)
                    python.touch()
                if command[1:3] == ["pip", "install"]:
                    packages = root / "Lib" / "site-packages"
                    for name in ("funasr", "qwen_asr", "torch", "torchaudio"):
                        (packages / name).mkdir(parents=True, exist_ok=True)
                return 0

            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": str(root), "MAW_MODEL_CACHE_ROOT": str(cache)}):
                with mock.patch("maw.local_runtime._find_uv", return_value=Path("uv.exe")):
                    with mock.patch("maw.local_runtime._run_process", side_effect=fake_run) as run_process:
                        status = install_local_runtime(on_event=lambda *event: events.append(event))

            self.assertTrue(status.ready)
            self.assertTrue((root / "runtime.json").exists())
            self.assertGreaterEqual(run_process.call_count, 3)
            self.assertEqual(events[-1][1], 100)
            self.assertTrue((cache / "huggingface" / "hub").is_dir())
            self.assertTrue((cache / "modelscope").is_dir())

    def test_install_without_uv_explains_packaged_bootstrap_requirement(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": temp_dir}):
                with mock.patch("maw.local_runtime._find_uv", return_value=None):
                    with self.assertRaises(LocalRuntimeError) as context:
                        install_local_runtime()

        self.assertIn("uv", str(context.exception))


if __name__ == "__main__":
    unittest.main()
