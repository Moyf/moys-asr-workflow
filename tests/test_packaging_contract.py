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
        self.assertIn("generate_subtitle_bcut_api", spec)
        self.assertIn("maw.soniox", spec)
        self.assertIn("maw.bcut", spec)
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

    def test_macos_bundle_uses_the_icns_app_icon(self) -> None:
        """Given a macOS app bundle, When PyInstaller builds it, Then the bundle has the branded ICNS icon."""
        spec = read_text("MAW.spec")
        workflow = read_text(".github/workflows/build-macos.yml")
        icon = (ROOT / "assets" / "maw.icns").read_bytes()

        self.assertIn("icon=str(ROOT / 'assets' / 'maw.icns')", spec)
        self.assertNotIn("icon=None", spec)
        self.assertIn("scripts/build_macos_icon.py --check", workflow)
        self.assertTrue(icon.startswith(b"icns"))
        self.assertEqual(int.from_bytes(icon[4:8], "big"), len(icon))
        self.assertIn(b"ic07", icon)
        self.assertIn(b"ic08", icon)

    def test_macos_release_workflow_publishes_standard_and_xff_archives_without_checksums(self) -> None:
        """Given a macOS arm64 release, When packaging runs, Then both app variants are uploaded without checksum assets."""
        workflow = read_text(".github/workflows/build-macos.yml")

        self.assertIn("runs-on: macos-14", workflow)
        self.assertIn("architecture: arm64", workflow)
        self.assertIn("https://www.osxexperts.net/ffmpeg81arm.zip", workflow)
        self.assertIn("https://www.osxexperts.net/ffprobe81arm.zip", workflow)
        self.assertIn("actions/setup-node@v4", workflow)
        self.assertIn("dtolnay/rust-toolchain@stable", workflow)
        self.assertIn("npm ci", workflow)
        self.assertIn("cargo check --manifest-path src-tauri/Cargo.toml", workflow)
        self.assertIn("tauri.macos.conf.json", workflow)
        self.assertIn("npm run tauri -- build --config src-tauri/tauri.macos.conf.json --bundles app --no-sign", workflow)
        self.assertIn("desktop/src-tauri/target/release/bundle/macos/MOSE.app", workflow)
        self.assertIn("MOSE.app/Contents/MacOS/mose", workflow)
        self.assertIn("codesign --verify --deep --strict --verbose=2 \"$MoseApp\"", workflow)
        self.assertIn("ditto dist/MOSE.app", workflow)
        self.assertIn("ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad", workflow)
        self.assertIn("a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1", workflow)
        self.assertIn("MAWxFF.app/Contents/MacOS/ffmpeg/bin", workflow)
        self.assertIn("codesign --force --deep --sign - dist/MAWxFF.app", workflow)
        self.assertIn("MAW-macOS-arm64-${Version}.zip", workflow)
        self.assertIn("MAWxFF-macOS-arm64-${Version}.zip", workflow)
        self.assertIn('StandardStage="build/release/standard"', workflow)
        self.assertIn('XffStage="build/release/xff"', workflow)
        self.assertIn('zip -qry "$GITHUB_WORKSPACE/$StandardArchive" MAW.app MOSE.app', workflow)
        self.assertIn("unzip -l \"$StandardArchive\" | grep -q 'MOSE.app/Contents/MacOS/mose'", workflow)
        self.assertIn("MAWxFF-macOS-arm64-*.zip", workflow)
        self.assertNotIn(".zip.sha256", workflow)

    def test_local_build_script_invokes_uv_and_pyinstaller_for_maw_onedir(self) -> None:
        """Given a Windows developer build, When the script is read, Then it builds dist/MAW/MAW.exe."""
        script = read_text("scripts/build-windows.ps1")

        self.assertIn("uv sync --group build --frozen", script)
        self.assertIn("uv run --group build pyinstaller", script)
        self.assertIn("MAW.spec", script)
        self.assertIn("dist\\MAW\\MAW.exe", script)
        self.assertIn("cargo check --manifest-path", script)
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
        self.assertIn("https://github.com/GyanD/codexffmpeg/releases/download", workflow)
        self.assertIn("for ($attempt = 1; $attempt -le 3; $attempt++)", workflow)
        self.assertIn("Start-Sleep -Seconds 10", workflow)
        self.assertIn("$DownloadedUrl", workflow)
        self.assertIn("db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec", workflow)
        self.assertIn("ffmpeg.exe", workflow)
        self.assertIn("ffprobe.exe", workflow)
        self.assertNotIn("ffplay.exe", workflow)
        self.assertIn("MAWxFF-Windows-x64-${{ github.ref_name }}.zip", workflow)
        self.assertIn("actions/upload-artifact@v4", workflow)
        self.assertIn("softprops/action-gh-release@v2", workflow)
        self.assertIn("target_commitish: ${{ github.sha }}", workflow)
        self.assertIn("GITHUB_TOKEN: ${{ github.token }}", workflow)
        self.assertNotIn(".zip.sha256", workflow)

    def test_mose_uses_its_dedicated_icons_and_declares_mosp_association(self) -> None:
        config = read_text("desktop/src-tauri/tauri.conf.json")
        cargo = read_text("desktop/src-tauri/Cargo.toml")
        macos_config = read_text("desktop/src-tauri/tauri.macos.conf.json")
        package_json = read_text("desktop/package.json")
        capabilities = read_text("desktop/src-tauri/capabilities/default.json")
        bridge = read_text("desktop/src-tauri/src/tauri_bridge.js")
        rust = read_text("desktop/src-tauri/src/lib.rs")
        server = read_text("desktop/src-tauri/src/server.rs")
        gui = read_text("maw/gui_web.py")
        icon_png = (ROOT / "assets" / "MOSE-icon.png").read_bytes()
        icon_ico = (ROOT / "desktop" / "src-tauri" / "icons" / "icon.ico").read_bytes()
        icon_icns = (ROOT / "desktop" / "src-tauri" / "icons" / "icon.icns").read_bytes()

        self.assertIn('"icons/icon.ico"', config)
        self.assertIn('"icons/icon.icns"', config)
        self.assertIn('"icons/32x32.png"', config)
        self.assertIn('"icons/128x128.png"', config)
        self.assertIn('"icons/128x128@2x.png"', config)
        self.assertIn('"icons": "tauri icon ../assets/MOSE-icon.png -o src-tauri/icons"', package_json)
        self.assertTrue(icon_png.startswith(b"\x89PNG\r\n\x1a\n"))
        self.assertEqual(icon_png[16:24], (500).to_bytes(4, "big") * 2)
        self.assertEqual(icon_ico[:4], b"\x00\x00\x01\x00")
        self.assertTrue(icon_icns.startswith(b"icns"))
        self.assertIn('"ext": ["mosp"]', config)
        self.assertIn('"dragDropEnabled": true', config)
        self.assertIn('"assetProtocol"', config)
        self.assertIn('"enable": true', config)
        self.assertIn("default-src 'self'", config)
        self.assertIn("connect-src 'self' ipc: http://ipc.localhost", config)
        self.assertIn("img-src 'self' data: asset: blob:", config)
        self.assertIn("media-src 'self' asset: blob:", config)
        self.assertNotIn('"csp": null', config)
        self.assertIn('features = ["protocol-asset"]', cargo)
        self.assertIn('tauri-plugin-single-instance = "2"', cargo)
        self.assertNotIn('"shell:allow-execute"', capabilities)
        self.assertIn('"dialog:default"', capabilities)
        self.assertIn("icon = executable", gui)
        self.assertIn("SHChangeNotify", gui)
        self.assertIn("project_paths_from_args", rust)
        self.assertIn("tauri_plugin_single_instance::init", rust)
        self.assertIn("queue_project_path", rust)
        self.assertIn("take_initial_project_path", rust)
        self.assertIn("RunEvent::Opened", rust)
        self.assertIn('cfg(any(target_os = "macos"', rust)
        self.assertIn("to_file_path", rust)
        self.assertIn('app_handle.emit("open-file"', rust)
        self.assertIn('"Library"', server)
        self.assertIn('"Application Support"', server)
        self.assertIn("atomic_write", server)
        self.assertIn("MoveFileExW", server)
        self.assertIn("sync_all", server)
        self.assertIn("allow_directory", server)
        self.assertIn('app.state::<tauri::scope::Scopes>()', server)
        self.assertIn('.allow_file(&playback)', server)
        self.assertNotIn("media_file_url", server)
        self.assertNotIn('"url": media_file_url', server)
        self.assertIn('convertFileSrc', bridge)
        self.assertIn('confirmProjectReplacement', bridge)
        self.assertIn('window.confirm', bridge)
        self.assertIn('requestExternalProject', bridge)
        self.assertIn('playbackPath', bridge)
        self.assertIn("take_initial_project_path", bridge)
        self.assertIn("tauri://drag-drop", bridge)
        self.assertIn("document.getElementById('drag-overlay')", bridge)
        self.assertNotIn("if (dragOverlay) dragOverlay", bridge)
        self.assertIn("openProjectAtPath(projectPath)", bridge)
        self.assertNotIn('"externalBin"', config)
        self.assertIn('"active": true', macos_config)
        self.assertIn('"targets": ["app"]', macos_config)

    def test_pr_release_workflow_builds_only_the_no_ffmpeg_windows_preview(self) -> None:
        """Given a pull request, When packaging runs, Then only a read-only standard ZIP is uploaded."""
        workflow = read_text(".github/workflows/pr-release-windows.yml")

        self.assertRegex(workflow, re.compile(r"on:\s+pull_request:", re.MULTILINE))
        self.assertIn("windows-2022", workflow)
        self.assertIn("permissions:\n  contents: read", workflow)
        self.assertIn("actions/setup-node@v4", workflow)
        self.assertIn("dtolnay/rust-toolchain@stable", workflow)
        self.assertIn("ref: ${{ github.event.pull_request.head.sha || github.sha }}", workflow)
        self.assertIn("uv sync --group build --frozen", workflow)
        self.assertIn("scripts\\build-windows.ps1 -SkipTests", workflow)
        self.assertIn("dist\\MAW\\MAW.exe", workflow)
        self.assertIn("dist\\MAW\\MOSE.exe", workflow)
        self.assertIn("Verify no FFmpeg is bundled", workflow)
        self.assertIn("Compress-Archive", workflow)
        self.assertIn("actions/upload-artifact@v4", workflow)
        self.assertIn("retention-days: 14", workflow)
        self.assertIn("MAW-Windows-x64-pr-", workflow)
        self.assertNotIn(".zip.sha256", workflow)
        self.assertIn("persist-credentials: false", workflow)
        self.assertNotIn("MAWxFF", workflow)
        self.assertNotIn("softprops/action-gh-release", workflow)

    def test_pr_release_comment_workflow_updates_the_pr_with_the_run_link(self) -> None:
        """Given a completed PR package run, When the comment workflow runs, Then it updates one PR comment."""
        workflow = read_text(".github/workflows/pr-release-comment.yml")

        self.assertIn("workflow_run:", workflow)
        self.assertIn("workflows: [Preview Windows Release]", workflow)
        self.assertIn("types: [completed]", workflow)
        self.assertIn("pull-requests: write", workflow)
        self.assertIn("actions/github-script@v7", workflow)
        self.assertIn("maw-windows-pr-release", workflow)
        self.assertIn("issues.updateComment", workflow)
        self.assertIn("issues.createComment", workflow)
        self.assertIn("run.html_url", workflow)


if __name__ == "__main__":
    _ = unittest.main()
