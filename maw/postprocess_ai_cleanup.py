# pyright: reportAny=false, reportArgumentType=false, reportUnknownVariableType=false, reportReturnType=false, reportAttributeAccessIssue=false

"""Recording-first spoken-word cleanup from a source-preserving editing draft.

The transcript is authoritative: the manuscript is only evidence.  The LLM
inserts strikeouts and review notes; a fixed parser maps complete source items
to reversible cuts. Local validators downgrade unsafe cuts to review, and any LLM
or protocol failure leaves the source files untouched.
"""

from __future__ import annotations

import difflib
import copy
import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Final

from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup_safety import (
    PURE_INTERJECTIONS,
    WHOLE_UTTERANCE_INTERJECTIONS,
    english_hesitation_only,
    information_loss_reason,
    protected_information_loss_reason,
)
from maw.postprocess_ai_cleanup_timeline import parse_timeline, draft_line
from maw.postprocess_ai_cleanup_diagnostics import CleanupTrace, record_raw_response
from maw.postprocess_ai_cleanup_review import review_decisions
from maw.postprocess_ai_cleanup_items import english_hesitation_removal, collapse_echo, scoped_item_ranges, remaining_text, item_text_spans, active_deleted_items
from maw.postprocess_io import SubtitleArtifact, write_artifacts
from maw.postprocess_llm import (
    MAX_RESPONSE_ATTEMPTS,
    LlmClientError,
    LlmDelta,
    LlmSettings,
    _loads_with_trailing_repair,
    _request_completion,
    _response_content,
    _strip_json_fence,
)
from maw.postprocess_match import (
    _load_input,
    _normalize_text,
    _read_script,
    clean_markdown_inline_symbols,
)
from maw.postprocess_match import _NormalizedText
from maw.project_preview import JsonDict, JsonValue
from maw.script_alignment import (
    DEFAULT_GAP_REMOVE_OPERATION_MODE,
    MAWE_GAP_REMOVE_DEFAULTS,
    _decorate_gap_ranges,
    _gap_ranges_from_provenance,
    _normalize_gap_provenance,
    _replace_provenance_source,
)


GAP_REMOVE_SCHEMA: Final[str] = "moy.asr.gap_remove.v1"
MARKERS_SCHEMA: Final[str] = "moy.asr.markers.v1"

# json_schema 约束载荷：仅约束结构（端点语法层），语义仍由本地协议校验兜底。
AI_CLEANUP_DECISIONS_JSON_SCHEMA: Final[dict[str, object]] = {
    "name": "maw_ai_cleanup_decisions",
    "schema": {
        "type": "object",
        "properties": {
            "decisions": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "decision": {"type": "string"},
                        "scriptLine": {"type": "string"},
                        "reason": {"type": "string"},
                        "evidence": {"type": "string"},
                        "altTakeId": {"type": "string"},
                        "removeItemIds": {"type": "array", "items": {"type": "string"}},
                        "removeItemRanges": {"type": "array", "items": {"type": "array", "items": {"type": "string"}}},
                    },
                    "required": ["id", "decision", "scriptLine"],
                },
            }
        },
        "required": ["decisions"],
    },
}
AI_CLEANUP_REVIEWS_JSON_SCHEMA: Final[dict[str, object]] = {
    "name": "maw_ai_cleanup_reviews",
    "schema": {
        "type": "object",
        "properties": {
            "reviews": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string"},
                        "reason": {"type": "string"},
                    },
                    "required": ["id", "reason"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["reviews"],
        "additionalProperties": False,
    },
}


MARKER_REVIEW_COLOR: Final[str] = "#f5a623"
MARKER_REVIEW_REASON_MAX_LENGTH: Final[int] = 300
MARKER_NOTE_MAX_LENGTH: Final[int] = 500
MARKER_NAME_MAX_LENGTH: Final[int] = 120

# 与文稿相似度的分级阈值：达到 exact 记「文稿已对应」，达到 fuzzy 记「改说」，
# 以下视为文稿中没有对应行。
SCRIPT_EXACT_RATIO: Final[float] = 0.85
SCRIPT_FUZZY_RATIO: Final[float] = 0.5
# 备用片段（altTakeId）与当前片段的最低相似度。
ALT_TAKE_MIN_RATIO: Final[float] = 0.6
# 文稿行单调分配时的前向窗口：允许跳过少量缺失行，仍按时间顺序对齐。
SCRIPT_LOOKAHEAD: Final[int] = 4
# 单次 LLM 请求的片段上限；超出时分批请求，任何一批失败即整体失败。
CLIPS_PER_REQUEST: Final[int] = 80
CONTEXT_CLIPS: Final[int] = 3
# 机械重复判定的最短归一化长度，避免「嗯」「对」这类短词误判。
REPEAT_MIN_CHARS: Final[int] = 6

DECISION_KEEP: Final[str] = "keep"
DECISION_DISCARD: Final[str] = "discard"
DECISION_REVIEW: Final[str] = "review"
DECISION_EDIT: Final[str] = "edit"

# 本地流程用语模式：试麦、报遍数、操作指令。只用于给「无备用片段」的 discard
# 提供本地佐证；命中不了的降级为待复核，绝不因此扩大移除范围。
_PROCESS_TALK_PATTERN: Final[re.Pattern[str]] = re.compile(
    "试麦|麦克风|话筒|听得到|听得见|能听见|测试一下|录一下|开始了吗|开始吧|"
    "录好了|录完了吗|还在录吗|关了吗|重来|重新来|重新开始|重新录|再来一遍|再来一次|刚才不算|"
    "刚才那段|上一遍|这一遍|第[一二三四五六七八九十0-9]+遍|删掉|剪掉|不要这段|掐掉"
)
# 整段只剩纯感叹词（哎、嗯等）时没有命题内容，无需重复或流程用语佐证即可移除；
# 「对」「可以」这类可能承载应答的短词不在白名单内。
_UTTERANCE_FILLER_PATTERN: Final[re.Pattern[str]] = re.compile(f"[{WHOLE_UTTERANCE_INTERJECTIONS}]+")

_CONTROL_CHARS: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f]+")


class AiCleanupError(RuntimeError):
    """Raised when the AI cleanup pass cannot produce a trustworthy result."""


