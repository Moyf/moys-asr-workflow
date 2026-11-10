"""maw.runtimes.pathwin 单测：Windows 非 ASCII 运行时路径的 ASCII 化决策。

本机（macOS/Linux）不要求真在 Windows 验证：Windows 行为通过 mock
``win32_get_short_path``（成功短路径 / 返回原样 / API 异常三分支）与
``sys.platform`` / ``_path_exists`` 模拟；非 Windows 平台断言全部入口
原样直通、零副作用。涉及真实 Windows 语义的用例按平台 skip，保证同一
份测试在 Windows CI（pr-release-windows 全量 Python 套件）上同样成立。
"""

from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw.runtimes import pathwin

NON_ASCII_ROOT = r"C:\Users\卓什么越\AppData\Local\MAW\local-runtime"
NON_ASCII_PREFIX_SHORT = r"C:\Users\7A6C~1\AppData\LOCAL~1"
ASCII_ROOT = r"C:\Users\runner\AppData\Local\MAW\local-runtime"

WIN32_ONLY = sys.platform == "win32"


def _win32_patches() -> tuple[object, ...]:
    """把 pathwin 模拟成 Windows 环境（base 的 win32 由调用方按需另补）。"""
    return (mock.patch("maw.runtimes.pathwin.sys.platform", "win32"),)


