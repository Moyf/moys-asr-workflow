# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownVariableType=false, reportReturnType=false

"""Match an authoritative script to existing subtitle time slots."""

from __future__ import annotations

import copy
import difflib
import json
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from collections.abc import Sequence

from maw.postprocess import OutputMode, _reconcile_items
from maw.postprocess_io import SubtitleArtifact, PostprocessFileError, read_project, read_srt, write_artifacts
from maw.project import normalize_project
from maw.project_preview import JsonDict, JsonValue
from scripts.mosp_match_text import (
    PRESERVED_END_PUNCTUATION,
    SPLIT_PUNCTUATION,
    AlignmentError,
    generate_matched_mosp,
)


SCRIPT_EXTENSIONS = frozenset({".txt", ".md", ".markdown"})
MIN_MATCH_COVERAGE = 0.55
DEFAULT_SPLIT_PUNCTUATION = frozenset({"，", "。", ",", ".", "\n"})


@dataclass(frozen=True, slots=True)
class ScriptMatchRequest:
    project_path: Path | None
    srt_path: Path | None
    script_path: Path
    output_mode: OutputMode
    output_directory: Path | None = None
    media_path: Path | None = None
    extra_split_punctuation: tuple[str, ...] = ()
    preserve_punctuation: tuple[str, ...] = ()
    match_mode: str = "script"


@dataclass(frozen=True, slots=True)
class _CueSpan:
    segment_index: int
    normalized_start: int
    normalized_end: int


@dataclass(frozen=True, slots=True)
class _NormalizedText:
    value: str
    original_starts: tuple[int, ...]

    def original_boundary(self, normalized_index: int, original_length: int) -> int:
        if normalized_index <= 0:
            return 0
        if normalized_index >= len(self.original_starts):
            return original_length
        return self.original_starts[normalized_index]


def run_script_match(request: ScriptMatchRequest) -> SubtitleArtifact:
    project, source_project, source_srt = _load_input(request.project_path, request.srt_path)
    script_path, script_text = _read_script(request.script_path)
    if request.match_mode not in {"script", "text"}:
        raise ValueError("不支持的文稿匹配模式")
    extra_split_punctuation = request.extra_split_punctuation if request.match_mode == "script" else ()
    preserve_punctuation = request.preserve_punctuation if request.match_mode == "script" else ()
    prepared_script, punctuation_warning = prepare_script_text(
        script_text,
        extra_split_punctuation,
        preserve_punctuation,
    )
    if (
        request.match_mode == "script"
        and source_project is not None
        and _has_complete_item_timings(project)
    ):
        matched, warnings = _match_project_with_character_timings(
            project,
            prepared_script,
            request.extra_split_punctuation,
            request.preserve_punctuation,
        )
    else:
        matched, warnings = _match_project(
            project,
            prepared_script,
            DEFAULT_SPLIT_PUNCTUATION | frozenset(request.extra_split_punctuation),
            DEFAULT_SPLIT_PUNCTUATION | frozenset(request.preserve_punctuation),
            request.match_mode,
        )
    return write_artifacts(
        matched,
        source_project_path=source_project,
        source_srt_path=source_srt,
        operation="matched",
        write_project=request.output_mode in {OutputMode.JSON, OutputMode.BOTH},
        write_srt=request.output_mode in {OutputMode.SRT, OutputMode.BOTH},
        warnings=(f"文稿来源：{script_path}", punctuation_warning, *warnings),
        output_directory=request.output_directory,
        media_path=request.media_path,
    )


def prepare_script_text(
    script_text: str,
    extra_split_punctuation: tuple[str, ...] = (),
    preserve_punctuation: tuple[str, ...] = (),
) -> tuple[str, str]:
    """Validate and apply custom manuscript punctuation before matching."""

    split_symbols = tuple(symbol for symbol in extra_split_punctuation if symbol)
    preserve_symbols = tuple(symbol for symbol in preserve_punctuation if symbol)
    missing = tuple(symbol for symbol in preserve_symbols if symbol not in split_symbols)
    if missing:
        raise ValueError(
            "保留符号必须来自额外断句符号：" + "、".join(missing)
        )
    if not split_symbols:
        return script_text, "未配置额外断句符号。"
    return script_text, f"额外断句符号：{len(split_symbols)} 个；保留：{len(preserve_symbols)} 个。"