@dataclass(frozen=True, slots=True)
class AiCleanupRequest:
    project_path: Path | None
    srt_path: Path | None
    script_path: Path | None
    output_mode: OutputMode
    output_directory: Path | None = None
    media_path: Path | None = None
    clean_markdown_symbols: bool = True
    notes: str = ""
    review_enabled: bool = False
    generate_comparison: bool = False


@dataclass(slots=True)
class _Clip:
    id: str
    segment_index: int
    text: str
    norm: _NormalizedText
    items: list[Mapping[str, object]]
    source_item_indices: list[int]
    script_line: str = ""
    script_line_index: int = -1
    script_match: str = "none"


def llm_complete(
    settings: LlmSettings,
    *,
    on_delta: LlmDelta | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    on_response: Callable[[object | None], None] | None = None,
) -> Callable[[str, list[dict[str, str]]], Mapping[str, object]]:
    """Build the transport closure used by :func:`run_ai_cleanup`.

    Editing passes return raw Markdown; only the final sparse audit uses JSON.
    Audit syntax errors retry once. The cleanup protocol loop validates every
    source row and retries malformed editing drafts.  Cancellation is the
    caller's concern and is wrapped around the returned closure.
    """

    def complete(prompt: str, clips: list[dict[str, str]]) -> Mapping[str, object]:
        last_error = "响应不是有效的 JSON。"
        for attempt in range(MAX_RESPONSE_ATTEMPTS):
            current_prompt = (
                prompt if not attempt else _retry_prompt(prompt, last_error, json_output=True)
            )
            if on_delta is not None:
                # Each request is a distinct batch/protocol attempt. Clear
                # partial text before retrying malformed provider output.
                on_delta("reset", "")
            body = _request_completion(
                settings,
                current_prompt,
                clips,
                on_delta=on_delta,
                is_cancelled=is_cancelled,
                on_response=on_response,
                use_json_format=bool(clips and all("proposed" in row for row in clips)),
                response_json_schema=AI_CLEANUP_REVIEWS_JSON_SCHEMA if clips and all("proposed" in row for row in clips) else None,
            )
            content = _response_content(body)
            record_raw_response(current_prompt, content)
            if not clips or not all("proposed" in row for row in clips):
                return {"timeline": content}
            try:
                return _loads_with_trailing_repair(_strip_json_fence(content))
            except json.JSONDecodeError as error:
                last_error = f"JSON syntax error: {error.msg} at character {error.pos}"
        raise LlmClientError(
            f"LLM returned invalid JSON after retry: {last_error}",
            category="protocol",
            operation="ai_cleanup",
        )

    return complete


