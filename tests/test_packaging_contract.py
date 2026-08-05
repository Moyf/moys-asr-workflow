from __future__ import annotations

import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


class PackagingContractTests(unittest.TestCase):
    def test_pyinstaller_build_dependency_is_locked_outside_runtime_dependencies(self) -> None:
        """Given packaging needs PyInstaller, When metadata is read, Then build deps are locked."""
        pyproject = read_text("pyproject.toml")
        lockfile = read_text("uv.lock")

        self.assertIsNone(re.search(r'(?s)dependencies = \[[^\]]*"pyinstaller', pyproject))
        self.assertRegex(pyproject, r'(?s)\[dependency-groups\].*build = \[[^\]]*"pyinstaller==6\.16\.0"')
        self.assertIn('name = "pyinstaller"', lockfile)

    def test_gitignore_keeps_local_windows_bundle_and_generated_build_state_untracked(self) -> None:
        """Given local EXE builds are retained, When ignore rules are read, Then binaries stay local."""
        ignored_paths = set(read_text(".gitignore").splitlines())

        self.assertIn("/dist/", ignored_paths)
        self.assertIn("/build/", ignored_paths)
        self.assertIn("*.spec.bak", ignored_paths)
        self.assertIn("*.exe", ignored_paths)
        self.assertIn("!MAW.spec", ignored_paths)
        self.assertIn("/dist/MAW/MAW.exe", ignored_paths)

    def test_spec_packages_full_gui_resources_without_sensitive_or_heavy_outputs(self) -> None:
        """Given the Windows GUI bundle, When MAW.spec is read, Then it is onedir/windowed/noupx."""
        spec = read_text("MAW.spec")

        self.assertIn("maw_gui.py", spec)
        self.assertIn("name='MAW'", spec)
        self.assertIn("console=False", spec)
        self.assertIn("upx=False", spec)
        self.assertIn("maw.gui_web", spec)
        self.assertNotIn("sv_ttk", spec)
        self.assertIn("generate_subtitle_qwen_api", spec)
        self.assertIn("generate_subtitle_soniox_api", spec)
        self.assertIn("maw.soniox", spec)
        self.assertIn("assets", spec)
        self.assertIn("maw.ico", spec)
        self.assertIn("show.webp", spec)
        self.assertIn("icon=str(ROOT / 'assets' / 'maw.ico')", spec)
        self.assertIn("COLLECT(", spec)
        self.assertNotIn("onefile=True", spec)
        for bundled_path in ("web", "server-editor", "LICENSE", "THIRD_PARTY_NOTICES.md"):
            self.assertIn(bundled_path, spec)
        for excluded_path in (".env", "node_modules", "tests", "ffmpeg", "*.mp4", "*.srt"):
            self.assertIn(excluded_path, spec)

    def test_local_build_script_invokes_uv_and_pyinstaller_for_maw_onedir(self) -> None:
        """Given a Windows developer build, When the script is read, Then it builds dist/MAW/MAW.exe."""
        script = read_text("scripts/build-windows.ps1")

        self.assertIn("uv sync --group build --frozen", script)
        self.assertIn("uv run --group build pyinstaller", script)
        self.assertIn("MAW.spec", script)
        self.assertIn("dist\\MAW\\MAW.exe", script)
        self.assertIn("npm run tauri -- build", script)
        self.assertIn("desktop\\src-tauri\\target\\release\\mose.exe", script)
        self.assertIn("dist\\MAW\\MOSE.exe", script)
        self.assertIn("$ErrorActionPreference = 'Stop'", script)

    def test_release_workflow_is_tag_triggered_and_publishes_both_windows_packages(self) -> None:
        """Given a v* tag push, When workflow is read, Then it releases standard and MAWxFF builds."""
        workflow = read_text(".github/workflows/release-windows.yml")

        self.assertRegex(workflow, re.compile(r"on:\s+push:\s+tags:\s+- 'v\*'", re.MULTILINE))
        self.assertIn("windows-2022", workflow)
        self.assertIn("actions/setup-node@v4", workflow)
        self.assertIn("dtolnay/rust-toolchain@stable", workflow)
        self.assertIn("uv sync --group build --frozen", workflow)
        self.assertIn("tests/test_packaging_contract.py", workflow)
        self.assertIn("pyproject.toml", workflow)
        self.assertIn("github.ref_name", workflow)
        self.assertIn(r'(?m)^version = "(?<version>[^"]+)"\r?$', workflow)
        self.assertIn("PYTHONUTF8: '1'", workflow)
        self.assertIn("dist\\MAW\\MAW.exe", workflow)
        self.assertIn("dist\\MAW\\MOSE.exe", workflow)
        self.assertIn("Compress-Archive", workflow)
        self.assertIn("Get-FileHash", workflow)
        self.assertIn("$FfmpegVersion = '8.1.2'", workflow)
        self.assertIn("ffmpeg-$FfmpegVersion-essentials_build.zip", workflow)
        self.assertIn("db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec", workflow)
        self.assertIn("ffmpeg.exe", workflow)
        self.assertIn("ffprobe.exe", workflow)
        self.assertNotIn("ffplay.exe", workflow)
        self.assertIn("MAWxFF-Windows-x64-${{ github.ref_name }}.zip", workflow)
        self.assertIn("actions/upload-artifact@v4", workflow)
        self.assertIn("softprops/action-gh-release@v2", workflow)
        self.assertIn("target_commitish: ${{ github.sha }}", workflow)
        self.assertIn("GITHUB_TOKEN: ${{ github.token }}", workflow)

    def test_mose_uses_maw_icon_and_declares_mosp_association(self) -> None:
        config = read_text("desktop/src-tauri/tauri.conf.json")

        self.assertIn('"../../assets/maw.ico"', config)
        self.assertIn('"ext": ["mosp"]', config)


if __name__ == "__main__":
    _ = unittest.main()
