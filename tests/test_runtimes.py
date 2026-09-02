"""Tests for the shared managed-runtime abstraction (maw.runtimes).

安装过程不联网：embedded Python 解压 / pip 安装 / verify 全部 mock，只断言
构造出的命令参数（-r / 镜像 / extra index / CUDA 兜底）与状态机迁移。
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

import maw.runtimes as runtimes  # noqa: F401  (intentionally imported for registry coverage)
import maw.runtimes.base as base_mod
from maw.runtime_manifest import STATUS_INSTALLING, write_runtime_manifest
from maw.runtimes import LOCAL, MOSS, OCR, get_runtime
from maw.runtimes.base import ManagedRuntime, ManagedRuntimeError, RuntimeSpec
from maw.runtimes.local_spec import LOCAL_SPEC, PYTORCH_INDEX, LocalRuntimeError
from maw.runtimes.moss_spec import MOSS_SPEC, PYTORCH_INDEX as MOSS_PYTORCH_INDEX
from maw.runtimes.ocr_spec import OCR_MODEL_ID, OCR_SPEC

PYTHON_RELATIVE = "python/python.exe" if os.name == "nt" else "python/bin/python"


def _fake_extract(_zip_path: Path, target_dir: Path) -> None:
    """假解压：制造 Windows embedded 布局的 python 占位（内嵌流测试固定 win32）。"""
    python = target_dir / "python.exe"
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

    def test_runtime_default_directories_are_distinct(self) -> None:
        self.assertEqual(
            {LOCAL.spec.dir_name, OCR.spec.dir_name, MOSS.spec.dir_name},
            {"local-runtime", "ocr-runtime", "local-runtime-moss"},
        )

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

    def test_moss_spec_is_real_embedded_spec_not_placeholder(self) -> None:
        # uv 迁移后 moss 与 local/ocr 走同一 embedded + frozen txt 机制：
        # 无 install_uv 占位、无手写 requirements 列表。
        self.assertFalse(getattr(MOSS.spec, "install_uv", False))
        self.assertIsNone(MOSS.spec.requirements)
        self.assertEqual(MOSS.spec.package_dirs, ("moss_transcribe_diarize", "transformers", "torch", "torchaudio"))
        self.assertEqual(MOSS.spec.requirements_key, "moss")
        self.assertEqual(MOSS.spec.requirements_bundle_name, "requirements-moss.txt")


class RuntimePathTests(unittest.TestCase):
    @mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
    @mock.patch("maw.runtimes.base.sys.platform", "win32")
    def test_frozen_windows_embedded_path_is_stable_on_unix_runners(self) -> None:
        root = Path("runtime")
        self.assertEqual(LOCAL.python_path(root), root / "python" / "python.exe")


class RuntimeInstallCommandTests(unittest.TestCase):
    # 内嵌流（embedded）测试固定 win32 + frozen：install 分支、CUDA 兜底与
    # python_path 布局在 mac/linux CI 上与 Windows 一致。
    @mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
    @mock.patch("maw.runtimes.base.sys.platform", "win32")
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
                    for name in ("faster_whisper", "funasr", "qwen_asr", "jieba", "torch", "torchaudio", "reapeaks"):
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

    @mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
    @mock.patch("maw.runtimes.base.sys.platform", "win32")
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

    # 类装饰器语义（win32 + frozen）由下方两个 mock 提供：CUDA 兜底只对非
    # darwin 平台执行，win32 同时保证不误入 unix venv 分支。
    @mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
    @mock.patch("maw.runtimes.base.sys.platform", "win32")
    def test_local_install_falls_back_to_cpu_torch_without_nvidia(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            requirements_txt = Path(temp_dir) / "requirements-local.txt"
            requirements_txt.write_text(
                "torch==2.13.0+cu130; sys_platform != 'darwin'\n"
                "torchaudio==2.11.0+cu130; sys_platform != 'darwin'\n"
                "funasr==1.4.2\n",
                encoding="utf-8",
            )
            cpu_txt = Path(temp_dir) / "requirements-local-cpu.txt"
            cpu_txt.write_text(
                "torch==2.13.0; sys_platform != 'darwin'\n"
                "torchaudio==2.11.0; sys_platform != 'darwin'\n"
                "funasr==1.4.2\n",
                encoding="utf-8",
            )
            calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                calls.append(command)
                if "install" in command:
                    site = root / "site-packages"
                    for name in ("faster_whisper", "funasr", "qwen_asr", "jieba", "torch", "torchaudio", "reapeaks"):
                        (site / name).mkdir(parents=True, exist_ok=True)
                return 0

            def fake_requirements_path(*, cpu: bool = False) -> Path:
                return cpu_txt if cpu else requirements_txt

            with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]):
                with mock.patch("maw.runtimes.base._extract_embed_python", side_effect=_fake_extract):
                    with mock.patch.object(LOCAL, "requirements_path", side_effect=fake_requirements_path):
                        with mock.patch("maw.runtimes.base._has_cuda", return_value=False):
                            with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                                with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                                    status = LOCAL.install(runtime_root=root)

            # 0=get-pip 1=依赖（CPU 版清单） 2=verify —— 旧「先装 cu130 再覆盖」步骤已移除
            install_command = calls[1]
            verify_command = calls[2]
            self.assertTrue(status.ready)
            # CPU 清单随包分发，首装直接调用：-r 指向 requirements-local-cpu.txt，
            # 且不再附加 cu130 extra index
            self.assertTrue(any(str(cpu_txt) in str(arg) for arg in install_command))
            self.assertNotIn("extra-index-url", install_command)
            self.assertNotIn("+cu130", cpu_txt.read_text(encoding="utf-8"))
            self.assertTrue(any("import jieba" in str(arg) for arg in verify_command))

    @mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
    @mock.patch("maw.runtimes.base.sys.platform", "win32")
    def test_moss_install_uses_frozen_txt_and_cu130_extra_index(self) -> None:
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
                    for name in ("moss_transcribe_diarize", "transformers", "torch", "torchaudio"):
                        (site / name).mkdir(parents=True, exist_ok=True)
                return 0

            with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]):
                with mock.patch("maw.runtimes.base._extract_embed_python", side_effect=_fake_extract):
                    with mock.patch.object(MOSS, "requirements_path", return_value=requirements_txt):
                        with mock.patch("maw.runtimes.base._has_cuda", return_value=True):
                            with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                                with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                                    status = MOSS.install(runtime_root=root)

            install_command = calls[1]
            verify_command = calls[2]
            self.assertTrue(status.ready)
            self.assertIn("-r", install_command)
            self.assertTrue(any("requirements-moss.txt" in str(arg) for arg in install_command))
            self.assertIn("--index-url", install_command)
            self.assertIn("--extra-index-url", install_command)
            self.assertIn(PYTORCH_INDEX, install_command)
            # verify 命令是 python -c 自检（moss_transcribe_diarize 导入）
            self.assertTrue(any("moss_transcribe_diarize" in str(arg) for arg in verify_command))


class SourceModeInstallTests(unittest.TestCase):
    """源码模式（非打包）安装：零下载，直接复用开发环境的 uv 与解释器。"""

    def test_source_mode_installs_via_uv_into_target_without_bootstrap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime-moss"
            requirements_txt = Path(temp_dir) / "requirements-moss.txt"
            requirements_txt.write_text("transformers==5.16.1\n", encoding="utf-8")
            calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                calls.append(command)
                if "install" in command:
                    site = root / "site-packages"
                    for name in ("moss_transcribe_diarize", "transformers", "torch", "torchaudio"):
                        (site / name).mkdir(parents=True, exist_ok=True)
                return 0

            def forbid_bootstrap(_filename: str) -> Path:
                raise AssertionError("source mode must not touch embedded bootstrap assets")

            with mock.patch("maw.runtimes.base.shutil.which", return_value=str(Path("C:/tools/uv.exe"))):
                with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=forbid_bootstrap):
                    with mock.patch.object(MOSS, "requirements_path", return_value=requirements_txt):
                        with mock.patch("maw.runtimes.base._has_cuda", return_value=True):
                            with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                                with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                                    status = MOSS.install(runtime_root=root)

            self.assertTrue(status.ready)
            # 源码模式没有解压/get-pip 步骤：只有 install + verify 两段。
            self.assertEqual(len(calls), 2)
            install_command = calls[0]
            verify_command = calls[-1]
            self.assertEqual(install_command[:3], [str(Path("C:/tools/uv.exe")), "pip", "install"])
            self.assertIn("--target", install_command)
            self.assertIn("-r", install_command)
            # 解释器是 MAW 自己的开发环境，而不是托管目录里的嵌入式 Python。
            self.assertNotIn(str(root), str(status.python_path))
            self.assertTrue(any("moss_transcribe_diarize" in str(arg) for arg in verify_command))

    def test_source_mode_without_uv_fails_with_install_hint(self) -> None:
        from maw.runtimes.base import ManagedRuntimeError

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            with mock.patch("maw.runtimes.base.shutil.which", return_value=None):
                with self.assertRaises(ManagedRuntimeError) as ctx:
                    LOCAL.install(runtime_root=root)

        self.assertIn("uv", str(ctx.exception))


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
            # 所有负载字段必须可 JSON 序列化（WindowsPath 会击穿 pywebview bridge）
            json.dumps(status.to_payload())
            self.assertIsInstance(status.model_cache_path, str)


@mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
@mock.patch("maw.runtimes.base.sys.platform", "linux")
class VenvRuntimeInstallTests(unittest.TestCase):
    """unix 打包版：宿主 python3 创建 venv 走同一份 frozen 清单（无需 bootstrap 资产）。"""

    @staticmethod
    def _venv_site_packages(root: Path) -> Path:
        site = root / "lib" / "python3.11" / "site-packages"
        site.mkdir(parents=True, exist_ok=True)
        return site

    def test_venv_layout_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            self.assertEqual(LOCAL.python_path(root), root / "bin" / "python")
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "runtime"
            site = self._venv_site_packages(root)
            self.assertEqual(LOCAL.site_packages(root), site)

    def test_venv_install_uses_host_python_without_bootstrap_assets(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            # GitHub Runner 的 %TEMP% 可能是 8.3 短路径（如 C:\Users\RUNNER~1\...）；
            # install() 会把 runtime_root 经 Path.resolve() 规范化后再拼进命令，
            # 断言与桩必须使用同一份规范化结果，否则仅在短路径环境下失败。
            canonical_root = root.expanduser().resolve(strict=False)
            requirements_txt = Path(temp_dir) / "requirements-local.txt"
            requirements_txt.write_text("funasr==1.4.2\njieba==0.42.1\n", encoding="utf-8")
            calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                calls.append(command)
                if "-m" in command and "venv" in command[2:4]:
                    python = canonical_root / "bin" / "python"
                    python.parent.mkdir(parents=True, exist_ok=True)
                    python.write_bytes(b"python")
                elif "install" in command:
                    for name in ("faster_whisper", "funasr", "qwen_asr", "jieba", "torch", "torchaudio", "reapeaks"):
                        (self._venv_site_packages(canonical_root) / name).mkdir(parents=True, exist_ok=True)
                return 0

            def forbid_bootstrap(_filename: str) -> Path:
                raise AssertionError("unix venv must not touch embedded bootstrap assets")

            # 版本探针（subprocess.run）直接返回成功；未 mock 任何 bootstrap 资产。
            with mock.patch("maw.runtimes.base.shutil.which", return_value="python3"):
                with mock.patch("maw.runtimes.base.subprocess.run", return_value=unittest.mock.MagicMock(returncode=0)):
                    with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=forbid_bootstrap):
                        with mock.patch.object(LOCAL, "requirements_path", return_value=requirements_txt):
                            with mock.patch("maw.runtimes.base._has_cuda", return_value=True):
                                with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                                    with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                                        status = LOCAL.install(runtime_root=root)

            create_command = calls[0]
            install_command = calls[1]
            verify_command = calls[2]
            self.assertTrue(status.ready)
            # venv 创建：宿主 python3 -m venv <root>（root 不存在，无 --clear）
            self.assertEqual(create_command[:3], ["python3", "-m", "venv"])
            self.assertTrue(any(str(canonical_root) in str(arg) for arg in create_command))
            self.assertNotIn("--clear", create_command)
            # pip 直装 venv：bin/python -m pip install -r <主清单>，无 --target
            bin_python = str(canonical_root / "bin" / "python")
            self.assertEqual(install_command[0], bin_python)
            self.assertIn("-r", install_command)
            self.assertTrue(any("requirements-local.txt" in str(arg) for arg in install_command))
            self.assertNotIn("--target", install_command)
            self.assertIn("--index-url", install_command)
            self.assertIn("--extra-index-url", install_command)
            self.assertIn(PYTORCH_INDEX, install_command)
            # verify 用 venv 内的 bin/python
            self.assertEqual(verify_command[0], bin_python)
            self.assertTrue(any("import jieba" in str(arg) for arg in verify_command))

    def test_venv_install_without_host_python3_explains_requirement(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            with mock.patch("maw.runtimes.base.shutil.which", return_value=None):
                with mock.patch("maw.runtimes.base._has_cuda", return_value=True):
                    with self.assertRaises(ManagedRuntimeError) as context:
                        LOCAL.install(runtime_root=root)

        self.assertIn("宿主 python3", str(context.exception))
        self.assertIn("Python 3.11", str(context.exception))

    def test_venv_install_falls_back_to_cpu_requirements_without_nvidia(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            requirements_txt = Path(temp_dir) / "requirements-local.txt"
            requirements_txt.write_text("torch==2.13.0+cu130\nfunasr==1.4.2\n", encoding="utf-8")
            cpu_txt = Path(temp_dir) / "requirements-local-cpu.txt"
            cpu_txt.write_text("torch==2.13.0\nfunasr==1.4.2\n", encoding="utf-8")
            calls: list[list[str]] = []

            def fake_run(command: list[str], **_kwargs: object) -> int:
                calls.append(command)
                if "-m" in command and "venv" in command[2:4]:
                    python = root / "bin" / "python"
                    python.parent.mkdir(parents=True, exist_ok=True)
                    python.write_bytes(b"python")
                elif "install" in command:
                    for name in ("faster_whisper", "funasr", "qwen_asr", "jieba", "torch", "torchaudio", "reapeaks"):
                        (self._venv_site_packages(root) / name).mkdir(parents=True, exist_ok=True)
                return 0

            def fake_requirements_path(*, cpu: bool = False) -> Path:
                return cpu_txt if cpu else requirements_txt

            with mock.patch("maw.runtimes.base.shutil.which", return_value="python3"):
                with mock.patch("maw.runtimes.base.subprocess.run", return_value=unittest.mock.MagicMock(returncode=0)):
                    with mock.patch.object(LOCAL, "requirements_path", side_effect=fake_requirements_path):
                        with mock.patch("maw.runtimes.base._has_cuda", return_value=False):
                            with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                                with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                                    status = LOCAL.install(runtime_root=root)

            install_command = calls[1]
            self.assertTrue(status.ready)
            # venv 下同样走 CPU 清单前置：-r requirements-local-cpu.txt、无 cu130 extra index
            self.assertTrue(any(str(cpu_txt) in str(arg) for arg in install_command))
            self.assertNotIn("extra-index-url", install_command)


class AutoFreezeRequirementsTests(unittest.TestCase):
    """源码模式缺 frozen 清单时按构建管线同款命令自动补齐（全新 clone 零手工步骤）。"""

    def _temp_build_dir(self) -> Path:
        build = Path(tempfile.mkdtemp()) / "build"
        build.mkdir(parents=True)
        self.addCleanup(lambda: shutil.rmtree(build.parent, ignore_errors=True))
        return build

    def test_freeze_commands_mirror_build_pipeline(self) -> None:
        uv = Path("C:/tools/uv.exe")
        build = Path("repo/build")
        # local 主清单：独立 dependency group 的 uv export（uv.lock 离线）
        self.assertEqual(
            base_mod.freezer.main_freeze_command(uv, LOCAL_SPEC, build),
            [str(uv), "export", "--frozen", "--only-group", "local",
             "--format", "requirements-txt", "-o", str(build / "requirements-local.txt")],
        )
        # local CPU 变体：生成式 in（build/ 下）原生冻结（带哈希）
        self.assertEqual(
            base_mod.freezer.cpu_freeze_command(uv, LOCAL_SPEC, build),
            [str(uv), "pip", "compile", str(build / "local-cpu-requirements.in"), "-p", "3.11",
             "--generate-hashes",
             "--index-strategy", "unsafe-best-match",
             "-o", str(build / "requirements-local-cpu.txt")],
        )
        # ocr：仅主清单；无 CPU 变体
        self.assertEqual(
            base_mod.freezer.main_freeze_command(uv, OCR_SPEC, build),
            [str(uv), "export", "--frozen", "--only-group", "ocr",
             "--format", "requirements-txt", "-o", str(build / "requirements-ocr.txt")],
        )
        self.assertIsNone(base_mod.freezer.cpu_freeze_command(uv, OCR_SPEC, build))
        # moss：uv pip compile（in 文件 pin cu130，必须带 extra index）
        self.assertEqual(
            base_mod.freezer.main_freeze_command(uv, MOSS_SPEC, build),
            [str(uv), "pip", "compile", "moss-requirements.in", "-p", "3.11",
             "--extra-index-url", MOSS_PYTORCH_INDEX,
             "--index-strategy", "unsafe-best-match",
             "-o", str(build / "requirements-moss.txt")],
        )
        # moss CPU 变体：同一 in 文件剥离生成（带哈希），与 local-cpu 同构
        self.assertEqual(
            base_mod.freezer.cpu_freeze_command(uv, MOSS_SPEC, build),
            [str(uv), "pip", "compile", str(build / "moss-cpu-requirements.in"), "-p", "3.11",
             "--generate-hashes",
             "--index-strategy", "unsafe-best-match",
             "-o", str(build / "requirements-moss-cpu.txt")],
        )

    def test_missing_main_txt_is_generated_with_progress_events(self) -> None:
        build = self._temp_build_dir()
        emitted: list[str] = []
        calls: list[list[str]] = []

        def fake_run(command: list[str], **_kwargs: object) -> int:
            calls.append(command)
            index = command.index("-o")
            Path(command[index + 1]).write_text("funasr==1.4.2\n", encoding="utf-8")
            return 0

        with mock.patch.object(base_mod, "_build_dir", return_value=build):
            with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                LOCAL._ensure_frozen_requirements(
                    Path("C:/tools/uv.exe"), cpu=False,
                    emit=lambda message, _percent, _stage: emitted.append(message),
                    cancel=Event(),
                )

        self.assertTrue((build / "requirements-local.txt").is_file())
        self.assertIn("正在生成", "".join(emitted))
        self.assertEqual(calls[0][1:3], ["export", "--frozen"])

    def test_existing_txt_skips_generation(self) -> None:
        build = self._temp_build_dir()
        (build / "requirements-local.txt").write_text("funasr==1.4.2\n", encoding="utf-8")
        with mock.patch.object(base_mod, "_build_dir", return_value=build):
            with mock.patch("maw.runtimes.base._run_process", side_effect=AssertionError("must not run")):
                LOCAL._ensure_frozen_requirements(
                    Path("C:/tools/uv.exe"), cpu=False,
                    emit=lambda *event: None, cancel=Event(),
                )

    def test_missing_moss_cpu_txt_is_generated_for_no_nvidia_machines(self) -> None:
        # MOSS 无 GPU 首装走 moss-cpu 清单（from moss-requirements.in 剥离生成，
        # in 先落盘 build/ 再原生冻结，与 local-cpu 同构）。
        build = self._temp_build_dir()
        (build.parent / "moss-requirements.in").write_text(
            "torch==2.13.0+cu130; sys_platform != 'darwin'\n",
            encoding="utf-8",
        )
        calls: list[list[str]] = []

        def fake_run(command: list[str], **_kwargs: object) -> int:
            calls.append(command)
            index = command.index("-o")
            Path(command[index + 1]).write_text("transformers==5.16.1\ntorch==2.13.0\n", encoding="utf-8")
            return 0

        with mock.patch.object(base_mod, "_build_dir", return_value=build):
            with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                MOSS._ensure_frozen_requirements(
                    Path("C:/tools/uv.exe"), cpu=True,
                    emit=lambda *event: None, cancel=Event(),
                )

        self.assertTrue((build / "requirements-moss-cpu.txt").is_file())
        # 生成式 in 已落盘，再由 uv pip compile 原生冻结
        self.assertTrue((build / "moss-cpu-requirements.in").is_file())
        cpu_in = (build / "moss-cpu-requirements.in").read_text(encoding="utf-8")
        self.assertIn("torch==2.13.0\n", cpu_in)
        self.assertNotIn("+cu130", cpu_in)
        self.assertEqual(calls[0][1:3], ["pip", "compile"])
        self.assertIn(str(build / "moss-cpu-requirements.in"), calls[0])
        self.assertIn("--generate-hashes", calls[0])
        self.assertNotIn("extra-index-url", calls[0])

    def test_generation_failure_wraps_error_and_keeps_hint(self) -> None:
        build = self._temp_build_dir()
        with mock.patch.object(base_mod, "_build_dir", return_value=build):
            with mock.patch("maw.runtimes.base._run_process", side_effect=LocalRuntimeError("镜像 404")):
                with self.assertRaises(ManagedRuntimeError) as context:
                    LOCAL._ensure_frozen_requirements(
                        Path("C:/tools/uv.exe"), cpu=False,
                        emit=lambda *event: None, cancel=Event(),
                    )

        self.assertIn("自动生成依赖清单失败", str(context.exception))
        self.assertIn("镜像 404", str(context.exception))

    def test_missing_uv_emits_warning_before_failing(self) -> None:
        events: list[tuple[str, int, str]] = []
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "local-runtime"
            with mock.patch("maw.runtimes.base.shutil.which", return_value=None):
                with self.assertRaises(ManagedRuntimeError) as ctx:
                    LOCAL.install(runtime_root=root, on_event=lambda m, p, s: events.append((m, p, s)))

        self.assertTrue(any("[警告]" in message and "uv" in message for message, _p, _s in events))
        hint = str(ctx.exception)
        self.assertIn("astral.sh/uv/install.ps1", hint)
        self.assertIn("astral.sh/uv/install.sh", hint)


if __name__ == "__main__":
    unittest.main()
