"""工程 → 基础 ASS 导出（工具箱「烧录字幕」的 mosp/json 输入用）。

编辑器内完整的 ASS 导出（强调语法、字级动画、逐句定位、多重字幕、说话人
前缀）依赖浏览器运行时（canvas 测宽、编辑器设置），Python 侧不做完整复刻；
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
    ass_color,
    ass_style_line,
    default_ass_font_name,
)
from maw.colors import COLOR_PALETTE
from maw.postprocess_ai_cleanup_items import cleaned_srt_segments
from maw.project import normalize_project, ProjectValidationFailed
from maw.track_output import select_export_tracks
from maw.script_alignment import project_cleanup_retained_segments

PROJECT_SUBTITLE_EXTENSIONS: frozenset[str] = frozenset({".mosp", ".json"})

# 与 web/shared/utils/ass-style.js 的同名常量保持一致。
ASS_REFERENCE_PLAY_RES_Y = 1080
ASS_DEFAULT_PREVIEW_FONT_SIZE = 18.0
ASS_AUTO_FONT_SIZE_1080P = 72
ASS_PREVIEW_TO_ASS_SCALE = ASS_AUTO_FONT_SIZE_1080P / ASS_DEFAULT_PREVIEW_FONT_SIZE
ASS_DEFAULT_COLOR = "#ffffff"
ASS_COLOR_STYLE_NAMES: tuple[str, ...] = tuple(name for name, _ in COLOR_PALETTE)

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


def _overlay_base_style(family: str, size: int, color: str, margin_v: int) -> dict[str, object]:
    style = _stroke_base_style(family, size, color)
    style["marginV"] = margin_v
    return style


def _main_event(segment: Mapping[str, object], groups: Mapping[str, object], *, color_style: str,
                prefix: str = "", layer: int = 0) -> str | None:
    times = _cue_times(segment)
    if times is None:
        return None
    start_cs, end_cs = times
    color_name = _effective_color_name(segment, groups)
    style_name = (
        f"{prefix}{color_name.upper()}"
        if color_style in {"text", "stroke"} and color_name in ASS_COLOR_STYLE_NAMES
        else (prefix.rstrip() or "Default")
    )
    text = escape_ass_text(segment.get("text"))
    return f"Dialogue: {layer},{_format_ass_time(start_cs)},{_format_ass_time(end_cs)},{style_name},,0,0,0,,{text}"


def _overlay_events(
    segments: list[object], *, groups: Mapping[str, object], color_style: str, family: str, size: int, color: str,
) -> tuple[list[str], list[str]]:
    events: list[str] = []
    enabled = [s for s in segments if isinstance(s, Mapping) and s.get("disabled") is not True]
    if not enabled:
        return [], []
    margin_v = 80 + _round_half_up(1.2 * size)
    for segment in enabled:
        start, end = segment.get("start"), segment.get("end")
        if type(start) is not int or type(end) is not int or end <= start:
            continue
        start_cs = max(0, _round_half_up(start / 10))
        end_cs = max(start_cs + 1, _round_half_up(end / 10))
        color_name = _effective_color_name(segment, groups)
        style_name = (
            f"Overlay {color_name.upper()}"
            if color_style in {"text", "stroke"} and color_name in ASS_COLOR_STYLE_NAMES
            else "Overlay"
        )
        events.append(
            f"Dialogue: 2,{_format_ass_time(start_cs)},{_format_ass_time(end_cs)},{style_name},,0,0,0,,{escape_ass_text(segment.get('text'))}",
        )
    if not events:
        return [], []
    lines = [ass_style_line(_overlay_base_style(family, size, color, margin_v), name="Overlay")]
    if color_style == "text":
        lines.extend(
            ass_style_line(
                _overlay_base_style(family, size, value, margin_v), name=f"Overlay {name.upper()}",
            )
            for name, value in COLOR_PALETTE
        )
    elif color_style == "stroke":
        for name, value in COLOR_PALETTE:
            variant = _overlay_base_style(family, size, color, margin_v)
            variant["outlineColor"] = value
            lines.append(ass_style_line(variant, name=f"Overlay {name.upper()}"))
    return lines, events


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

    try:
        selected = select_export_tracks(project, mode)
    except ValueError as error:
        raise ProjectSubtitleError(str(error)) from error
    main = next((track for track in selected if track["role"] == "main"), None)
    overlay = next((track for track in selected if track["role"] == "overlay"), None)
    secondary = next((track for track in selected if track["role"] == "secondary"), None)
    raw_segments = main["segments"] if main else []
    if not isinstance(raw_segments, list):
        raise ProjectSubtitleError("工程中没有字幕段落。")
    main_segments = cleaned_srt_segments(
        project,
        project_cleanup_retained_segments(raw_segments, project.get("gap_remove")),
    )
    events = [
        event
        for segment in main_segments
        if isinstance(segment, Mapping) and segment.get("disabled") is not True
        and isinstance(segment.get("text"), str) and segment["text"].strip()
        and (event := _main_event(segment, groups, color_style=color_style)) is not None
    ]

    overlay_segments = overlay["segments"] if overlay else []
    overlay_lines, overlay_events = _overlay_events(
        overlay_segments, groups=groups, color_style=color_style, family=family, size=size, color=color,
    )
    events.extend(overlay_events)
    secondary_lines: list[str] = []
    if secondary:
        secondary_style = _stroke_base_style(family, size, color)
        secondary_lines.append(ass_style_line(secondary_style, name="Secondary"))
        if color_style in {"text", "stroke"}:
            for name, value in COLOR_PALETTE:
                variant = dict(secondary_style)
                variant["primaryColor" if color_style == "text" else "outlineColor"] = value
                secondary_lines.append(ass_style_line(variant, name=f"Secondary {name.upper()}"))
        events.extend(event for segment in secondary["segments"]
                      if isinstance(segment, Mapping) and segment.get("disabled") is not True
                      and isinstance(segment.get("text"), str) and segment["text"].strip()
                      and (event := _main_event(segment, groups, color_style=color_style,
                                                prefix="Secondary ", layer=1)) is not None)
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
        _inline_style_line("Default", family, size, color),
    ]
    if color_style == "text":
        header.extend(_inline_style_line(name.upper(), family, size, value) for name, value in COLOR_PALETTE)
    elif color_style == "stroke":
        for name, value in COLOR_PALETTE:
            variant = _stroke_base_style(family, size, color)
            variant["outlineColor"] = value
            header.append(ass_style_line(variant, name=name.upper()))
    header.extend(overlay_lines)
    header.extend(secondary_lines)
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
