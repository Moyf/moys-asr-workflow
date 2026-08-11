"""Time-safe subtitle text post-processing."""

from __future__ import annotations

import copy
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path
from typing import Final

from maw.postprocess_io import SubtitleArtifact, read_project, read_srt, write_artifacts
from maw.project import normalize_project
from maw.project_preview import JsonDict, JsonValue


class OutputMode(StrEnum):
    JSON = "json"
    SRT = "srt"
    BOTH = "both"


@dataclass(frozen=True, slots=True)
class Replacement:
    source: str
    target: str


@dataclass(frozen=True, slots=True)
class ReplacementRequest:
    project_path: Path | None
    srt_path: Path | None
    output_mode: OutputMode
    replacements: tuple[Replacement, ...]


@dataclass(frozen=True, slots=True)
class LlmPostprocessRequest:
    project_path: Path | None
    srt_path: Path | None
    output_mode: OutputMode
    operation: str
    custom_prompt: str
    task_prompt: str | None = None


LlmComplete = Callable[[str, list[dict[str, str]]], Mapping[str, JsonValue]]
LlmStatus = Callable[[str, Mapping[str, int]], None]

PROMPTS: Final[dict[str, str]] = {
    "proofread": "校对字幕中的错别字、漏字和明显识别错误，不扩写事实。",
    "resegment": "重新整理句子的字幕拆分。可以合并或拆分连续字幕，但不得删除内容。",
    "translate_en": "翻译为自然英文。允许在相邻字幕间调整语序，使每句可读。",
    "translate_zh": "翻译为自然中文。允许在相邻字幕间调整语序，使每句可读。",
    "custom": "按照用户指令处理字幕文本。",
}

SAFE_SCALARS: Final = ("speaker", "disabled")
VISUAL_FIELDS: Final = ("sticker", "sticker_ref", "color", "color_ref")
MAX_LLM_CUES_PER_REQUEST: Final = 300
TIMING_FIELDS: Final = ("start", "end", "text", "items")


def run_fixed_replacement(request: ReplacementRequest) -> SubtitleArtifact:
    project, source_project, source_srt = _load_input(request.project_path, request.srt_path)
    segments = project.get("segments")
    if isinstance(segments, list):
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            original = segment.get("text")
            if not isinstance(original, str):
                continue
            replaced = original
            for entry in request.replacements:
                if entry.source:
                    replaced = replaced.replace(entry.source, entry.target)
            if replaced != original:
                segment["text"] = replaced
                _ = segment.pop("items", None)
    return _write(project, source_project, source_srt, "replace", request.output_mode)


def run_llm_postprocess(
    request: LlmPostprocessRequest,
    *,
    complete: LlmComplete,
    on_status: LlmStatus | None = None,
) -> SubtitleArtifact:
    _notify_status(on_status, "toolbox_status_reading")
    project, source_project, source_srt = _load_input(request.project_path, request.srt_path)
    operation_prompt = PROMPTS.get(request.operation, PROMPTS["custom"]) if request.task_prompt is None else request.task_prompt.strip()
    custom = request.custom_prompt.strip()
    system_prompt = _protocol_prompt(operation_prompt, custom)
    cues = _llm_cues(project)
    batches = [
        cues[index : index + MAX_LLM_CUES_PER_REQUEST]
        for index in range(0, len(cues), MAX_LLM_CUES_PER_REQUEST)
    ] or [cues]
    _notify_status(on_status, "toolbox_status_preparing_llm")
    responses: list[Mapping[str, JsonValue]] = []
    for index, batch in enumerate(batches, 1):
        _notify_status(on_status, "toolbox_status_llm_batch", current=index, total=len(batches))
        responses.append(complete(system_prompt, batch))
        _notify_status(on_status, "toolbox_status_llm_batch_done", current=index, total=len(batches))
    _notify_status(on_status, "toolbox_status_reorganizing")
    response = _combine_llm_responses(responses)
    processed, warnings = _apply_llm_groups_with_warnings(project, response)
    if len(batches) > 1:
        warnings = (f"字幕较长，已分批处理（共 {len(batches)} 批）。",) + warnings
    _notify_status(on_status, "toolbox_status_writing")
    return _write(processed, source_project, source_srt, request.operation, request.output_mode, warnings)


def _notify_status(on_status: LlmStatus | None, key: str, **details: int) -> None:
    if on_status is not None:
        on_status(key, details)