def run_ai_cleanup(
    request: AiCleanupRequest,
    *,
    complete: Callable[[str, list[dict[str, str]]], Mapping[str, object]],
    on_status: Callable[[str], None] | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    begin_commit: Callable[[], bool] | None = None,
) -> SubtitleArtifact:
    """Run the recording-first cleanup and write ``ai_cleanup`` artifacts."""

    project, source_project, source_srt = _load_input(
        request.project_path, request.srt_path
    )
    script_path, script_text = _read_script(request.script_path) if request.script_path is not None else (None, "")
    if request.clean_markdown_symbols:
        script_text = clean_markdown_inline_symbols(script_text)
    script_lines = [line.strip() for line in script_text.splitlines() if line.strip()]
    if request.script_path is not None and not script_lines:
        raise AiCleanupError("文稿整理需要文稿中至少有一行文字。")

    segments = project.get("segments")
    if not isinstance(segments, list) or not segments:
        raise AiCleanupError("字幕工程中没有可整理的字幕段。")

    original_project = copy.deepcopy(project)
    clips = _build_clips(segments, script_lines, project=project)
    _raise_if_cancelled(is_cancelled)
    trace = CleanupTrace(complete, base=source_project or source_srt, directory=request.output_directory)
    try:
        decisions = _collect_decisions(
            trace, clips, script_lines, on_status=on_status, notes=request.notes,
            on_protocol_error=trace.reject,
        )
        _raise_if_cancelled(is_cancelled)
        resolved, reasons = _resolve_decisions(clips, decisions)
        trace.checkpoint("首次整理本地校验", decisions=decisions, resolved=resolved, reasons=reasons)
        if request.review_enabled and clips:
            candidates = _collect_decisions(
                trace, clips, script_lines, on_status=on_status, notes=request.notes,
                scan_state=(decisions, resolved), on_protocol_error=trace.reject,
            )
            _raise_if_cancelled(is_cancelled)
            for clip_id, candidate in candidates.items():
                if candidate.get("decision") == DECISION_KEEP:
                    continue
                if candidate.get("decision") == DECISION_EDIT and resolved[clip_id] == DECISION_EDIT:
                    candidate = {**candidate, "deleteItems": sorted(set(decisions[clip_id].get("deleteItems", [])) | set(candidate.get("deleteItems", [])))}
                    if len(candidate["deleteItems"]) >= len(next(clip.items for clip in clips if clip.id == clip_id)):
                        candidate = {**candidate, "decision": DECISION_REVIEW, "deleteItems": [], "reason": "累计划删涵盖整段，需要复核"}
                decisions[clip_id] = candidate
            resolved, reasons = _resolve_decisions(clips, decisions)
            trace.checkpoint("漏清扫描本地校验", decisions=decisions, resolved=resolved, reasons=reasons)
            flags = review_decisions(
                trace,
                _readthrough_rows(segments, clips, decisions, resolved),
                notes=request.notes,
                on_status=on_status, on_protocol_error=trace.reject,
            )
            _raise_if_cancelled(is_cancelled)
            for clip_id, reason in flags.items():
                resolved[clip_id] = DECISION_REVIEW
                reasons[clip_id] = reason
            trace.checkpoint("剪后安全审计本地校验", flags=flags, resolved=resolved, reasons=reasons)
    except LlmClientError as error:
        raise trace.failure(error) from error
    except Exception as error:
        trace.status = "中断"
        trace.checkpoint("中断", error=str(error))
        raise

    removed_ranges: list[dict[str, object]] = []
    discarded_main_ids: set[str] = set()
    ai_markers: list[dict[str, object]] = []
    stats = {
        "matchedLines": 0,
        "rephrased": 0,
        "extrasKept": 0,
        "removed": 0,
        "pendingReview": 0,
        "editedSegments": 0,
        "removedItems": 0,
    }
    clip_segments = {clip.segment_index for clip in clips}
    for clip in clips:
        outcome = resolved[clip.id]
        segment = segments[clip.segment_index]
        assert isinstance(segment, dict)
        if outcome == DECISION_DISCARD:
            local = _local_removal(clip, decisions[clip.id])[0]
            if local is not None:
                source_indices = [clip.source_item_indices[index] for first, last in local for index in range(first, last)]
                ranges = scoped_item_ranges(segment, source_indices)
                removed_ranges.extend(ranges)
                for removed_range in ranges:
                    scope = {**removed_range, "text": removed_range["cleanup_scope"]["text"]}
                    ai_markers.append(_ai_annotation(scope, "删除", reasons[clip.id] or "可核验的局部口吃", pending=False))
                stats["removed"] += 1
                continue
            segment["disabled"] = True
            discarded_main_ids.add(str(segment["id"]))
            removed_ranges.append(
                {
                    "start": int(segment.get("start", 0)),
                    "end": int(segment.get("end", 0)),
                }
            )
            reason = reasons[clip.id] or "有证据的无效录制内容"
            alt = decisions[clip.id].get("altTakeId")
            if alt:
                alternative = next((item.text for item in clips if item.id == alt), "")
                reason += f"；替代字幕：{alternative[:80]}"
            ai_markers.append(_ai_annotation(segment, "删除", reason, pending=False))
            stats["removed"] += 1
            continue
        if outcome == DECISION_EDIT:
            deleted = decisions[clip.id].get("deleteItems", [])
            ranges = scoped_item_ranges(segment, [clip.source_item_indices[i] for i in deleted])
            removed_ranges.extend(ranges)
            for removed_range in ranges:
                ai_markers.append(_ai_annotation({**segment, **removed_range}, "删除", reasons[clip.id], pending=False))
            stats["editedSegments"] += 1
            stats["removedItems"] += len(deleted)
            continue
        if outcome == DECISION_REVIEW:
            reason = reasons[clip.id] or "AI 建议复核"
            operation = "替代项" if decisions[clip.id].get("altTakeId") else "复核"
            ai_markers.append(_ai_annotation(segment, operation, reason))
            stats["pendingReview"] += 1
            continue
        if clip.script_match == "exact":
            stats["matchedLines"] += 1
        elif clip.script_match == "rephrased":
            stats["rephrased"] += 1
        else:
            stats["extrasKept"] += 1

    # 缺少字词时间的段不送 LLM，也不移除：保留原文并生成复核标记。
    for index, segment in enumerate(segments):
        if (
            not isinstance(segment, dict)
            or segment.get("disabled") is True
            or index in clip_segments
        ):
            continue
        if _segment_has_item_timings(segment):
            continue
        reason = "缺少字词时间，无法安全移除"
        ai_markers.append(_ai_annotation(segment, "复核", reason))
        stats["pendingReview"] += 1

    if discarded_main_ids:
        _disable_bound_extensions(project, discarded_main_ids)
    if removed_ranges:
        project["gap_remove"] = _build_gap_remove(project, removed_ranges)
    if ai_markers:
        project["markers"] = _build_markers_field(ai_markers, project.get("markers"))

    if is_cancelled is not None and is_cancelled():
        raise trace.failure(LlmClientError("操作已取消。", category="cancelled", operation="ai_cleanup"))

    warnings = (
        f"文稿来源：{script_path}" if script_path else "无参考文稿：按原始转写整理。",
        f"AI 整理：整段移除 {stats['removed']} 段，局部删减 {stats['editedSegments']} 段 / {stats['removedItems']} 个词项，待核查 {stats['pendingReview']} 段。",
    )
    if begin_commit is not None and not begin_commit():
        raise trace.failure(LlmClientError("操作已取消。", category="cancelled", operation="ai_cleanup"))
    try:
        artifact = write_artifacts(
            project,
            source_project_path=source_project,
            source_srt_path=source_srt,
            operation="ai_cleanup",
            write_project=request.output_mode in {OutputMode.JSON, OutputMode.BOTH},
            write_srt=request.output_mode in {OutputMode.SRT, OutputMode.BOTH},
            warnings=warnings,
            output_directory=request.output_directory,
            media_path=request.media_path,
            stats=stats,
            comparison_source=original_project if request.generate_comparison else None,
            comparison_rows=[{ "id": str(segments[c.segment_index]["id"]), "decision": resolved[c.id], "reason": reasons[c.id], "deleteItems": [c.source_item_indices[i] for i in decisions[c.id].get("deleteItems", [])] if resolved[c.id] == DECISION_EDIT else [] } for c in clips],
        )
    except Exception as error:
        trace.status = "写出失败"
        trace.checkpoint("写出失败", error=str(error))
        raise
    trace.status = "成功"
    trace.checkpoint("最终结果", stats=stats, project=artifact.project_path, srt=artifact.srt_path)
    if trace.save_error:
        return replace(artifact, warnings=(*artifact.warnings, f"AI 整理记录保存失败：{trace.save_error}"))
    return artifact


def _raise_if_cancelled(is_cancelled: Callable[[], bool] | None) -> None:
    if is_cancelled is not None and is_cancelled():
        raise LlmClientError(
            "操作已取消。", category="cancelled", operation="ai_cleanup"
        )


def build_clips(
    segments: Sequence[JsonValue], script_lines: Sequence[str]
) -> list[dict[str, str]]:
    """Return the LLM clip payload (temp ids, text only, no timings or paths)."""

    return _clips_payload(
        _build_clips(list(segments), list(script_lines)), script_lines
    )


