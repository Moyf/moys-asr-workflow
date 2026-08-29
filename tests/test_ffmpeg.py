from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import maw.ffmpeg as ffmpeg_module
from maw.ffmpeg import FfmpegTools, ffmpeg_search_path, resolve_ffmpeg_tool, resolve_ffmpeg_tools


class FfmpegResolverTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @staticmethod
    def _tool_path(directory: Path, tool: str) -> Path:
        suffix = ".exe" if os.name == "nt" else ""
        return directory / f"{tool}{suffix}"

    def _write_tools(self, directory: Path, *tools: str) -> dict[str, Path]:
        directory.mkdir(parents=True, exist_ok=True)
        result: dict[str, Path] = {}
        for tool in tools:
            path = self._tool_path(directory, tool)
            path.write_bytes(tool.encode("ascii"))
            if os.name != "nt":
                path.chmod(path.stat().st_mode | 0o111)
            result[tool] = path
        return result

    def test_explicit_configuration_precedes_environment_and_path(self) -> None:
        configured = self._write_tools(self.root / "configured", "ffmpeg", "ffprobe")
        environment_configured = self._write_tools(self.root / "environment", "ffmpeg", "ffprobe")
        from_path = self._write_tools(self.root / "path", "ffmpeg", "ffprobe")

        result = resolve_ffmpeg_tools(
            configured_path=self.root / "configured",
            environment={"FFMPEG_PATH": str(self.root / "environment"), "PATH": str(self.root / "path")},
            include_bundled=False,
            include_macos=False,
        )

        self.assertEqual(result, FfmpegTools(configured["ffmpeg"].resolve(), configured["ffprobe"].resolve()))
        self.assertNotEqual(result.ffmpeg, environment_configured["ffmpeg"].resolve())
        self.assertNotEqual(result.ffprobe, from_path["ffprobe"].resolve())

    def test_environment_ffmpeg_path_precedes_plain_path(self) -> None:
        configured = self._write_tools(self.root / "environment", "ffmpeg", "ffprobe")
        from_path = self._write_tools(self.root / "path", "ffmpeg", "ffprobe")

        result = resolve_ffmpeg_tools(
            environment={"FFMPEG_PATH": str(self.root / "environment"), "PATH": str(self.root / "path")},
            include_bundled=False,
            include_macos=False,
        )

        self.assertEqual(result.ffmpeg, configured["ffmpeg"].resolve())
        self.assertEqual(result.ffprobe, configured["ffprobe"].resolve())
        self.assertNotEqual(result.ffmpeg, from_path["ffmpeg"].resolve())

    def test_each_tool_can_fall_back_when_configured_directory_is_partial(self) -> None:
        configured = self._write_tools(self.root / "configured", "ffmpeg")
        from_path = self._write_tools(self.root / "path", "ffmpeg", "ffprobe")

        result = resolve_ffmpeg_tools(
            configured_path=self.root / "configured",
            environment={"PATH": str(self.root / "path")},
            include_bundled=False,
            include_macos=False,
        )

        self.assertEqual(result.ffmpeg, configured["ffmpeg"].resolve())
        self.assertEqual(result.ffprobe, from_path["ffprobe"].resolve())

    def test_bundled_tools_precede_plain_path(self) -> None:
        bundled = self._write_tools(self.root / "bundle", "ffmpeg", "ffprobe")
        from_path = self._write_tools(self.root / "path", "ffmpeg", "ffprobe")

        result = resolve_ffmpeg_tools(
            environment={"PATH": str(self.root / "path")},
            bundled_directories=(self.root / "bundle",),
            include_macos=False,
        )

        self.assertEqual(result.ffmpeg, bundled["ffmpeg"].resolve())
        self.assertEqual(result.ffprobe, bundled["ffprobe"].resolve())
        self.assertNotEqual(result.ffmpeg, from_path["ffmpeg"].resolve())

    def test_empty_path_does_not_search_host_or_current_directory(self) -> None:
        with mock.patch.object(ffmpeg_module.shutil, "which", return_value=str(self.root / "unexpected")) as which:
            result = resolve_ffmpeg_tools(
                environment={"PATH": ""},
                platform="darwin",
                macos_directories=(self.root / "homebrew",),
                include_bundled=False,
                include_macos=False,
            )

        self.assertEqual(result, FfmpegTools())
        which.assert_not_called()

    def test_macos_candidates_are_added_to_search_path_and_resolved(self) -> None:
        homebrew = self._write_tools(self.root / "homebrew", "ffmpeg", "ffprobe")
        expanded = ffmpeg_search_path(
            "/usr/bin",
            platform="darwin",
            macos_directories=(self.root / "homebrew",),
        )

        self.assertIsNotNone(expanded)
        self.assertIn(str(self.root / "homebrew"), str(expanded).split(os.pathsep))
        result = resolve_ffmpeg_tools(
            environment={"PATH": ""},
            platform="darwin",
            macos_directories=(self.root / "homebrew",),
            include_bundled=False,
        )
        self.assertEqual(result.ffmpeg, homebrew["ffmpeg"].resolve())
        self.assertEqual(result.ffprobe, homebrew["ffprobe"].resolve())

    def test_frozen_bundle_is_checked_beside_launcher_executable(self) -> None:
        executable = self.root / "MAW.exe"
        executable.write_bytes(b"launcher")
        bundled = self._write_tools(self.root / "ffmpeg" / "bin", "ffmpeg", "ffprobe")

        with mock.patch.object(ffmpeg_module.sys, "frozen", True, create=True):
            with mock.patch.object(ffmpeg_module.sys, "executable", str(executable)):
                result = resolve_ffmpeg_tools(
                    environment={"PATH": ""},
                    include_macos=False,
                )

        self.assertEqual(result.ffmpeg, bundled["ffmpeg"].resolve())
        self.assertEqual(result.ffprobe, bundled["ffprobe"].resolve())

    def test_strict_configuration_does_not_fall_back_to_path(self) -> None:
        from_path = self._write_tools(self.root / "path", "ffmpeg", "ffprobe")
        missing = self.root / "missing"

        result = resolve_ffmpeg_tools(
            configured_path=missing,
            environment={"PATH": str(self.root / "path")},
            include_bundled=False,
            include_macos=False,
            strict_config=True,
        )

        self.assertEqual(result, FfmpegTools())
        self.assertNotEqual(result.ffmpeg, from_path["ffmpeg"].resolve())

    def test_explicit_missing_tool_can_be_returned_for_process_error(self) -> None:
        missing = self.root / "missing" / self._tool_path(Path("."), "ffmpeg").name

        result = resolve_ffmpeg_tool(
            "ffmpeg",
            missing,
            environment={"PATH": ""},
            include_bundled=False,
            include_macos=False,
            allow_missing_explicit=True,
        )

        self.assertEqual(result, missing)


if __name__ == "__main__":
    unittest.main()
