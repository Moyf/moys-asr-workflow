# pyright: reportAny=false, reportArgumentType=false, reportUnknownVariableType=false, reportReturnType=false, reportAttributeAccessIssue=false

"""Recording-first spoken-word cleanup backed by an LLM decision pass.

The transcript is authoritative: the manuscript is only evidence.  The LLM
never rewrites text or timecodes; it only classifies whole cues as keep,
discard (backed by an alternate take or literal evidence), or review.  Local
validators only ever downgrade unsafe discards to review items, and any LLM
or protocol failure leaves the source files untouched.
"""

from __future__ import annotations

import difflib
import copy
import json
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from maw.postprocess import OutputMode
from maw.postprocess_ai_cleanup_safety import information_loss_reason
from maw.postprocess_ai_cleanup_review import review_decisions
from maw.postprocess_io import SubtitleArtifact, write_artifacts
from maw.postprocess_llm import (
    LlmClientError,
    LlmSettings,
    MAX_RESPONSE_ATTEMPTS,
    _request_completion,
    _response_content,
    _strip_json_fence,
)
from maw.postprocess_match import _load_input, _normalize_text, _read_script, clean_markdown_inline_symbols
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

# 本地流程用语模式：试麦、报遍数、操作指令。只用于给「无备用片段」的 discard
# 提供本地佐证；命中不了的降级为待复核，绝不因此扩大移除范围。
_PROCESS_TALK_PATTERN: Final[re.Pattern[str]] = re.compile(
    "试麦|麦克风|话筒|听得到|听得见|能听见|测试一下|录一下|开始了吗|开始吧|"
    "录好了|录完了吗|还在录吗|关了吗|重来|重新来|再来一遍|再来一次|刚才不算|"
    "刚才那段|上一遍|这一遍|第[一二三四五六七八九十0-9]+遍|删掉|剪掉|不要这段|掐掉"
)

_CONTROL_CHARS: Final[re.Pattern[str]] = re.compile(r"[\x00-\x1f\x7f]+")


class AiCleanupError(RuntimeError):
    """Raised when the AI cleanup pass cannot produce a trustworthy result."""


@dataclass(frozen=True, slots=True)
class AiCleanupRequest:
    project_path: Path | None
    srt_path: Path | None
    script_path: Path
    output_mode: OutputMode
    output_directory: Path | None = None
    media_path: Path | None = None
    clean_markdown_symbols: bool = True
    notes: str = ""
    # Internal switch: callers can disable the second pass; no GUI setting yet.
    review_enabled: bool = True


@dataclass(slots=True)
class _Clip:
    id: str
    segment_index: int
    text: str
    norm: _NormalizedText
    script_line: str = ""
    script_line_index: int = -1
    script_match: str = "none"


def llm_complete(settings: LlmSettings) -> Callable[[str, list[dict[str, str]]], Mapping[str, object]]:
    """Build the transport closure used by :func:`run_ai_cleanup`.

    JSON syntax errors retry once with an augmented prompt (the same policy as
    ``complete_subtitle_groups``); the protocol retry loop in the cleanup module
    handles semantic protocol violations on top of this.  Cancellation is the
    caller's concern and is wrapped around the returned closure.
    """

    def complete(prompt: str, clips: list[dict[str, str]]) -> Mapping[str, object]:
        last_error = "响应不是有效的 JSON。"
        for attempt in range(MAX_RESPONSE_ATTEMPTS):
            current_prompt = prompt if not attempt else _retry_prompt(prompt, last_error)
            body = _request_completion(settings, current_prompt, clips, on_delta=None)
            content = _response_content(body)
            try:
                return json.loads(_strip_json_fence(content))
            except json.JSONDecodeError as error:
                last_error = f"JSON syntax error: {error.msg} at character {error.pos}"
        raise LlmClientError(f"LLM returned invalid JSON after retry: {last_error}", category="protocol", operation="ai_cleanup")

    return complete


