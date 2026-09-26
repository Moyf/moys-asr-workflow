from __future__ import annotations

import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import edit  # noqa: E402


class EditorAssetContractTests(unittest.TestCase):
    def test_editor_script_manifest_is_ordered_and_complete(self) -> None:
        self.assertEqual(
            edit.read_editor_script_manifest(),
            (
                "editor/boot/editor-boot.js",
                "editor/boot/editor-runtime.js",
                "shared/host/storage.js",
                "shared/host/files.js",
                "shared/host/server-api.js",
                "editor/boot/editor-host.js",
                "shared/gap-remove-core.js",
                "shared/utils/data.js",
                "shared/utils/fonts.js",
                "shared/utils/speakers.js",
                "shared/utils/media-metadata.js",
                "shared/utils/navigation.js",
                "shared/utils/text-processing.js",
                "shared/utils/timed-text-core.js",
                "shared/utils/timed-text-plans.js",
                "shared/utils/timed-text-edit.js",
                "shared/utils/text-metrics.js",
                "shared/utils/segment-timing.js",
                "shared/utils/split-alignment.js",
                "shared/utils/split-trim.js",
                "shared/utils/timeline.js",
                "shared/utils/settings.js",
                "shared/utils/gap-remove.js",
                "shared/utils/history.js",
                "shared/utils/multi-subtitle.js",
                "shared/utils/word-split.js",
                "shared/utils/srt.js",
                "shared/utils/ass-style.js",
                "shared/utils/ass-animation.js",
                "shared/utils/ass-export.js",
                "shared/utils/export-plan.js",
                "shared/utils/fcp7.js",
                "shared/utils/export-workflow.js",
                "shared/utils/platform.js",
                "shared/utils/preview-geometry.js",
                "shared/utils/lottie.js",
                "shared/utils/ograf.js",
                "shared/editor-utils.js",
                "shared/editor-i18n.js",
                "editor/media/waveform/constants.js",
                "editor/media/waveform/labels.js",
                "editor/media/waveform/scale.js",
                "editor/media/waveform/layout.js",
                "editor/media/waveform/settings.js",
                "editor/media/waveform/payload.js",
                "editor/media/waveform/colors.js",
                "editor/media/waveform/timing.js",
                "editor/media/waveform/visibility.js",
                "editor/media/waveform/controls.js",
                "editor/media/waveform/pointer.js",
                "editor/media/waveform/workspace.js",
                "editor/media/waveform/scale-controls.js",
                "editor/media/waveform/media.js",
                "editor/media/waveform/render.js",
                "editor/media/waveform/cue-blocks.js",
                "editor/media/waveform/canvas.js",
                "editor/media/waveform/input.js",
                "editor/media/waveform/cue-drag.js",
                "editor/media/waveform/cue-commands.js",
                "editor/media/waveform/gap-drag.js",
                "editor/media/waveform/cue-drag-update.js",
                "editor/media/waveform/playback.js",
                "editor/media/waveform.js",
                "editor/ui/editor-hint.js",
                "editor/media/editor-jkl.js",
                "editor/state/editor-settings.js",
                "editor/state/editor-multi-subtitle-core.js",
                "editor/ui/editor-gap-remove-data.js",
                "editor/styles/editor-colors.js",
                "editor/ui/editor-dom.js",
                "editor/state/editor-cue-panel-state.js",
                "editor/state/editor-history.js",
                "editor/state/editor-core-state.js",
                "editor/cues/editor-split-trim.js",
                "editor/cues/editor-split-mode.js",
                "editor/ui/editor-display-settings.js",
                "editor/ui/editor-floating-panel.js",
                "editor/ui/editor-settings-panels.js",
                "editor/ui/editor-ninja.js",
                "editor/media/editor-media-playback.js",
                "editor/cues/editor-keyboard-targets.js",
                "editor/cues/editor-shortcuts.js",
                "editor/cues/editor-merge-adjacent.js",
                "editor/styles/editor-appearance.js",
                "editor/media/editor-preview-geometry.js",
                "editor/media/editor-playback-loop.js",
                "editor/media/editor-sticker-overlay.js",
                "editor/io/editor-export-srt.js",
                "editor/io/editor-export-timeline.js",
                "editor/io/editor-server-save.js",
                "editor/ui/editor-workspaces.js",
                "editor/io/editor-project-save.js",
                "editor/io/editor-dynamic-exports.js",
                "editor/ui/editor-export-menus.js",
                "editor/io/editor-project-media-inputs.js",
                "editor/io/editor-project-load.js",
                "editor/io/editor-loading-progress.js",
                "editor/io/editor-multi-import.js",
                "editor/media/editor-media-load.js",
                "editor/io/editor-sticker-root.js",
                "editor/cues/editor-find-replace.js",
                "editor/cues/editor-text-process.js",
                "editor/cues/editor-timed-text-edit.js",
                "editor/cues/editor-sticker-picker.js",
                "editor/cues/editor-add-cue.js",
                "editor/cues/editor-bound-drag.js",
                "editor/ui/editor-context-menus.js",
                "editor/cues/editor-text-cleanup.js",
                "editor/media/editor-waveform-init.js",
                "editor/media/editor-media-step.js",
                "editor/styles/editor-appearance-inputs.js",
                "editor/ui/editor-behavior-hints.js",
                "editor/io/editor-server-connection.js",
                "editor/io/editor-drag-drop.js",
                "editor/io/editor-sticker-otio-export.js",
                "editor/io/editor-json-repair.js",
                "editor/ui/editor-help-panel.js",
                "editor/ui/editor-theme.js",
                "editor/ui/editor-gap-remove-ui.js",
                "editor/cues/editor-selection.js",
                "editor/cues/editor-binding-align.js",
                "editor/cues/editor-cue-panel.js",
                "editor/cues/editor-cue-elements.js",
                "editor/cues/editor-color-filter.js",
                "editor/cues/editor-search.js",
                "editor/cues/editor-inline-edit.js",
                "editor/cues/editor-split-core.js",
                "editor/cues/editor-split-context.js",
                "editor/cues/editor-segment-ops.js",
                "editor/cues/editor-nav-preview.js",
                "editor/cues/editor-cue-events.js",
                "editor/cues/editor-cue-list-anchor.js",
                "editor/cues/editor-timeline.js",
                "editor/styles/editor-speaker-labels.js",
                "editor/boot/editor.js",
                "editor/cues/editor-wiring-overlay-transfer.js",
                "editor/styles/editor-wiring-ass-storage.js",
                "editor/boot/editor-wiring-initial-config.js",
                "editor/ui/editor-wiring-dom-panels.js",
                "editor/styles/editor-wiring-ass-manager.js",
                "editor/ui/editor-wiring-settings-init.js",
                "editor/ui/editor-wiring-settings-help.js",
                "editor/ui/editor-wiring-theme-split-settings.js",
                "editor/ui/editor-wiring-display-behavior.js",
                "editor/styles/editor-wiring-appearance-settings.js",
                "editor/ui/editor-wiring-gap-panel.js",
                "editor/cues/editor-wiring-cue-panel.js",
                "editor/cues/editor-wiring-search-filter.js",
                "editor/cues/editor-wiring-overlay-split-merge.js",
                "editor/cues/editor-wiring-list-navigation.js",
                "editor/media/editor-wiring-keyboard-guards.js",
                "editor/media/editor-wiring-media-controls.js",
                "editor/cues/editor-wiring-edit-shortcuts.js",
                "editor/styles/editor-wiring-font-geometry.js",
                "editor/styles/editor-wiring-ass-preview.js",
                "editor/media/editor-wiring-sticker-preview.js",
                "editor/io/editor-wiring-export-context.js",
                "editor/io/editor-wiring-export-actions.js",
                "editor/ui/editor-wiring-toolbar-menus.js",
                "editor/io/editor-wiring-project-inputs.js",
                "editor/media/editor-wiring-media-inputs.js",
                "editor/io/editor-wiring-sticker-root.js",
                "editor/cues/editor-wiring-text-tools.js",
                "editor/cues/editor-wiring-overlay-actions.js",
                "editor/ui/editor-wiring-context-menus.js",
                "editor/media/editor-wiring-waveform-hints.js",
                "editor/io/editor-wiring-server-events.js",
                "editor/io/editor-wiring-file-drop.js",
                "editor/boot/editor-startup.js",
                "editor/boot/editor-onboarding.js",
            ),
        )

    def test_editor_script_payload_follows_manifest_order(self) -> None:
        payload = edit.build_editor_scripts()
        # 检查整份源码的装配顺序，而不是随物理切段频繁失效的片段 marker。
        previous_end = 0
        for asset_name in edit.read_editor_script_manifest():
            source = edit.read_web_asset(asset_name).rstrip()
            self.assertTrue(source, asset_name)
            current_index = payload.index(source, previous_end)
            self.assertGreaterEqual(current_index, previous_end, asset_name)
            previous_end = current_index + len(source)

    def test_waveform_gap_display_type_uses_shared_core_and_subtle_protected_style(self) -> None:
        waveform = edit.build_editor_scripts()
        styles = edit.read_web_asset("waveform.css")
        self.assertIn("getGapRemoveDisplayType", waveform)
        self.assertIn("isGapRemoveDisplayProtected", waveform)
        self.assertIn("block.classList.toggle('restored', gap.removed === false)", waveform)
        self.assertIn("waveform-gap-block.protected", styles)
        self.assertIn("box-shadow: inset 0 0 0 4px", styles)
        self.assertIn("this.options.getGapRemoveGaps?.() || []", waveform)

    def test_gap_state_labels_match_in_mawe_and_align(self) -> None:
        waveform = edit.build_editor_scripts()
        align_page = (ROOT / "server-align" / "index.html").read_text(encoding="utf-8")
        label = "gap.removed === false ? '空隙（未激活）' : '空隙'"
        self.assertIn(label, waveform)
        self.assertIn(label, align_page)

    def test_gap_manual_drag_uses_blue_handles_and_preview_in_both_editors(self) -> None:
        waveform_styles = edit.read_web_asset("waveform.css")
        align_page = (ROOT / "server-align" / "index.html").read_text(encoding="utf-8")
        for styles, handle, dragging in (
            (waveform_styles, ".waveform-gap-handle::after", ".waveform-gap-block.dragging"),
            (align_page, ".gap-handle::after", ".gap-range.dragging"),
        ):
            self.assertIn(handle, styles)
            self.assertIn(dragging, styles)
            self.assertIn("background: #5ab6ff", styles)
            self.assertIn("rgba(94", styles)

    def test_gap_core_exposes_restore_and_clear_semantics(self) -> None:
        core = edit.read_web_asset("shared/gap-remove-core.js")
        self.assertIn("function getGapRemoveDisplayGaps", core)
        self.assertIn("removed: false", core)
        self.assertIn("function removeGapRemoveProvenanceRange", core)
        self.assertIn("GAP_DISPLAY_PROJECTION_CACHE", core)
        self.assertIn("function moveGapRemoveProvenance", core)
        self.assertIn("function absorbGapRemoveProvenanceRanges", core)
        self.assertIn("GAP_REMOVE_MANUAL_OPERATION_MOVE", core)
        self.assertIn("cleared_ranges", core)
        self.assertNotIn("underlying", core)

    def test_editor_overall_gap_move_uses_shared_provenance_operation(self) -> None:
        script = edit.read_web_asset("editor/ui/editor-gap-remove-ui.js")
        start = script.index("function translateManualGap(")
        end = script.index("function resizeManualGapBoundary(", start)
        section = script[start:end]
        self.assertIn("core.moveGapRemoveProvenance", section)
        self.assertNotIn("original.start, end: original.end, removed: false", section)

    def test_shrink_gaps_replaces_audio_source_without_manual_override(self) -> None:
        script = edit.read_web_asset("editor/ui/editor-gap-remove-ui.js")
        start = script.index("function shrinkExistingGaps()")
        end = script.index("function readGapRemoveDisableSettings()", start)
        section = script[start:end]
        self.assertIn("core.replaceGapRemoveProvenanceSource", section)
        self.assertIn("state.manual_corrections = provenance.manual_overrides.length > 0", section)
        self.assertNotIn("commitManualGapRemoveChange(state, overrides)", section)

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

    def test_server_connection_warning_uses_shared_editor_contract(self) -> None:
        template = edit.read_web_asset("editor-template.html")
        styles = edit.read_web_asset("editor.css")
        script = edit.read_web_asset("editor/io/editor-server-connection.js")
        self.assertIn('id="server-connection-banner"', template)
        self.assertIn("SERVER_CONNECTION_FAILURE_THRESHOLD", script)
        self.assertIn("function checkServerConnection()", script)
        self.assertIn(".server-connection-banner", styles)
        self.assertIn(".server-connection-banner[hidden]", styles)

    def test_server_startup_labels_distinguish_waveform_cache_and_generation(self) -> None:
        script = edit.read_web_asset("editor/io/editor-server-connection.js")
        for label in (
            "loading_waveform_cache: '正在读取波形缓存…'",
            "generating_waveform: '未找到可用缓存，正在生成波形…'",
            "waveform_ready: '波形已就绪…'",
            "loading_spectral_cache: '正在读取频谱缓存…'",
            "loading_reapeaks_waveform: '正在读取 REAPER 波形缓存…'",
            "loading_waveform_cache: 'Reading waveform cache…'",
            "generating_waveform: 'No usable cache found; generating waveform…'",
        ):
            self.assertIn(label, script)
        self.assertNotIn("preparing_waveform: '正在生成波形…'", script)

    def test_hint_stack_stays_above_floating_surfaces(self) -> None:
        styles = edit.read_web_asset("editor.css")
        hint_stack = styles[styles.index("#hint-stack {"):styles.index("  .hint-card {", styles.index("#hint-stack {"))]
        self.assertIn("z-index: 490", hint_stack)

    def test_server_onboarding_uses_user_settings_across_random_ports(self) -> None:
        script = edit.read_web_asset("editor/boot/editor-onboarding.js")
        self.assertIn("serverOnboardingPersistenceEnabled", script)
        self.assertIn("SERVER_CONFIG.onboardingStatus", script)
        self.assertIn("body: JSON.stringify({ onboardingStatus: status })", script)
        self.assertIn("keepalive: true", script)

    def test_new_project_action_precedes_open_project(self) -> None:
        template = edit.read_web_asset("editor-template.html")
        self.assertIn('id="new-project"', template)
        self.assertLess(template.index('id="new-project"'), template.index('id="open-project"'))

    def test_editor_sources_expose_checkpointed_import_contract(self) -> None:
        script = edit.build_editor_scripts()
        project_load = edit.read_web_asset("editor/io/editor-project-load.js")
        project_save = edit.read_web_asset("editor/io/editor-project-save.js")
        server_save = edit.read_web_asset("editor/io/editor-server-save.js")
        for seam in (
            "function buildBlankProject()",
            "function suggestedProjectName(",
            "async function createProjectCheckpoint(",
            "async function ensureProjectCheckpointForImport(",
            "function applyCanonicalProject(",
        ):
            self.assertIn(seam, project_load)
        self.assertIn("let projectFileHandle = null", server_save)
        self.assertIn("function saveProjectToHandle(", project_save)
        self.assertIn("function saveCurrentProject(", project_save)
        self.assertIn("function detachServerProjectSaving(", project_load)
        self.assertNotIn("SERVER_CONFIG.createUrl", script)
        self.assertNotIn("!projectLoadedFromSrt", script + project_load + project_save + server_save)

    def test_ass_style_library_saves_require_token_and_flush_before_unload(self) -> None:
        script = edit.build_editor_scripts()
        # 共享样式库写入必须携带页面请求令牌（服务器 403 契约见 test_local_editor_server）。
        self.assertIn("requestToken: MaweBoot.SERVER_CONFIG?.requestToken || ''", script)
        # debounce 定时器在刷新/关闭/切后台时不保证触发；dirty 状态必须用
        # keepalive 请求在 pagehide / visibilitychange 时补发最后一次修改。
        self.assertIn("function flushAssStyleLibraryOnUnload()", script)
        self.assertIn("keepalive: true", script)
        self.assertIn("window.addEventListener('pagehide', flushAssStyleLibraryOnUnload)", script)
        self.assertIn("if (document.visibilityState === 'hidden') {\n    flushAssStyleLibraryOnUnload();", script)

    def test_sticker_root_uses_server_validation_without_browser_picker(self) -> None:
        template = edit.read_web_asset("editor-template.html")
        script = edit.build_editor_scripts()
        sticker_root = edit.read_web_asset("editor/io/editor-sticker-root.js")
        styles = edit.read_web_asset("editor.css")
        self.assertIn('id="sticker-root-input"', template)
        self.assertIn('id="sticker-root-read"', template)
        self.assertIn('id="sticker-root-status"', template)
        self.assertIn("SERVER_CONFIG.stickerRootUrl", script)
        self.assertIn("MaweBoot.STICKERS.splice(0, MaweBoot.STICKERS.length, ...result.stickers)", script)
        self.assertIn("let stickerRootHintCard = null", sticker_root)
        self.assertIn("stickerRootHintCard?.remove()", script)
        self.assertIn("function setStickerRootModalOpen(open)", sticker_root)
        self.assertIn("event.key === 'Escape'", script)
        self.assertIn("event.key !== 'Tab'", script)
        self.assertIn("#sticker-root-modal { z-index: 465; }", styles)
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
        script = edit.build_editor_scripts()
        self.assertIn('id="sticker-otio-export-mode"', template)
        self.assertIn('option value="portable"', template)
        otio_script = edit.read_web_asset("editor/io/editor-export-timeline.js")
        sticker_otio = edit.read_web_asset("editor/io/editor-sticker-otio-export.js")
        self.assertIn("sticker_rel: sticker.rel || ''", otio_script)
        self.assertIn("sticker_rel: sticker.sticker_rel", edit.read_web_asset("editor/io/editor-export-timeline.js"))
        self.assertIn("MaweBoot.SERVER_CONFIG?.canPortableStickerExport", sticker_otio)
        self.assertIn("MaweBoot.SERVER_CONFIG?.portableStickerExportUrl", sticker_otio)
        self.assertIn("'stickers', MaweExportTimeline.buildStickerOtio", script)
        self.assertIn("'gap-removed-stickers', MaweExportTimeline.buildGapRemovedStickerOtio", script)
        self.assertIn("timeline: JSON.parse(payload)", edit.read_web_asset("editor/io/editor-sticker-otio-export.js"))

    def test_portable_sticker_export_capability_syncs_after_project_binding(self) -> None:
        script = edit.build_editor_scripts()
        sticker_otio = edit.read_web_asset("editor/io/editor-sticker-otio-export.js")
        self.assertIn("function syncStickerOtioExportMode()", sticker_otio)
        self.assertIn("portableStickerExportOption.disabled = !available", sticker_otio)
        self.assertIn("stickerOtioExportMode.value = available", sticker_otio)
        self.assertIn("? MaweSettings.EDITOR_SETTINGS.stickerOtioExportMode", sticker_otio)
        self.assertIn(": 'original'", sticker_otio)
        self.assertIn("stickerOtioExportMode: 'original'", edit.read_web_asset("editor/state/editor-settings.js"))
        self.assertIn(
            "MaweSettings.updateEditorSettings({ stickerOtioExportMode: MaweStickerOtioExport.stickerOtioExportMode.value })",
            script,
        )
        # 便携导出能力只在服务器渲染绑定工程时开启；浏览器句柄工程不被服务器
        # 跟踪，解除保存时必须一并关闭，避免把导出写到服务器旧工程目录。
        self.assertIn("MaweBoot.SERVER_CONFIG.canPortableStickerExport = false", edit.read_web_asset("editor/io/editor-project-load.js"))
        self.assertNotIn("SERVER_CONFIG.canPortableStickerExport = true", script)
        self.assertIn("if (!syncStickerOtioExportMode()) {", sticker_otio)
        self.assertIn("function configureServerSaveControls()", edit.read_web_asset("editor/io/editor-server-save.js"))
        # 同步统一收敛在 configureServerSaveControls 末尾：保存目标变化
        # （服务器绑定 / 浏览器句柄 / 解除）都流经它重算便携导出可用性。
        self.assertEqual(edit.read_web_asset("editor/io/editor-server-save.js").count("MaweStickerOtioExport.syncStickerOtioExportMode();"), 1)
        self.assertNotIn("const portableStickerExportEnabled", script)

    def test_generated_page_contains_registered_modules_in_order(self) -> None:
        page = edit.build_blank_html()
        self.assertNotRegex(page, r"__[A-Z][A-Z0-9_]+__")
        self.assertIn(
            f'<span class="app-version" id="app-version" data-label="版本号">版本号 v{edit.get_app_version()}</span>',
            page,
        )
        # 便携页禁止携带「生成时间：…」式硬编码时间戳；「正在生成时间线 OTIOZ…」
        # 这类把「生成时间」作为前缀子串的普通文案不受限制。
        self.assertNotRegex(page, r"生成时间\s*[:：]")
        markers = (
            "// Shared frontend runtime registry.",
            "global.AsrGapRemoveCore = Object.freeze({",
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


class StickerScanTests(unittest.TestCase):
    def test_scan_stickers_keeps_images_when_dimensions_are_unreadable(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            sticker = Path(directory) / "broken.png"
            sticker.write_bytes(b"not-a-png")
            stderr = StringIO()
            with redirect_stderr(stderr):
                root, stickers = edit.scan_stickers(Path(directory))

        self.assertTrue(root)
        self.assertEqual(stickers, [{"name": "broken", "filename": "broken.png", "rel": "broken.png"}])
        self.assertIn("无法读取尺寸", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