def _readthrough_rows(
    segments: Sequence[JsonValue],
    clips: Sequence[_Clip],
    decisions: Mapping[str, Mapping[str, object]],
    resolved: Mapping[str, str],
) -> list[dict[str, str]]:
    by_index = {clip.segment_index: clip for clip in clips}
    by_id = {clip.id: clip for clip in clips}
    rows: list[dict[str, str]] = []
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict) or segment.get("disabled") is True:
            continue
        text = str(segment.get("text") or "").strip()
        if not text:
            continue
        clip = by_index.get(index)
        if clip is None:
            rows.append(
                {
                    "id": f"u{index + 1:03d}",
                    "asrText": text,
                    "proposed": "review",
                    "contextOnly": "true",
                }
            )
            continue
        deleted = decisions[clip.id].get("deleteItems", []) if resolved[clip.id] == DECISION_EDIT else []
        row = {"id": clip.id, "asrText": remaining_text(clip.text, clip.items, deleted), "proposed": resolved[clip.id]}
        local, _ = _local_removal(clip, decisions[clip.id])
        if local is not None and resolved[clip.id] == DECISION_DISCARD:
            deleted = [index for first, last in local for index in range(first, last)]
            row["retainedText"] = remaining_text(clip.text, clip.items, deleted)
            row["removedText"] = "".join(str(clip.items[index]["text"]) for index in deleted)
            row["proposed"] = "partial"
        if deleted:
            row["originalText"] = clip.text
            row["discardedText"] = "".join(str(clip.items[index]["text"]) for index in deleted)
        refs = decisions[clip.id].get("altTakeIds", []) or [str(decisions[clip.id].get("altTakeId") or "")]
        alternatives = [by_id[ref] for ref in refs if ref in by_id and resolved[ref] not in {DECISION_DISCARD, DECISION_EDIT}]
        if alternatives:
            row["alternativeId"] = ",".join(other.id for other in alternatives)
            row["alternativeText"] = "".join(other.text for other in alternatives)
        rows.append(row)
    return rows


def _build_clips(segments: list[JsonValue], script_lines: list[str], *, project: Mapping[str, object] | None = None) -> list[_Clip]:
    clips: list[_Clip] = []
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict) or segment.get("disabled") is True:
            continue
        text = str(segment.get("text") or "").strip()
        if not text or not _segment_has_item_timings(segment):
            # 没有文字或没有字词时间的段不参与自动移除；后者生成待复核标记。
            continue
        deleted = active_deleted_items(project or {}, segment["items"], segment=segment)
        source_indices = [i for i in range(len(segment["items"])) if i not in deleted]
        text = remaining_text(text, segment["items"], deleted)
        if not text or not source_indices:
            continue
        clips.append(
            _Clip(
                id=f"c{len(clips) + 1:03d}",
                segment_index=index,
                text=text,
                norm=_normalize_text(text),
                items=[segment["items"][i] for i in source_indices],
                source_item_indices=source_indices,
            )
        )
    _assign_script_lines(clips, script_lines)
    return clips


def _segment_has_item_timings(segment: Mapping[str, object]) -> bool:
    items = segment.get("items")
    if not isinstance(items, list) or not items:
        return False
    valid = all(
        isinstance(item, dict)
        and isinstance(item.get("text"), str)
        and type(item.get("start")) is int
        and type(item.get("end")) is int
        and int(segment.get("start", 0)) <= item["start"] < item["end"] <= int(segment.get("end", 0))
        for item in items
    )
    return valid and all(items[i]["end"] <= items[i + 1]["start"] for i in range(len(items) - 1)) and item_text_spans(str(segment.get("text") or ""), items) is not None


def _assign_script_lines(clips: list[_Clip], script_lines: list[str]) -> None:
    """Monotonically assign each clip to at most one script line."""

    if not clips:
        return
    lines_norm = [_normalize_text(line) for line in script_lines]
    cursor = 0
    for clip in clips:
        best_index = -1
        best_ratio = 0.0
        for line_index in range(
            cursor, min(cursor + SCRIPT_LOOKAHEAD, len(lines_norm))
        ):
            ratio = 1.0 if clip.norm.value in lines_norm[line_index].value else difflib.SequenceMatcher(
                None, clip.norm.value, lines_norm[line_index].value, autojunk=False
            ).ratio()
            if ratio > best_ratio:
                best_index = line_index
                best_ratio = ratio
        if best_index < 0 or best_ratio < SCRIPT_FUZZY_RATIO:
            continue
        clip.script_line_index = best_index
        clip.script_line = script_lines[best_index]
        clip.script_match = "exact" if best_ratio >= SCRIPT_EXACT_RATIO else "rephrased"
        cursor = best_index


def _collect_decisions(
    complete: Callable[[str, list[dict[str, str]]], Mapping[str, object]],
    clips: list[_Clip],
    script_lines: list[str],
    *,
    on_status: Callable[[str], None] | None,
    notes: str = "",
    scan_state: tuple[Mapping[str, Mapping[str, object]], Mapping[str, str]] | None = None,
    on_protocol_error: Callable[[str], None] | None = None,
) -> dict[str, Mapping[str, object]]:
    decisions: dict[str, Mapping[str, object]] = {}
    for batch_start in range(0, len(clips), CLIPS_PER_REQUEST):
        if on_status is not None:
            on_status("toolbox_status_ai_cleanup")
        batch_end = batch_start + CLIPS_PER_REQUEST
        batch = clips[batch_start:batch_end]
        if scan_state is not None:
            batch = [clip for clip in batch if scan_state[1][clip.id] != DECISION_DISCARD]
            if not batch:
                continue
        context = clips[
            max(0, batch_start - CONTEXT_CLIPS) : min(
                len(clips), batch_end + CONTEXT_CLIPS
            )
        ]
        decisions.update(
            _complete_batch(complete, batch, script_lines, context=context, notes=notes, scan_state=scan_state, on_protocol_error=on_protocol_error)
        )
    return decisions


