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
    install_local_runtime,
    managed_runtime_status,
    model_cache_environment,
    prepare_model_in_process,
    prepare_model_in_runtime,
)
from maw.runtimes import LOCAL


class LocalRuntimeTests(unittest.TestCase):
    def test_local_transcription_script_imports_bundled_maw_without_script_path(self) -> None:
        """回归：Windows embedded Python 的 ``._pth`` 不会自动加入脚本目录。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            temp_root = Path(temp_dir)
            bundle_root = temp_root / "local-runtime"
            package_root = bundle_root / "maw"
            package_root.mkdir(parents=True)
            shutil.copyfile(
                Path(__file__).resolve().parents[1] / "generate_subtitle_local.py",
                bundle_root / "generate_subtitle_local.py",
            )
            (package_root / "__init__.py").write_text("\n", encoding="utf-8")
            shutil.copyfile(
                Path(__file__).resolve().parents[1] / "maw" / "ffmpeg.py",
                package_root / "ffmpeg.py",
            )
            (package_root / "console.py").write_text(
                "def configure_utf8_stdio():\n"
                "    pass\n",
                encoding="utf-8",
            )
            (package_root / "local_asr.py").write_text(
                "FUNASR_DEFAULT_MODEL = 'funasr'\n"
                "QWEN_DEFAULT_CHUNK_SECONDS = 30\n"
                "QWEN_DEFAULT_FORCED_ALIGNER = 'aligner'\n"
                "QWEN_DEFAULT_MODEL = 'qwen'\n"
                "WHISPER_DEFAULT_MODEL = 'whisper'\n"
                "def build_local_segments(*args, **kwargs): pass\n"
                "def create_local_engine(*args, **kwargs): pass\n"
                "def parse_duration(value): return int(value)\n"
                "def prepared_audio(*args, **kwargs): pass\n"
                "def write_local_outputs(*args, **kwargs): pass\n",
                encoding="utf-8",
            )
            script = bundle_root / "generate_subtitle_local.py"
            work_dir = temp_root / "work"
            work_dir.mkdir()
            environment = dict(os.environ)
            environment.pop("PYTHONPATH", None)
            environment["PYTHONUTF8"] = "1"
            environment["PYTHONIOENCODING"] = "utf-8:replace"
            driver = (
                "import sys\n"
                "from pathlib import Path\n"
                f"script = Path({str(script)!r})\n"
                "sys.path = [entry for entry in sys.path if Path(entry or '.').resolve() != script.parent.resolve()]\n"
                "sys.argv = [str(script), '--help']\n"
                "namespace = {'__name__': '__main__', '__file__': str(script), '__package__': None}\n"
                "exec(compile(script.read_text(encoding='utf-8'), str(script), 'exec'), namespace, namespace)\n"
            )
            result = subprocess.run(
                [sys.executable, "-c", driver],
                cwd=work_dir,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=environment,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("usage:", result.stdout.lower())

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
            shutil.copyfile(
                Path(__file__).resolve().parents[1] / "maw" / "console.py",
                package_root / "console.py",
            )
            work_dir = temp_root / "work"
            work_dir.mkdir()
            environment = dict(os.environ)
            environment.pop("PYTHONPATH", None)
            environment["PYTHONUTF8"] = "1"
            environment["PYTHONIOENCODING"] = "utf-8:replace"

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
                encoding="utf-8",
                errors="replace",
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

    # 内嵌流测试固定 win32：install 分支与 python_path 布局在 mac/linux CI 上一致。
    @mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
    @mock.patch("maw.runtimes.base.sys.platform", "win32")
    def test_install_creates_manifest_after_venv_and_dependency_steps(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            cache = Path(temp_dir) / "models"
            events: list[tuple[str, int, str]] = []

            def fake_extract(_zip_path: Path, target_dir: Path) -> None:
                python = target_dir / ("python.exe" if sys.platform == "win32" else "bin/python")
                python.parent.mkdir(parents=True, exist_ok=True)
                python.touch()

            def fake_run(command: list[str], **_kwargs: object) -> int:
                if "install" in command:
                    packages = root / "site-packages"
                    for name in ("faster_whisper", "funasr", "qwen_asr", "jieba", "torch", "torchaudio", "reapeaks"):
                        (packages / name).mkdir(parents=True, exist_ok=True)
                return 0

            requirements_txt = Path(temp_dir) / "requirements-local.txt"
            requirements_txt.write_text("funasr==1.4.2\nqwen-asr==0.0.6\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": str(root), "MAW_MODEL_CACHE_ROOT": str(cache)}):
                with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]):
                    with mock.patch("maw.runtimes.base._extract_embed_python", side_effect=fake_extract):
                        with mock.patch.object(LOCAL, "requirements_path", return_value=requirements_txt):
                            with mock.patch("maw.runtimes.base._has_cuda", return_value=True):
                                with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                                    with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run) as run_process:
                                        status = install_local_runtime(on_event=lambda *event: events.append(event))

            self.assertTrue(status.ready)
            self.assertTrue((root / "runtime.json").exists())
            self.assertGreaterEqual(run_process.call_count, 3)
            self.assertEqual(events[-1][1], 100)
            self.assertTrue((cache / "huggingface" / "hub").is_dir())
            self.assertTrue((cache / "modelscope").is_dir())

            install_command = run_process.call_args_list[1].args[0]
            verify_command = run_process.call_args_list[2].args[0]

        self.assertIn("-r", install_command)
        self.assertTrue(any("requirements-local.txt" in str(arg) for arg in install_command))
        self.assertIn("--target", install_command)
        self.assertIn("import jieba", verify_command[-1])

    @mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
    @mock.patch("maw.runtimes.base.sys.platform", "win32")
    def test_install_without_bootstrap_assets_explains_packaged_requirement(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with mock.patch.dict(os.environ, {"MAW_LOCAL_RUNTIME_ROOT": temp_dir}):
                with mock.patch("maw.runtimes.base._find_bootstrap_asset", return_value=None):
                    with self.assertRaises(LocalRuntimeError) as context:
                        install_local_runtime()

        self.assertIn("embedded Python", str(context.exception))

    def test_source_model_prepare_uses_current_python_and_shared_cache(self) -> None:
        with mock.patch("maw.local_runtime._run_process", return_value=0) as run_process:
            result = prepare_model_in_process(
                engine="qwen-asr",
                model="Qwen/Qwen3-ASR-0.6B",
                device="cpu",
                forced_aligner="Qwen/Qwen3-ForcedAligner-0.6B",
            )

        self.assertEqual(result, 0)
        command = run_process.call_args.args[0]
        self.assertEqual(command[0], sys.executable)
        self.assertIn("local_runtime_worker.py", command[1])
        self.assertIn("--forced-aligner", command)
        environment = run_process.call_args.kwargs["env"]
        self.assertEqual(environment["HF_HUB_CACHE"], model_cache_environment()["HF_HUB_CACHE"])

    def test_prepare_entries_forward_process_error_mapping_kwargs(self) -> None:
        """回归：`runtimes.base._run_process` 的 cwd / error_class / cancelled_class /
        cancelled_message / message_prefix 是必填关键字参数。prepare 两个入口若漏传，
        GUI「下载模型」点击即抛 TypeError（PR #77 实测），mock 无法替它兜底。"""
        from maw.local_runtime import (
            LocalRuntimeError,
            LocalRuntimeStatus,
        )
        from maw.runtimes.base import RuntimeCancelled

        ready = LocalRuntimeStatus("ready", True, "path", "python", "cache", "")

        def assert_mapping_kwargs(run_process: mock.Mock) -> None:
            kwargs = run_process.call_args.kwargs
            self.assertIs(kwargs["error_class"], LocalRuntimeError)
            self.assertTrue(issubclass(kwargs["cancelled_class"], RuntimeCancelled))
            self.assertTrue(str(kwargs["cancelled_message"]).strip())
            self.assertTrue(str(kwargs["message_prefix"]).strip())
            self.assertTrue(Path(str(kwargs["cwd"])).is_dir())

        with mock.patch("maw.local_runtime.managed_runtime_status", return_value=ready):
            with mock.patch("maw.local_runtime._run_process", return_value=0) as run_process:
                prepare_model_in_runtime(
                    engine="whisper",
                    model="Systran/faster-whisper-large-v3",
                    device="cpu",
                )
        assert_mapping_kwargs(run_process)

        with mock.patch("maw.local_runtime._run_process", return_value=0) as run_process:
            prepare_model_in_process(engine="qwen-asr", model="Qwen/Qwen3-ASR-0.6B", device="cpu")
        assert_mapping_kwargs(run_process)


if __name__ == "__main__":
    unittest.main()