@unittest.skipIf(WIN32_ONLY, "非 Windows 直通断言仅适用 POSIX 平台")
class NonWindowsPassthroughTests(unittest.TestCase):
    """非 Windows 平台：一切入口原样直通，绝不触碰文件系统与 ctypes。"""

    def test_ensure_ascii_root_returns_path_unchanged_without_fs_access(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "卓什么越" / "local-runtime"
            with mock.patch.object(pathwin, "win32_get_short_path") as short_path:
                with mock.patch.object(pathwin, "_path_exists") as path_exists:
                    self.assertEqual(pathwin.ensure_ascii_root(root, dir_name="local-runtime"), root)
            short_path.assert_not_called()
            path_exists.assert_not_called()

    def test_prepare_install_root_is_noop_on_unix(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "卓什么越" / "local-runtime"
            with mock.patch.object(pathwin, "probe_writable") as probe:
                self.assertEqual(pathwin.prepare_install_root(root, dir_name="local-runtime"), root)
            probe.assert_not_called()
            self.assertFalse(root.exists())  # 直通不得创建目录

    def test_ascii_path_failure_hint_is_empty_on_unix(self) -> None:
        self.assertEqual(pathwin.ascii_path_failure_hint(Path("C:/Users/卓什么越/runtime")), "")

    def test_win32_get_short_path_never_touches_ctypes_on_unix(self) -> None:
        self.assertEqual(pathwin.win32_get_short_path(NON_ASCII_ROOT), NON_ASCII_ROOT)


class AsciiAliasTests(unittest.TestCase):
    """``ascii_alias``：已存在前缀转 8.3 短路径、保留 ASCII 尾段的三分支。"""

    def _alias(self, path: str, *, exists: set[str], short_map: dict[str, str] | None = None, api_error: bool = False) -> str:
        def get_short_path(path_str: str) -> str:
            if api_error:
                raise OSError(3, "GetShortPathNameW 失败（模拟）")
            if short_map and path_str in short_map:
                return short_map[path_str]
            return path_str  # 存在但没有 8.3 短名（8.3 被禁用）

        with _win32_patches()[0]:
            with mock.patch.object(pathwin, "_path_exists", side_effect=lambda p: str(p) in exists):
                with mock.patch.object(pathwin, "win32_get_short_path", side_effect=get_short_path):
                    return str(pathwin.ascii_alias(path))

    def test_full_path_exists_and_converts_to_short_form(self) -> None:
        short_full = r"C:\Users\7A6C~1\AppData\Local\MAW\LOCAL-R~1"
        result = self._alias(NON_ASCII_ROOT, exists={NON_ASCII_ROOT}, short_map={NON_ASCII_ROOT: short_full})
        self.assertEqual(result, short_full)

    def test_missing_root_walks_up_to_existing_prefix_and_keeps_ascii_tail(self) -> None:
        prefix = r"C:\Users\卓什么越\AppData\Local"
        result = self._alias(
            NON_ASCII_ROOT,
            exists={prefix},
            short_map={prefix: NON_ASCII_PREFIX_SHORT},
        )
        self.assertEqual(result, NON_ASCII_PREFIX_SHORT + r"\MAW\local-runtime")

    def test_everything_missing_returns_original(self) -> None:
        self.assertEqual(self._alias(NON_ASCII_ROOT, exists=set()), NON_ASCII_ROOT)

    def test_existing_prefix_without_short_name_gives_up(self) -> None:
        # 8.3 被注册表禁用：已存在前缀原样返回 → 整卷无短名，放弃别名
        prefix = r"C:\Users\卓什么越\AppData\Local"
        self.assertEqual(
            self._alias(NON_ASCII_ROOT, exists={prefix}),  # short_map 缺省 → 返回原样
            NON_ASCII_ROOT,
        )

    def test_api_error_on_existing_prefix_falls_back_to_original(self) -> None:
        prefix = r"C:\Users\卓什么越\AppData\Local"
        self.assertEqual(self._alias(NON_ASCII_ROOT, exists={prefix}, api_error=True), NON_ASCII_ROOT)

    def test_non_ascii_tail_cannot_be_aliased(self) -> None:
        # 尾段（尚未创建的目录）自身含非 ASCII：别名救不了
        path = r"D:\existing\中文目录\runtime"
        result = self._alias(path, exists={r"D:\existing"}, short_map={r"D:\existing": r"D:\EXIST~1"})
        self.assertEqual(result, path)


class EnsureAsciiRootDecisionTableTests(unittest.TestCase):
    """``ensure_ascii_root`` 决策表（ASCII 直通 / 别名 / fallback / 不迁移）。"""

    def _ensure(self, path: str, *, dir_name: str = "local-runtime", allow_relocate: bool = True,
                alias_result: str | None = None, env: dict[str, str] | None = None) -> str:
        def fake_alias(value: object) -> object:
            return alias_result if alias_result is not None else value

        with _win32_patches()[0]:
            with mock.patch.dict(os.environ, env or {}, clear=False):
                with mock.patch.object(pathwin, "ascii_alias", side_effect=fake_alias):
                    return str(pathwin.ensure_ascii_root(Path(path), dir_name=dir_name, allow_relocate=allow_relocate))

    def test_ascii_path_is_untouched_even_without_alias_effort(self) -> None:
        with mock.patch.object(pathwin, "ascii_alias") as alias:
            self.assertEqual(self._ensure(ASCII_ROOT), ASCII_ROOT)
        alias.assert_not_called()

    def test_ascii_alias_wins_when_available(self) -> None:
        alias = r"C:\Users\7A6C~1\AppData\LOCAL~1\MAW\local-runtime"
        self.assertEqual(self._ensure(NON_ASCII_ROOT, alias_result=alias), alias)

    def test_explicit_config_accepts_alias_but_not_relocation(self) -> None:
        """显式配置：8.3 别名可用时照常转换（同一物理目录）；不可用时不迁移。"""
        alias = r"C:\Users\7A6C~1\AppData\LOCAL~1\MAW\local-runtime"
        with tempfile.TemporaryDirectory() as temp_dir:
            env = {"PROGRAMDATA": temp_dir}
            self.assertEqual(
                self._ensure(NON_ASCII_ROOT, alias_result=alias, allow_relocate=False, env=env),
                alias,
            )
            self.assertEqual(
                self._ensure(NON_ASCII_ROOT, alias_result=NON_ASCII_ROOT, allow_relocate=False, env=env),
                NON_ASCII_ROOT,
            )

    def test_alias_unavailable_relocates_to_programdata_common_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            env = {"PROGRAMDATA": temp_dir}
            expected = str(Path(temp_dir).joinpath(*pathwin.COMMON_RUNTIMES_SUBPATH) / "local-runtime")
            self.assertEqual(self._ensure(NON_ASCII_ROOT, alias_result=NON_ASCII_ROOT, env=env), expected)

    def test_alias_unavailable_env_override_gets_per_runtime_subdir(self) -> None:
        """MAW_RUNTIME_ASCII_ROOT 是公共运行时根：各 Runtime 占独立子目录，互不覆盖。"""
        with tempfile.TemporaryDirectory() as temp_dir:
            env = {"MAW_RUNTIME_ASCII_ROOT": temp_dir, "PROGRAMDATA": tempfile.gettempdir()}
            expected = str(Path(temp_dir) / "local-runtime")
            self.assertEqual(self._ensure(NON_ASCII_ROOT, alias_result=NON_ASCII_ROOT, env=env), expected)
            expected_ocr = str(Path(temp_dir) / "ocr-runtime")
            self.assertEqual(
                self._ensure(NON_ASCII_ROOT, dir_name="ocr-runtime", alias_result=NON_ASCII_ROOT, env=env),
                expected_ocr,
            )

    def test_unresolvable_fallback_keeps_original_path(self) -> None:
        # 无 PROGRAMDATA 也无 override：放弃迁移，交由 verify 错误增强给出指引
        env = {"MAW_RUNTIME_ASCII_ROOT": "", "PROGRAMDATA": ""}
        self.assertEqual(self._ensure(NON_ASCII_ROOT, alias_result=NON_ASCII_ROOT, env=env), NON_ASCII_ROOT)


class FallbackRootTests(unittest.TestCase):
    def test_env_override_wins_over_programdata_with_runtime_subdir(self) -> None:
        with tempfile.TemporaryDirectory() as override_dir, tempfile.TemporaryDirectory() as program_data:
            with mock.patch.dict(os.environ, {"MAW_RUNTIME_ASCII_ROOT": override_dir, "PROGRAMDATA": program_data}):
                self.assertEqual(pathwin.fallback_root("local-runtime"), Path(override_dir) / "local-runtime")
                self.assertEqual(pathwin.fallback_root("ocr-runtime"), Path(override_dir) / "ocr-runtime")

    def test_programdata_common_dir_layout(self) -> None:
        with tempfile.TemporaryDirectory() as program_data:
            with mock.patch.dict(os.environ, {"PROGRAMDATA": program_data}, clear=False):
                os.environ.pop("MAW_RUNTIME_ASCII_ROOT", None)
                expected = Path(program_data).joinpath(*pathwin.COMMON_RUNTIMES_SUBPATH) / "ocr-runtime"
                self.assertEqual(pathwin.fallback_root("ocr-runtime"), expected)

    def test_missing_programdata_raises_actionable_error(self) -> None:
        env = {"MAW_RUNTIME_ASCII_ROOT": "", "PROGRAMDATA": ""}
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaises(pathwin.AsciiRootUnavailable) as context:
                pathwin.fallback_root("local-runtime")
        self.assertIn(pathwin.FALLBACK_ROOT_ENV, str(context.exception))


class ProbeWritableTests(unittest.TestCase):
    def test_probe_creates_dir_and_cleans_up_probe_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "MAW" / "runtimes" / "local-runtime"
            pathwin.probe_writable(root)
            self.assertTrue(root.is_dir())
            self.assertFalse((root / ".maw-write-probe").exists())  # 探针文件已删

    @unittest.skipIf(WIN32_ONLY, "Windows 的 chmod 不阻止目录内建文件，无法这样模拟不可写")
    def test_permission_error_becomes_actionable_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            parent = Path(temp_dir) / "locked"
            parent.mkdir()
            os.chmod(parent, 0o500)  # r-x：非 root 用户不可写
            try:
                if hasattr(os, "geteuid") and os.geteuid() == 0:
                    self.skipTest("root 用户无视目录权限，无法模拟不可写")
                with self.assertRaises(pathwin.AsciiRootUnavailable) as context:
                    pathwin.probe_writable(parent / "child")
            finally:
                os.chmod(parent, 0o700)
        self.assertIn(pathwin.FALLBACK_ROOT_ENV, str(context.exception))


class PrepareInstallRootTests(unittest.TestCase):
    def test_only_fallback_form_is_probed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            candidate = Path(temp_dir) / "progdata" / "MAW" / "runtimes" / "local-runtime"
            alias_root = Path(temp_dir) / "short" / "local-runtime"
            with _win32_patches()[0]:
                with mock.patch.dict(os.environ, {"PROGRAMDATA": str(Path(temp_dir) / "progdata")}):
                    # 别名形态（candidate 不匹配）不探测，也不创建目录
                    with mock.patch.object(pathwin, "probe_writable") as probe:
                        self.assertEqual(pathwin.prepare_install_root(alias_root, dir_name="local-runtime"), alias_root)
                        self.assertFalse(alias_root.exists())
                    probe.assert_not_called()
                    # fallback 形态放行前真实探测（建目录 + 探针文件）
                    self.assertEqual(pathwin.prepare_install_root(candidate, dir_name="local-runtime"), candidate)
            self.assertTrue(candidate.is_dir())

    def test_probe_failure_raises_ascii_root_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            candidate = Path(temp_dir) / "progdata" / "MAW" / "runtimes" / "local-runtime"
            with _win32_patches()[0]:
                with mock.patch.dict(os.environ, {"PROGRAMDATA": str(Path(temp_dir) / "progdata")}):
                    with mock.patch.object(
                        pathwin, "probe_writable",
                        side_effect=pathwin.AsciiRootUnavailable("不可写（模拟）"),
                    ):
                        with self.assertRaises(pathwin.AsciiRootUnavailable):
                            pathwin.prepare_install_root(candidate, dir_name="local-runtime")


class AsciiPathFailureHintTests(unittest.TestCase):
    def test_hint_includes_self_rescue_and_feedback_for_non_ascii_path(self) -> None:
        with _win32_patches()[0]:
            hint = pathwin.ascii_path_failure_hint(Path(NON_ASCII_ROOT))
        self.assertIn("非 ASCII", hint)
        self.assertIn("纯英文路径", hint)  # 对显式配置用户有效的主出路
        self.assertIn(pathwin.FALLBACK_ROOT_ENV, hint)
        self.assertIn(pathwin.ISSUE_FEEDBACK_URL, hint)

    def test_ascii_path_gets_no_hint(self) -> None:
        with _win32_patches()[0]:
            self.assertEqual(pathwin.ascii_path_failure_hint(Path(ASCII_ROOT)), "")


class Win32RealApiSmokeTests(unittest.TestCase):
    """真实 GetShortPathNameW 冒烟：只在 Windows 上执行（CI 与维护者本机）。"""

    @unittest.skipUnless(WIN32_ONLY, "真实 Windows API 冒烟")
    def test_existing_temp_dir_converts_and_points_to_same_dir(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            converted = pathwin.win32_get_short_path(temp_dir)
            self.assertTrue(os.path.exists(converted))
            # resolve 会把 8.3 短名展开回长路径：转换前后必须同一目录
            self.assertEqual(Path(converted).resolve(), Path(temp_dir).resolve())


if __name__ == "__main__":
    unittest.main()
