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
    output_directory: Path | None = None


@dataclass(frozen=True, slots=True)
class LlmPostprocessRequest:
    project_path: Path | None
    srt_path: Path | None
    output_mode: OutputMode
    operation: str
    custom_prompt: str
    task_prompt: str | None = None
    output_directory: Path | None = None


LlmComplete = Callable[[str, list[dict[str, JsonValue]]], Mapping[str, JsonValue]]
LlmStatus = Callable[[str, Mapping[str, int]], None]

PROMPTS: Final[dict[str, str]] = {
    "proofread": "校对字幕中的错别字、漏字和明显识别错误，不扩写事实。",
    "resegment": "重新整理句子的字幕拆分。可以合并或拆分连续字幕，但不得删除内容。",
    "translate_en": "翻译为自然英文。必须保持原字幕的段数、顺序和每段时间范围，一条输入字幕只能对应一条输出字幕；不得合并、拆分或重排相邻字幕。",
    "translate_zh": "翻译为自然中文。必须保持原字幕的段数、顺序和每段时间范围，一条输入字幕只能对应一条输出字幕；不得合并、拆分或重排相邻字幕。",
    "custom": "按照用户指令处理字幕文本。",
}

SAFE_SCALARS: Final = ("speaker", "disabled")
VISUAL_FIELDS: Final = ("sticker", "sticker_ref", "color", "color_ref")
MAX_LLM_CUES_PER_REQUEST: Final = 80
MAX_LLM_INPUT_CHARS_PER_REQUEST: Final = 4000
MAX_LLM_WARNING_TEXT_CHARS: Final = 240
TIMING_FIELDS: Final = ("start", "end", "text", "items")
ONE_TO_ONE_TRANSLATION_OPERATIONS: Final = frozenset({"translate_en", "translate_zh"})


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
                reconciled_items = _reconcile_items(original, segment.get("items"), replaced)
                if reconciled_items is None:
                    _ = segment.pop("items", None)
                else:
                    segment["items"] = reconciled_items
    return _write(project, source_project, source_srt, "replace", request.output_mode, output_directory=request.output_directory)


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
    strict_translation = request.operation in ONE_TO_ONE_TRANSLATION_OPERATIONS
    item_aware_resegment = request.operation == "resegment" and _has_complete_items(project)
    system_prompt = _protocol_prompt(
        operation_prompt,
        custom,
        strict_translation=strict_translation,
        item_aware_resegment=item_aware_resegment,
    )
    cues = _llm_cues(project, include_items=item_aware_resegment)
    batches = _llm_batches(cues)
    _notify_status(on_status, "toolbox_status_preparing_llm")
    responses: list[Mapping[str, JsonValue]] = []
    skipped_source_ids: set[str] = set()
    response_warnings: list[str] = []
    response_modes: list[str] = []
    for index, batch in enumerate(batches, 1):
        _notify_status(on_status, "toolbox_status_llm_batch", current=index, total=len(batches))
        try:
            response = complete(system_prompt, batch)
        except RuntimeError as error:
            first_id = str(batch[0]["id"]) if batch else "?"
            last_id = str(batch[-1]["id"]) if batch else "?"
            raise RuntimeError(
                f"第 {index}/{len(batches)} 批（{first_id}–{last_id}）处理失败：{error}"
            ) from error
        clean_response, batch_skipped, batch_warnings, response_mode = _sanitize_llm_response(
            response,
            batch,
            batch_number=index,
            strict_translation=strict_translation,
            item_aware_resegment=item_aware_resegment,
        )
        responses.append(clean_response)
        response_modes.append(response_mode)
        skipped_source_ids.update(batch_skipped)
        response_warnings.extend(batch_warnings)
        _notify_status(on_status, "toolbox_status_llm_batch_done", current=index, total=len(batches))
    source_ids = {str(cue["id"]) for cue in cues}
    if source_ids and skipped_source_ids >= source_ids:
        report = _format_skip_report(skipped_source_ids, response_warnings)
        detail = f"\n{report}" if report else ""
        raise ValueError(f"LLM 没有生成可用字幕，未写出输出产物。{detail}")
    _notify_status(on_status, "toolbox_status_reorganizing")
    response = _combine_llm_responses(responses)
    if item_aware_resegment and all(mode == "atoms" for mode in response_modes):
        processed, warnings = _apply_llm_atom_groups_with_warnings(
            project,
            response,
            skipped_source_ids=skipped_source_ids,
        )
    elif item_aware_resegment and all(mode == "cues" for mode in response_modes):
        processed, warnings = _apply_llm_groups_with_warnings(
            project,
            response,
            strict_translation=strict_translation,
            skipped_source_ids=skipped_source_ids,
            preserve_items_on_equal_text=False,
        )
        warnings = (
            "模型未返回字词边界，已使用字幕级安全重分句；本次不保留逐词时间码。",
            *warnings,
        )
    elif item_aware_resegment:
        raise ValueError("LLM 分批返回了不一致的字词边界协议，未写出输出产物。")
    else:
        processed, warnings = _apply_llm_groups_with_warnings(
            project,
            response,
            strict_translation=strict_translation,
            skipped_source_ids=skipped_source_ids,
            preserve_items_on_equal_text=not strict_translation,
        )
    if skipped_source_ids:
        warnings = (
            _format_skip_summary(skipped_source_ids),
            *_format_skip_report_lines(response_warnings),
            *warnings,
        )
    else:
        warnings = tuple(warnings)
    if len(batches) > 1:
        warnings = (f"字幕较长，已分批处理（共 {len(batches)} 批）。",) + warnings
    _notify_status(on_status, "toolbox_status_writing")
    return _write(processed, source_project, source_srt, request.operation, request.output_mode, warnings, output_directory=request.output_directory)


