# pyright: reportAny=false, reportImplicitOverride=false, reportImplicitStringConcatenation=false, reportUnannotatedClassAttribute=false, reportUninitializedInstanceVariable=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false

from __future__ import annotations

import math
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
        self.assertIn('id="cues-empty"', page)
        self.assertIn('加载工程后显示字幕列表', page)
        self.assertIn('id="layout-preset"', page)
        self.assertIn('id="layout-reset"', page)
        self.assertIn('class="toolbar-utility-group" role="group" aria-label="编辑器工具"', page)
        self.assertIn('data-waveform-tool="select"', page)
        self.assertIn('data-waveform-tool="razor"', page)
        self.assertIn('<span>分割</span>', page)
        # 帮助按钮改用 🤔 文本图标后，SVG 工具图标只剩选择/分割两个
        self.assertEqual(page.count('class="toolbar-button-icon"'), 2)
        self.assertIn('.waveform-cue-block.selected {', page)
        # 选中字幕块只用 outline + 阴影高亮，不再改 border-color
        self.assertIn('outline: 2px solid #ffd54a;', page)
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
        self.assertIn('<span class="editor-settings-title">操作</span>', page)
        self.assertIn('字幕编辑拆分按键', page)
        self.assertNotIn('波形区拆分按键', page)
        self.assertEqual(page.count('class="editor-settings-item editor-settings-list-fields editor-settings-display-row"'), 2)
        self.assertIn('id="help-split-key"', page)
        self.assertIn('id="help-waveform-split-key"', page)
        self.assertNotIn('确定删除第 ${idx + 1} 条字幕', page)
        self.assertNotIn('确定删除选中的 ${targetIdxs.length} 条字幕', page)
        self.assertIn('id="export-start-at-zero"', page)
        for field in ('index', 'time', 'charcount'):
            self.assertIn(f'id="cue-list-show-{field}" checked', page)
            self.assertIn(f"container.classList.toggle('hide-cue-{field}'", page)
        self.assertIn('id="cue-list-show-sticker"> 表情包', page)
        self.assertNotIn('id="cue-list-show-sticker" checked', page)
        self.assertIn("container.classList.toggle('hide-cue-sticker'", page)
        self.assertIn('cueListShowIndex: saved.cueListShowIndex !== false', page)
        self.assertIn('cueListShowTime: saved.cueListShowTime !== false', page)
        self.assertIn('cueListShowSticker: saved.cueListShowSticker === true', page)
        self.assertIn('cueListShowCharcount: saved.cueListShowCharcount !== false', page)
        self.assertIn('id="cue-editor-show-navigation" checked', page)
        self.assertIn('id="cue-editor-show-sticker"> 表情包', page)
        self.assertIn('cueEditorShowNavigation: saved.cueEditorShowNavigation !== false', page)
        self.assertIn('cueEditorShowSticker: saved.cueEditorShowSticker === true', page)
        self.assertIn("cuePanel.classList.toggle('hide-cue-editor-navigation'", page)
        self.assertIn("cuePanel.classList.toggle('hide-cue-editor-sticker'", page)
        self.assertIn('const projectHasStickers = DATA.segments.some(segment => segment.sticker || segment.sticker_ref);', page)
        self.assertIn('!EDITOR_SETTINGS.cueListShowSticker || !projectHasStickers,', page)
        self.assertIn('DATA.segments.forEach((seg, i) => container.appendChild(buildCueEl(seg, i)));\n  applyCueListDisplaySettings();', page)
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
        self.assertIn('<option value="middle_drag" selected>中键拖动</option>', page)
        # 空隙操作已从「移除静音空隙」弹窗移到「设置/波形」分组
        self.assertNotIn('class="gap-remove-operation-section"', page)
        self.assertIn('空隙操作\n      <select id="gap-remove-operation-mode">', page)
        self.assertIn('class="gap-remove-parameters-heading"', page)
        self.assertIn('id="gap-removed-export-dropdown" hidden', page)
        self.assertIn('id="gap-removed-export-btn"', page)
        self.assertIn('导出去空隙版本', page)
        self.assertIn('id="subtitle-export-dropdown" hidden', page)
        self.assertIn('id="download-full-srt"', page)
        self.assertIn('id="download-color-srt"', page)
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
        self.assertIn('id="waveform-pane" aria-label="音频波形" tabindex="-1"', page)
        self.assertIn("this.pane.addEventListener('pointerdown', () => this.focusWaveform());", page)
        self.assertIn('id="project-media-modal"', page)
        self.assertIn("projectMediaSelectButton.addEventListener('click'", page)
        self.assertNotIn("confirm('是否同时选择该工程关联的媒体文件？", page)
        self.assertIn("flashHint('请先加载媒体，然后才能预览');", page)
        self.assertIn('event.composedPath?.().includes(player)', page)
        self.assertIn('const playerFocused = isPlayerKeyboardTarget(e);', page)
        self.assertIn('e.stopImmediatePropagation();', page)
        self.assertIn('width: 74px; aspect-ratio: 1;', page)
        self.assertIn('minmax(max-content, calc(var(--layout-row-middle)', page)
        self.assertIn(
            '.editor-workspace.layout-wave-right:has(> .current-cue-panel.empty) {\n'
            '  grid-template-rows:\n'
            '    minmax(56px, calc(var(--layout-row-top) - 9.333px))\n'
            '    7px\n'
            '    max-content\n'
            '    7px\n'
            '    minmax(56px, 1fr);',
            page,
        )
        self.assertNotIn('.editor-workspace.layout-wave-right > .current-cue-panel {\n  overflow-y: auto;', page)
        self.assertNotIn('id="waveform-side"', page)
        self.assertIn('getSrtExportOffset(', page)
        self.assertNotRegex(page, r"__[A-Z][A-Z0-9_]+__")

    def test_user_text_that_looks_like_a_template_token_is_preserved(self) -> None:
        page = edit.render_editor_page(
            title="__USER_TITLE__",
            media_html='<audio id="player"></audio>',
            data_json='{"segments":[{"text":"__USER_TEXT__"}]}',
            filename_base_json='"untitled"',
            stickers_json="[]",
            sticker_root_json='""',
            generated_at="now",
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
        self.assertIn(
            "grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);",
            styles,
        )
        self.assertNotIn(
            ".layout-resizer-v { grid-column: 2; grid-row: 1 / 6; cursor: col-resize; display: block; }",
            styles,
        )
        self.assertNotIn(
            ".layout-wave-bottom .layout-resizer-h1 { grid-column: 1 / 4;",
            styles,
        )
        self.assertIn(
            ".editor-workspace.layout-wave-right > .cues-container,\n"
            ".editor-workspace.layout-wave-bottom > .cues-container,\n"
            ".layout-free .cues-container {\n"
            "  overflow-y: auto;",
            styles,
        )


if __name__ == "__main__":
    unittest.main()