def _has_complete_item_timings(project: JsonDict) -> bool:
    segments = project.get("segments")
    if not isinstance(segments, list) or not segments:
        return False
    enabled_count = 0
    for segment in segments:
        if not isinstance(segment, dict):
            return False
        if segment.get("disabled") is True:
            continue
        enabled_count += 1
        items = segment.get("items")
        if not isinstance(items, list) or not items:
            return False
        if any(
            not isinstance(item, dict)
            or not isinstance(item.get("text"), str)
            or not isinstance(item.get("start"), (int, float))
            or isinstance(item.get("start"), bool)
            or not isinstance(item.get("end"), (int, float))
            or isinstance(item.get("end"), bool)
            for item in items
        ):
            return False
    return enabled_count > 0


def _match_project_with_character_timings(
    project: JsonDict,
    script_text: str,
    extra_split_punctuation: tuple[str, ...],
    preserve_punctuation: tuple[str, ...],
) -> tuple[JsonDict, tuple[str, ...]]:
    split_punctuation = SPLIT_PUNCTUATION | frozenset(extra_split_punctuation)
    preserved = (
        DEFAULT_SPLIT_PUNCTUATION
        | PRESERVED_END_PUNCTUATION
        | frozenset(preserve_punctuation)
    )
    if any(len(symbol) != 1 for symbol in split_punctuation | preserved):
        return _match_project(project, script_text, split_punctuation, preserved, "script")

    source_segments = project.get("segments")
    if not isinstance(source_segments, list):
        raise ValueError("project segments must be an array")
    matcher_project = copy.deepcopy(project)
    matcher_project["segments"] = [
        segment
        for segment in source_segments
        if isinstance(segment, dict) and segment.get("disabled") is not True
    ]
    mosp_text = json.dumps(matcher_project, ensure_ascii=False)
    try:
        _cues, report, matched_text = generate_matched_mosp(
            mosp_text,
            script_text,
            split_punctuation=split_punctuation,
            preserve_punctuation=preserved,
        )
    except AlignmentError as error:
        raise ValueError(str(error)) from error

    asr_characters = _report_integer(report, "asr_characters")
    manuscript_characters = _report_integer(report, "manuscript_characters")
    matched_characters = _report_integer(report, "matched_characters")
    coverage = matched_characters / max(1, min(asr_characters, manuscript_characters))
    if coverage < MIN_MATCH_COVERAGE:
        raise ValueError(
            f"script and subtitle match coverage is too low ({coverage:.0%}); "
            f"at least {MIN_MATCH_COVERAGE:.0%} of the shorter text must match"
        )

    raw_matched: JsonValue = json.loads(matched_text)
    if not isinstance(raw_matched, dict):
        raise ValueError("character matcher returned an invalid project")
    _preserve_equal_count_segment_metadata(matcher_project, raw_matched)
    raw_matched["segments"] = _merge_disabled_segments(source_segments, raw_matched)
    matched = normalize_project(raw_matched)
    warnings = (
        f"文稿匹配度：{coverage:.0%}；已按字词时间码重新生成字幕段。",
    )
    return matched, warnings


def _report_integer(report: dict[str, object], key: str) -> int:
    value = report.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"character matcher report field {key!r} is invalid")
    return value


def _integer_field(segment: JsonDict, key: str, default: int | None = None) -> int:
    value = segment.get(key)
    if value is None:
        value = default
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ValueError(f"project segment field {key!r} is invalid")
    return round(value)


def _merge_disabled_segments(
    source_segments: list[JsonValue],
    matched: JsonDict,
) -> list[JsonValue]:
    matched_segments = matched.get("segments")
    if not isinstance(matched_segments, list):
        raise ValueError("character matcher returned invalid segments")
    disabled_segments = [
        copy.deepcopy(segment)
        for segment in source_segments
        if isinstance(segment, dict) and segment.get("disabled") is True
    ]
    combined = [*matched_segments, *disabled_segments]
    combined.sort(
        key=lambda segment: (
            segment.get("start", 0) if isinstance(segment, dict) else 0,
            segment.get("end", 0) if isinstance(segment, dict) else 0,
        )
    )
    return combined