def _notify_status(on_status: LlmStatus | None, key: str, **details: int) -> None:
    if on_status is not None:
        on_status(key, details)


def apply_llm_groups(project: JsonDict, response: Mapping[str, JsonValue]) -> JsonDict:
    processed, _warnings = _apply_llm_groups_with_warnings(project, response)
    return processed


def _llm_batches(cues: list[dict[str, JsonValue]]) -> list[list[dict[str, JsonValue]]]:
    batches: list[list[dict[str, JsonValue]]] = []
    current: list[dict[str, JsonValue]] = []
    current_chars = 0
    for cue in cues:
        cue_chars = len(str(cue["text"]))
        if current and (
            len(current) >= MAX_LLM_CUES_PER_REQUEST
            or current_chars + cue_chars > MAX_LLM_INPUT_CHARS_PER_REQUEST
        ):
            batches.append(current)
            current = []
            current_chars = 0
        current.append(cue)
        current_chars += cue_chars
    if current or not batches:
        batches.append(current)
    return batches


def _cue_number(source_id: str) -> str:
    try:
        return str(int(source_id.removeprefix("c")))
    except ValueError:
        return "?"


def _cue_text_preview(text: str) -> str:
    value = " ".join(text.split())
    if len(value) <= MAX_LLM_WARNING_TEXT_CHARS:
        return value or "（空）"
    return f"{value[:MAX_LLM_WARNING_TEXT_CHARS - 1]}…"


def _format_skip_detail(
    cue: Mapping[str, JsonValue],
    *,
    batch_number: int,
    group_index: int | None,
    reason: str,
) -> str:
    source_id = str(cue["id"])
    text = str(cue.get("text") or "")
    group_label = f"，模型第 {group_index} 组" if group_index is not None else ""
    return (
        f"第 {_cue_number(source_id)} 条（{source_id}，第 {batch_number} 批{group_label}）："
        f"{reason}；原文：{_cue_text_preview(text)}"
    )


def _format_skip_summary(skipped_source_ids: Sequence[str]) -> str:
    return f"已跳过 {len(set(skipped_source_ids))} 条不合规字幕，未写入输出产物。"


def _format_skip_report_lines(details: Sequence[str]) -> tuple[str, ...]:
    if not details:
        return ()
    return ("不合规字幕明细：", *(f"- {detail}" for detail in details))


def _format_skip_report(skipped_source_ids: Sequence[str], details: Sequence[str]) -> str:
    lines = (_format_skip_summary(skipped_source_ids), *_format_skip_report_lines(details))
    return "\n".join(lines)