def run_ai_cleanup(
    request: AiCleanupRequest,
    *,
    complete: Callable[[str, list[dict[str, str]]], Mapping[str, object]],
    on_status: Callable[[str], None] | None = None,
) -> SubtitleArtifact:
    """Run the recording-first cleanup and write ``ai_cleanup`` artifacts."""

    project, source_project, source_srt = _load_input(request.project_path, request.srt_path)
    script_path, script_text = _read_script(request.script_path)
    if request.clean_markdown_symbols:
        script_text = clean_markdown_inline_symbols(script_text)
    script_lines = [line.strip() for line in script_text.splitlines() if line.strip()]
    if not script_lines:
        raise AiCleanupError("文稿整理需要文稿中至少有一行文字。")

    segments = project.get("segments")
    if not isinstance(segments, list) or not segments:
        raise AiCleanupError("字幕工程中没有可整理的字幕段。")

    clips = _build_clips(segments, script_lines)
    decisions = _collect_decisions(complete, clips, script_lines, on_status=on_status, notes=request.notes)
    resolved, reasons = _resolve_decisions(clips, decisions)
    if request.review_enabled and DECISION_DISCARD in resolved.values():
        flags = review_decisions(
            complete, _readthrough_rows(segments, clips, decisions, resolved),
            notes=request.notes, on_status=on_status,
        )
        for clip_id, reason in flags.items():
            resolved[clip_id] = DECISION_REVIEW
            reasons[clip_id] = reason

    removed_ranges: list[dict[str, int]] = []
    discarded_main_ids: set[str] = set()
    ai_markers: list[dict[str, object]] = []
    stats = {"matchedLines": 0, "rephrased": 0, "extrasKept": 0, "removed": 0, "pendingReview": 0}
    clip_segments = {clip.segment_index for clip in clips}
    for clip in clips:
        outcome = resolved[clip.id]
        segment = segments[clip.segment_index]
        assert isinstance(segment, dict)
        if outcome == DECISION_DISCARD:
            segment["disabled"] = True
            discarded_main_ids.add(str(segment["id"]))
            removed_ranges.append({"start": int(segment.get("start", 0)), "end": int(segment.get("end", 0))})
            reason = reasons[clip.id] or "有证据的无效录制内容"
            alt = decisions[clip.id].get("altTakeId")
            if alt:
                alternative = next((item.text for item in clips if item.id == alt), "")
                reason += f"；替代字幕：{alternative[:80]}"
            ai_markers.append(_ai_annotation(segment, "删除", reason, pending=False))
            stats["removed"] += 1
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
        if not isinstance(segment, dict) or segment.get("disabled") is True or index in clip_segments:
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

    warnings = (
        f"文稿来源：{script_path}",
        f"AI 整理：自动移除 {stats['removed']} 段，待复核 {stats['pendingReview']} 段。",
    )
    return write_artifacts(
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
    )


def build_clips(segments: Sequence[JsonValue], script_lines: Sequence[str]) -> list[dict[str, str]]:
    """Return the LLM clip payload (temp ids, text only, no timings or paths)."""

    return _clips_payload(_build_clips(list(segments), list(script_lines)), script_lines)


def _readthrough_rows(
    segments: Sequence[JsonValue], clips: Sequence[_Clip],
    decisions: Mapping[str, Mapping[str, object]], resolved: Mapping[str, str],
) -> list[dict[str, str]]:
    by_index = {clip.segment_index: clip for clip in clips}
    by_id = {clip.id: clip for clip in clips}
    rows: list[dict[str, str]] = []
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict) or segment.get("disabled") is True:
            continue
        text = _CONTROL_CHARS.sub(" ", str(segment.get("text") or "")).strip()
        if not text:
            continue
        clip = by_index.get(index)
        if clip is None:
            rows.append({"id": f"u{index + 1:03d}", "asrText": text, "proposed": "review", "contextOnly": "true"})
            continue
        row = {"id": clip.id, "asrText": clip.text, "proposed": resolved[clip.id]}
        alt = by_id.get(str(decisions[clip.id].get("altTakeId") or ""))
        if alt is not None:
            row["alternativeId"] = alt.id
            row["alternativeText"] = alt.text
        rows.append(row)
    return rows


def _build_clips(segments: list[JsonValue], script_lines: list[str]) -> list[_Clip]:
    clips: list[_Clip] = []
    for index, segment in enumerate(segments):
        if not isinstance(segment, dict) or segment.get("disabled") is True:
            continue
        text = _CONTROL_CHARS.sub(" ", str(segment.get("text") or "")).strip()
        if not text or not _segment_has_item_timings(segment):
            # 没有文字或没有字词时间的段不参与自动移除；后者生成待复核标记。
            continue
        clips.append(_Clip(
            id=f"c{len(clips) + 1:03d}",
            segment_index=index,
            text=text,
            norm=_normalize_text(text),
        ))
    _assign_script_lines(clips, script_lines)
    return clips


def _segment_has_item_timings(segment: Mapping[str, object]) -> bool:
    items = segment.get("items")
    if not isinstance(items, list) or not items:
        return False
    return all(
        isinstance(item, dict)
        and isinstance(item.get("text"), str)
        and isinstance(item.get("start"), (int, float))
        and not isinstance(item.get("start"), bool)
        and isinstance(item.get("end"), (int, float))
        and not isinstance(item.get("end"), bool)
        for item in items
    )