def _preserve_equal_count_segment_metadata(
    source: JsonDict,
    matched: JsonDict,
) -> None:
    source_segments = source.get("segments")
    matched_segments = matched.get("segments")
    if not isinstance(source_segments, list) or not isinstance(matched_segments, list):
        return
    if len(source_segments) != len(matched_segments):
        return
    for source_segment, matched_segment in zip(source_segments, matched_segments, strict=True):
        if not isinstance(source_segment, dict) or not isinstance(matched_segment, dict):
            continue
        for key in ("id", "speaker", "disabled", "sticker", "sticker_ref", "color", "color_ref"):
            if key in source_segment:
                matched_segment[key] = copy.deepcopy(source_segment[key])


def _match_project(
    project: JsonDict,
    script_text: str,
    split_punctuation: frozenset[str] = DEFAULT_SPLIT_PUNCTUATION,
    preserve_punctuation: frozenset[str] = frozenset(),
    match_mode: str = "script",
) -> tuple[JsonDict, tuple[str, ...]]:
    if match_mode not in {"script", "text"}:
        raise ValueError("不支持的文稿匹配模式")
    segments = project.get("segments")
    if not isinstance(segments, list):
        raise ValueError("project segments must be an array")

    punctuation_segments = _split_script_segments(script_text, split_punctuation, preserve_punctuation) if match_mode == "script" else ()
    alignment_text = "".join(punctuation_segments) if punctuation_segments else script_text.replace("\r", "").replace("\n", "")
    script = _normalize_text(alignment_text)
    source_parts: list[str] = []
    spans: list[_CueSpan] = []
    offset = 0
    for index, raw_segment in enumerate(segments):
        if not isinstance(raw_segment, dict) or raw_segment.get("disabled") is True:
            continue
        text = raw_segment.get("text")
        if not isinstance(text, str):
            continue
        normalized = _normalize_text(text)
        if not normalized.value:
            continue
        start = offset
        source_parts.append(normalized.value)
        offset += len(normalized.value)
        spans.append(_CueSpan(index, start, offset))
    source_text = "".join(source_parts)
    if not source_text:
        raise ValueError("no enabled subtitle text is available for matching")
    if not script.value:
        raise ValueError("script text is empty")

    matcher = difflib.SequenceMatcher(None, source_text, script.value, autojunk=False)
    blocks = tuple(block for block in matcher.get_matching_blocks() if block.size)
    matched_chars = sum(block.size for block in blocks)
    coverage = matched_chars / max(1, min(len(source_text), len(script.value)))

    has_manuscript_boundaries = len(punctuation_segments) > 1 and (
        "\n" in script_text or "\r" in script_text or any(symbol in script_text for symbol in split_punctuation)
    )
    if match_mode == "script" and has_manuscript_boundaries and len(punctuation_segments) != len(spans):
        result = _resegment_project(
            project,
            segments,
            spans,
            punctuation_segments,
            source_text,
            script,
            _alignment_boundaries(len(source_text), len(script.value), blocks),
            blocks[-1].a + blocks[-1].size if blocks else 0,
        )
        if result is not None:
            return result, (f"文稿匹配度：{coverage:.0%}；已按文稿换行更新，未匹配的文稿/字幕部分保留原样。",)

    if match_mode == "script" and ("\n" in script_text or "\r" in script_text) and len(punctuation_segments) == len(spans):
        result = copy.deepcopy(project)
        result_segments = result.get("segments")
        if not isinstance(result_segments, list):
            raise ValueError("project segments must be an array")
        changed = 0
        for span, replacement in zip(spans, punctuation_segments):
            source_segment = segments[span.segment_index]
            target_segment = result_segments[span.segment_index]
            if not isinstance(source_segment, dict) or not isinstance(target_segment, dict):
                continue
            original_text = source_segment.get("text")
            if not isinstance(original_text, str):
                continue
            if replacement != original_text:
                target_segment["text"] = replacement
                reconciled_items = _reconcile_items(original_text, target_segment.get("items"), replacement)
                if reconciled_items is None:
                    target_segment.pop("items", None)
                else:
                    reconciled_items_value: list[JsonValue] = []
                    reconciled_items_value.extend(reconciled_items)
                    target_segment["items"] = reconciled_items_value
                changed += 1
        return normalize_project(result), (f"文稿匹配度：100%；已按文稿换行更新 {changed} 个字幕段。",)

    if coverage < MIN_MATCH_COVERAGE:
        raise ValueError(
            f"script and subtitle match coverage is too low ({coverage:.0%}); "
            f"at least {MIN_MATCH_COVERAGE:.0%} of the shorter text must match"
        )

    boundaries = _alignment_boundaries(len(source_text), len(script.value), blocks)
    result = copy.deepcopy(project)
    result_segments = result.get("segments")
    if not isinstance(result_segments, list):
        raise ValueError("project segments must be an array")
    unmatched = 0
    changed = 0
    for span in spans:
        script_start = _map_boundary(span.normalized_start, boundaries)
        script_end = _map_boundary(span.normalized_end, boundaries)
        script_start, script_end = sorted((script_start, script_end))
        source_segment = segments[span.segment_index]
        target_segment = result_segments[span.segment_index]
        if not isinstance(source_segment, dict) or not isinstance(target_segment, dict):
            continue
        original_text = source_segment.get("text")
        if not isinstance(original_text, str):
            continue
        replacement = _slice_normalized(alignment_text, script, script_start, script_end)
        if not replacement:
            unmatched += 1
            continue
        if replacement != original_text:
            target_segment["text"] = replacement
            reconciled_items = _reconcile_items(
                original_text,
                target_segment.get("items"),
                replacement,
            )
            if reconciled_items is None:
                target_segment.pop("items", None)
            else:
                items_value: list[JsonValue] = []
                items_value.extend(reconciled_items)
                target_segment["items"] = items_value
            changed += 1

    warnings: list[str] = [f"文稿匹配度：{coverage:.0%}；已更新 {changed} 个字幕段。"]
    if unmatched:
        warnings.append(f"{unmatched} 个字幕段未找到对应文稿，已保留原字幕文字。")
    disabled_count = sum(
        1
        for segment in segments
        if isinstance(segment, dict) and segment.get("disabled") is True
    )
    if disabled_count:
        warnings.append(f"已保留 {disabled_count} 个 disabled 字幕段，未参与文稿匹配。")
    return normalize_project(result), tuple(warnings)