def _sanitize_llm_response(
    response: Mapping[str, JsonValue],
    batch: Sequence[dict[str, JsonValue]],
    *,
    batch_number: int,
    strict_translation: bool,
    item_aware_resegment: bool,
) -> tuple[JsonDict, frozenset[str], tuple[str, ...], str]:
    """Keep valid groups and mark source cues with unusable model output.

    A malformed JSON document is rejected by the client before this function
    runs. Once the document is valid JSON, however, one bad group must not
    prevent otherwise valid subtitle cues from being written.
    """
    raw_groups = response.get("groups")
    if not isinstance(raw_groups, list):
        raise ValueError("LLM response must contain a groups array")
    response_mode = _response_mode(response, item_aware_resegment=item_aware_resegment)
    if response_mode == "atoms":
        return _sanitize_atom_response(response, batch, batch_number=batch_number)
    expected_ids = tuple(str(cue["id"]) for cue in batch)
    expected_set = set(expected_ids)
    index_by_id = {cue_id: index for index, cue_id in enumerate(expected_ids)}
    cue_by_id = {str(cue["id"]): cue for cue in batch}
    accepted_groups: list[JsonValue] = []
    accepted_sequence: list[str] = []
    accepted_ids: set[str] = set()
    skipped_details: dict[str, str] = {}
    last_group_ids: tuple[str, ...] = ()

    def reject(group_index: int, reason: str, ids: Sequence[str]) -> None:
        known_ids = tuple(cue_id for cue_id in ids if cue_id in expected_set)
        for cue_id in known_ids:
            skipped_details.setdefault(
                cue_id,
                _format_skip_detail(
                    cue_by_id[cue_id],
                    batch_number=batch_number,
                    group_index=group_index,
                    reason=reason,
                ),
            )

    for group_index, raw_group in enumerate(raw_groups, start=1):
        if not isinstance(raw_group, dict):
            reject(group_index, "结果不是对象", ())
            continue
        raw_ids = raw_group.get("source_ids")
        if raw_ids is None and isinstance(raw_group.get("id"), str):
            raw_ids = [raw_group["id"]]
        candidate_ids = tuple(value for value in raw_ids if isinstance(value, str)) if isinstance(raw_ids, list) else ()
        if (
            not isinstance(raw_ids, list)
            or not raw_ids
            or len(candidate_ids) != len(raw_ids)
            or any(not value for value in candidate_ids)
        ):
            reject(group_index, "缺少有效 source_ids", candidate_ids)
            continue
        if any(cue_id not in expected_set for cue_id in candidate_ids):
            reject(group_index, "包含未知 source ID", candidate_ids)
            continue
        if len(set(candidate_ids)) != len(candidate_ids):
            reject(group_index, "同一组重复 source ID", candidate_ids)
            continue
        text = raw_group.get("text")
        if not isinstance(text, str) or not text.strip():
            reject(group_index, "text 为空", candidate_ids)
            continue
        if strict_translation and len(candidate_ids) != 1:
            reject(group_index, "翻译结果必须一条输入对应一条输出", candidate_ids)
            continue
        positions = [index_by_id[cue_id] for cue_id in candidate_ids]
        if len(positions) > 1 and positions != list(range(positions[0], positions[0] + len(positions))):
            reject(group_index, "合并的字幕必须相邻", candidate_ids)
            continue
        is_split_repeat = (
            not strict_translation
            and len(candidate_ids) == 1
            and last_group_ids == candidate_ids
        )
        if any(cue_id in accepted_ids for cue_id in candidate_ids) and not is_split_repeat:
            reject(group_index, "重复覆盖已经处理的 source ID", candidate_ids)
            continue
        if accepted_sequence and not is_split_repeat and positions[0] <= index_by_id[accepted_sequence[-1]]:
            reject(group_index, "source ID 顺序错误", candidate_ids)
            continue
        accepted_groups.append({"source_ids": list(candidate_ids), "text": text.strip()})
        accepted_sequence.extend(candidate_ids)
        accepted_ids.update(candidate_ids)
        for cue_id in candidate_ids:
            skipped_details.pop(cue_id, None)
        last_group_ids = candidate_ids

    missing_ids = [cue_id for cue_id in expected_ids if cue_id not in accepted_ids]
    for cue_id in missing_ids:
        skipped_details.setdefault(
            cue_id,
            _format_skip_detail(
                cue_by_id[cue_id],
                batch_number=batch_number,
                group_index=None,
                reason="模型未返回该字幕的可用 group（可能因输出遗漏、截断或 group 格式错误）",
            ),
        )
    skipped_ids = frozenset(skipped_details)
    details = tuple(skipped_details[cue_id] for cue_id in expected_ids if cue_id in skipped_details)
    return {"groups": accepted_groups}, skipped_ids, details, "cues"