def _complete_batch(
    complete: Callable[[str, list[dict[str, str]]], Mapping[str, object]],
    batch: Sequence[_Clip],
    script_lines: Sequence[str],
    *,
    context: Sequence[_Clip] = (),
    notes: str = "",
    scan_state: tuple[Mapping[str, Mapping[str, object]], Mapping[str, str]] | None = None,
    on_protocol_error: Callable[[str], None] | None = None,
) -> dict[str, Mapping[str, object]]:
    expected_ids = {clip.id for clip in batch}
    prompt = _system_prompt(notes)
    references = context or batch
    payload = _clips_payload(references, script_lines, target_ids=expected_ids)
    if scan_state is not None:
        prompt += "\n这是漏清扫描：通读 currentText 连成的剩余稿，寻找遗漏的真重复、未完成起头和口误。keep 表示不新增修改；新删除仍须完整覆盖证据，不能按删减比例扩删。在原始行上保留已有划删，再补划遗漏；已删词不能作为覆盖证据。输出完整目标行的编辑稿。"
        by_id = {clip.id: clip for clip in references}
        for row in payload:
            clip = by_id[row["id"]]
            outcome = scan_state[1][clip.id]
            deleted = scan_state[0][clip.id].get("deleteItems", []) if outcome == DECISION_EDIT else []
            row["currentText"] = "" if outcome == DECISION_DISCARD else remaining_text(clip.text, clip.items, deleted)
            row["currentDecision"] = outcome
            row["currentTimeline"] = draft_line(clip.id, clip.text, deleted, clip.items)
    prompt += "\n本轮仅输出以下目标 ID，严格保持顺序（其余行只读，不输出）：" + "、".join(clip.id for clip in batch)
    last_error = ""
    for attempt in range(MAX_RESPONSE_ATTEMPTS):
        _ = attempt
        parsed = complete(
            prompt if not last_error else _retry_prompt(prompt, last_error), payload
        )
        if isinstance(parsed, Mapping) and "timeline" in parsed:
            try:
                parsed = parse_timeline(str(parsed["timeline"]), payload, {clip.id: clip.items for clip in batch})
                _infer_draft_alternatives(clips=references, parsed=parsed, scan_state=scan_state)
            except ValueError as error:
                last_error = str(error)
                if on_protocol_error:
                    on_protocol_error(last_error)
                continue
        protocol_error = _protocol_error(
            parsed, expected_ids, reference_ids={clip.id for clip in references},
            item_counts={clip.id: len(clip.items) for clip in batch},
        )
        if protocol_error is None:
            return {
                str(decision.get("id")): decision
                for decision in parsed.get("decisions", [])
                if isinstance(decision, Mapping)
            }
        last_error = protocol_error
        if on_protocol_error:
            on_protocol_error(last_error)
    raise LlmClientError(
        f"AI 整理响应在重试后仍未通过协议校验：{last_error}",
        category="protocol",
        operation="ai_cleanup",
    )


def _infer_draft_alternatives(*, clips, parsed, scan_state=None):
    """Infer evidence from retained source expressions, never model timecodes."""
    decisions = {row["id"]: row for row in parsed["decisions"]}
    def retained(clip):
        proposed = decisions.get(clip.id, {}).get("decision", "keep")
        return proposed in {DECISION_KEEP, DECISION_REVIEW} and (scan_state is None or scan_state[1][clip.id] not in {DECISION_DISCARD, DECISION_EDIT})
    for clip in clips:
        row = decisions.get(clip.id)
        if row is None or row["decision"] not in {DECISION_DISCARD, DECISION_EDIT}:
            continue
        source = collapse_echo(clip.text) if row["decision"] == DECISION_DISCARD else "".join(str(clip.items[i]["text"]) for i in row["deleteItems"])
        for start, other in enumerate(clips):
            if other.id == clip.id or not retained(other):
                continue
            if row["decision"] == DECISION_EDIT and abs(other.segment_index - clip.segment_index) > 3:
                continue
            group = []
            for candidate in clips[start:start + 4]:
                if candidate.id == clip.id or not retained(candidate) or group and candidate.segment_index != group[-1].segment_index + 1:
                    break
                group.append(candidate)
                replacement = collapse_echo("".join(item.text for item in group))
                if information_loss_reason(source, replacement) is None:
                    row["altTakeIds"] = [item.id for item in group]
                    break
            if row.get("altTakeIds"):
                break


def _clips_payload(
    batch: Sequence[_Clip],
    script_lines: Sequence[str],
    *,
    target_ids: set[str] | None = None,
) -> list[dict[str, str]]:
    """Return the wire payload: temp ids and text only, no timings or paths."""

    payload: list[dict[str, str]] = []
    for clip in batch:
        line_index = clip.script_line_index
        payload.append(
            {
                "id": clip.id,
                "asrText": clip.text,
                "scriptLine": clip.script_line,
                "prevScriptLine": _line_at(script_lines, line_index - 1),
                "nextScriptLine": _line_at(script_lines, line_index + 1),
                "scriptMatch": clip.script_match,
                "itemTexts": json.dumps([item["text"] for item in clip.items], ensure_ascii=False),
                "sourceLine": draft_line(clip.id, clip.text),
                "contextText": "\n".join(f"{other.id}: {other.text}" for other in batch[max(0, len(payload) - 3):len(payload) + 4]),
            }
        )
        if target_ids is not None and clip.id not in target_ids:
            payload[-1]["contextOnly"] = "true"
        if clip.items:
            payload[-1]["items"] = json.dumps([
                {"id": f"{clip.id}:i{index + 1:03d}", "text": item["text"]}
                for index, item in enumerate(clip.items)
            ], ensure_ascii=False)
    return payload


def _line_at(lines: Sequence[str], index: int) -> str:
    return lines[index] if 0 <= index < len(lines) else ""


def _system_prompt(notes: str = "") -> str:
    from maw.postprocess_ai_cleanup_prompt import cleanup_prompt
    return cleanup_prompt(notes)


def _retry_prompt(prompt: str, reason: str, *, json_output: bool = False) -> str:
    return (
        f"{prompt}\n\n上一次输出未通过本地协议校验（{reason}）。请重新处理同一批输入并完整返回结果。"
        + (
            "只输出一个严格有效的 JSON 对象，遵循上述审计结构；不要输出代码块或额外文字。"
            if json_output else
            "只输出完整类 Markdown 编辑稿，保持每行 id、原文和顺序，遵循完整词项划删与行尾注释规则；不要输出 JSON、标题或额外说明。"
        )
    )


