from __future__ import annotations

import ast
import re
import tomllib
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def _local_module_path(module_name: str) -> Path | None:
    module_path = ROOT / (module_name.replace(".", "/") + ".py")
    if module_path.is_file():
        return module_path
    package_path = ROOT / module_name.replace(".", "/") / "__init__.py"
    return package_path if package_path.is_file() else None


def _local_import_modules(path: Path, module_name: str) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    imported: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                if _local_module_path(alias.name):
                    imported.add(alias.name)
            continue
        if not isinstance(node, ast.ImportFrom):
            continue
        if node.level:
            base = module_name.split(".")[:-node.level]
            if node.module:
                base.extend(node.module.split("."))
            candidate = ".".join(base)
        else:
            candidate = node.module or ""
        if candidate and _local_module_path(candidate):
            imported.add(candidate)
            continue
        for alias in node.names:
            child = f"{candidate}.{alias.name}" if candidate else alias.name
            if _local_module_path(child):
                imported.add(child)
    return imported


def _local_runtime_import_graph() -> set[str]:
    modules = {"maw.local_runtime_worker", "generate_subtitle_local"}
    pending = list(modules)
    while pending:
        module_name = pending.pop()
        path = _local_module_path(module_name)
        if path is None:
            continue
        for imported in _local_import_modules(path, module_name):
            if imported not in modules:
                modules.add(imported)
                pending.append(imported)
    return modules


def _local_runtime_spec_entry(relative_path: str) -> str:
    parts = Path(relative_path).parts
    expression = " / ".join(["ROOT", *(f'"{part}"' for part in parts)])
    target = "local-runtime/maw" if parts[0] == "maw" else "local-runtime"
    return f"(str({expression}), \"{target}\")"