def _response_mode(response: Mapping[str, JsonValue], *, item_aware_resegment: bool) -> str:
    if not item_aware_resegment:
        return "cues"
    raw_groups = response.get("groups")
    if not isinstance(raw_groups, list) or not raw_groups:
        # An empty/invalid batch is treated as an atom response so that a
        # valid atom response from another batch can still be combined safely.
        return "atoms"
    has_atoms = any(isinstance(group, dict) and "atom_ids" in group for group in raw_groups)
    return "atoms" if has_atoms else "cues"


def _sanitize_atom_response(
    response: Mapping[str, JsonValue],
    batch: Sequence[dict[str, JsonValue]],
    *,
    batch_number: int,
) -> tuple[JsonDict, frozenset[str], tuple[str, ...], str]:
    """Validate a word-boundary response, failing the whole batch safely.

    Atom responses intentionally carry no text.  The local side reconstructs
    text from the original mosp items, so an LLM cannot silently rewrite text
    while it is only being asked to resegment.
    """
    expected_atom_ids: list[str] = []
    for cue in batch:
        source_id = str(cue["id"])
        raw_items = cue.get("items")
        if not isinstance(raw_items, list):
            return _reject_atom_batch(batch, batch_number, "输入字幕缺少有效字词时间码")
        for item in raw_items:
            if not isinstance(item, dict) or not isinstance(item.get("id"), str):
                return _reject_atom_batch(batch, batch_number, "输入字词时间码格式无效")
            atom_id = str(item["id"])
            expected_atom_ids.append(atom_id)
    atom_positions = {atom_id: index for index, atom_id in enumerate(expected_atom_ids)}
    raw_groups = response.get("groups")
    if not isinstance(raw_groups, list) or not raw_groups:
        return _reject_atom_batch(batch, batch_number, "模型未返回有效 atom_ids")

    accepted_groups: list[JsonValue] = []
    flattened: list[str] = []
    seen: set[str] = set()
    for group_index, raw_group in enumerate(raw_groups, start=1):
        if not isinstance(raw_group, dict):
            return _reject_atom_batch(batch, batch_number, f"模型第 {group_index} 组不是对象")
        raw_ids = raw_group.get("atom_ids")
        if (
            not isinstance(raw_ids, list)
            or not raw_ids
            or not all(isinstance(value, str) and value for value in raw_ids)
        ):
            return _reject_atom_batch(batch, batch_number, f"模型第 {group_index} 组缺少有效 atom_ids")
        atom_ids = [str(value) for value in raw_ids]
        if any(atom_id not in atom_positions for atom_id in atom_ids):
            return _reject_atom_batch(batch, batch_number, f"模型第 {group_index} 组包含未知 atom ID")
        if any(atom_id in seen for atom_id in atom_ids):
            return _reject_atom_batch(batch, batch_number, f"模型第 {group_index} 组重复覆盖 atom ID")
        positions = [atom_positions[atom_id] for atom_id in atom_ids]
        if positions != list(range(positions[0], positions[0] + len(positions))):
            return _reject_atom_batch(batch, batch_number, f"模型第 {group_index} 组的 atom ID 必须连续")
        seen.update(atom_ids)
        flattened.extend(atom_ids)
        accepted_groups.append({"atom_ids": atom_ids})
    if flattened != expected_atom_ids:
        return _reject_atom_batch(batch, batch_number, "模型遗漏、重排或跳过了部分 atom ID")
    return {"groups": accepted_groups}, frozenset(), (), "atoms"


