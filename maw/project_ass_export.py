"""工程 → 基础 ASS 导出（工具箱「烧录字幕」的 mosp/json 输入用）。

编辑器内完整的 ASS 导出（强调语法、字级动画、逐句定位、多重字幕）
依赖浏览器运行时（canvas 测宽、编辑器设置），Python 侧不做完整复刻；
本模块复刻编辑器「非 ASS 模式」的导出分支：工程自身的基础样式（字体、字号、
颜色、颜色字幕、叠加轨）+ 纯文本转义。与编辑器导出的能力差异在工具箱 UI
提示与 docs/user/TOOLBOX.md 中说明。

语义对齐 web/shared/utils/ass-export.js 的 buildAssPayload 非 ASS 分支：
- Default/颜色/Overlay 样式行的字段值与编辑器逐字段一致；
- 时间按厘秒取整（half-up），最短保留 1 厘秒；
- 文本转义规则与 escapeAssText 一致（反斜杠、花括号、换行 \\N）。
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Mapping

from maw.ass_styles import (
    DEFAULT_ASS_STYLE,
    _normalize_style,
    ass_color,
    ass_style_line,
    default_ass_font_name,
)
from maw.colors import COLOR_PALETTE, COLOR_PALETTE_ALL
from maw.speaker_export import export_speaker_name, speaker_display_color, speaker_label_separator
from maw.postprocess_ai_cleanup_items import cleaned_srt_segments
from maw.project import normalize_project, ProjectValidationFailed
from maw.track_output import select_export_tracks
from maw.track_styles import resolve_track_style
from maw.script_alignment import project_cleanup_retained_segments

PROJECT_SUBTITLE_EXTENSIONS: frozenset[str] = frozenset({".mosp", ".json"})

# 与 web/shared/utils/ass-style.js 的同名常量保持一致。
ASS_REFERENCE_PLAY_RES_Y = 1080
ASS_DEFAULT_PREVIEW_FONT_SIZE = 18.0
ASS_AUTO_FONT_SIZE_1080P = 72
ASS_PREVIEW_TO_ASS_SCALE = ASS_AUTO_FONT_SIZE_1080P / ASS_DEFAULT_PREVIEW_FONT_SIZE
ASS_DEFAULT_COLOR = "#ffffff"
ASS_COLOR_STYLE_NAMES: tuple[str, ...] = tuple(name for name, _ in COLOR_PALETTE_ALL)

_FONT_FAMILY_KEYS = {
    "default": default_ass_font_name(),
    "yahei": "Microsoft YaHei",
    "hei": "SimHei",
    "song": "SimSun",
    "sans": "Arial",
}


class ProjectSubtitleError(ValueError):
    """工程字幕输入无法读取或导出（无可用条目、格式损坏等）。"""


def _round_half_up(value: float) -> int:
    # JS Math.round 是 half-up；Python round 是银行家舍入，半值会差 1。
    return math.floor(value + 0.5)


def _font_family(value: object) -> str:
    family = _FONT_FAMILY_KEYS.get(str(value or "").strip(), str(value or "").strip())
    family = " ".join(str(family).replace("\r", " ").replace("\n", " ").replace(",", " ").split())
    return family or default_ass_font_name()


def _font_size(appearance: Mapping[str, object], play_res_y: int) -> int:
    raw = appearance.get("font_size")
    numeric = float(raw) if isinstance(raw, (int, float)) and not isinstance(raw, bool) else 0.0
    preview_size = numeric if numeric > 0 else ASS_DEFAULT_PREVIEW_FONT_SIZE
    scale = play_res_y / ASS_REFERENCE_PLAY_RES_Y if play_res_y > 0 else 1.0
    size = _round_half_up(preview_size * ASS_PREVIEW_TO_ASS_SCALE * scale)
    return min(512, max(1, size))


def _primary_color(appearance: Mapping[str, object]) -> str:
    color = str(appearance.get("color") or "").strip().lower()
    if len(color) == 7 and color.startswith("#") and all(c in "0123456789abcdef" for c in color[1:]):
        return color
    return ASS_DEFAULT_COLOR


def _ass_color_style(value: object) -> str:
    text = str(value or "").strip().lower()
    return text if text in {"text", "speaker", "stroke", "none"} else "text"


def _effective_color_name(segment: Mapping[str, object], groups: Mapping[str, object]) -> str | None:
    value = groups.get(str(segment.get("color_group_id") or ""))
    return str(value.get("name") or "") or None if isinstance(value, Mapping) else None


def _export_color_palette(project: Mapping[str, object], groups: Mapping[str, object],
                          segments: list[object]) -> tuple[tuple[str, str], ...]:
    if project.get("palette_size") == 9:
        return COLOR_PALETTE_ALL
    used = {
        _effective_color_name(segment, groups) for segment in segments
        if isinstance(segment, Mapping) and segment.get("disabled") is not True
    } if project.get("annotation_mode") != "speaker" else set()
    # Keep legacy five-colour output stable; collapsing the palette must still
    # retain styles referenced by existing extended-colour cues.
    return (*COLOR_PALETTE, *(entry for entry in COLOR_PALETTE_ALL[len(COLOR_PALETTE):] if entry[0] in used))


def escape_ass_text(text: object) -> str:
    return (
        str(text or "")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
        .replace("\\", "\\\\")
        .replace("{", "\\{")
        .replace("}", "\\}")
        .replace("\n", "\\N")
    )


def _format_ass_time(centiseconds: int) -> str:
    hours, remainder = divmod(max(0, centiseconds), 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    seconds, hundredths = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{hundredths:02d}"


def _cue_times(segment: Mapping[str, object]) -> tuple[int, int] | None:
    start, end = segment.get("start"), segment.get("end")
    if type(start) is not int or type(end) is not int:
        return None
    start_cs = max(0, _round_half_up(start / 10))
    end_cs = max(start_cs + 1, _round_half_up(end / 10))
    return start_cs, end_cs


def _inline_style_line(name: str, family: str, size: int, color: str) -> str:
    # 编辑器非 ASS 模式的 Default / 颜色样式是逐字段写死的行，这里保持一致。
    ass = ass_color(color)
    return (
        f"Style: {name},{family},{size},{ass},{ass},"
        "&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,80,1"
    )


def _stroke_base_style(family: str, size: int, color: str) -> dict[str, object]:
    return {
        **DEFAULT_ASS_STYLE,
        "fontName": family,
        "fontSize": size,
        "primaryColor": color,
        "outlineColor": "#000000",
        "outline": 2,
        "shadow": 0,
        "alignment": 2,
        "marginL": 10,
        "marginR": 10,
        "marginV": 80,
    }


def _event_text(project: Mapping[str, object], segment: Mapping[str, object], groups: Mapping[str, object],
                *, color_style: str, base_color: str) -> tuple[str, str]:
    name = export_speaker_name(project, segment)
    text = escape_ass_text(segment.get("text"))
    if name:
        prefix = escape_ass_text(name + speaker_label_separator(project))
        color = speaker_display_color(project, segment, groups)
        if color_style == "speaker" and color:
            # Only the prefix is coloured. All user-controlled text is escaped
            # before adding trusted ASS override tags.
            def override(value):
                return f"&H{value[5:7]}{value[3:5]}{value[1:3]}&".upper()
            prefix = f"{{\\c{override(color)}}}{prefix}{{\\c{override(base_color)}}}"
        text = prefix + text
    # ASS's Name column is comma-delimited; do not let a display name shift fields.
    return name.replace(",", " ").replace("\r", " ").replace("\n", " "), text


def render_project_ass(
    project: Mapping[str, object],
    *,
    title: str,
    play_resolution: tuple[int, int],
    mode: str = "main",
) -> str:
    """把工程渲染为基础 ASS（编辑器非 ASS 模式导出分支的 Python 复刻）。"""
    try:
        project = normalize_project(dict(project))
    except ProjectValidationFailed as error:
        raise ProjectSubtitleError(str(error)) from error
    groups = {group["id"]: group["value"] for group in project["subtitle_groups"]["color"]}
    play_res_x = max(1, int(play_resolution[0]))
    play_res_y = max(1, int(play_resolution[1]))
    preview = project.get("preview")
    appearance: Mapping[str, object] = (
        preview.get("subtitle") if isinstance(preview, Mapping) and isinstance(preview.get("subtitle"), Mapping) else {}
    )
    family = _font_family(appearance.get("font_family"))
    size = _font_size(appearance, play_res_y)
    color = _primary_color(appearance)
    color_style = _ass_color_style(appearance.get("ass_color_style"))
    speaker_styles = {speaker["id"]: f"Speaker {index + 1}" for index, speaker in enumerate(project["speakers"])}

    try:
        selected = select_export_tracks(project, mode)
    except ValueError as error:
        raise ProjectSubtitleError(str(error)) from error
    tracks = {track["role"]: track for track in selected}
    main = tracks.get("main")
    main_segments = cleaned_srt_segments(
        project, project_cleanup_retained_segments(main["segments"] if main else [], project.get("gap_remove")),
    )
    overlay = tracks.get("overlay")
    secondary = tracks.get("secondary")
    overlay_segments = overlay["segments"] if overlay else []
    secondary_segments = secondary["segments"] if secondary else []
    palette = _export_color_palette(project, groups, [*main_segments, *overlay_segments, *secondary_segments])
    variants = [(name.upper(), value) for name, value in palette]
    identity_mode = project.get("annotation_mode") == "speaker"
    if identity_mode:
        variants.extend((speaker_styles[speaker["id"]], speaker["color"]) for speaker in project["speakers"])
    tint_field = {"text": "primaryColor", "stroke": "outlineColor"}.get(color_style)
    snapshot_scale = play_res_y / ASS_REFERENCE_PLAY_RES_Y
    style_lines = []
    cue_style_lines = []
    events = []

    def overlay_cue_margin(style, segment):
        scaled_size = min(512, max(1, _round_half_up(float(style["fontSize"]) * snapshot_scale)))
        margin = int(style["marginV"]) + _round_half_up(1.2 * scaled_size)
        if style["alignment"] not in (1, 2, 3) or not main:
            return margin
        main_snapshot = resolve_track_style(project, main)
        main_base = (_normalize_style(main_snapshot, DEFAULT_ASS_STYLE, style_id=main_snapshot["id"])
                     if main_snapshot else _stroke_base_style(family, size, color))
        for other in main_segments:
            if (other.get("disabled") is True or not str(other.get("text") or "").strip()
                    or other.get("start", 0) >= segment["end"] or other.get("end", 0) <= segment["start"]):
                continue
            override = other.get("assStyle")
            effective = _normalize_style(override, DEFAULT_ASS_STYLE, style_id="cue") if override else main_base
            if effective["alignment"] not in (1, 2, 3):
                continue
            scale = snapshot_scale if override or main_snapshot else 1.0
            main_size = min(512, max(1, _round_half_up(float(effective["fontSize"]) * scale)))
            margin = max(margin, int(effective["marginV"]) + _round_half_up(1.2 * main_size))
        return margin

    def render_track(track, segments, *, default_name, layer):
        is_overlay = default_name == "Overlay"
        is_main = default_name == "Default"
        track_snapshot = resolve_track_style(project, track) if track else None
        base = _stroke_base_style(family, size, color)
        scale = 1.0
        if track_snapshot is not None:
            base = _normalize_style(track_snapshot, DEFAULT_ASS_STYLE, style_id=track_snapshot["id"])
            scale = snapshot_scale
        if is_overlay:
            scaled_size = min(512, max(1, _round_half_up(float(base["fontSize"]) * scale)))
            base["marginV"] += _round_half_up(1.2 * scaled_size)
        prefix = "" if is_main else default_name + " "
        first_event = len(events)
        for segment in segments:
            if segment.get("disabled") is True:
                continue
            cue_snapshot = segment.get("assStyle")
            if not (is_overlay and cue_snapshot is None) and not str(segment.get("text") or "").strip():
                continue
            times = _cue_times(segment)
            if times is None or (is_overlay and segment["end"] <= segment["start"]):
                continue
            event_style = default_name
            body_color = base["primaryColor"]
            if cue_snapshot is not None:
                cue_style = _normalize_style(cue_snapshot, DEFAULT_ASS_STYLE, style_id="cue")
                if is_overlay:
                    cue_style["marginV"] = overlay_cue_margin(cue_style, segment)
                tint = speaker_display_color(project, segment, groups) if tint_field else None
                if tint:
                    cue_style[tint_field] = tint
                body_color = cue_style["primaryColor"]
                event_style = f"Cue_{len(cue_style_lines)}"
                cue_style_lines.append(ass_style_line(cue_style, name=event_style, font_size_scale=snapshot_scale))
            elif tint_field:
                if identity_mode:
                    variant = speaker_styles.get(segment.get("speaker"))
                else:
                    category = _effective_color_name(segment, groups)
                    variant = category.upper() if category in ASS_COLOR_STYLE_NAMES else None
                if variant:
                    event_style = prefix + variant
            name, text = _event_text(project, segment, groups, color_style=color_style, base_color=body_color)
            start, end = map(_format_ass_time, times)
            events.append(f"Dialogue: {layer},{start},{end},{event_style},{name},0,0,0,,{text}")

        if is_overlay and len(events) == first_event:
            return
        # The historic main-track inline styles have their own secondary colour and background alpha.
        inline_main = is_main and track_snapshot is None
        style_lines.append(_inline_style_line(default_name, family, size, color) if inline_main else
                           ass_style_line(base, name=default_name, font_size_scale=scale))
        if tint_field:
            for name, value in variants:
                if inline_main and color_style == "text":
                    line = _inline_style_line(name, family, size, value)
                else:
                    line = ass_style_line({**base, tint_field: value}, name=prefix + name, font_size_scale=scale)
                style_lines.append(line)

    # Keep the Default style in standalone overlay and extension ASS files, too.
    render_track(main, main_segments, default_name="Default", layer=0)
    if overlay:
        render_track(overlay, overlay_segments, default_name="Overlay", layer=2)
    if secondary:
        render_track(secondary, secondary_segments, default_name="Secondary", layer=1)
    if not events:
        raise ProjectSubtitleError("工程中没有可用的字幕条目，无法烧录。")

    header = [
        "[Script Info]",
        "; Script generated by MAW",
        f"Title: {_header_value(title)}",
        "ScriptType: v4.00+",
        f"PlayResX: {play_res_x}",
        f"PlayResY: {play_res_y}",
        "WrapStyle: 0",
        "ScaledBorderAndShadow: yes",
        "YCbCr Matrix: None",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        *style_lines,
        *cue_style_lines,
    ]
    return "\n".join([*header, "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text", *events, ""])


def _header_value(value: object) -> str:
    text = " ".join(str(value or "MAW").split())
    return text or "MAW"


def load_burn_project(path: Path) -> tuple[dict[str, object], str]:
    """读取工程 JSON，返回 (document, 用于标题的文件名主干)。"""

    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except OSError as error:
        raise ProjectSubtitleError(f"无法读取工程文件：{error}") from error
    except (UnicodeError, json.JSONDecodeError) as error:
        raise ProjectSubtitleError(f"工程文件不是有效的 JSON：{error}") from error
    if not isinstance(payload, dict):
        raise ProjectSubtitleError("工程文件内容不是 JSON 对象。")
    try:
        return normalize_project(payload), path.stem
    except ProjectValidationFailed as error:
        raise ProjectSubtitleError(str(error)) from error
