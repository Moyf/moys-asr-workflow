# pyright: reportAny=false, reportImplicitOverride=false, reportImplicitStringConcatenation=false, reportUnannotatedClassAttribute=false, reportUninitializedInstanceVariable=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

import math
import os
import shutil
import struct
import sys
import tempfile
import unittest
import wave
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import edit  # noqa: E402
import waveform as waveform_module  # noqa: E402


class WaveformExtractionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.media_path = Path(self.temp_dir.name) / "tone.wav"
        sample_rate = 8_000
        duration_seconds = 0.4
        with wave.open(str(self.media_path), "wb") as output:
            output.setnchannels(1)
            output.setsampwidth(2)
            output.setframerate(sample_rate)
            frames = bytearray()
            for index in range(round(sample_rate * duration_seconds)):
                value = round(math.sin(2 * math.pi * 440 * index / sample_rate) * 16_000)
                frames.extend(struct.pack("<h", value))
            output.writeframes(frames)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_streaming_extraction_and_cache_match(self) -> None:
        payload = waveform_module.extract_waveform(self.media_path)
        self.assertTrue(waveform_module.is_waveform_payload(payload))
        self.assertTrue(waveform_module.waveform_matches_media(payload, self.media_path))
        self.assertEqual(payload["peaks_per_second"], 100)
        self.assertEqual(payload["peak_count"], 40)
        self.assertEqual(payload["duration_ms"], 400)
        self.assertEqual(len(payload["data"]), 108)

        cached, extracted = waveform_module.load_or_extract_waveform(payload, self.media_path)
        self.assertIs(cached, payload)
        self.assertFalse(extracted)

        lower_density, extracted = waveform_module.load_or_extract_waveform(
            payload,
            self.media_path,
            peaks_per_second=50,
        )
        self.assertTrue(extracted)
        self.assertEqual(lower_density["peaks_per_second"], 50)
        self.assertEqual(lower_density["peak_count"], 20)

    def test_media_signature_invalidates_when_file_changes(self) -> None:
        payload = {
            "schema": waveform_module.WAVEFORM_SCHEMA,
            "encoding": waveform_module.WAVEFORM_ENCODING,
            "peaks_per_second": 100,
            "peak_count": 1,
            "duration_ms": 10,
            "data": "AAA=",
            "source": waveform_module.media_signature(self.media_path),
        }
        self.assertTrue(waveform_module.waveform_matches_media(payload, self.media_path))
        self.media_path.write_bytes(self.media_path.read_bytes() + b"\x00\x00")
        self.assertFalse(waveform_module.waveform_matches_media(payload, self.media_path))

    def test_sidecar_waveform_is_reused_when_project_has_no_embedded_cache(self) -> None:
        payload = {
            "schema": waveform_module.WAVEFORM_SCHEMA,
            "encoding": waveform_module.WAVEFORM_ENCODING,
            "peaks_per_second": 100,
            "peak_count": 1,
            "duration_ms": 10,
            "data": "AAA=",
            "source": waveform_module.media_signature(self.media_path),
        }
        sidecar = waveform_module.waveform_sidecar_path(self.media_path)
        waveform_module.save_waveform_sidecar(payload, self.media_path)
        self.assertTrue(sidecar.exists())
        self.assertNotIn(b"\r\n", sidecar.read_bytes())
        self.assertEqual(waveform_module.load_waveform_sidecar(self.media_path), payload)
        cached, extracted = waveform_module.load_or_extract_waveform(None, self.media_path)
        self.assertEqual(cached, payload)
        self.assertFalse(extracted)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_embed_waveform_adds_valid_payload_without_sidecar(self) -> None:
        project = {"segments": []}

        result = waveform_module.embed_waveform(project, self.media_path)

        self.assertIs(result.error, None)
        self.assertEqual(project, {"segments": []})
        embedded = result.project["waveform"]
        self.assertTrue(waveform_module.is_waveform_payload(embedded))
        self.assertTrue(waveform_module.waveform_matches_media(embedded, self.media_path))
        self.assertEqual(embedded["encoding"], waveform_module.WAVEFORM_ENCODING)
        self.assertGreater(embedded["peak_count"], 0)
        self.assertEqual(embedded["source"], waveform_module.media_signature(self.media_path))
        self.assertFalse(waveform_module.waveform_sidecar_path(self.media_path).exists())

    def test_embed_waveform_leaves_project_unchanged_when_extraction_fails(self) -> None:
        project = {"segments": [], "waveform": {"stale": True}}
        bad_media = Path(self.temp_dir.name) / "notes.txt"
        bad_media.write_text("not audio", encoding="utf-8")

        result = waveform_module.embed_waveform(project, bad_media)

        self.assertIsNotNone(result.error)
        self.assertIs(result.project, project)
        self.assertEqual(project, {"segments": [], "waveform": {"stale": True}})