def _reject_atom_batch(
    batch: Sequence[dict[str, JsonValue]],
    batch_number: int,
    reason: str,
) -> tuple[JsonDict, frozenset[str], tuple[str, ...], str]:
    skipped = tuple(str(cue["id"]) for cue in batch)
    details = tuple(
        _format_skip_detail(cue, batch_number=batch_number, group_index=None, reason=reason)
        for cue in batch
    )
    return {"groups": []}, frozenset(skipped), details, "atoms"


def _apply_llm_groups_with_warnings(
    project: JsonDict,
    response: Mapping[str, JsonValue],
    *,
    strict_translation: bool = False,
    skipped_source_ids: Sequence[str] = (),
    preserve_items_on_equal_text: bool = True,
) -> tuple[JsonDict, tuple[str, ...]]:
    source_segments = _segments(project)
    raw_groups = response.get("groups")
    if not isinstance(raw_groups, list):
        raise ValueError("LLM response must contain a groups array")
    parsed: list[tuple[tuple[str, ...], str]] = []
    for group_index, raw_group in enumerate(raw_groups, start=1):
        if not isinstance(raw_group, dict):
            raise ValueError(f"LLM group {group_index} must be an object")
        raw_ids = raw_group.get("source_ids")
        if raw_ids is None and isinstance(raw_group.get("id"), str):
            raw_ids = [raw_group["id"]]
        if not isinstance(raw_ids, list) or not raw_ids or not all(isinstance(value, str) for value in raw_ids):
            raise ValueError(f"LLM group {group_index} must contain source_ids")
        text = raw_group.get("text")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"LLM group {group_index} must contain non-empty text")
        source_ids = tuple(value for value in raw_ids if isinstance(value, str))
        if len(set(source_ids)) != len(source_ids):
            raise ValueError(f"LLM group {group_index} cannot repeat a source ID inside one group")
        parsed.append((source_ids, text.strip()))
    all_expected = [f"c{index:04d}" for index in range(1, len(source_segments) + 1)]
    skipped = set(skipped_source_ids) & set(all_expected)
    expected = [cue_id for cue_id in all_expected if cue_id not in skipped]
    if strict_translation and (
        len(parsed) != len(expected)
        or any(source_ids != (expected_id,) for (source_ids, _text), expected_id in zip(parsed, expected))
    ):
        raise ValueError("translation output must preserve one source cue per group in order")
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
    index_by_id = {cue_id: index for index, cue_id in enumerate(all_expected)}
    regrouped = any(len(ids) != 1 for ids, _text in parsed) or len(parsed) != len(expected)
    new_segments = _build_segments(
        source_segments,
        parsed,
        index_by_id,
        preserve_items_on_equal_text=preserve_items_on_equal_text,
    )
    result = copy.deepcopy(project)
    result["segments"] = new_segments
    warnings: list[str] = []
    if regrouped:
        warnings.append("重分句后已移除逐词时间和贴纸/颜色引用，避免产生错误对齐。")
    return normalize_project(result), tuple(warnings)