def _resegment_project(
    project: JsonDict,
    segments: Sequence[JsonValue],
    spans: list[_CueSpan],
    manuscript_segments: tuple[str, ...],
    source_text: str,
    script: _NormalizedText,
    boundaries: tuple[tuple[int, int], ...],
    matched_source_end: int,
) -> JsonDict | None:
    if any(isinstance(segment, dict) and segment.get("disabled") is True for segment in segments):
        return None
    result = copy.deepcopy(project)
    original_segments: list[JsonDict] = [
        segment for segment in segments if isinstance(segment, dict)
    ]
    if len(original_segments) != len(spans):
        return None
    source_length = len(source_text)
    script_offsets: list[int] = []
    offset = 0
    for value in manuscript_segments:
        offset += len(_normalize_text(value).value)
        script_offsets.append(offset)
    source_offsets = [_map_script_boundary(boundary, boundaries, source_length) for boundary in (0, *script_offsets)]
    source_offsets = [min(offset, matched_source_end) for offset in source_offsets]

    def source_time(position: int) -> int:
        for span in spans:
            if position <= span.normalized_end:
                segment = original_segments[span.segment_index]
                ratio = (position - span.normalized_start) / max(1, span.normalized_end - span.normalized_start)
                start = _integer_field(segment, "start")
                end = _integer_field(segment, "end")
                return round(start + ratio * (end - start))
        segment = original_segments[-1]
        return _integer_field(segment, "end")

    rebuilt: list[JsonDict] = []
    for index, text in enumerate(manuscript_segments):
        start = source_time(source_offsets[index])
        end = source_time(source_offsets[index + 1])
        if end <= start:
            return None
        source_index = min(len(original_segments) - 1, next((span.segment_index for span in spans if span.normalized_end > source_offsets[index]), 0))
        segment = copy.deepcopy(original_segments[source_index])
        segment["id"] = f"main-matched-{index + 1:03d}"
        segment["start"] = start
        segment["end"] = end
        segment["text"] = text
        segment.pop("items", None)
        rebuilt.append(segment)
    last_end = _integer_field(rebuilt[-1], "end") if rebuilt else 0
    untouched = [
        copy.deepcopy(segment)
        for segment in segments
        if isinstance(segment, dict) and _integer_field(segment, "start", 0) >= last_end
    ]
    result["segments"] = [*rebuilt, *untouched]
    return normalize_project(result)