def apply_llm_groups(project: JsonDict, response: Mapping[str, JsonValue]) -> JsonDict:
    processed, _warnings = _apply_llm_groups_with_warnings(project, response)
    return processed


def _apply_llm_groups_with_warnings(
    project: JsonDict,
    response: Mapping[str, JsonValue],
) -> tuple[JsonDict, tuple[str, ...]]:
    source_segments = _segments(project)
    raw_groups = response.get("groups")
    if not isinstance(raw_groups, list):
        raise ValueError("LLM response must contain a groups array")
    parsed: list[tuple[tuple[str, ...], str]] = []
    for raw_group in raw_groups:
        if not isinstance(raw_group, dict):
            raise ValueError("each LLM group must be an object")
        raw_ids = raw_group.get("source_ids")
        if raw_ids is None and isinstance(raw_group.get("id"), str):
            raw_ids = [raw_group["id"]]
        if not isinstance(raw_ids, list) or not raw_ids or not all(isinstance(value, str) for value in raw_ids):
            raise ValueError("each LLM group must contain source_ids")
        text = raw_group.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError("each LLM group must contain non-empty text")
        source_ids = tuple(value for value in raw_ids if isinstance(value, str))
        if len(set(source_ids)) != len(source_ids):
            raise ValueError("LLM groups cannot repeat a source ID inside one group")
        parsed.append((source_ids, text.strip()))
    expected = [f"c{index:04d}" for index in range(1, len(source_segments) + 1)]
    flattened = [cue_id for source_ids, _text in parsed for cue_id in source_ids]
    collapsed = [cue_id for index, cue_id in enumerate(flattened) if index == 0 or cue_id != flattened[index - 1]]
    if collapsed != expected:
        raise ValueError("LLM groups must cover source cue IDs once, in order; only consecutive split repeats are allowed")
    occurrences: dict[str, list[int]] = {}
    for group_index, (source_ids, _text) in enumerate(parsed):
        for cue_id in source_ids:
            occurrences.setdefault(cue_id, []).append(group_index)
    for cue_id, group_indexes in occurrences.items():
        if len(group_indexes) > 1 and any(len(parsed[index][0]) != 1 for index in group_indexes):
            raise ValueError(f"LLM split groups for {cue_id} must contain only one source ID")
    index_by_id = {cue_id: index for index, cue_id in enumerate(expected)}
    regrouped = any(len(ids) != 1 for ids, _text in parsed) or len(parsed) != len(source_segments)
    new_segments = _build_segments(source_segments, parsed, index_by_id)
    result = copy.deepcopy(project)
    result["segments"] = new_segments
    warnings = ("重分句后已移除逐词时间和贴纸/颜色引用，避免产生错误对齐。",) if regrouped else ()
    return normalize_project(result), warnings


def _build_segments(
    sources: list[JsonDict],
    groups: Sequence[tuple[tuple[str, ...], str]],
    index_by_id: Mapping[str, int],
) -> list[JsonValue]:
    split_counts: dict[str, int] = {}
    for source_ids, _text in groups:
        if len(source_ids) == 1:
            split_counts[source_ids[0]] = split_counts.get(source_ids[0], 0) + 1
    split_positions: dict[str, int] = {}
    result: list[JsonValue] = []
    regrouped = len(groups) != len(sources) or any(len(source_ids) != 1 for source_ids, _text in groups)
    for source_ids, text in groups:
        source_indexes = [index_by_id[cue_id] for cue_id in source_ids]
        first = sources[source_indexes[0]]
        last = sources[source_indexes[-1]]
        disabled_states = {sources[index].get("disabled") is True for index in source_indexes}
        if len(disabled_states) > 1:
            raise ValueError("LLM groups cannot merge enabled and disabled cues")
        start = _required_ms(first, "start")
        end = _required_ms(last, "end")
        if len(source_ids) == 1 and split_counts.get(source_ids[0], 0) > 1:
            split_position = split_positions.get(source_ids[0], 0)
            split_total = split_counts[source_ids[0]]
            duration = end - start
            if duration < split_total:
                raise ValueError("source cue is too short to split while preserving positive durations")
            part_start = start + round(duration * split_position / split_total)
            part_end = start + round(duration * (split_position + 1) / split_total)
            split_positions[source_ids[0]] = split_position + 1
            start, end = part_start, part_end
        unchanged = len(source_ids) == 1 and split_counts.get(source_ids[0], 0) == 1 and text == first.get("text")
        segment: JsonDict = copy.deepcopy(first) if unchanged else _copy_common_metadata(
            [sources[index] for index in source_indexes],
        )
        segment.update({"start": start, "end": end, "text": text})
        if regrouped or not unchanged:
            segment.pop("items", None)
        if regrouped:
            for field in VISUAL_FIELDS:
                segment.pop(field, None)
        elif not unchanged:
            for field in VISUAL_FIELDS:
                if field in first:
                    segment[field] = copy.deepcopy(first[field])
        scalar_values = {field: first.get(field) for field in SAFE_SCALARS}
        for field, value in scalar_values.items():
            if value is not None and all(source.get(field) == value for source in (sources[index] for index in source_indexes)):
                segment[field] = copy.deepcopy(value)
        result.append(segment)
    return result