def _protocol_error(
    parsed: object,
    expected_ids: set[str],
    *,
    reference_ids: set[str] | None = None,
    item_counts: Mapping[str, int] | None = None,
) -> str | None:
    if not isinstance(parsed, dict):
        return "响应必须是 JSON 对象"
    decisions = parsed.get("decisions")
    if not isinstance(decisions, list):
        return "响应必须包含 decisions 数组"
    seen: set[str] = set()
    for index, decision in enumerate(decisions, start=1):
        if not isinstance(decision, dict):
            return f"decision {index} 必须是对象"
        clip_id = decision.get("id")
        if not isinstance(clip_id, str) or clip_id not in expected_ids:
            return f"decision {index} 的 id 不是本次输入的片段 id"
        if clip_id in seen:
            return f"片段 {clip_id} 出现了多个 decision"
        seen.add(clip_id)
        outcome = decision.get("decision")
        if outcome not in {DECISION_KEEP, DECISION_DISCARD, DECISION_REVIEW, DECISION_EDIT}:
            return f"片段 {clip_id} 的 decision 必须是 keep/discard/review"
        if not isinstance(decision.get("scriptLine"), str):
            return f"片段 {clip_id} 缺少 scriptLine 字符串"
        if not isinstance(decision.get("reason", ""), str):
            return f"片段 {clip_id} 的 reason 必须是字符串"
        alt_take = decision.get("altTakeId", "")
        if alt_take != "" and (
            not isinstance(alt_take, str)
            or alt_take not in (reference_ids or expected_ids)
        ):
            return f"片段 {clip_id} 的 altTakeId 不是本次输入的片段 id"
        evidence = decision.get("evidence", "")
        if evidence != "" and not isinstance(evidence, str):
            return f"片段 {clip_id} 的 evidence 必须是字符串"
        alternatives = decision.get("altTakeIds", [])
        if not isinstance(alternatives, list) or any(not isinstance(ref, str) or ref not in (reference_ids or expected_ids) for ref in alternatives) or len(set(alternatives)) != len(alternatives):
            return f"片段 {clip_id} 的 altTakeIds 必须是唯一的有效片段 id"
        if alt_take and alternatives:
            return f"片段 {clip_id} 的 altTakeId 与 altTakeIds 只能提供一个"
        deleted = decision.get("deleteItems", [])
        if not isinstance(deleted, list) or any(type(index) is not int or index < 0 or item_counts is not None and index >= item_counts.get(clip_id, 0) for index in deleted) or deleted != sorted(set(deleted)):
            return f"片段 {clip_id} 的 deleteItems 必须是递增且有效的原始 item 索引"
        if outcome == DECISION_EDIT and (not deleted or item_counts is not None and len(deleted) >= item_counts.get(clip_id, 0)):
            return f"片段 {clip_id} 的 edit 必须删除部分完整 items，整段删除用 discard"
        if outcome != DECISION_EDIT and deleted:
            return f"片段 {clip_id} 只有 edit 可以携带 deleteItems"
    missing = sorted(expected_ids - seen)
    if missing:
        return "缺少片段的 decision：" + "、".join(missing)
    return None


def _resolve_decisions(
    clips: list[_Clip],
    decisions: Mapping[str, Mapping[str, object]],
) -> tuple[dict[str, str], dict[str, str]]:
    """Apply local safety checks; only ever downgrade discards to review.

    Returns the resolved outcome per clip id plus the effective review reason
    (the LLM reason when present, otherwise the local downgrade reason).
    """

    by_id = {clip.id: clip for clip in clips}
    resolved = {
        clip.id: str(decisions[clip.id].get("decision") or DECISION_KEEP)
        for clip in clips
    }
    reasons = {
        clip.id: str(decisions[clip.id].get("reason") or "").strip() for clip in clips
    }
    norms = {clip.id: clip.norm.value for clip in clips}

    def downgrade(clip_id: str, reason: str) -> None:
        if resolved.get(clip_id) == DECISION_DISCARD:
            resolved[clip_id] = DECISION_REVIEW
            # 复核标记展示的是「为什么变成待复核」，因此覆盖 LLM 的理由。
            reasons[clip_id] = reason

    for clip in clips:
        if resolved[clip.id] not in {DECISION_DISCARD, DECISION_EDIT}:
            continue
        decision = decisions[clip.id]
        if "removeItemIds" in decision or "removeItemRanges" in decision:
            _local, local_reason = _local_removal(clip, decision)
            if local_reason:
                downgrade(clip.id, local_reason)
            continue
        alt_take_id = str(decision.get("altTakeId") or "")
        evidence = str(decision.get("evidence") or "")
        alt_ids = decision.get("altTakeIds", []) or ([alt_take_id] if alt_take_id else [])
        alt_clips = [by_id[ref] for ref in alt_ids if ref in by_id]
        alt_clip = alt_clips[0] if len(alt_clips) == 1 else None
        alt_take_id = alt_clip.id if alt_clip else alt_take_id
        if resolved[clip.id] == DECISION_EDIT:
            deleted = decision.get("deleteItems", [])
            kept = remaining_text(clip.text, clip.items, deleted)
            removed = "".join(str(clip.items[index]["text"]) for index in deleted)
            replacement = "".join(other.text for other in alt_clips if resolved[other.id] not in {DECISION_DISCARD, DECISION_EDIT} and other.id != clip.id)
            evidence_ok = bool(evidence) and _contains_normalized(_normalize_text(removed).value, evidence)
            shortcut_safe = protected_information_loss_reason(collapse_echo(clip.text), collapse_echo(kept)) is None and (
                collapse_echo(clip.text) == collapse_echo(kept)
                or bool(re.fullmatch(rf"[{PURE_INTERJECTIONS}、，。\s]+|想一下|我重说", removed))
                or english_hesitation_removal(clip.text, clip.items, deleted)
            )
            safe = shortcut_safe or bool(replacement) and information_loss_reason(removed, replacement) is None
            if not evidence_ok or not safe:
                resolved[clip.id] = DECISION_REVIEW
                reasons[clip.id] = "词项删除缺少可验证的重复、口水词或保留版本覆盖证据"
            continue
        if len(alt_clips) > 1:
            positions = [other.segment_index for other in alt_clips]
            if positions != sorted(positions) or any(b != a + 1 for a, b in zip(positions, positions[1:])):
                downgrade(clip.id, "分组保留版本必须连续并按原顺序引用")
            elif clip.id in alt_ids or any(resolved[ref] in {DECISION_DISCARD, DECISION_EDIT} for ref in alt_ids):
                downgrade(clip.id, "保留版本包含自身或仍在删除的片段")
            else:
                reason = information_loss_reason(collapse_echo(clip.text), collapse_echo("".join(other.text for other in alt_clips)))
                if reason:
                    downgrade(clip.id, reason)
            continue

        if alt_clip is not None:
            if alt_take_id == clip.id:
                downgrade(clip.id, "altTakeId 指向自身")
                continue
            ratio = difflib.SequenceMatcher(
                None, _normalize_text(collapse_echo(clip.text)).value, _normalize_text(collapse_echo(alt_clip.text)).value, autojunk=False
            ).ratio()
            if ratio < ALT_TAKE_MIN_RATIO:
                downgrade(clip.id, "备用片段与当前片段相似度过低")
                continue
            if resolved[alt_take_id] in {DECISION_DISCARD, DECISION_EDIT}:
                downgrade(clip.id, "备用片段也被标记移除，改为复核")
                continue
            coverage_reason = information_loss_reason(collapse_echo(clip.text), collapse_echo(alt_clip.text))
            if coverage_reason:
                downgrade(clip.id, coverage_reason)
            continue

        # 没有备用片段时，本地必须能佐证这是一次可机械确认的移除。
        evidence_ok = bool(evidence) and _contains_normalized(norms[clip.id], evidence)
        pattern_ok = (
            bool(_PROCESS_TALK_PATTERN.search(clip.text))
            or _is_repeated_text(clip, clips, resolved)
            or bool(_UTTERANCE_FILLER_PATTERN.fullmatch(clip.norm.value))
            or english_hesitation_only(clip.text)
        )
        # 仅整段是流程用语时豁免报遍数；夹在正文中的「第3遍」仍是受保护数字。
        outside_process_talk = _PROCESS_TALK_PATTERN.sub("", norms[clip.id])
        pure_process_talk = not outside_process_talk or bool(
            _UTTERANCE_FILLER_PATTERN.fullmatch(outside_process_talk)
        )
        has_digits = (
            any(char.isdigit() for char in norms[clip.id])
            or bool(re.search(r"第[零〇一二两三四五六七八九十百千万亿]+遍", norms[clip.id]))
        ) and not pure_process_talk
        sole_script_line = clip.script_line_index >= 0 and not any(
            other.script_line_index == clip.script_line_index and other.id != clip.id
            for other in clips
        )
        if not evidence_ok:
            downgrade(clip.id, "证据引用未在原文中找到")
        elif not pattern_ok:
            downgrade(clip.id, "缺少可本地验证的重复或流程用语证据")
        elif has_digits:
            downgrade(clip.id, "片段包含数字，需要人工确认")
        elif sole_script_line:
            downgrade(clip.id, "移除后将丢失对应文稿内容，需要人工确认")
    _keep_complete_retakes(clips, decisions, resolved, reasons)
    return resolved, reasons


