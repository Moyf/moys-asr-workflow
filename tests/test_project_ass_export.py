from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from maw.project_tracks import get_main_track
from maw.project import normalize_project
from maw.project_ass_export import (
    PROJECT_SUBTITLE_EXTENSIONS,
    ProjectSubtitleError,
    escape_ass_text,
    load_burn_project,
    render_project_ass,
)


def _style_line(lines: list[str], name: str) -> str:
    matches = [line for line in lines if line.startswith(f"Style: {name},")]
    if len(matches) != 1:
        raise AssertionError(f"expected exactly one {name} style, got {len(matches)}")
    return matches[0]


def _dialogues(content: str, layer: str) -> list[str]:
    return [line for line in content.splitlines() if line.startswith(f"Dialogue: {layer},")]


def _basic_project() -> dict[str, object]:
    return {
        "segments": [
            {"id": "a", "start": 0, "end": 1500, "text": "第一句"},
            {"id": "b", "start": 2000, "end": 2400, "text": "禁用句", "disabled": True},
            {"id": "c", "start": 2500, "end": 5200, "text": "第三句"},
        ],
        "preview": {"subtitle": {"x": 0, "y": 0, "width": 1, "height": 1, "font_family": "yahei", "font_size": 20, "color": "#123456"}},
    }