class PackagingContractTests(unittest.TestCase):
    def test_launcher_version_matches_project_metadata(self) -> None:
        """Given project metadata, When the Launcher is packaged, Then every displayed fallback version matches it."""
        project = tomllib.loads(read_text("pyproject.toml"))
        version = project["project"]["version"]
        launcher_html = read_text("web/launcher/index.html")
        launcher_js = read_text("web/launcher/launcher.js")
        gui = read_text("maw/gui_web.py")
        editor = read_text("edit.py")

        self.assertIn(f'id="appVersion">v{version}</span>', launcher_html)
        self.assertIn(f'appVersion: "{version}"', launcher_js)
        self.assertIn(f'BUNDLED_APP_VERSION = "{version}"', gui)
        self.assertIn(f'BUNDLED_EDITOR_VERSION = "{version}"', editor)

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
        self.assertIn("maw.cli", spec)
        self.assertIn('collect_all("rapidocr")', spec)
        self.assertIn('collect_all("onnxruntime")', spec)
        self.assertIn('binaries=binaries', spec)
        self.assertIn("pp-ocrv6_det_small.onnx", spec.lower())
        for module in (
            "maw.postprocess",
            "maw.postprocess_io",
            "maw.postprocess_llm",
            "maw.postprocess_ffmpeg",
            "maw.postprocess_match",
            "maw.postprocess_ocr",
        ):
            self.assertIn(module, spec)
        self.assertNotIn("sv_ttk", spec)
        self.assertIn("generate_subtitle_qwen_api", spec)
        self.assertIn("generate_subtitle_soniox_api", spec)
        self.assertIn("generate_subtitle_bcut_api", spec)
        self.assertIn("maw.soniox", spec)
        self.assertIn("local-runtime", spec)
        self.assertIn("local_runtime_worker.py", spec)
        self.assertIn("maw.bcut", spec)
        self.assertIn("assets", spec)
        self.assertIn("maw.ico", spec)
        self.assertIn("show.webp", spec)
        self.assertIn("icon=str(ROOT / 'assets' / 'maw.ico')", spec)
        self.assertIn("COLLECT(", spec)
        self.assertNotIn("onefile=True", spec)
        for bundled_path in ("web", "server-editor", "LICENSE", "THIRD_PARTY_NOTICES.md"):
            self.assertIn(bundled_path, spec)
        for excluded_module in ("funasr", "qwen_asr", "torch", "torchaudio"):
            self.assertIn(f'"{excluded_module}"', spec)
        self.assertNotIn('"*.mp4"', spec)
        self.assertNotIn('"*.srt"', spec)

    def test_local_runtime_bundles_every_local_import_dependency(self) -> None:
        """Given local ASR entrypoints, When packaging is read, Then their local imports are copied beside them."""
        spec = read_text("MAW.spec")
        bundled_paths = {
            str(_local_module_path(module).relative_to(ROOT)).replace("\\", "/")
            for module in _local_runtime_import_graph()
            if _local_module_path(module) is not None
        }

        self.assertIn("maw/qwen_audio.py", bundled_paths)
        for relative_path in sorted(bundled_paths):
            self.assertIn(_local_runtime_spec_entry(relative_path), spec)

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

    def test_macos_release_workflow_publishes_maw_archives_without_mose_or_checksums(self) -> None:
        """Given a macOS arm64 release, When packaging runs, Then only MAW app variants are uploaded."""
        workflow = read_text(".github/workflows/build-macos.yml")

        self.assertIn("runs-on: macos-14", workflow)
        self.assertIn("architecture: arm64", workflow)
        self.assertIn("https://www.osxexperts.net/ffmpeg81arm.zip", workflow)
        self.assertIn("https://www.osxexperts.net/ffprobe81arm.zip", workflow)
        self.assertNotIn("MOSE", workflow)
        self.assertNotIn("actions/setup-node@v4", workflow)
        self.assertNotIn("dtolnay/rust-toolchain@stable", workflow)
        self.assertNotIn("cargo check --manifest-path src-tauri/Cargo.toml", workflow)

    def test_tag_release_workflows_use_idempotent_release_uploads(self) -> None:
        """Given all platform workflows publish one tag release, When they run, Then they use idempotent gh CLI uploads."""
        for workflow_path in (
            ".github/workflows/release-windows.yml",
            ".github/workflows/build-macos.yml",
            ".github/workflows/release-linux.yml",
        ):
            workflow = read_text(workflow_path)
            self.assertIn("gh release upload", workflow)
            self.assertIn("--clobber", workflow)
        # macOS-specific assertions
        macos_workflow = read_text(".github/workflows/build-macos.yml")
        self.assertNotIn("tauri.macos.conf.json", macos_workflow)
        self.assertIn("ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad", macos_workflow)
        self.assertIn("a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1", macos_workflow)
        self.assertIn("MAWxFF.app/Contents/MacOS/ffmpeg/bin", macos_workflow)
        self.assertIn("codesign --force --deep --sign - dist/MAWxFF.app", macos_workflow)
        self.assertIn("MAW-macOS-arm64-${Version}.zip", macos_workflow)
        self.assertIn("MAWxFF-macOS-arm64-${Version}.zip", macos_workflow)
        self.assertIn("scripts/sync_launcher_version.py --write", macos_workflow)
        self.assertIn("scripts/sync_launcher_version.py --check", macos_workflow)
        self.assertIn('StandardStage="build/release/standard"', macos_workflow)
        self.assertIn('XffStage="build/release/xff"', macos_workflow)
        self.assertIn('zip -qry "$GITHUB_WORKSPACE/$StandardArchive" MAW.app', macos_workflow)
        self.assertIn('zip -qry "$GITHUB_WORKSPACE/$XffArchive" MAWxFF.app', macos_workflow)
        self.assertNotIn("MOSE.app", macos_workflow)
        self.assertIn("MAWxFF-macOS-arm64-*.zip", macos_workflow)
        self.assertNotIn(".zip.sha256", macos_workflow)

    def test_local_build_script_invokes_uv_and_pyinstaller_for_maw_onedir(self) -> None:
        """Given a Windows developer build, When the script is read, Then it builds dist/MAW/MAW.exe."""
        script = read_text("scripts/build-windows.ps1")

        self.assertIn("uv sync --group build --frozen", script)
        self.assertIn("uv run --group build pyinstaller", script)
        self.assertIn("MAW.spec", script)
        self.assertIn("dist\\MAW\\MAW.exe", script)
        self.assertNotIn("cargo check --manifest-path", script)
        self.assertNotIn("npm run tauri -- build", script)
        self.assertNotIn("desktop", script)
        self.assertNotIn("MOSE", script)
        self.assertIn("bootstrap", script)
        self.assertIn("uv.exe", script)
        self.assertIn("$ErrorActionPreference = 'Stop'", script)

    def test_windows_preview_workflow_verifies_launcher_version(self) -> None:
        """Given a Windows preview build, When packaging starts, Then stale Launcher versions fail early."""
        workflow = read_text(".github/workflows/pr-release-windows.yml")

        self.assertIn("scripts/sync_launcher_version.py --check", workflow)

    def test_release_workflow_is_tag_triggered_and_publishes_both_windows_packages(self) -> None:
        """Given a v* tag push, When workflow is read, Then it releases standard and MAWxFF builds."""
        workflow = read_text(".github/workflows/release-windows.yml")

        self.assertRegex(workflow, re.compile(r"on:\s+push:\s+tags:\s+- 'v\*'", re.MULTILINE))
        self.assertIn("windows-2022", workflow)
        self.assertNotIn("actions/setup-node@v4", workflow)
        self.assertNotIn("dtolnay/rust-toolchain@stable", workflow)
        self.assertIn("uv sync --group build --frozen", workflow)
        self.assertIn("tests/test_packaging_contract.py", workflow)
        self.assertIn("pyproject.toml", workflow)
        self.assertIn("github.ref_name", workflow)
        self.assertIn(r'(?m)^version = "(?<version>[^"]+)"\r?$', workflow)
        self.assertIn("scripts/sync_launcher_version.py --write", workflow)
        self.assertIn("scripts/sync_launcher_version.py --check", workflow)
        self.assertIn("PYTHONUTF8: '1'", workflow)
        self.assertIn("dist\\MAW\\MAW.exe", workflow)
        self.assertNotIn("MOSE", workflow)
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
        self.assertIn("gh release upload", workflow)
        self.assertIn("--target '${{ github.sha }}'", workflow)
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
        self.assertNotIn("    _register_mosp_association()\n", gui)
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
        self.assertNotIn("actions/setup-node@v4", workflow)
        self.assertNotIn("dtolnay/rust-toolchain@stable", workflow)
        self.assertIn("ref: ${{ github.event.pull_request.head.sha || github.sha }}", workflow)
        self.assertIn("uv sync --group build --frozen", workflow)
        self.assertIn("scripts\\build-windows.ps1 -SkipTests", workflow)
        self.assertIn("dist\\MAW\\MAW.exe", workflow)
        self.assertNotIn("MOSE", workflow)
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