def _assign_script_lines(clips: list[_Clip], script_lines: list[str]) -> None:
    """Monotonically assign each clip to at most one script line."""

    if not clips:
        return
    lines_norm = [_normalize_text(line) for line in script_lines]
    cursor = 0
    for clip in clips:
        best_index = -1
        best_ratio = 0.0
        for line_index in range(cursor, min(cursor + SCRIPT_LOOKAHEAD, len(lines_norm))):
            ratio = difflib.SequenceMatcher(None, clip.norm.value, lines_norm[line_index].value, autojunk=False).ratio()
            if ratio > best_ratio:
                best_index = line_index
                best_ratio = ratio
        if best_index < 0 or best_ratio < SCRIPT_FUZZY_RATIO:
            continue
        clip.script_line_index = best_index
        clip.script_line = script_lines[best_index]
        clip.script_match = "exact" if best_ratio >= SCRIPT_EXACT_RATIO else "rephrased"
        cursor = best_index + 1


def _collect_decisions(
    complete: Callable[[str, list[dict[str, str]]], Mapping[str, object]],
    clips: list[_Clip],
    script_lines: list[str],
    *,
    on_status: Callable[[str], None] | None,
    notes: str = "",
) -> dict[str, Mapping[str, object]]:
    decisions: dict[str, Mapping[str, object]] = {}
    for batch_start in range(0, len(clips), CLIPS_PER_REQUEST):
        if on_status is not None:
            on_status("toolbox_status_ai_cleanup")
        batch_end = batch_start + CLIPS_PER_REQUEST
        batch = clips[batch_start:batch_end]
        context = clips[max(0, batch_start - CONTEXT_CLIPS):min(len(clips), batch_end + CONTEXT_CLIPS)]
        decisions.update(_complete_batch(complete, batch, script_lines, context=context, notes=notes))
    return decisions


def _complete_batch(
    complete: Callable[[str, list[dict[str, str]]], Mapping[str, object]],
    batch: Sequence[_Clip],
    script_lines: Sequence[str],
    *,
    context: Sequence[_Clip] = (),
    notes: str = "",
) -> dict[str, Mapping[str, object]]:
    expected_ids = {clip.id for clip in batch}
    prompt = _system_prompt(notes)
    references = context or batch
    payload = _clips_payload(references, script_lines, target_ids=expected_ids)
    last_error = ""
    for attempt in range(MAX_RESPONSE_ATTEMPTS):
        _ = attempt
        parsed = complete(prompt if not last_error else _retry_prompt(prompt, last_error), payload)
        protocol_error = _protocol_error(parsed, expected_ids, reference_ids={clip.id for clip in references})
        if protocol_error is None:
            return {
                str(decision.get("id")): decision
                for decision in parsed.get("decisions", [])
                if isinstance(decision, Mapping)
            }
        last_error = protocol_error
    raise LlmClientError(f"AI 整理响应在重试后仍未通过协议校验：{last_error}", category="protocol", operation="ai_cleanup")


def _clips_payload(
    batch: Sequence[_Clip], script_lines: Sequence[str], *, target_ids: set[str] | None = None,
) -> list[dict[str, str]]:
    """Return the wire payload: temp ids and text only, no timings or paths."""

    payload: list[dict[str, str]] = []
    for clip in batch:
        line_index = clip.script_line_index
        payload.append({
            "id": clip.id,
            "asrText": clip.text,
            "scriptLine": clip.script_line,
            "prevScriptLine": _line_at(script_lines, line_index - 1),
            "nextScriptLine": _line_at(script_lines, line_index + 1),
            "scriptMatch": clip.script_match,
        })
        if target_ids is not None and clip.id not in target_ids:
            payload[-1]["contextOnly"] = "true"
    return payload


def _line_at(lines: Sequence[str], index: int) -> str:
    return lines[index] if 0 <= index < len(lines) else ""