class ProjectAssExportTests(unittest.TestCase):
    def test_render_matches_editor_non_ass_branch_header_and_default_style(self) -> None:
        content = render_project_ass(_basic_project(), title="演示", play_resolution=(1920, 1080))
        lines = content.splitlines()
        self.assertEqual(lines[0], "[Script Info]")
        self.assertIn("Title: 演示", lines)
        self.assertIn("PlayResX: 1920", lines)
        self.assertIn("PlayResY: 1080", lines)
        # 编辑器非 ASS 分支的 Default 行逐字段一致：Outline 2 / MarginV 80 / Bold 0。
        self.assertEqual(
            _style_line(lines, "Default"),
            "Style: Default,Microsoft YaHei,80,&H00563412,&H00563412,"
            "&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,80,1",
        )
        self.assertIn("[Events]", lines)
        self.assertIn(
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
            lines,
        )

    def test_font_size_scales_with_play_resolution_half_up(self) -> None:
        project = _basic_project()
        for height, expected in [(1080, 80), (2160, 160), (540, 40), (1440, 107)]:
            with self.subTest(height=height):
                content = render_project_ass(project, title="t", play_resolution=(2560, height))
                self.assertIn(f",{expected},", _style_line(content.splitlines(), "Default"))

    def test_font_size_falls_back_to_preview_default(self) -> None:
        project: dict[str, object] = {"segments": [{"id": "a", "start": 0, "end": 500, "text": "hi"}]}
        content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
        self.assertIn(",72,", _style_line(content.splitlines(), "Default"))

    def test_font_family_keys_and_sanitization(self) -> None:
        project = _basic_project()
        for key, expected in [("hei", "SimHei"), ("song", "SimSun"), ("sans", "Arial")]:
            with self.subTest(key=key):
                project["preview"] = {"subtitle": {"x": 0, "y": 0, "width": 1, "height": 1, "font_family": key}}
                content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
                self.assertIn(f"Style: Default,{expected},", content)
        project["preview"] = {"subtitle": {"x": 0, "y": 0, "width": 1, "height": 1, "font_family": "My,Font\nName"}}
        with self.assertRaises(ProjectSubtitleError):
            render_project_ass(project, title="t", play_resolution=(1920, 1080))

    def test_disabled_segments_are_skipped_and_order_is_preserved(self) -> None:
        content = render_project_ass(_basic_project(), title="t", play_resolution=(1920, 1080))
        dialogues = _dialogues(content, "0")
        self.assertEqual(len(dialogues), 2)
        self.assertIn("第一句", dialogues[0])
        self.assertIn("第三句", dialogues[1])
        self.assertNotIn("禁用句", content)
        # 保持工程数组顺序（与编辑器导出一致），不按时间排序。
        self.assertLess(dialogues[0], dialogues[1])

    def test_cue_times_are_centisecond_quantized_with_minimum_duration(self) -> None:
        project: dict[str, object] = {"segments": [{"id": "a", "start": 15, "end": 20, "text": "x"}]}
        content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
        self.assertIn("Dialogue: 0,0:00:00.02,0:00:00.03,Default,,0,0,0,,x", content)

    def test_color_styles_follow_ass_color_style_mode(self) -> None:
        project = _basic_project()
        project["preview"] = {"subtitle": {"x": 0, "y": 0, "width": 1, "height": 1, "ass_color_style": "text"}}
        content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
        lines = content.splitlines()
        for name in ("YELLOW", "GREEN", "RED", "PURPLE", "BLUE"):
            _style_line(lines, name)
        self.assertIn("&H001FCAF9", _style_line(lines, "YELLOW"))
        # speaker / none 不生成颜色样式，事件全部回落 Default。
        project["preview"] = {"subtitle": {"x": 0, "y": 0, "width": 1, "height": 1, "ass_color_style": "none"}}
        content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
        self.assertNotIn("Style: YELLOW,", content)

    def test_color_ref_head_resolves_palette_style(self) -> None:
        project: dict[str, object] = {
            "segments": [
                {"id": "a", "start": 0, "end": 500, "text": "头", "color": {"name": "green"}},
                {"id": "b", "start": 600, "end": 900, "text": "引用", "color_ref": {"headIdx": 0}},
            ],
        }
        content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
        dialogues = _dialogues(content, "0")
        self.assertIn("GREEN", dialogues[0])
        self.assertIn("GREEN", dialogues[1])

    def test_color_refs_keep_original_indices_when_empty_cues_are_filtered(self) -> None:
        project = {
            "segments": [
                {"start": 0, "end": 100, "text": "", "items": []},
                {"start": 100, "end": 200, "text": "头", "color": {"name": "green"}},
                {"start": 200, "end": 300, "text": "另一组", "color": {"name": "red"}},
                {"start": 300, "end": 400, "text": "引用", "color_ref": {"headIdx": 1}},
            ],
        }
        before = json.dumps(project, ensure_ascii=False)
        content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
        dialogues = _dialogues(content, "0")
        self.assertEqual([line.split(",")[3] for line in dialogues], ["GREEN", "RED", "GREEN"])
        self.assertEqual(json.dumps(project, ensure_ascii=False), before)

    def test_color_ref_can_resolve_an_empty_filtered_head(self) -> None:
        project = {
            "segments": [
                {"start": 0, "end": 100, "text": "", "items": [], "color": {"name": "green"}},
                {"start": 100, "end": 200, "text": "引用", "color_ref": {"headIdx": 0}},
            ],
        }
        dialogues = _dialogues(render_project_ass(project, title="t", play_resolution=(1920, 1080)), "0")
        self.assertEqual(len(dialogues), 1)
        self.assertEqual(dialogues[0].split(",")[3], "GREEN")

    def test_text_escaping_matches_editor_escape_ass_text(self) -> None:
        self.assertEqual(escape_ass_text("a\\b{c}d\r\ne\nf"), "a\\\\b\\{c\\}d\\Ne\\Nf")
        project: dict[str, object] = {"segments": [{"id": "a", "start": 0, "end": 500, "text": "a\\{b}\n下"}]}
        content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
        self.assertIn("a\\\\\\{b\\}\\N下", content)

    def test_overlay_track_styles_and_events(self) -> None:
        project = _basic_project()
        project["overlay_track"] = {
            "enabled": True,
            "segments": [
                {"id": "o1", "start": 300, "end": 900, "text": "叠加"},
                {"id": "o2", "start": 1000, "end": 1100, "text": "禁用跳过", "disabled": True},
            ],
        }
        content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
        lines = content.splitlines()
        overlay = _style_line(lines, "Overlay")
        # MarginV 链式锚定：80 + 1.2 × 80 = 176；描边沿用主样式但固定 2/0。
        self.assertIn("10,10,176,1", overlay)
        events = _dialogues(content, "2")
        self.assertEqual(len(events), 1)
        self.assertIn("Overlay,,0,0,0,,叠加", events[0])

    def test_overlay_snapshot_uses_its_scaled_font_and_margin_for_stacking(self) -> None:
        for font_size, margin, height, expected in [(60, 80, 1080, 152), (100, 35, 540, 95)]:
            with self.subTest(font_size=font_size, margin=margin, height=height):
                project = normalize_project(_basic_project())
                project["styles"] = [{"id": "shared", "name": "Shared", "fontSize": font_size, "marginV": margin}]
                project["tracks"][0]["style"] = {"style_id": "shared"}
                project["tracks"].append({"id": "overlay", "name": "Overlay", "role": "overlay", "enabled": True,
                    "style": {"style_id": "shared"}, "segments": [{"id": "o", "start": 0, "end": 500, "text": "overlay"}]})
                project["preview"]["subtitle"]["ass_color_style"] = "text"
                lines = render_project_ass(project, title="t", play_resolution=(1920, height)).splitlines()
                self.assertEqual(int(_style_line(lines, "Default").split(",")[-2]), margin)
                self.assertEqual(int(_style_line(lines, "Overlay").split(",")[-2]), expected)
                self.assertEqual(int(_style_line(lines, "Overlay RED").split(",")[-2]), expected)

    def test_overlay_cue_style_keeps_automatic_stack_offset(self) -> None:
        project = _basic_project()
        project["overlay_track"] = {"enabled": True, "segments": [{
            "id": "o", "start": 0, "end": 500, "text": "overlay",
            "assStyle": {"fontName": "Arial", "fontSize": 60, "marginV": 80},
        }]}
        # Main and overlay share a layer so libass can account for actual glyphs.
        for height, expected in [(1080, 152), (540, 116)]:
            with self.subTest(height=height):
                lines = render_project_ass(project, title="t", play_resolution=(1920, height)).splitlines()
                cue = _style_line(lines, "Cue_0")
                self.assertEqual(cue.split(",")[1], "Arial")
                self.assertEqual(int(cue.split(",")[-2]), expected)
                self.assertIn(",Cue_0,", _dialogues("\n".join(lines), "0")[-1])

    def test_overlay_cue_style_clears_multiline_main(self) -> None:
        project = _basic_project()
        project["segments"][0]["text"] = "first line\nsecond line"
        project["overlay_track"] = {"enabled": True, "segments": [{
            "id": "o", "start": 0, "end": 500, "text": "overlay",
            "assStyle": {"fontName": "Arial", "fontSize": 60, "marginV": 80},
        }]}
        lines = render_project_ass(project, title="t", play_resolution=(1920, 1080)).splitlines()
        self.assertEqual(int(_style_line(lines, "Cue_0").split(",")[-2]), 152)
        self.assertIn(",Cue_0,", _dialogues("\n".join(lines), "0")[-1])

    def test_overlay_cue_is_split_when_later_main_cue_appears(self) -> None:
        project = _basic_project()
        project["segments"] = [{"start": 500, "end": 1000, "text": "main"}]
        project["overlay_track"] = {"enabled": True, "segments": [{
            "start": 0, "end": 1000, "text": "overlay", "assStyle": {"fontName": "Arial"},
        }]}
        lines = _dialogues(render_project_ass(project, title="t", play_resolution=(1920, 1080)), "0")
        overlays = [line for line in lines if ",Cue_0," in line]
        self.assertEqual(len(overlays), 2)
        self.assertIn("0:00:00.00,0:00:00.50", overlays[0])
        self.assertIn("0:00:00.50,0:00:01.00", overlays[1])

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg not installed")
    def test_libass_stacks_wrapped_main_after_overlay_started(self) -> None:
        project = {
            "segments": [{"start": 500, "end": 1000, "text": "MAIN TEXT " * 15}],
            "preview": {"subtitle": {"x": 0, "y": 0, "width": 1, "height": 1,
                                     "font_size": 20, "color": "#ff0000"}},
            "overlay_track": {"enabled": True, "segments": [{
                "start": 0, "end": 1000, "text": "OVERLAY TEXT",
                "assStyle": {"fontName": "Arial", "fontSize": 60, "marginV": 80, "primaryColor": "#00ff00"},
            }]},
        }
        ass = render_project_ass(project, title="test", play_resolution=(640, 360))
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "sub.ass").write_text(ass, encoding="utf-8")
            result = subprocess.run([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i",
                "color=c=black:s=640x360:d=1", "-vf", r"ass=sub.ass,select=gte(t\,0.6)",
                "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
                cwd=directory, capture_output=True, check=True)
        pixels = result.stdout
        self.assertEqual(len(pixels), 640 * 360 * 3)
        main_y, overlay_y = [], []
        for offset in range(0, len(pixels), 3):
            red, green, _ = pixels[offset:offset + 3]
            if red > 80 and red > green * 2:
                main_y.append((offset // 3) // 640)
            if green > 80 and green > red * 2:
                overlay_y.append((offset // 3) // 640)
        self.assertTrue(main_y and overlay_y, "both subtitles must render")
        self.assertLess(max(overlay_y), min(main_y), "overlay must remain above the wrapped main subtitle")

    def test_overlay_disabled_or_closed_track_is_ignored(self) -> None:
        project = _basic_project()
        project["overlay_track"] = {"enabled": False, "segments": [{"id": "o", "start": 0, "end": 500, "text": "x"}]}
        self.assertNotIn("Dialogue: 2,", render_project_ass(project, title="t", play_resolution=(1920, 1080)))
        project["overlay_track"] = {"enabled": True, "segments": [{"id": "o", "start": 0, "end": 500, "text": "x", "disabled": True}]}
        self.assertNotIn("Dialogue: 2,", render_project_ass(project, title="t", play_resolution=(1920, 1080)))

    def test_ai_cleanup_projection_hides_covered_words_like_srt_export(self) -> None:
        project = _basic_project()
        project["segments"] = [
            {"id": "a", "start": 0, "end": 1500, "text": "保留词删除词", "items": [
                {"start": 0, "end": 500, "text": "保留词"},
                {"start": 500, "end": 1000, "text": "删除词"},
            ]},
        ]
        project["gap_remove"] = {
            "gaps": [{"start": 500, "end": 1000, "removed": True}],
            "provenance": {"sources": {"ai_cleanup": [
                {"start": 500, "end": 1000, "cleanup_scope": {
                    "segment_id": "a", "item_start": 1, "item_end": 2, "text": "删除词",
                }},
            ]}},
        }
        content = render_project_ass(project, title="t", play_resolution=(1920, 1080))
        self.assertIn("保留词", content)
        self.assertNotIn("删除词", content)

    def test_empty_project_raises(self) -> None:
        with self.assertRaises(ProjectSubtitleError):
            render_project_ass({"segments": []}, title="t", play_resolution=(1920, 1080))
        with self.assertRaises(ProjectSubtitleError):
            render_project_ass({"segments": [{"id": "a", "start": 0, "end": 500, "text": "x", "disabled": True}]}, title="t", play_resolution=(1920, 1080))
        with self.assertRaises(ProjectSubtitleError):
            render_project_ass({}, title="t", play_resolution=(1920, 1080))

    def test_load_burn_project_reads_mosp_and_json(self) -> None:
        for suffix in (".mosp", ".json"):
            for schema in (None, "moy.asr.project.v1", "moy.asr.project.v1.5", "moy.asr.project.v2"):
                with self.subTest(suffix=suffix, schema=schema):
                    with tempfile.TemporaryDirectory() as root:
                        path = Path(root) / f"demo{suffix}"
                        project = _basic_project()
                        if schema == "moy.asr.project.v2":
                            project = normalize_project(project)
                        elif schema == "moy.asr.project.v1.5":
                            migrated = normalize_project(project)
                            project.update(schema=schema, segments=get_main_track(migrated)["segments"],
                                           subtitle_groups=migrated["subtitle_groups"])
                        elif schema is not None:
                            project["schema"] = schema
                        path.write_text(json.dumps(project), encoding="utf-8")
                        document, stem = load_burn_project(path)
                        self.assertEqual(stem, "demo")
                        self.assertEqual(document["schema"], "moy.asr.project.v2")
                        self.assertEqual(len(get_main_track(document)["segments"]), 3)
                        self.assertNotIn("segments", document)

    def test_load_burn_project_rejects_unsupported_schema(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "future.mosp"
            for schema in ("moy.asr.project.v99", None):
                with self.subTest(schema=schema):
                    project = _basic_project()
                    project["schema"] = schema
                    path.write_text(json.dumps(project), encoding="utf-8")
                    with self.assertRaises(ProjectSubtitleError):
                        load_burn_project(path)

    def test_load_burn_project_rejects_v15_without_its_required_group_table(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "invalid-v15.mosp"
            path.write_text(json.dumps({"schema": "moy.asr.project.v1.5", "segments": []}), encoding="utf-8")
            with self.assertRaisesRegex(ProjectSubtitleError, "subtitle_groups"):
                load_burn_project(path)

    def test_load_burn_project_rejects_invalid_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "broken.mosp"
            path.write_text("{not json", encoding="utf-8")
            with self.assertRaises(ProjectSubtitleError):
                load_burn_project(path)
            path = Path(root) / "list.mosp"
            path.write_text("[]", encoding="utf-8")
            with self.assertRaises(ProjectSubtitleError):
                load_burn_project(path)
            path = Path(root) / "missing.mosp"
            with self.assertRaises(ProjectSubtitleError):
                load_burn_project(path)

    def test_project_subtitle_extensions(self) -> None:
        self.assertEqual(PROJECT_SUBTITLE_EXTENSIONS, frozenset({".mosp", ".json"}))


if __name__ == "__main__":
    unittest.main()