class EditorAssetTests(unittest.TestCase):
    def test_project_waveform_survives_loading_media(self) -> None:
        editor = (ROOT / "web" / "editor.js").read_text(encoding="utf-8")
        waveform = (ROOT / "web" / "waveform.js").read_text(encoding="utf-8")
        self.assertIn("let waveformLoadedFromProject = false;", editor)
        self.assertIn("waveformLoadedFromProject = waveformEditor.setPayload(DATA.waveform);", editor)
        self.assertIn("const preserveProjectWaveform = waveformLoadedFromProject", editor)
        self.assertIn("if (waveformEditor && !preserveProjectWaveform)", editor)
        self.assertIn("getPayload()", waveform)

    def test_blank_editor_inlines_modular_assets(self) -> None:
        page = edit.build_blank_html()
        self.assertIn('class="waveform-mode-switch"', page)
        self.assertIn('id="current-cue-panel"', page)
        self.assertIn('class="cue-panel-layout"', page)
        self.assertIn('container: cue-panel / inline-size;', page)
        self.assertIn('@container cue-panel (max-width: 680px)', page)
        self.assertIn('.cue-panel-navigation { grid-column: 1;', page)
        self.assertIn('.cue-panel-time-actions {\n      grid-column: 1;', page)
        self.assertIn('.cue-panel-text-wrap { grid-column: 1; }', page)
        self.assertIn('.cue-panel-sticker-wrap { grid-column: 1;', page)
        panel_markup_start = page.index('<div class="cue-panel-layout">')
        panel_markup_end = page.index('</section>', panel_markup_start)
        panel_markup = page[panel_markup_start:panel_markup_end]
        panel_parts = [
            panel_markup.index('class="cue-panel-navigation"'),
            panel_markup.index('class="cue-panel-time-actions"'),
            panel_markup.index('class="cue-panel-text-wrap"'),
            panel_markup.index('class="cue-panel-sticker-wrap"'),
        ]
        self.assertEqual(panel_parts, sorted(panel_parts))
        self.assertIn('id="player-empty"', page)
        self.assertIn('加载媒体后显示视频', page)
        self.assertIn("mediaElement.addEventListener('click'", page)
        self.assertIn('value="select-and-seek" selected>选中并跳转', page)
        self.assertIn('value="select-only">仅选中（不跳转）', page)
        self.assertIn('value="select-and-play">选中并跳转（自动播放）', page)
        self.assertIn('id="click-target-field"', page)
        self.assertIn('value="cue-start">字幕开头', page)
        self.assertTrue(
            'value="pointer" selected>鼠标所在位置' in page,
            '点击字幕块的默认跳转目标应为鼠标所在位置',
        )
        self.assertIn('id="cues-empty"', page)
        self.assertIn('加载工程后显示字幕列表', page)
        self.assertIn('id="workspace-preset"', page)
        self.assertIn('<option value="three-fold">三折叠布局</option>', page)
        self.assertIn('id="layout-reset"', page)
        self.assertIn('class="toolbar-utility-group" role="group" aria-label="编辑器工具"', page)
        self.assertIn('data-waveform-tool="select"', page)
        self.assertIn('data-waveform-tool="razor"', page)
        self.assertIn('<span>分割</span>', page)
        self.assertIn('class="ninja-razor-icon"', page)
        self.assertIn('id="ninja-mode"', page)
        self.assertIn('id="ninja-slash-effect"', page)
        self.assertIn('id="ninja-slash-effect-field"', page)
        self.assertIn('const NINJA_SFX_BASE_URL = "web/sfx/";', page)
        self.assertIn('const NINJA_SFX_HISTORY = [];', page)
        self.assertIn('function triggerNinjaSplitFeedback()', page)
        # 帮助按钮改用 🤔 文本图标后，SVG 工具图标只剩选择/分割两个
        self.assertEqual(page.count('class="toolbar-button-icon"'), 2)
        self.assertIn('.waveform-cue-block.selected {', page)
        # 选中字幕块只用 outline + 阴影高亮（颜色走 --selection-* 变量），不再改 border-color
        self.assertIn('outline: 2px solid var(--selection-yellow);', page)
        self.assertIn('filter: brightness(1.08);', page)

        self.assertIn(
            'background: color-mix(in srgb, var(--color-bar, #777) 30%, var(--accent) 30%);',
            page,
        )
        # 单行模式徽章位置跟随块高公式，避免嵌进更高的块内
        self.assertIn('.waveform-basic .waveform-cue-badge {', page)
        self.assertIn('bottom: calc(9px + max(35px, min(72px, 40%))', page)
        self.assertIn('id="layout-drop-preview"', page)
        self.assertIn('layout-insert-preview', page)
        self.assertIn('insertLayoutModuleAtEdge', page)
        self.assertIn('const dockHandle = container.querySelector', page)
        self.assertIn("const cueElements = container.querySelectorAll(':scope > .cue');", page)
        self.assertIn('onLayoutUndo: (label, snapshot) => pushLayoutUndo(label, snapshot)', page)
        self.assertIn('this.cues = document.getElementById(\'cues-container\')', page)
        self.assertIn('flex-direction: column;', page)
        self.assertIn("class WaveformEditor", page)
        self.assertIn('const DATA = {"segments": []', page)
        self.assertIn('id="save-project"', page)
        self.assertIn('id="save-project-as"', page)
        self.assertIn('const SERVER_CONFIG = null;', page)
        self.assertIn('id="editor-settings-toggle"', page)
        self.assertIn('id="editor-settings-panel"', page)
        self.assertIn('<span class="editor-settings-title">通用操作</span>', page)
        self.assertIn('字幕（编辑状态下）拆分按键', page)
        self.assertNotIn('波形区拆分按键', page)
        self.assertEqual(page.count('class="editor-settings-item editor-settings-list-fields editor-settings-display-row"'), 2)
        self.assertIn('id="help-split-key"', page)
        self.assertIn('id="help-waveform-split-key"', page)
        self.assertNotIn('确定删除第 ${idx + 1} 条字幕', page)
        self.assertNotIn('确定删除选中的 ${targetIdxs.length} 条字幕', page)
        self.assertIn('id="export-start-at-zero"', page)
        self.assertIn(
            '<input type="checkbox" id="export-start-at-zero"> SRT 首条从 0 开始',
            page,
        )
        self.assertNotIn('id="export-start-at-zero" checked', page)
        for field in ('index', 'time', 'charcount'):
            self.assertIn(f'id="cue-list-show-{field}" checked', page)
            self.assertIn(f"container.classList.toggle('hide-cue-{field}'", page)
        self.assertIn('id="cue-list-show-sticker" checked> 表情包', page)
        self.assertIn("container.classList.toggle('hide-cue-sticker'", page)
        self.assertIn('id="cue-list-auto-scroll-on-click" checked', page)
        self.assertIn('cueListAutoScrollOnClick: saved.cueListAutoScrollOnClick !== false', page)
        self.assertIn('if (EDITOR_SETTINGS.cueListAutoScrollOnClick) scrollCueToCenter(el);', page)
        self.assertIn('const comfortInset = Math.min(120, Math.max(48, cRect.height * 0.2));', page)
        self.assertIn('cueListShowIndex: saved.cueListShowIndex !== false', page)
        self.assertIn('cueListShowTime: saved.cueListShowTime !== false', page)
        self.assertIn('cueListShowSticker: saved.cueListShowSticker !== false', page)
        self.assertIn('cueListShowCharcount: saved.cueListShowCharcount !== false', page)
        self.assertNotIn('id="cue-editor-show-navigation" checked', page)
        self.assertNotIn('id="cue-editor-show-time-actions" checked', page)
        self.assertIn('cueEditorShowTimeActions: saved.cueEditorShowTimeActions === true', page)
        self.assertIn('id="cue-editor-show-sticker"> 表情包', page)
        self.assertIn('cueEditorShowNavigation: saved.cueEditorShowNavigation === true', page)
        self.assertIn('cueEditorShowSticker: saved.cueEditorShowSticker === true', page)
        self.assertIn("cuePanel.classList.toggle('hide-cue-editor-navigation'", page)
        self.assertIn("cuePanel.classList.toggle('hide-cue-editor-sticker'", page)
        self.assertIn('class="toolbar main-toolbar"', page)
        self.assertIn('class="toolbar player-toolbar"', page)
        self.assertIn('class="toolbar cue-list-toolbar"', page)
        self.assertIn('class="toolbar waveform-toolbar"', page)
        self.assertNotIn('class="toolbar row-subtitle"', page)
        self.assertNotIn('class="toolbar row-waveform"', page)
        self.assertIn('class="player-stage"', page)
        self.assertIn('id="media-play-toggle"', page)
        self.assertIn('id="media-seek"', page)
        self.assertIn('id="media-volume"', page)
        self.assertIn('id="media-playback-rate"', page)
        self.assertIn('id="media-fullscreen"', page)
        self.assertIn('function bindPlayerEvents(mediaElement)', page)
        self.assertNotIn('id="player" controls', page)
        self.assertIn('id="overlay-toggle" checked> 预览字幕', page)
        self.assertIn('id="sticker-overlay-toggle"> 预览表情包', page)
        self.assertIn('id="merge-join-text"', page)
        self.assertIn('id="waveform-drag-playhead"', page)
        self.assertIn('播放时跳过空隙', page)
        self.assertIn('const DEFAULT_LAYOUT_ROWS = [42, 16, 42];', page)
        self.assertIn("rows: [42, 16, 42], tree: DEFAULT_RIGHT_LAYOUT_TREE", page)
        self.assertIn('const projectHasStickers = DATA.segments.some(segment => segment.sticker || segment.sticker_ref);', page)
        self.assertIn('!EDITOR_SETTINGS.cueListShowSticker || !projectHasStickers,', page)
        self.assertIn("DATA.segments.forEach((seg, i) => container.appendChild(buildCueEl(seg, i)));", page)
        self.assertIn("const multiVisible = multiSubtitleVisible();", page)
        self.assertIn('id="multi-subtitle-toggle"', page)
        self.assertIn("cuePanelText?.addEventListener('keydown'", page)
        self.assertIn('const action = getConfiguredEnterAction(event);', page)
        self.assertIn("if (action === 'split') splitCuePanelAtCursor();", page)
        self.assertIn('if (e.target === cuePanelText) return;', page)
        self.assertIn('.cue .sticker-slot {\n    flex: 0 1 80px; min-width: 40px;', page)
        self.assertIn('.cue .time {\n    font-size: 11px;', page)
        # 时间码列由字幕列表容器统一切换：宽时单行，窄于 700px 时所有行一起变成两行。
        self.assertIn('container: cue-list / inline-size;', page)
        self.assertIn('grid-template-areas: "start arrow end";', page)
        self.assertIn('width: 24ch; padding-top: 1px; flex: 0 0 24ch;', page)
        self.assertIn('@container cue-list (max-width: 700px)', page)
        self.assertIn('"start arrow"\n        "end end";', page)
        self.assertIn("timeStartEl.className = 'time-start';", page)
        self.assertIn("timeArrowEl.className = 'time-arrow';", page)
        self.assertIn("timeEndEl.className = 'time-end';", page)
        self.assertIn('overflow: hidden; text-overflow: ellipsis; white-space: nowrap;', page)
        self.assertIn('id="gap-remove-manage"', page)
        self.assertIn('id="gap-remove-panel"', page)
        self.assertIn('>移除静音空隙</button>', page)
        self.assertNotIn('>移除静音空隙…</button>', page)
        self.assertIn('id="gap-remove-panel-title">移除静音空隙</h3>', page)
        self.assertIn('aria-modal="false"', page)
        self.assertIn('id="gap-remove-drag-handle"', page)
        self.assertIn('id="gap-remove-close"', page)
        self.assertIn('id="gap-remove-threshold"', page)
        self.assertNotIn('id="gap-remove-minimum-sound"', page)
        self.assertIn('id="gap-skip-playback" checked', page)
        self.assertIn('id="gap-remove-hysteresis" min="0" max="30" step="0.5" value="2"', page)
        self.assertIn('id="gap-remove-operation-mode"', page)
        self.assertIn('<option value="boundary_drag" selected>拖动边界</option>', page)
        # 空隙操作已从「移除静音空隙」弹窗移到「设置/波形」分组
        self.assertNotIn('class="gap-remove-operation-section"', page)
        self.assertIn('空隙区段操作方式\n      <select id="gap-remove-operation-mode">', page)
        self.assertIn('id="gap-remove-clear-all" class="danger">全部清理</button>', page)
        self.assertIn('确定要清理全部 ${state.gaps.length} 个空隙区段吗？', page)
        self.assertIn("message.className = 'gap-remove-total';", page)
        self.assertIn('class="gap-remove-parameters-heading"', page)
        self.assertIn('id="gap-removed-export-dropdown" hidden', page)
        self.assertIn('id="gap-removed-export-btn"', page)
        self.assertIn('导出去空隙版本', page)
        self.assertIn('id="subtitle-export-dropdown" hidden', page)
        self.assertIn('id="download-full-srt"', page)
        self.assertIn('id="download-color-srt"', page)
        self.assertIn('id="download-plain-text"', page)
        self.assertIn('id="download-gap-removed-srt"', page)
        self.assertIn('id="download-gap-removed-color-srt"', page)
        self.assertIn('id="download-gap-removed-otio"', page)
        self.assertIn('>时间线 OTIO 工程</div>', page)
        self.assertIn('id="download-gap-removed-ffconcat"', page)
        self.assertIn('id="download-gap-removed-regions-json"', page)
        self.assertNotIn('gap-remove-subtitle-warning', page)
        self.assertIn('gapRemovedExportDropdown.hidden = !gaps.some((gap) => gap.removed);', page)
        self.assertIn("const GAP_REMOVE_SCHEMA = 'moy.asr.gap_remove.v1';", page)
        self.assertIn('buildGapRemovedOtio()', page)
        self.assertIn('buildGapRemovedFfconcat()', page)
        self.assertIn('buildGapRemovedRegionsJson()', page)
        self.assertIn("schema: 'moy.asr.gap_removed_keep_regions.v1'", page)
        self.assertIn('waveform-gap-block', page)
        self.assertIn('waveform-gap-handle', page)
        self.assertIn('showGapContextMenu?.(event.clientX, event.clientY, index)', page)
        self.assertIn("gap.removed === false ? '移除区段' : '恢复区段'", page)
        self.assertIn("addItem('清理该区段', () => clearGap(index), { danger: true });", page)
        self.assertIn('id="waveform-pane" aria-label="音频波形" tabindex="-1"', page)
        self.assertIn("this.pane.addEventListener('pointerdown', () => this.focusWaveform());", page)
        self.assertIn('id="project-media-modal"', page)
        self.assertIn("projectMediaSelectButton.addEventListener('click'", page)
        self.assertIn('id="subtitle-font-size"', page)
        self.assertIn('id="subtitle-font-family"', page)
        self.assertIn('id="subtitle-font-family-scan"', page)
        self.assertIn('id="subtitle-background-color"', page)
        self.assertIn('id="subtitle-background-alpha"', page)
        self.assertIn('queryLocalFonts', page)
        self.assertIn('var(--font-sans)', page)
        self.assertIn('id="subtitle-preview-settings-toggle"', page)
        self.assertIn('id="subtitle-preview-settings-panel"', page)
        self.assertIn('class="subtitle-preview-setting-row"', page)
        self.assertNotIn('<span class="editor-settings-title">字幕预览</span>', page)
        self.assertIn('getSubtitleAppearance()', page)
        self.assertIn('font_size', page)
        self.assertIn('font_family', page)
        self.assertIn('background_alpha', page)
        self.assertIn('accept=".json,.mosp,application/json"', page)
        self.assertNotIn('id="open-project-file" accept=".json,.mosp,application/json" multiple', page)
        self.assertNotIn("confirm('是否同时选择该工程关联的媒体文件？", page)
        self.assertIn("flashHint('请先加载媒体，然后才能预览');", page)
        self.assertIn('event.composedPath?.().includes(player)', page)
        self.assertIn('function isTextEditingTarget(event)', page)
        self.assertIn('function isPlaybackKeyboardTarget(event)', page)
        self.assertIn('if (editingState || isTextEditingTarget(e)) return;', page)
        self.assertIn('let interceptedSpace = false;', page)
        self.assertIn('e.stopImmediatePropagation();', page)
        self.assertIn('width: 74px; aspect-ratio: 1;', page)
        # 面板行对选中/未选中使用同一套轨道尺寸：高度只随手动拖拽变化，不再因选中跳变
        self.assertIn('minmax(max-content, calc(var(--layout-row-middle)', page)
        self.assertNotIn(':has(> .current-cue-panel.empty)', page)
        # 不引入文本域自动增高：拖高面板时布局保持原样
        self.assertNotIn('.layout-wave-right #cue-panel-text { flex:', page)
        self.assertNotIn('.editor-workspace.layout-wave-right > .current-cue-panel {\n  overflow-y: auto;', page)
        self.assertNotIn('id="waveform-side"', page)
        self.assertIn('getSrtExportFirstIndex(', page)
        self.assertNotRegex(page, r"__[A-Z][A-Z0-9_]+__")

    def test_blank_editor_does_not_inline_local_stickers(self) -> None:
        with tempfile.TemporaryDirectory() as sticker_dir:
            sticker_path = Path(sticker_dir) / "private-sticker.png"
            sticker_path.write_bytes(b"private")
            previous_sticker_dir = os.environ.get("STICKER_DIR")
            os.environ["STICKER_DIR"] = sticker_dir
            try:
                page = edit.build_blank_html()
            finally:
                if previous_sticker_dir is None:
                    del os.environ["STICKER_DIR"]
                else:
                    os.environ["STICKER_DIR"] = previous_sticker_dir

        self.assertIn("const STICKERS = [];", page)
        self.assertIn('let STICKER_ROOT = "";', page)
        self.assertNotIn("private-sticker.png", page)
        self.assertNotIn(Path(sticker_dir).resolve().as_posix(), page)

    def test_ninja_settings_and_split_feedback_are_rendered(self) -> None:
        page = edit.build_blank_html()
        for marker in (
            'id="ninja-mode"',
            'id="ninja-slash-effect"',
            'id="ninja-slash-effect-field"',
            'const NINJA_SFX_BASE_URL = "web/sfx/";',
            'const NINJA_SFX_HISTORY = [];',
            'function triggerNinjaSplitFeedback()',
            'sfx_katana_slash_01.ogg',
            'sfx_katana_slash_01.opus',
            '打开字幕忍者模式，让拆分字幕变得更加有趣',
        ):
            self.assertIn(marker, page)

    def test_user_text_that_looks_like_a_template_token_is_preserved(self) -> None:
        page = edit.render_editor_page(
            title="__USER_TITLE__",
            media_html='<audio id="player"></audio>',
            data_json='{"segments":[{"text":"__USER_TEXT__"}]}',
            filename_base_json='"untitled"',
            stickers_json="[]",
            sticker_root_json='""',
            app_version="vtest",
            json_display="project.json",
            json_name_class="",
            media_name_display="audio.wav",
            media_name_title="",
            media_name_class="",
        )
        self.assertIn("__USER_TITLE__", page)
        self.assertIn("__USER_TEXT__", page)

    def test_all_source_assets_use_lf_and_end_with_newline(self) -> None:
        for path in [
            ROOT / "edit.py",
            ROOT / "waveform.py",
            ROOT / "server-editor" / "serve.py",
            *(path for path in sorted((ROOT / "web").glob("*")) if path.is_file()),
        ]:
            content = path.read_bytes()
            self.assertNotIn(b"\r\n", content, path.name)
            self.assertTrue(content.endswith(b"\n"), path.name)

    def test_stylesheets_have_balanced_blocks(self) -> None:
        for path in sorted((ROOT / "web").glob("*.css")):
            content = path.read_text(encoding="utf-8")
            self.assertEqual(content.count("{"), content.count("}"), path.name)

    def test_preset_layouts_do_not_keep_inactive_resize_tracks(self) -> None:
        styles = (ROOT / "web" / "waveform.css").read_text(encoding="utf-8")
        # 大荧幕布局与自定义工作区统一由 custom 渲染器渲染，不再保留 wave-bottom 专属网格
        self.assertNotIn(".layout-wave-bottom", styles)
        self.assertNotIn(
            ".layout-resizer-v { grid-column: 2; grid-row: 1 / 6; cursor: col-resize; display: block; }",
            styles,
        )
        self.assertIn(
            ".editor-workspace.layout-wave-right > .cues-container,\n"
            ".layout-custom .cues-container {\n"
            "  overflow-y: auto;",
            styles,
        )


if __name__ == "__main__":
    unittest.main()