def _keep_complete_retakes(clips, decisions, resolved, reasons):
    """Prevent mixing halves of adjacent, literally identical multi-cue takes."""
    for start in range(len(clips) - 3):
        for width in range(2, 5):
            pair = clips[start:start + width * 2]
            if len(pair) != width * 2 or any(b.segment_index != a.segment_index + 1 for a, b in zip(pair, pair[1:])):
                continue
            old, new = pair[:width], pair[width:]
            if resolved[old[0].id] != DECISION_DISCARD or resolved[new[0].id] != DECISION_KEEP:
                continue
            if any(resolved[clip.id] not in {DECISION_KEEP, DECISION_DISCARD} or any(key in decisions[clip.id] for key in ("removeItemIds", "removeItemRanges")) for clip in pair):
                continue
            if any(collapse_echo(before.text).strip() != collapse_echo(after.text).strip() for before, after in zip(old, new)):
                continue
            for clip in old:
                resolved[clip.id] = DECISION_DISCARD
                reasons[clip.id] = "完整重录连续性校验：后面整组逐句覆盖旧版，统一保留后面的完整版本"
            for clip in new:
                resolved[clip.id] = DECISION_KEEP
                reasons[clip.id] = "完整重录连续性校验：随新版开头一起保留，避免拼接旧版收尾"


def _contains_normalized(haystack_norm: str, evidence: str) -> bool:
    needle = _normalize_text(evidence).value
    return bool(needle) and needle in haystack_norm


def _local_removal(
    clip: _Clip, decision: Mapping[str, object],
) -> tuple[list[tuple[int, int]] | None, str | None]:
    """Resolve exact temporary references; never infer character timecodes."""
    if "removeItemIds" not in decision and "removeItemRanges" not in decision:
        return None, None
    if "removeItemIds" in decision and "removeItemRanges" in decision:
        return None, "局部范围字段不能同时提供，需要复核"
    groups = decision.get("removeItemRanges", [decision.get("removeItemIds")])
    if not clip.items:
        return None, "局部移除缺少可靠字词映射，需要复核"
    if not isinstance(groups, list) or not groups:
        return None, "局部字词引用必须是非空连续数组，需要复核"
    known = [f"{clip.id}:i{index + 1:03d}" for index in range(len(clip.items))]
    ranges: list[tuple[int, int]] = []
    for ids in groups:
        if not isinstance(ids, list) or not ids or any(not isinstance(value, str) for value in ids):
            return None, "局部字词引用必须是非空连续数组，需要复核"
        if any(value not in known for value in ids) or len(set(ids)) != len(ids):
            return None, "局部字词引用不存在或重复，需要复核"
        first = known.index(ids[0])
        last = first + len(ids)
        if ids != known[first:last] or (ranges and first < ranges[-1][1]):
            return None, "局部字词引用必须按原顺序连续且各组不重叠，需要复核"
        ranges.append((first, last))
    deleted = {index for first, last in ranges for index in range(first, last)}
    removed = "".join(str(item["text"]) for index, item in enumerate(clip.items) if index in deleted)
    remaining = [item for index, item in enumerate(clip.items) if index not in deleted]
    retained = "".join(str(item["text"]) for item in remaining)
    if decision.get("altTakeId") or decision.get("evidence") != removed:
        return None, "局部证据必须精确覆盖引用字词，需要复核"
    if not _normalize_text(retained).value or sum(int(item["end"]) - int(item["start"]) for item in remaining) < 100:
        return None, "局部移除后没有有效剩余字幕，需要复核"
    from maw.postprocess_ai_cleanup_safety import local_information_loss_reason
    for first, last in ranges:
        reason = local_information_loss_reason(
            "".join(str(item["text"]) for item in clip.items[first:last]), retained,
            "".join(str(item["text"]) for index, item in enumerate(clip.items) if index < first and index not in deleted),
            "".join(str(item["text"]) for index, item in enumerate(clip.items) if index >= last and index not in deleted),
            clip.script_line,
        )
        if reason:
            return None, reason
    return ranges, None