def _apply_llm_atom_groups_with_warnings(
    project: JsonDict,
    response: Mapping[str, JsonValue],
    *,
    skipped_source_ids: Sequence[str] = (),
) -> tuple[JsonDict, tuple[str, ...]]:
    """Rebuild resegmented cues from the source mosp word timings."""
    source_segments = _segments(project)
    source_ids = [f"c{index:04d}" for index in range(1, len(source_segments) + 1)]
    skipped = set(skipped_source_ids)
    active_source_ids = [source_id for source_id in source_ids if source_id not in skipped]
    atom_by_id: dict[str, JsonDict] = {}
    source_atoms: dict[str, list[str]] = {}
    source_index_by_id = {source_id: index for index, source_id in enumerate(source_ids)}
    for source_id, segment in zip(source_ids, source_segments):
        items = _validated_items(segment)
        if items is None:
            raise ValueError(f"{source_id} 缺少可用于重新断句的有效字词时间码")
        atom_ids: list[str] = []
        for item_index, item in enumerate(items, 1):
            atom_id = f"{source_id}a{item_index:04d}"
            atom_ids.append(atom_id)
            atom_by_id[atom_id] = copy.deepcopy(item)
        source_atoms[source_id] = atom_ids

    active_atom_ids = [
        atom_id
        for source_id in active_source_ids
        for atom_id in source_atoms[source_id]
    ]
    atom_positions = {atom_id: index for index, atom_id in enumerate(active_atom_ids)}
    raw_groups = response.get("groups")
    if not isinstance(raw_groups, list) or not raw_groups:
        raise ValueError("LLM response must contain atom boundary groups")
    parsed: list[tuple[str, ...]] = []
    flattened: list[str] = []
    seen: set[str] = set()
    for group_index, raw_group in enumerate(raw_groups, start=1):
        if not isinstance(raw_group, dict):
            raise ValueError(f"LLM atom group {group_index} must be an object")
        raw_ids = raw_group.get("atom_ids")
        if not isinstance(raw_ids, list) or not raw_ids or not all(isinstance(value, str) for value in raw_ids):
            raise ValueError(f"LLM atom group {group_index} must contain atom_ids")
        atom_ids = tuple(str(value) for value in raw_ids)
        if any(atom_id not in atom_positions for atom_id in atom_ids):
            raise ValueError(f"LLM atom group {group_index} contains an unknown atom ID")
        if any(atom_id in seen for atom_id in atom_ids):
            raise ValueError(f"LLM atom group {group_index} repeats an atom ID")
        positions = [atom_positions[atom_id] for atom_id in atom_ids]
        if positions != list(range(positions[0], positions[0] + len(positions))):
            raise ValueError(f"LLM atom group {group_index} must contain consecutive atom IDs")
        parsed.append(atom_ids)
        flattened.extend(atom_ids)
        seen.update(atom_ids)
    if flattened != active_atom_ids:
        raise ValueError("LLM atom groups must cover all active atom IDs once, in order")

    atom_source_id = {
        atom_id: source_id
        for source_id, atom_ids in source_atoms.items()
        for atom_id in atom_ids
        if source_id in active_source_ids
    }
    source_occurrences: dict[str, int] = {}
    for atom_ids in parsed:
        group_source_ids = set(atom_source_id[atom_id] for atom_id in atom_ids)
        for source_id in group_source_ids:
            source_occurrences[source_id] = source_occurrences.get(source_id, 0) + 1
    regrouped = len(parsed) != len(active_source_ids) or any(
        len({atom_source_id[atom_id] for atom_id in atom_ids}) != 1 for atom_ids in parsed
    ) or any(
        source_occurrences[source_id] != 1 for source_id in active_source_ids
    )

    new_segments: list[JsonValue] = []
    for atom_ids in parsed:
        group_source_ids = tuple(dict.fromkeys(atom_source_id[atom_id] for atom_id in atom_ids))
        source_indexes = [source_index_by_id[source_id] for source_id in group_source_ids]
        source_group = [source_segments[index] for index in source_indexes]
        disabled_states = {source.get("disabled") is True for source in source_group}
        if len(disabled_states) > 1:
            raise ValueError("LLM atom groups cannot merge enabled and disabled cues")
        first_source = source_group[0]
        first_atom = atom_by_id[atom_ids[0]]
        last_atom = atom_by_id[atom_ids[-1]]
        if len(group_source_ids) == 1 and tuple(atom_ids) == tuple(source_atoms[group_source_ids[0]]):
            start = _required_ms(first_source, "start")
            end = _required_ms(first_source, "end")
        else:
            start = _required_ms(first_atom, "start")
            end = _required_ms(last_atom, "end")
        if end <= start:
            raise ValueError("LLM atom groups cannot create a non-positive subtitle duration")
        text = "".join(str(atom_by_id[atom_id]["text"]) for atom_id in atom_ids)
        is_full_source = (
            len(group_source_ids) == 1
            and tuple(atom_ids) == tuple(source_atoms[group_source_ids[0]])
            and not regrouped
        )
        segment = copy.deepcopy(first_source) if is_full_source else _copy_common_metadata(source_group)
        segment.update({
            "start": start,
            "end": end,
            "text": text,
            "items": [copy.deepcopy(atom_by_id[atom_id]) for atom_id in atom_ids],
        })
        if regrouped:
            for field in VISUAL_FIELDS:
                segment.pop(field, None)
        for field in SAFE_SCALARS:
            first_value = first_source.get(field)
            if first_value is not None and all(source.get(field) == first_value for source in source_group):
                segment[field] = copy.deepcopy(first_value)
        new_segments.append(segment)

    result = copy.deepcopy(project)
    result["segments"] = new_segments
    warnings: list[str] = []
    if regrouped:
        warnings.append("已按 mosp 中的字词时间码重新断句，并保留逐词时间对齐。")
    return normalize_project(result), tuple(warnings)