def _copy_common_metadata(source_segments: Sequence[JsonDict]) -> JsonDict:
    first = source_segments[0]
    excluded = set(TIMING_FIELDS) | set(SAFE_SCALARS) | set(VISUAL_FIELDS)
    result: JsonDict = {}
    for field, value in first.items():
        if field in excluded:
            continue
        if all(field in source and source[field] == value for source in source_segments[1:]):
            result[field] = copy.deepcopy(value)
    return result


def _combine_llm_responses(responses: Sequence[Mapping[str, JsonValue]]) -> JsonDict:
    groups: list[JsonValue] = []
    for response in responses:
        raw_groups = response.get("groups")
        if not isinstance(raw_groups, list):
            raise ValueError("LLM response must contain a groups array")
        groups.extend(raw_groups)
    return {"groups": groups}


def _protocol_prompt(operation_prompt: str, custom_prompt: str) -> str:
    task = f"\n任务：{operation_prompt}" if operation_prompt else ""
    custom = f"\n用户附加要求：{custom_prompt}" if custom_prompt else ""
    return (
        "你处理的是字幕，不是普通文章。输入只有按顺序排列的不透明 cue ID 与文字。"
        "不要猜测、输出或修改时间。返回严格 JSON：{\"groups\":[{\"source_ids\":[\"c0001\"],\"text\":\"...\"}]}。"
        "source_ids 必须按输入顺序完整覆盖；合并连续字幕时放入同一组，拆分一条字幕时可让连续多组重复同一个 ID。"
        "不得重排 ID、跳过 ID、添加未知 ID 或返回空文字。"
        f"{task}{custom}"
    )


def _llm_cues(project: JsonDict) -> list[dict[str, str]]:
    return [
        {"id": f"c{index:04d}", "text": str(segment["text"])}
        for index, segment in enumerate(_segments(project), 1)
    ]


def _load_input(project_path: Path | None, srt_path: Path | None) -> tuple[JsonDict, Path | None, Path | None]:
    if project_path is not None:
        resolved = project_path.expanduser().resolve()
        return read_project(resolved), resolved, srt_path.expanduser().resolve() if srt_path else None
    if srt_path is not None:
        resolved = srt_path.expanduser().resolve()
        return read_srt(resolved), None, resolved
    raise ValueError("a project or SRT input is required")


def _write(
    project: JsonDict,
    source_project: Path | None,
    source_srt: Path | None,
    operation: str,
    mode: OutputMode,
    warnings: tuple[str, ...] = (),
) -> SubtitleArtifact:
    return write_artifacts(
        project,
        source_project_path=source_project,
        source_srt_path=source_srt,
        operation=operation,
        write_project=mode in {OutputMode.JSON, OutputMode.BOTH},
        write_srt=mode in {OutputMode.SRT, OutputMode.BOTH},
        warnings=warnings,
    )


def _segments(project: JsonDict) -> list[JsonDict]:
    raw_segments = project.get("segments")
    if not isinstance(raw_segments, list):
        raise ValueError("project segments must be an array")
    segments: list[JsonDict] = []
    for segment in raw_segments:
        if not isinstance(segment, dict):
            raise ValueError("project segment must be an object")
        segments.append(segment)
    return segments


def _required_ms(segment: JsonDict, field: str) -> int:
    value = segment.get(field)
    if type(value) is not int:
        raise ValueError(f"segment {field} must be integer milliseconds")
    return value