def _is_repeated_text(
    clip: _Clip, clips: Sequence[_Clip], resolved: Mapping[str, str]
) -> bool:
    value = clip.norm.value
    if len(value) < REPEAT_MIN_CHARS:
        return False
    return any(
        other.id != clip.id
        and resolved[other.id] not in {DECISION_DISCARD, DECISION_EDIT}
        and value in other.norm.value
        and information_loss_reason(clip.text, other.text) is None
        for other in clips
    )


def _marker_name(text: str) -> str:
    compact = _CONTROL_CHARS.sub(" ", text).strip()
    return compact[:20] if len(compact) > 20 else compact or "待复核"


def _ai_annotation(
    segment: Mapping[str, object],
    operation: str,
    reason: str,
    *,
    pending: bool = True,
) -> dict[str, object]:
    compact = _CONTROL_CHARS.sub(" ", reason).strip()
    compact = re.sub(r"^(?:\[AI\]\s*)+", "", compact, flags=re.IGNORECASE)
    head, separator, body = compact.replace(":", "：", 1).partition("：")
    if separator and head.strip() in {"删除", "移除", "保留", "复核", "替代项"}:
        compact = body.strip()
    marker: dict[str, object] = {
        "start": int(segment.get("start", 0)),
        "name": _marker_name(str(segment.get("text") or "")),
        "color": MARKER_REVIEW_COLOR if pending else "#8e4ec6",
        "note": f"[AI] {operation}：{compact or '需要人工确认'}",
    }
    end = int(segment.get("end", 0))
    if end > marker["start"]:
        marker["end"] = end
    if pending:
        marker["review"] = {"status": "pending", "reason": reason}
    return marker


def _disable_bound_extensions(project: JsonDict, main_ids: set[str]) -> None:
    """Match the editor's main-driven disabling without touching independent tracks."""
    multi = project.get("multi_subtitle")
    if not isinstance(multi, Mapping):
        return
    targets: dict[str, set[str]] = {}
    for binding in multi.get("bindings", []):
        if not isinstance(binding, Mapping):
            continue
        if not main_ids.intersection(binding.get("main_segment_ids", [])):
            continue
        targets.setdefault(str(binding.get("track_id")), set()).update(
            binding.get("extension_segment_ids", []),
        )
    # Bindings remain meaningful when bilingual display is switched off.
    for track in multi.get("tracks", []):
        if not isinstance(track, Mapping):
            continue
        extension_ids = targets.get(str(track.get("id")), set())
        for segment in track.get("segments", []):
            if isinstance(segment, dict) and segment.get("id") in extension_ids:
                segment["disabled"] = True


def _build_gap_remove(
    project: JsonDict, removed_ranges: Sequence[Mapping[str, object]]
) -> dict[str, object]:
    existing = project.get("gap_remove")
    has_existing = isinstance(existing, Mapping)
    provenance = _normalize_gap_provenance(
        existing.get("provenance") if has_existing else None,
        existing.get("gaps") if has_existing else None,
    )
    ranges = [
        {**raw_range, "start": int(raw_range["start"]), "end": int(raw_range["end"])}
        for raw_range in sorted(
            removed_ranges, key=lambda item: (int(item["start"]), int(item["end"]))
        )
        if int(raw_range["end"]) > int(raw_range["start"])
    ]
    previous = provenance["sources"]["ai_cleanup"]
    provenance = _replace_provenance_source(provenance, "ai_cleanup", [*previous, *ranges])
    gaps = _decorate_gap_ranges(_gap_ranges_from_provenance(provenance), provenance)
    base: dict[str, object] = (
        dict(existing)
        if has_existing
        else {
            "detector": "audio_gate",
            "minimum_ms": int(MAWE_GAP_REMOVE_DEFAULTS["minimum_ms"]),
            "threshold_db": float(MAWE_GAP_REMOVE_DEFAULTS["threshold_db"]),
            "hysteresis_db": float(MAWE_GAP_REMOVE_DEFAULTS["hysteresis_db"]),
            "lead_in_ms": int(MAWE_GAP_REMOVE_DEFAULTS["lead_in_ms"]),
            "lead_out_ms": int(MAWE_GAP_REMOVE_DEFAULTS["lead_out_ms"]),
            "skip_playback": True,
            "operation_mode": DEFAULT_GAP_REMOVE_OPERATION_MODE,
            "disable_coverage_percent": 80,
            "disable_remaining_ms": 300,
        }
    )
    base.update(
        {
            "schema": GAP_REMOVE_SCHEMA,
            "manual_corrections": bool(provenance["manual_overrides"]),
            "gaps": gaps,
            "provenance": provenance,
        }
    )
    return base


def _build_markers_field(
    ai_markers: list[dict[str, object]], existing: object = None
) -> dict[str, object]:
    """Assemble deletion annotations and review regions in canonical markers.

    Preserve existing annotations and allocate fresh IDs for new review items.
    Only new review items are time-sorted; existing stable IDs never change.
    """

    from maw.postprocess_annotations import append_markers
    bounded = []
    for marker in ai_markers:
        entry = copy.deepcopy(marker)
        entry["name"] = _sanitize_marker_text(marker["name"], MARKER_NAME_MAX_LENGTH)
        entry["note"] = _sanitize_marker_text(marker["note"], MARKER_NOTE_MAX_LENGTH)
        if isinstance(marker.get("review"), Mapping):
            entry["review"] = {"status": "pending", "reason": _sanitize_marker_text(marker["review"]["reason"], MARKER_REVIEW_REASON_MAX_LENGTH)}
        bounded.append(entry)
    return append_markers(existing, bounded)


def _sanitize_marker_text(value: object, max_length: int) -> str:
    compact = _CONTROL_CHARS.sub(" ", str(value or "")).strip()
    return compact[:max_length]