def _build_segments(
    sources: list[JsonDict],
    groups: Sequence[tuple[tuple[str, ...], str]],
    index_by_id: Mapping[str, int],
    *,
    preserve_items_on_equal_text: bool = True,
) -> list[JsonValue]:
    split_counts: dict[str, int] = {}
    for source_ids, _text in groups:
        if len(source_ids) == 1:
            split_counts[source_ids[0]] = split_counts.get(source_ids[0], 0) + 1
    split_positions: dict[str, int] = {}
    result: list[JsonValue] = []
    occurrences = [cue_id for source_ids, _text in groups for cue_id in source_ids]
    regrouped = any(len(source_ids) != 1 for source_ids, _text in groups) or len(set(occurrences)) != len(occurrences)
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
        if regrouped:
            segment.pop("items", None)
        elif not unchanged:
            if preserve_items_on_equal_text:
                reconciled_items = _reconcile_items(
                    str(first.get("text") or ""),
                    first.get("items"),
                    text,
                )
                if reconciled_items is None:
                    segment.pop("items", None)
                else:
                    segment["items"] = reconciled_items
            else:
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


def _validated_items(segment: JsonDict) -> list[JsonDict] | None:
    """Return item timing data only when it can safely be used as text atoms."""
    text = segment.get("text")
    raw_items = segment.get("items")
    segment_start = segment.get("start")
    segment_end = segment.get("end")
    if (
        not isinstance(text, str)
        or not isinstance(raw_items, list)
        or not raw_items
        or type(segment_start) is not int
        or type(segment_end) is not int
        or segment_end <= segment_start
    ):
        return None
    items: list[JsonDict] = []
    previous_start = segment_start
    previous_end = segment_start
    text_parts: list[str] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict):
            return None
        item_text = raw_item.get("text")
        item_start = raw_item.get("start")
        item_end = raw_item.get("end")
        if (
            not isinstance(item_text, str)
            or type(item_start) is not int
            or type(item_end) is not int
            or item_start < segment_start
            or item_end > segment_end
            or item_end < item_start
            or item_start < previous_start
            or item_end < previous_end
        ):
            return None
        text_parts.append(item_text)
        items.append(raw_item)
        previous_start = item_start
        previous_end = item_end
    if "".join(text_parts) != text:
        return None
    return items


def _has_complete_items(project: JsonDict) -> bool:
    segments = _segments(project)
    return bool(segments) and all(_validated_items(segment) is not None for segment in segments)


def _reconcile_items(
    original_text: str,
    raw_items: JsonValue,
    new_text: str,
) -> list[JsonDict] | None:
    """Reuse item ranges when a text edit keeps each atom's character width.

    This deliberately uses a conservative rule.  A same-length edit is only
    safe when every existing item's text can be replaced by a slice of the
    same length; insertion, deletion, invalid item data, and boundary changes
    drop items for that segment instead of attaching stale timings.
    """
    if original_text == new_text:
        if isinstance(raw_items, list) and all(isinstance(item, dict) for item in raw_items):
            return copy.deepcopy(raw_items)
        return None
    if not isinstance(raw_items, list) or not raw_items or len(new_text) != len(original_text):
        return None
    item_texts: list[str] = []
    items: list[JsonDict] = []
    for raw_item in raw_items:
        if not isinstance(raw_item, dict) or not isinstance(raw_item.get("text"), str):
            return None
        item_texts.append(str(raw_item["text"]))
        items.append(copy.deepcopy(raw_item))
    if "".join(item_texts) != original_text:
        return None
    offset = 0
    for item, item_text in zip(items, item_texts):
        width = len(item_text)
        item["text"] = new_text[offset : offset + width]
        offset += width
    if offset != len(new_text):
        return None
    return items


