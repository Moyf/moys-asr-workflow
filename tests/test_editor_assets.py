from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import edit  # noqa: E402


class EditorAssetContractTests(unittest.TestCase):
    def test_editor_script_manifest_is_ordered_and_complete(self) -> None:
        self.assertEqual(
            edit.read_editor_script_manifest(),
            (
                "editor-runtime.js",
                "editor-utils.js",
                "editor-i18n.js",
                "waveform.js",
                "editor.js",
                "editor-onboarding.js",
            ),
        )

    def test_editor_script_payload_follows_manifest_order(self) -> None:
        payload = edit.build_editor_scripts()
        previous_index = -1
        markers = (
            "// Shared frontend runtime registry.",
            "// Pure editor helpers kept separate",
            "(function initMaweI18n(global) {",
            "// Framework-neutral waveform runtime.",
            "const EDITOR_SETTINGS_KEY = 'moy.asr.editor.settings.v1';",
            "const helpOnboardingButton = document.getElementById('help-onboarding');",
        )
        for asset_name, marker in zip(edit.read_editor_script_manifest(), markers):
            current_index = payload.index(marker)
            self.assertGreater(current_index, previous_index, asset_name)
            previous_index = current_index

    def test_template_uses_one_script_token(self) -> None:
        template = edit.read_web_asset("editor-template.html")
        self.assertEqual(template.count("__EDITOR_SCRIPTS_JS__"), 1)
        for legacy_token in (
            "__EDITOR_UTILS_JS__",
            "__EDITOR_I18N_JS__",
            "__WAVEFORM_JS__",
            "__EDITOR_JS__",
            "__EDITOR_ONBOARDING_JS__",
        ):
            self.assertNotIn(legacy_token, template)

    def test_new_project_action_precedes_open_project(self) -> None:
        template = edit.read_web_asset("editor-template.html")
        self.assertIn('id="new-project"', template)
        self.assertLess(template.index('id="new-project"'), template.index('id="open-project"'))

    def test_editor_sources_expose_checkpointed_import_contract(self) -> None:
        script = edit.read_web_asset("editor.js")
        for seam in (
            "function buildBlankProject()",
            "function suggestedProjectName(",
            "async function createProjectCheckpoint(",
            "async function ensureProjectCheckpointForImport(",
            "function applyCanonicalProject(",
        ):
            self.assertIn(seam, script)
        self.assertIn("let projectFileHandle = null", script)
        self.assertIn("function saveProjectToHandle(", script)
        self.assertIn("function saveCurrentProject(", script)
        self.assertIn("function detachServerProjectSaving(", script)
        self.assertNotIn("SERVER_CONFIG.createUrl", script)
        self.assertNotIn("!projectLoadedFromSrt", script)

    def test_sticker_root_uses_server_validation_without_browser_picker(self) -> None:
        template = edit.read_web_asset("editor-template.html")
        script = edit.read_web_asset("editor.js")
        styles = edit.read_web_asset("editor.css")
        self.assertIn('id="sticker-root-input"', template)
        self.assertIn('id="sticker-root-read"', template)
        self.assertIn('id="sticker-root-status"', template)
        self.assertIn("SERVER_CONFIG.stickerRootUrl", script)
        self.assertIn("STICKERS.splice(0, STICKERS.length, ...result.stickers)", script)
        self.assertIn("let stickerRootHintCard = null", script)
        self.assertIn("stickerRootHintCard?.remove()", script)
        self.assertIn("function setStickerRootModalOpen(open)", script)
        self.assertIn("event.key === 'Escape'", script)
        self.assertIn("event.key !== 'Tab'", script)
        self.assertIn("#sticker-root-modal { z-index: 280; }", styles)
        self.assertIn("width: min(540px, calc(100vw - 32px))", styles)
        for removed in (
            "showDirectoryPicker",
            "webkitdirectory",
            "sticker-root-folder-input",
            "applyStickerFiles",
            "collectStickerEntries",
            "[本地]",
        ):
            self.assertNotIn(removed, template + script)

    def test_sticker_otio_exposes_portable_mode_and_relative_metadata(self) -> None:
        template = edit.read_web_asset("editor-template.html")
        script = edit.read_web_asset("editor.js")
        self.assertIn('id="sticker-otio-export-mode"', template)
        self.assertIn('option value="portable"', template)
        self.assertIn("sticker_rel: seg.sticker.rel || ''", script)
        self.assertIn("sticker_rel: sticker.sticker_rel", script)
        self.assertIn("SERVER_CONFIG?.canPortableStickerExport", script)
        self.assertIn("SERVER_CONFIG?.portableStickerExportUrl", script)
        self.assertIn("'stickers', buildStickerOtio", script)
        self.assertIn("'gap-removed-stickers', buildGapRemovedStickerOtio", script)
        self.assertIn("timeline: JSON.parse(payload)", script)

    def test_portable_sticker_export_capability_syncs_after_project_binding(self) -> None:
        script = edit.read_web_asset("editor.js")
        self.assertIn("function syncStickerOtioExportMode()", script)
        self.assertIn("portableStickerExportOption.disabled = !available", script)
        self.assertIn("stickerOtioExportMode.value = available", script)
        self.assertIn("? EDITOR_SETTINGS.stickerOtioExportMode", script)
        self.assertIn(": 'original'", script)
        self.assertIn("stickerOtioExportMode: 'original'", script)
        self.assertIn("saved.stickerOtioExportMode === 'portable' ? 'portable' : 'original'", script)
        self.assertIn("updateEditorSettings({ stickerOtioExportMode: stickerOtioExportMode.value })", script)
        # 便携导出能力只在服务器渲染绑定工程时开启；浏览器句柄工程不被服务器
        # 跟踪，解除保存时必须一并关闭，避免把导出写到服务器旧工程目录。
        self.assertIn("SERVER_CONFIG.canPortableStickerExport = false", script)
        self.assertNotIn("SERVER_CONFIG.canPortableStickerExport = true", script)
        self.assertIn("if (!syncStickerOtioExportMode())", script)
        self.assertIn("function configureServerSaveControls()", script)
        # 同步统一收敛在 configureServerSaveControls 末尾：保存目标变化
        # （服务器绑定 / 浏览器句柄 / 解除）都流经它重算便携导出可用性。
        self.assertEqual(script.count("syncStickerOtioExportMode();"), 1)
        self.assertNotIn("const portableStickerExportEnabled", script)

    def test_generated_page_contains_registered_modules_in_order(self) -> None:
        page = edit.build_blank_html()
        self.assertNotRegex(page, r"__[A-Z][A-Z0-9_]+__")
        self.assertIn(
            f'<span class="app-version" id="app-version" data-label="版本号">版本号 v{edit.get_app_version()}</span>',
            page,
        )
        self.assertNotIn("生成时间", page)
        markers = (
            "// Shared frontend runtime registry.",
            "window.AsrEditorUtils = {",
            "global.MAWE_I18N = {",
            "window.AsrWaveform = {",
            "window.MAWE_EDITOR_BRIDGE = Object.freeze({",
            "window.MAWE_ONBOARDING = Object.freeze({",
        )
        indices = [page.index(marker) for marker in markers]
        self.assertEqual(indices, sorted(indices))

    def test_tauri_builder_consumes_the_shared_script_manifest(self) -> None:
        build_script = (ROOT / "desktop" / "src-tauri" / "build.rs").read_text(encoding="utf-8")
        self.assertIn('web_dir.join("editor-scripts.txt")', build_script)
        self.assertIn('("__EDITOR_SCRIPTS_JS__", editor_scripts.as_str())', build_script)
        for legacy_token in (
            "__EDITOR_UTILS_JS__",
            "__EDITOR_I18N_JS__",
            "__WAVEFORM_JS__",
            "__EDITOR_JS__",
        ):
            self.assertNotIn(legacy_token, build_script)


if __name__ == "__main__":
    unittest.main()