def _system_prompt(notes: str = "") -> str:
    extra = ""
    cleaned_notes = notes.strip()
    if cleaned_notes:
        extra = (
            "\n用户补充说明（用户对本次整理的额外要求，在上述规则内参考执行，"
            "不得据此改写、翻译或总结任何文字）：\n"
            f"{cleaned_notes}\n"
        )
    return (
        "你在整理一段口播录音的识别稿。录音是最终成品（录音优先）：识别文字不能改写，"
        "时间码不能改动，片段顺序不能调整。文稿只是参考证据。\n"
        "输入按录音顺序排列。contextOnly 为字符串 true 的片段仅供理解上下文，不得返回其 decision；"
        "其余片段才是本批裁决对象，每个必须返回一次。altTakeId 可引用本批或只读上下文中的片段。\n"
        "对每个输入片段输出一个决定：\n"
        "- keep：保留。文稿对应内容、改说、包含独有信息（数字、专有名词）的题外话都保留。\n"
        "- discard：整段移除。只有两类片段允许：\n"
        "  1. 重录废片：存在另一片段说的是同一句话的更好一遍，用 altTakeId 指向它；\n"
        "  2. 试麦、报遍数、流程对话、机械重复：用 evidence 从 asrText 原文引用关键依据。\n"
        "- review：不确定就复核。识别疑似错误、内容与文稿冲突、拿不准是否该删、切点不安全时选 review。\n"
        "规则：拿不准一律 review，不要为了输出整洁而 discard；不要改写、翻译或总结任何文字；"
        "scriptLine 原样返回输入值。\n"
        "信息覆盖检查：主题相同不等于重复。整段移除前确认保留版本完整覆盖原段的事实、数字、"
        "人物身份、方法、步骤、案例、限定条件、否定、因果和承接；病句或口误中的独有信息也要保留。"
        "不能完整覆盖就 review，不设目标删减比例。重来信号仅作用于明确指向的当前 take，"
        "不得扩大删除此前已成立的内容。\n"
        '只输出一个严格有效的 JSON 对象：{"decisions": [{"id": "c001", "decision": "keep|discard|review", '
        '"scriptLine": "...", "reason": "...", "evidence": "...", "altTakeId": "..."}]}。'
        "evidence 与 altTakeId 只在 discard 时提供（二选一）；keep/review 可省略。"
        "reason 用一句话中文说明依据。"
        "reason 使用 操作：原因 格式，如 删除：试麦、替代项：有同类版本但信息覆盖存疑、"
        "复核：承接不确定、保留：包含独有步骤；不要添加 [AI] 前缀。"
        f"{extra}"
    )


def _retry_prompt(prompt: str, reason: str) -> str:
    return (
        f"{prompt}\n\n上一次输出未通过本地协议校验（{reason}）。请重新处理同一批输入并完整返回结果。"
        "只输出一个严格有效的 JSON 对象，严格遵循上述工序要求的结构和只读边界；"
        "不要输出 Markdown 代码块、注释或额外文字。"
    )