def _combine_llm_responses(responses: Sequence[Mapping[str, JsonValue]]) -> JsonDict:
    groups: list[JsonValue] = []
    for response in responses:
        raw_groups = response.get("groups")
        if not isinstance(raw_groups, list):
            raise ValueError("LLM response must contain a groups array")
        groups.extend(raw_groups)
    return {"groups": groups}


def _protocol_prompt(
    operation_prompt: str,
    custom_prompt: str,
    *,
    strict_translation: bool = False,
    item_aware_resegment: bool = False,
) -> str:
    task = f"\n任务：{operation_prompt}" if operation_prompt else ""
    custom = f"\n用户附加要求：{custom_prompt}" if custom_prompt else ""
    if item_aware_resegment:
        return (
            "你处理的是带字词时间码的字幕。输入按顺序包含 cue ID、文字和 items；每个 item 都有不透明 atom ID 与文字。"
            "本次只允许重新组织字幕边界，不得改写、增删或重排任何文字。"
            "不要猜测、输出或修改时间。只返回严格有效的 JSON 对象，不要 Markdown 代码块、注释、解释或额外文字。"
            "返回格式：{\"groups\":[{\"atom_ids\":[\"c0001a0001\",\"c0001a0002\"]}]}。"
            "atom_ids 必须按输入顺序完整覆盖，每个 atom ID 恰好出现一次；每组必须是连续的 atom ID。"
            "不得返回 source_ids、添加未知 atom ID、遗漏 atom ID 或返回空组。"
            f"{task}{custom}"
        )
    grouping = (
        "source_ids 必须按输入顺序完整覆盖；每组只能包含一个 source ID，且每个 ID 只能出现一次；不得合并、拆分或重排相邻字幕。"
        if strict_translation
        else "source_ids 必须按输入顺序完整覆盖；合并连续字幕时放入同一组，拆分一条字幕时可让连续多组重复同一个 ID。"
    )
    return (
        "你处理的是字幕，不是普通文章。输入只有按顺序排列的不透明 cue ID 与文字。"
        "不要猜测、输出或修改时间。只返回严格有效的 JSON 对象，不要 Markdown 代码块、注释、解释或额外文字。"
        "返回格式：{\"groups\":[{\"source_ids\":[\"c0001\"],\"text\":\"...\"}]}。"
        "每个 group 都必须包含非空 text 字符串；text 中的双引号、反斜杠和换行必须按 JSON 规则转义。"
        f"{grouping}"
        "不得重排 ID、跳过 ID、添加未知 ID 或返回空文字。"
        f"{task}{custom}"
    )


def _llm_cues(project: JsonDict, *, include_items: bool = False) -> list[dict[str, JsonValue]]:
    cues: list[dict[str, JsonValue]] = []
    for index, segment in enumerate(_segments(project), 1):
        cue: dict[str, JsonValue] = {"id": f"c{index:04d}", "text": str(segment["text"])}
        if include_items:
            items = _validated_items(segment)
            if items is None:
                raise ValueError(f"c{index:04d} 缺少可用于重新断句的有效字词时间码")
            cue["items"] = [
                {"id": f"c{index:04d}a{item_index:04d}", "text": str(item["text"])}
                for item_index, item in enumerate(items, 1)
            ]
        cues.append(cue)
    return cues


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
    output_directory: Path | None = None,
) -> SubtitleArtifact:
    return write_artifacts(
        project,
        source_project_path=source_project,
        source_srt_path=source_srt,
        operation=operation,
        write_project=mode in {OutputMode.JSON, OutputMode.BOTH},
        write_srt=mode in {OutputMode.SRT, OutputMode.BOTH},
        warnings=warnings,
        output_directory=output_directory,
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