def _map_script_boundary(script_index: int, boundaries: tuple[tuple[int, int], ...], source_length: int) -> int:
    if script_index <= boundaries[0][1]:
        return boundaries[0][0]
    if script_index >= boundaries[-1][1]:
        return boundaries[-1][0]
    for (left_source, left_script), (right_source, right_script) in zip(boundaries, boundaries[1:]):
        if script_index == left_script:
            return left_source
        if script_index <= right_script:
            script_span = right_script - left_script
            if script_span <= 0:
                return left_source
            return left_source + round((script_index - left_script) * (right_source - left_source) / script_span)
    return source_length


def _split_script_segments(
    text: str,
    punctuation: frozenset[str],
    preserve_punctuation: frozenset[str],
) -> tuple[str, ...]:
    """Split a manuscript at configured symbols while keeping selected marks."""

    if not punctuation:
        return ()
    segments: list[str] = []
    current: list[str] = []
    symbols = tuple(sorted(punctuation, key=len, reverse=True))
    index = 0
    while index < len(text):
        symbol = next((candidate for candidate in symbols if text.startswith(candidate, index)), "")
        if symbol:
            if symbol in preserve_punctuation:
                current.append(symbol)
            value = "".join(current).strip()
            if _normalize_text(value).value:
                segments.append(value)
            current = []
            index += len(symbol)
            continue
        current.append(text[index])
        index += 1
    value = "".join(current).strip()
    if _normalize_text(value).value:
        segments.append(value)
    return tuple(segments)


def _alignment_boundaries(
    source_length: int,
    script_length: int,
    blocks: tuple[difflib.Match, ...],
) -> tuple[tuple[int, int], ...]:
    points: set[tuple[int, int]] = {(0, 0), (source_length, script_length)}
    for block in blocks:
        points.add((block.a, block.b))
        points.add((block.a + block.size, block.b + block.size))
    return tuple(sorted(points))


def _map_boundary(source_index: int, boundaries: tuple[tuple[int, int], ...]) -> int:
    if source_index <= boundaries[0][0]:
        return boundaries[0][1]
    if source_index >= boundaries[-1][0]:
        return boundaries[-1][1]
    for (left_source, left_script), (right_source, right_script) in zip(boundaries, boundaries[1:]):
        if source_index == left_source:
            return left_script
        if source_index <= right_source:
            source_span = right_source - left_source
            if source_span <= 0:
                return left_script
            distance = source_index - left_source
            return left_script + round(distance * (right_script - left_script) / source_span)
    return boundaries[-1][1]


def _slice_normalized(
    original: str,
    normalized: _NormalizedText,
    start: int,
    end: int,
) -> str:
    if end <= start:
        return ""
    original_start = normalized.original_boundary(start, len(original))
    original_end = normalized.original_boundary(end, len(original))
    return original[original_start:original_end].strip()


def _normalize_text(value: str) -> _NormalizedText:
    chars: list[str] = []
    original_starts: list[int] = []
    for index, original_char in enumerate(value):
        normalized_char = unicodedata.normalize("NFKC", original_char).casefold()
        for char in normalized_char:
            category = unicodedata.category(char)
            if category[0] not in {"L", "M", "N"}:
                continue
            chars.append(char)
            original_starts.append(index)
    return _NormalizedText("".join(chars), tuple(original_starts))


def _read_script(path: Path) -> tuple[Path, str]:
    source = path.expanduser().resolve()
    if not source.is_file() or source.suffix.lower() not in SCRIPT_EXTENSIONS:
        raise PostprocessFileError(source, "script must be an existing UTF-8 .txt, .md, or .markdown file")
    try:
        text = source.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeError) as error:
        raise PostprocessFileError(source, f"cannot read script: {error}") from error
    if not text.strip():
        raise PostprocessFileError(source, "script is empty")
    return source, text


def _load_input(project_path: Path | None, srt_path: Path | None) -> tuple[JsonDict, Path | None, Path | None]:
    if project_path is not None:
        resolved = project_path.expanduser().resolve()
        return read_project(resolved), resolved, srt_path.expanduser().resolve() if srt_path else None
    if srt_path is not None:
        resolved = srt_path.expanduser().resolve()
        return read_srt(resolved), None, resolved
    raise ValueError("a project or SRT input is required")