def _protocol_error(
    parsed: object, expected_ids: set[str], *, reference_ids: set[str] | None = None,
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
        if outcome not in {DECISION_KEEP, DECISION_DISCARD, DECISION_REVIEW}:
            return f"片段 {clip_id} 的 decision 必须是 keep/discard/review"
        if not isinstance(decision.get("scriptLine"), str):
            return f"片段 {clip_id} 缺少 scriptLine 字符串"
        if not isinstance(decision.get("reason", ""), str):
            return f"片段 {clip_id} 的 reason 必须是字符串"
        alt_take = decision.get("altTakeId", "")
        if alt_take != "" and (not isinstance(alt_take, str) or alt_take not in (reference_ids or expected_ids)):
            return f"片段 {clip_id} 的 altTakeId 不是本次输入的片段 id"
        evidence = decision.get("evidence", "")
        if evidence != "" and not isinstance(evidence, str):
            return f"片段 {clip_id} 的 evidence 必须是字符串"
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
    resolved = {clip.id: str(decisions[clip.id].get("decision") or DECISION_KEEP) for clip in clips}
    reasons = {clip.id: str(decisions[clip.id].get("reason") or "").strip() for clip in clips}
    norms = {clip.id: clip.norm.value for clip in clips}

    def downgrade(clip_id: str, reason: str) -> None:
        if resolved.get(clip_id) == DECISION_DISCARD:
            resolved[clip_id] = DECISION_REVIEW
            # 复核标记展示的是「为什么变成待复核」，因此覆盖 LLM 的理由。
            reasons[clip_id] = reason

    for clip in clips:
        if resolved[clip.id] != DECISION_DISCARD:
            continue
        decision = decisions[clip.id]
        alt_take_id = str(decision.get("altTakeId") or "")
        evidence = str(decision.get("evidence") or "")
        alt_clip = by_id.get(alt_take_id) if alt_take_id else None

        if alt_clip is not None:
            if alt_take_id == clip.id:
                downgrade(clip.id, "altTakeId 指向自身")
                continue
            ratio = difflib.SequenceMatcher(None, clip.norm.value, alt_clip.norm.value, autojunk=False).ratio()
            if ratio < ALT_TAKE_MIN_RATIO:
                downgrade(clip.id, "备用片段与当前片段相似度过低")
                continue
            if resolved[alt_take_id] == DECISION_DISCARD:
                downgrade(clip.id, "备用片段也被标记移除，改为复核")
                continue
            coverage_reason = information_loss_reason(clip.text, alt_clip.text)
            if coverage_reason:
                downgrade(clip.id, coverage_reason)
            continue

        # 没有备用片段时，本地必须能佐证这是一次可机械确认的移除。
        evidence_ok = bool(evidence) and _contains_normalized(norms[clip.id], evidence)
        pattern_ok = bool(_PROCESS_TALK_PATTERN.search(clip.text)) or _is_repeated_text(clip, clips, resolved)
        has_digits = any(char.isdigit() for char in norms[clip.id])
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
    return resolved, reasons


def _contains_normalized(haystack_norm: str, evidence: str) -> bool:
    needle = _normalize_text(evidence).value
    return bool(needle) and needle in haystack_norm


def _is_repeated_text(clip: _Clip, clips: Sequence[_Clip], resolved: Mapping[str, str]) -> bool:
    value = clip.norm.value
    if len(value) < REPEAT_MIN_CHARS:
        return False
    return any(
        other.id != clip.id
        and resolved[other.id] != DECISION_DISCARD
        and value in other.norm.value
        and information_loss_reason(clip.text, other.text) is None
        for other in clips
    )


def _marker_name(text: str) -> str:
    compact = _CONTROL_CHARS.sub(" ", text).strip()
    return compact[:20] if len(compact) > 20 else compact or "待复核"


def _ai_annotation(
    segment: Mapping[str, object], operation: str, reason: str, *, pending: bool = True,
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


def _build_gap_remove(project: JsonDict, removed_ranges: Sequence[Mapping[str, int]]) -> dict[str, object]:
    existing = project.get("gap_remove")
    has_existing = isinstance(existing, Mapping)
    provenance = _normalize_gap_provenance(
        existing.get("provenance") if has_existing else None,
        existing.get("gaps") if has_existing else None,
    )
    ranges = [
        {"start": int(raw_range["start"]), "end": int(raw_range["end"])}
        for raw_range in sorted(removed_ranges, key=lambda item: (int(item["start"]), int(item["end"])))
        if int(raw_range["end"]) > int(raw_range["start"])
    ]
    provenance = _replace_provenance_source(provenance, "ai_cleanup", ranges)
    gaps = _decorate_gap_ranges(_gap_ranges_from_provenance(provenance), provenance)
    base: dict[str, object] = dict(existing) if has_existing else {
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
    base.update({
        "schema": GAP_REMOVE_SCHEMA,
        "manual_corrections": bool(provenance["manual_overrides"]),
        "gaps": gaps,
        "provenance": provenance,
    })
    return base


def _build_markers_field(ai_markers: list[dict[str, object]], existing: object = None) -> dict[str, object]:
    """Assemble deletion annotations and review regions in canonical markers.

    Preserve existing annotations and allocate fresh IDs for new review items.
    Only new review items are time-sorted; existing stable IDs never change.
    """

    base = copy.deepcopy(dict(existing)) if isinstance(existing, Mapping) else {}
    raw_items = base.get("items")
    items = list(raw_items) if isinstance(raw_items, list) else []
    ordered = sorted(ai_markers, key=lambda marker: (int(marker["start"]), str(marker["name"])))
    used = {str(marker["id"]) for marker in items if isinstance(marker, Mapping) and isinstance(marker.get("id"), str)}
    for marker in ordered:
        index = 1
        while f"marker-{index:03d}" in used:
            index += 1
        marker_id = f"marker-{index:03d}"
        used.add(marker_id)
        items.append({
            "id": marker_id,
            "start": int(marker["start"]),
            "name": _sanitize_marker_text(marker["name"], MARKER_NAME_MAX_LENGTH),
            "color": str(marker["color"]),
            "note": _sanitize_marker_text(marker["note"], MARKER_NOTE_MAX_LENGTH),
        })
        if marker.get("end") is not None:
            items[-1]["end"] = int(marker["end"])
        review = marker.get("review")
        if isinstance(review, Mapping):
            items[-1]["review"] = {
                "status": "pending",
                "reason": _sanitize_marker_text(review["reason"], MARKER_REVIEW_REASON_MAX_LENGTH),
            }
    base.update({"schema": MARKERS_SCHEMA, "items": items})
    return base


def _sanitize_marker_text(value: object, max_length: int) -> str:
    compact = _CONTROL_CHARS.sub(" ", str(value or "")).strip()
    return compact[:max_length]
