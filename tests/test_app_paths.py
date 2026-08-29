from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from maw import app_paths


class AppPathsTests(unittest.TestCase):
    def test_windows_user_data_paths_share_the_maw_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            local_app_data = Path(temp_dir) / "LocalAppData"
            with mock.patch.object(app_paths.sys, "platform", "win32"), mock.patch.dict(
                os.environ,
                {"LOCALAPPDATA": str(local_app_data), "MAW_APP_DATA_ROOT": ""},
                clear=True,
            ):
                root = app_paths.default_app_data_root()

                self.assertEqual(root, local_app_data / "MAW")
                self.assertEqual(app_paths.default_log_directory(), root / "logs")
                self.assertEqual(app_paths.default_emoji_font_path(), root / "NotoColorEmoji.ttf")
                self.assertEqual(app_paths.default_server_settings_path(), root / "server-editor-settings.json")

    def test_macos_user_data_root_uses_maw_application_support(self) -> None:
        with mock.patch.object(app_paths.sys, "platform", "darwin"), mock.patch.object(
            app_paths.Path, "home", return_value=Path("/Users/test-user")
        ), mock.patch.dict(os.environ, {"MAW_APP_DATA_ROOT": ""}, clear=True):
            self.assertEqual(
                app_paths.default_app_data_root(),
                Path("/Users/test-user") / "Library" / "Application Support" / "MAW",
            )

    def test_linux_user_data_root_uses_xdg_data_home(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch.object(app_paths.sys, "platform", "linux"), mock.patch.dict(
            os.environ,
            {"XDG_DATA_HOME": temp_dir, "MAW_APP_DATA_ROOT": ""},
            clear=True,
        ):
            self.assertEqual(app_paths.default_app_data_root(), Path(temp_dir) / "MAW")

    def test_source_env_stays_at_repository_root(self) -> None:
        with mock.patch.object(app_paths.sys, "frozen", False, create=True), mock.patch.dict(
            os.environ, {"MAW_ENV_FILE": ""}, clear=False
        ):
            self.assertEqual(app_paths.default_env_path(), app_paths.SOURCE_ROOT / ".env")

    def test_frozen_env_prefers_file_beside_executable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app_dir = Path(temp_dir) / "MAW"
            app_dir.mkdir()
            adjacent = app_dir / ".env"
            adjacent.write_text("CONFIG_SOURCE=adjacent\n", encoding="utf-8")
            with mock.patch.object(app_paths.sys, "platform", "win32"), mock.patch.object(
                app_paths.sys, "frozen", True, create=True
            ), mock.patch.object(app_paths.sys, "executable", str(app_dir / "MAW.exe")), mock.patch.dict(
                os.environ,
                {"LOCALAPPDATA": str(Path(temp_dir) / "LocalAppData"), "MAW_ENV_FILE": ""},
                clear=True,
            ):
                self.assertEqual(app_paths.default_env_path(), adjacent.resolve())

    def test_frozen_env_falls_back_to_shared_root_and_honors_child_override(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            app_dir = Path(temp_dir) / "MAW"
            app_dir.mkdir()
            local_app_data = Path(temp_dir) / "LocalAppData"
            override = Path(temp_dir) / "explicit.env"
            with mock.patch.object(app_paths.sys, "platform", "win32"), mock.patch.object(
                app_paths.sys, "frozen", True, create=True
            ), mock.patch.object(app_paths.sys, "executable", str(app_dir / "MAW.exe")), mock.patch.dict(
                os.environ,
                {"LOCALAPPDATA": str(local_app_data), "MAW_ENV_FILE": ""},
                clear=True,
            ):
                self.assertEqual(app_paths.default_env_path(), (local_app_data / "MAW" / ".env").resolve())
                os.environ["MAW_ENV_FILE"] = str(override)
                self.assertEqual(app_paths.default_env_path(), override.resolve())

    def test_legacy_server_settings_path_keeps_old_namespace_for_fallback(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            local_app_data = Path(temp_dir) / "LocalAppData"
            with mock.patch.object(app_paths.sys, "platform", "win32"), mock.patch.dict(
                os.environ,
                {"LOCALAPPDATA": str(local_app_data), "MAW_APP_DATA_ROOT": ""},
                clear=True,
            ):
                self.assertEqual(
                    app_paths.legacy_server_settings_path(),
                    local_app_data / "Moy" / "moys-asr-workflow" / "server-editor-settings.json",
                )


if __name__ == "__main__":
    unittest.main()
