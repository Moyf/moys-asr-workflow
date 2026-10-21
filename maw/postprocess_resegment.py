"""Source-preserving subtitle boundaries and locally enforced length limits."""

from __future__ import annotations
from maw.project_mutations import replace_main_segments
from maw.project_tracks import iter_segments

import copy
import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from maw.postprocess_ai_cleanup_items import item_text_spans, scoped_item_ranges, verified_scope_indices
from maw.postprocess_io import SubtitleArtifact
from maw.postprocess_draft import draft_lines
from maw.postprocess_resegment_diagnostics import ResegmentTrace
from maw.postprocess_llm import (
    LlmClientError,
    LlmDelta,
    LlmResponseObserver,
    LlmSettings,
    _request_completion,
    _response_content,
)
from maw.project_preview import JsonDict, JsonValue

if TYPE_CHECKING:
    from maw.postprocess import LlmComplete, LlmPostprocessRequest, LlmStatus
    from collections.abc import Callable


def normalize_max_chars(value: object) -> int:
    if value is None or value == "":
        return 0
    if isinstance(value, bool) or not re.fullmatch(r"\d+", str(value)):
        raise ValueError("最大字数必须为 1–500 的整数，或留空不限制。")
    count = int(str(value))
    if not 0 <= count <= 500:
        raise ValueError("最大字数必须为 1–500 的整数，或留空不限制。")
    return count


def char_count(text: str) -> int:
    return sum(not char.isspace() for char in text)


@dataclass(frozen=True)
class Unit:
    id: str
    text: str
    source: int
    start: int
    end: int
    item: JsonDict | None


class BoundaryValidationError(ValueError):
    def __init__(self, message: str, issues: list[str]) -> None:
        super().__init__(message)
        self.issues = issues


def source_units(segment: JsonDict, source: int) -> list[Unit]:
    text = str(segment.get("text") or "")
    items = segment.get("items")
    cue_id = f"c{source + 1:04d}"
    spans = (
        item_text_spans(text, items)
        if isinstance(items, list) and items and all(isinstance(i, dict) for i in items)
        else None
    )
    valid = spans is not None and all(
        type(i.get("start")) is int
        and type(i.get("end")) is int
        and int(segment["start"]) <= i["start"] < i["end"] <= int(segment["end"])
        and (index == 0 or items[index - 1]["end"] <= i["start"])
        for index, i in enumerate(items)
    )
    if not valid:
        return [
            Unit(cue_id, text, source, int(segment["start"]), int(segment["end"]), None)
        ]
    return [
        Unit(
            f"{cue_id}a{index + 1:04d}",
            text[
                0 if index == 0 else spans[index][0] : spans[index + 1][0]
                if index + 1 < len(spans)
                else len(text)
            ],
            source,
            i["start"],
            i["end"],
            i,
        )
        for index, i in enumerate(items)
    ]


def boundary_prompt(max_chars: int, notes: str = "") -> str:
    return (
        "你是字幕断句编辑，先通读完整表达及 contextBefore/contextAfter，再只选择自然断点。\n"
        "按完整意群与阅读节奏合并过碎短字幕，拆开过长表达。不要机械照搬现有 cue 边界。"
        "优先句末、完整分句，其次完整短语；不要把主谓、动宾、否定与动词、人名、数字与单位拆散。"
        "短感叹、回答、转折可独立成句，不能为了整齐把不同表达强行合并。\n"
        "输出前把相邻两条连读：不要让是、把、被、的、设为等连接骨架悬在句尾，"
        "也不要单独留下‘所以后来’或‘第二，’这类等待后文的引导语。"
        "需要拆长句时优先在完整分句或列举项之后断开，保持数字与帧、像素、百分比等单位相连。\n"
        "输入 items 的 id 是不透明 atom ID，表示可用词项边界；没有词级时间的 cue 只提供一个完整段单元。"
        "只能在完整单元之后断句，不能改写、增删、重排原文，也不能生成时间。上下文只读。\n"
        "只返回类 Markdown 断点列表：每行 [该条字幕最后一个单元的id]，如 [c0001a0004]。"
        "不必抄写原文或列出整组 ID，不返回标题、JSON 或解释。断点必须唯一、递增，最后一个输入单元必须作为最后断点；"
        "脚本根据这些位置完整覆盖全部原文。\n"
        + (
            f"每条字幕最多 {max_chars} 个字符，中文、英文与标点逐字符计数，空白不计。尽量在上限内选自然断点，不能拆开完整单元。\n"
            if max_chars
            else "未设置最大字数，按自然语义断句，不设目标条数或固定长度。\n"
        )
        + (f"补充要求（不得突破原文和边界约束）：{notes}" if notes else "")
    )


def complete_boundaries(
    settings: LlmSettings,
    prompt: str,
    rows: list[dict[str, JsonValue]],
    *,
    on_delta: LlmDelta | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    on_response: LlmResponseObserver | None = None,
) -> JsonDict:
    if on_delta is not None:
        on_delta("reset", "")
    body = _request_completion(
        settings,
        prompt,
        rows,
        use_json_format=False,
        on_delta=on_delta,
        is_cancelled=is_cancelled,
        on_response=on_response,
    )
    return {"draft": _response_content(body)}


def parse_boundaries(
    response: Mapping[str, JsonValue], units: Sequence[Unit]
) -> list[list[Unit]]:
    """Accept sparse boundaries; legacy callbacks must preserve exact source text."""
    if not isinstance(response, Mapping):
        raise ValueError("断点响应必须是有效编辑稿。")
    ids = [unit.id for unit in units]
    positions = {unit_id: index for index, unit_id in enumerate(ids)}
    draft = response.get("draft")
    if isinstance(draft, str):
        lines = draft_lines(draft)
        # Compatibility for providers/integrations returning the old JSON shape.
        if lines and lines[0].lstrip().startswith("{"):
            return parse_boundaries(json.loads("\n".join(lines)), units)
        ends = []
        for line in lines:
            match = re.fullmatch(r"\[([^\[\]\s]+)\]", line.strip())
            if match is None or match[1] not in positions:
                raise ValueError("断点必须是输入单元 ID，且每行只有 [id]。")
            ends.append(positions[match[1]] + 1)
    else:
        groups = response.get("groups")
        if not isinstance(groups, list) or not groups:
            raise ValueError("模型没有返回有效断点。")
        if all(isinstance(g, dict) and "atom_ids" in g for g in groups):
            flattened = [i for g in groups for i in g["atom_ids"]]
            if flattened != ids or any(not g["atom_ids"] for g in groups):
                raise ValueError("词项分组必须按原顺序完整覆盖。")
            ends = [positions[g["atom_ids"][-1]] + 1 for g in groups]
        else:
            texts = [g.get("text") for g in groups if isinstance(g, dict)]
            if (
                len(texts) != len(groups)
                or not all(isinstance(t, str) and t for t in texts)
                or "".join(texts) != "".join(u.text for u in units)
            ):
                raise ValueError("重新断句不能改写、删除或重复原文。")
            char_ends = {}
            cursor = 0
            for index, unit in enumerate(units):
                cursor += len(unit.text)
                char_ends[cursor] = index + 1
            ends = []
            cursor = 0
            for text in texts:
                cursor += len(text)
                if cursor not in char_ends:
                    raise ValueError("断点切开了完整词项，或缺少词级时间。")
                ends.append(char_ends[cursor])
    if not ends or ends[-1] != len(units) or ends != sorted(set(ends)):
        raise ValueError("断点必须唯一、递增且包含最后一个单元；不能遗漏尾部。")
    invalid = []
    for end in ends[:-1]:
        # Existing source-cue boundaries are already legal recovery points.
        # Without an intervening space, two separate English cues would
        # otherwise look like one continuous word to the text-only guard.
        if units[end - 1].source != units[end].source:
            continue
        left = "".join(u.text for u in units[max(0, end - 3) : end])
        right = "".join(u.text for u in units[end : end + 3])
        reason = boundary_issue(left, right)
        if reason:
            before, after = units[end - 1], units[end]
            invalid.append(
                f"断点 [{before.id}] → [{after.id}]（原字幕 {before.source + 1} → {after.source + 1}）："
                f"左侧 {json.dumps(left[-60:], ensure_ascii=False)} | 右侧 {json.dumps(right[:60], ensure_ascii=False)}；{reason}"
            )
    if invalid:
        detail = "\n".join(invalid[:5])
        if len(invalid) > 5:
            detail += f"\n另有 {len(invalid) - 5} 处无效断点，请查看阶段记录。"
        raise BoundaryValidationError(f"断点不能拆开数字、比例或数字与单位，也不能拆开连续英文字母。共 {len(invalid)} 处：\n{detail}", invalid)
    return [list(units[start:end]) for start, end in zip([0, *ends[:-1]], ends)]


def safe_boundary(left: str, right: str) -> bool:
    return boundary_issue(left, right) is None


def boundary_issue(left: str, right: str) -> str | None:
    # Separators may be individual ASR items. Inspect both sides to distinguish
    # numeric punctuation (16:9 / 1,000 / 1/2) from sentence punctuation.
    if (re.search(r"\d\s*$", left) and re.match(r"\s*[.,:：/／]\s*\d", right)) or (
        re.search(r"\d\s*[.,:：/／]\s*$", left) and re.match(r"\s*\d", right)
    ):
        return "断点拆开了数字中的小数、千位分隔、比例或分数。"
    # Preserve numbers, decimal fractions and common quantity units.
    if re.search(r"\d[.,]?$", left.rstrip()) and re.match(
        r"[\d.%％]|(?:公斤|千克|厘米|毫米|毫秒|分钟|小时|万元|亿元|像素|帧率|帧|元|秒|米|岁|个|年|月|日|天|kg\b|ms\b|cm\b|px\b|fps\b|Hz\b|kHz\b|MHz\b|GB\b|MB\b|kbps\b|Mbps\b)",
        right.lstrip(),
        re.I,
    ):
        return "断点拆开了数字、百分比或数字与单位。"
    if left and right and re.search(r"[A-Za-z0-9]$", left) and re.match(r"[A-Za-z0-9]", right):
        return "断点两侧为连续英文字母或数字。"
    return None


def boundary_penalty(left: str, right: str) -> int:
    """Soft grammar hints; never forbid a required length-constrained cut."""
    left, right = left.rstrip(), right.lstrip()
    if not left or not right or left[-1] in "。！？.!?；;，,、：:":
        # Short section labels still depend on their following action.
        return 40 if re.fullmatch(r"第[一二三四五六七八九十]+[，,:：]?", left) else 0
    penalty = (
        40
        if re.search(
            r"(?:设为|意味着|需要|包括|例如|因为|所以|如果|为了|是|为|把|被|将|对|和|与|及|或|的|地|得)$",
            left,
        )
        else 0
    )
    if re.fullmatch(
        r"(?:所以(?:后来)?|因此|同时|另外|例如|因为|如果|但是|不过|而且)", left
    ):
        penalty += 40
    if re.match(r"[的地得]", right):
        penalty += 20
    return penalty


def limit_groups(
    group: list[Unit], maximum: int, *, preferred_ends: set[str] | None = None
) -> tuple[list[list[Unit]], bool]:
    """Find legal cuts with a bounded dynamic program, avoiding tiny tails."""
    if not maximum or char_count("".join(u.text for u in group)) <= maximum:
        return [group], False
    # Adjacent numeric fragments form one indivisible unit for local splitting.
    blocks: list[list[Unit]] = []
    for index, unit in enumerate(group):
        if blocks and not safe_boundary(
            "".join(u.text for u in blocks[-1]),
            "".join(u.text for u in group[index : index + 3]),
        ):
            blocks[-1].append(unit)
        else:
            blocks.append([unit])
    costs = [0.0] + [float("inf")] * len(blocks)
    previous = [0] * (len(blocks) + 1)
    for end in range(1, len(blocks) + 1):
        length = 0
        for start in range(end - 1, -1, -1):
            length += sum(char_count(u.text) for u in blocks[start])
            if length > maximum and start != end - 1:
                break
            punctuation = blocks[end - 1][-1].text.rstrip()[-1:]
            boundary_cost = (
                0
                if end == len(blocks) or punctuation in "。！？.!?；;"
                else 3
                if punctuation in "，,、：:"
                else 8
            )
            left = "".join(u.text for block in blocks[start:end] for u in block)
            right = "".join(u.text for block in blocks[end : end + 3] for u in block)
            boundary_cost += boundary_penalty(left, right)
            if (
                preferred_ends
                and end != len(blocks)
                and blocks[end - 1][-1].id not in preferred_ends
            ):
                boundary_cost += 10
            # Complete short answers may stand alone; orphan introductions
            # and tiny tails should lose to a longer legal reading unit.
            short_cost = (
                max(0, min(5, maximum) - length) * 15
                if punctuation not in "。！？.!?；;"
                else 0
            )
            cost = (
                costs[start]
                + 12
                + ((maximum - min(length, maximum)) / maximum) ** 2 * 8
                + boundary_cost
                + short_cost
            )
            if cost < costs[end]:
                costs[end], previous[end] = cost, start
    result = []
    end = len(blocks)
    while end:
        start = previous[end]
        result.append([u for block in blocks[start:end] for u in block])
        end = start
    result.reverse()
    return result, any(
        char_count("".join(u.text for u in part)) > maximum for part in result
    )


def refine_groups(groups: list[list[Unit]], maximum: int) -> list[list[Unit]]:
    """Rebalance only adjacent groups with a dangling proposed boundary.

    Model boundaries remain preferences within those runs. Other semantic
    joins, speaker/pause blocks and source items keep their existing meaning.
    """
    if not maximum:
        return groups
    result = []
    run: list[Unit] = []
    preferred: set[str] = set()
    for index, group in enumerate(groups):
        run.extend(group)
        preferred.add(group[-1].id)
        next_text = (
            "".join(u.text for u in groups[index + 1])
            if index + 1 < len(groups)
            else ""
        )
        text = "".join(u.text for u in group)
        if next_text and boundary_penalty(text, next_text):
            continue
        parts, _ = limit_groups(run, maximum, preferred_ends=preferred)
        result.extend(parts)
        run, preferred = [], set()
    return result


def remap_cleanup_scopes(
    project: JsonDict, sources: Sequence[JsonDict], rebuilt: Sequence[JsonDict],
    output_groups: Sequence[Sequence[Unit]], by_source: Mapping[int, Sequence[Unit]],
) -> None:
    """Rebind exact source words without changing audio cuts or restoration."""
    gap_remove = project.get("gap_remove")
    provenance = gap_remove.get("provenance") if isinstance(gap_remove, dict) else None
    source_layers = provenance.get("sources") if isinstance(provenance, dict) else None
    entries = source_layers.get("ai_cleanup") if isinstance(source_layers, dict) else None
    if not isinstance(entries, list):
        return
    originals = {str(segment["id"]): segment for segment in sources}
    locations = {}
    for segment, group in zip(rebuilt, output_groups):
        items = segment.get("items")
        if not isinstance(items, list) or len(items) != len(group) or any(unit.item is None or item != unit.item for item, unit in zip(items, group)):
            continue
        for index, unit in enumerate(group):
            if unit.item is not None:
                locations[unit.id] = (segment, index)
    units_by_segment = {str(segment["id"]): by_source[index] for index, segment in enumerate(sources)}
    remapped = []
    used_ids = {str(entry.get("id")) for entry in entries if isinstance(entry, dict)}
    for entry in entries:
        scope = entry.get("cleanup_scope") if isinstance(entry, dict) else None
        original = originals.get(str(scope.get("segment_id"))) if isinstance(scope, dict) else None
        indices = verified_scope_indices(entry, original) if original is not None else range(0)
        units = units_by_segment.get(str(original["id"])) if original is not None else None
        if not indices:
            remapped.append(entry)
            continue
        if units is None or len(units) != len(original["items"]) or any(units[i].id not in locations for i in indices):
            raise ValueError("重新断句无法保持局部删减的完整词项绑定；未写出结果，请保留原工程。")
        targets = {}
        for index in indices:
            segment, new_index = locations[units[index].id]
            target = targets.setdefault(segment["id"], (segment, []))
            target[1].append(new_index)
        pieces = [piece for segment, indexes in targets.values() for piece in scoped_item_ranges(segment, indexes)]
        pieces.sort(key=lambda piece: piece["start"])
        # Item boundaries can leave a pause between newly split cues. Preserve
        # that audio-only range; it never grants permission to remove words.
        cursor = entry["start"]
        ranges = []
        for piece in pieces:
            if cursor < piece["start"]:
                ranges.append({"start": cursor, "end": piece["start"]})
            ranges.append(piece)
            cursor = piece["end"]
        if cursor < entry["end"]:
            ranges.append({"start": cursor, "end": entry["end"]})
        for number, piece in enumerate(ranges):
            updated = {key: copy.deepcopy(value) for key, value in entry.items() if key != "cleanup_scope"}
            updated.update(piece)
            if number and "id" in updated:
                base = f"{entry['id']}-resegment-{number}"
                candidate, suffix = base, 1
                while candidate in used_ids:
                    candidate = f"{base}-{suffix}"
                    suffix += 1
                updated["id"] = candidate
                used_ids.add(candidate)
            remapped.append(updated)
    source_layers["ai_cleanup"] = remapped


def run_resegment(
    request: LlmPostprocessRequest,
    *,
    complete: LlmComplete,
    on_status: LlmStatus | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    begin_commit: Callable[[], bool] | None = None,
) -> SubtitleArtifact:
    from maw.postprocess import PostprocessStepError, _postprocess_step_error

    trace = ResegmentTrace(request.project_path or request.srt_path, request.output_directory)
    try:
        artifact = _run_resegment(request, complete=complete, on_status=on_status, is_cancelled=is_cancelled, begin_commit=begin_commit, trace=trace)
    except Exception as error:
        trace.finish("已取消" if getattr(error, "category", "") == "cancelled" else "失败", error=str(error))
        hint = trace.hint()
        if hint:
            if isinstance(error, LlmClientError):
                raise replace(error, message=f"{error}\n{hint}") from error
            if isinstance(error, PostprocessStepError):
                raise _postprocess_step_error(f"{error}\n{hint}", error) from error
            if isinstance(error, ValueError):
                raise ValueError(f"{error}\n{hint}") from error
        raise
    trace.finish("成功", project=artifact.project_path, srt=artifact.srt_path)
    if trace.save_error:
        return replace(artifact, warnings=(*artifact.warnings, trace.hint()))
    return artifact


def _run_resegment(
    request: LlmPostprocessRequest,
    *,
    complete: LlmComplete,
    on_status: LlmStatus | None,
    is_cancelled: Callable[[], bool] | None,
    begin_commit: Callable[[], bool] | None,
    trace: ResegmentTrace,
) -> SubtitleArtifact:
    from maw.postprocess import (
        _copy_common_metadata,
        _is_transient_llm_failure,
        _llm_batches,
        _load_input,
        _notify_status,
        _postprocess_step_error,
        _raise_if_cancelled,
        _segments,
        _unique_derived_segment_id,
        _write,
        PostprocessStepError,
        SAFE_SCALARS,
    )

    maximum = normalize_max_chars(request.max_chars)
    _raise_if_cancelled(is_cancelled)
    _notify_status(on_status, "toolbox_status_reading")
    project, source_project, source_srt = _load_input(
        request.project_path, request.srt_path
    )
    sources = _segments(project)
    by_source = {index: source_units(s, index) for index, s in enumerate(sources)}
    bindings = project.get("bindings", [])
    bound_ids = {main_id for binding in bindings for main_id in binding["source_segment_ids"]}
    preserved_bound = []
    rows: list[dict[str, JsonValue]] = []
    blocks = []
    previous_index = None
    for index, segment in enumerate(sources):
        bound = segment.get("id") in bound_ids
        if bound:
            preserved_bound.append(index)
        if bound or segment.get("disabled") or not str(segment.get("text") or "").strip():
            if rows:
                blocks.append(rows)
            rows, previous_index = [], None
            continue
        units = by_source[index]
        if previous_index is not None and (
            (
                segment.get("speaker") is not None
                and sources[previous_index].get("speaker") is not None
                and segment.get("speaker") != sources[previous_index].get("speaker")
            )
            or bool(units[0].item) != bool(by_source[previous_index][0].item)
            or int(segment["start"]) - int(sources[previous_index]["end"]) > 1500
        ):
            blocks.append(rows)
            rows = []
        rows.append(
            {
                "id": f"c{index + 1:04d}",
                "text": segment["text"],
                "items": [{"id": u.id, "text": u.text} for u in units],
            }
        )
        previous_index = index
    if rows:
        blocks.append(rows)
    batches = [batch for block in blocks for batch in _llm_batches(block)]
    _notify_status(on_status, "toolbox_status_preparing_llm")
    output_groups: list[list[Unit]] = []
    warnings = [
        f"第 {index + 1} 条字幕已有一对一副字幕绑定，已保留原 ID、文字与时间；请先重新断句，再翻译或创建绑定。"
        + (f"该段超过最大 {maximum} 字，需先解除绑定后人工处理。" if maximum and char_count(str(sources[index]["text"])) > maximum else "")
        for index in preserved_bound
    ]
    annotations = []
    failed = 0
    for number, batch in enumerate(batches, 1):
        _raise_if_cancelled(is_cancelled)
        indexes = [int(str(row["id"])[1:]) - 1 for row in batch]
        units = [u for i in indexes for u in by_source[i]]
        first, last = indexes[0], indexes[-1]
        payload = copy.deepcopy(batch)
        payload[0]["contextBefore"] = "".join(
            str(s["text"])
            for s in sources[max(0, first - 2) : first]
            if not s.get("disabled")
        )
        payload[-1]["contextAfter"] = "".join(
            str(s["text"])
            for s in sources[last + 1 : last + 3]
            if not s.get("disabled")
        )
        prompt = boundary_prompt(maximum, request.custom_prompt)
        _notify_status(
            on_status, "toolbox_status_llm_batch", current=number, total=len(batches)
        )
        try:
            for attempt in range(2):
                _notify_status(on_status, "toolbox_status_llm_batch", current=number, total=len(batches), attempt=attempt + 1)
                trace.start(number, attempt + 1, prompt, payload)
                response = complete(prompt, payload)
                trace.update(response=response)
                _raise_if_cancelled(is_cancelled)
                try:
                    groups = parse_boundaries(response, units)
                    trace.update(validation="通过", groups=[{"endId": group[-1].id, "text": "".join(unit.text for unit in group)} for group in groups])
                    break
                except (ValueError, TypeError, KeyError) as error:
                    trace.update(validation="失败", error=str(error), issues=getattr(error, "issues", []))
                    if attempt:
                        raise ValueError(
                            f"第 {number} 批断点校验失败：{error}"
                        ) from error
                    prompt += f"\n上次未通过校验：{error}。请重新输出完整且递增的断点列表，包含最后一个单元。"
        except (LlmClientError, PostprocessStepError) as error:
            trace.update(error=str(error))
            if not _is_transient_llm_failure(error):
                raise _postprocess_step_error(
                    f"第 {number} 批重新断句失败：{error}", error
                ) from error
            failed += 1
            warnings.append(f"第 {number} 批网络/服务请求失败，保留原文与时间。")
            if maximum and any(
                char_count(str(sources[i]["text"])) > maximum for i in indexes
            ):
                warnings.append(
                    f"第 {number} 批未处理的原字幕可能超过最大 {maximum} 字，需重试或人工拆分。"
                )
            annotations.append({"source_ids": [f"c{i + 1:04d}" for i in indexes], "kind": "review", "message": "网络/服务请求失败，本段保留原文，需重试断句。"})
            output_groups.extend(by_source[i] for i in indexes)
            continue
        from maw.postprocess_annotations import validate_annotations
        notes, note_warnings = validate_annotations(response.get("annotations"), {f"c{i + 1:04d}": sources[i] for i in indexes})
        annotations.extend(notes)
        warnings.extend(note_warnings)
        for group in refine_groups(groups, maximum):
            parts, over = limit_groups(group, maximum)
            output_groups.extend(parts)
            if over:
                annotations.append({"source_ids": [f"c{i + 1:04d}" for i in dict.fromkeys(u.source for u in group)], "kind": "review", "message": f"完整词项、数字单位或无词级时间段无法安全满足最大 {maximum} 字；已保留，请人工核查。"})
                warnings.append(
                    f"第 {group[0].source + 1} 条原字幕含超长完整词项、数字单位或无词级时间段，无法安全满足最大 {maximum} 字；已保留。"
                )
        _notify_status(
            on_status,
            "toolbox_status_llm_batch_done",
            current=number,
            total=len(batches),
        )
    if batches and failed == len(batches):
        raise ValueError("所有批次的网络/服务请求都失败，未写出输出产物。")
    covered = {u.source for group in output_groups for u in group}
    output_groups.extend(by_source[i] for i in range(len(sources)) if i not in covered)
    output_groups.sort(key=lambda group: (group[0].source, group[0].start))
    used_ids = {str(s["id"]) for s in iter_segments(project)}
    rebuilt = []
    part_number = 0
    retained_source_ids = set()
    for group in output_groups:
        source_indexes = list(dict.fromkeys(u.source for u in group))
        original = sources[source_indexes[0]]
        if len(source_indexes) == 1 and group == by_source[source_indexes[0]]:
            rebuilt.append(copy.deepcopy(original))
            retained_source_ids.add(original["id"])
            continue
        part_number += 1
        segment = _copy_common_metadata([sources[i] for i in source_indexes])
        segment.update(
            {
                "id": original["id"] if original["id"] not in retained_source_ids else _unique_derived_segment_id(
                    original, f"c{source_indexes[0] + 1:04d}", part_number, used_ids),
                "text": "".join(u.text for u in group),
                "start": group[0].start,
                "end": group[-1].end,
            }
        )
        retained_source_ids.add(original["id"])
        for key in SAFE_SCALARS:
            if key in original and all(
                sources[i].get(key) == original[key] for i in source_indexes
            ):
                segment[key] = copy.deepcopy(original[key])
        if all(u.item is not None for u in group):
            segment["items"] = [copy.deepcopy(u.item) for u in group]
        rebuilt.append(segment)
    processed = copy.deepcopy(project)
    replace_main_segments(processed, rebuilt)
    trace.results["segments"] = copy.deepcopy(rebuilt)
    remap_cleanup_scopes(processed, sources, rebuilt, output_groups, by_source)
    from maw.postprocess_annotations import write_annotations
    warnings.extend(write_annotations(processed, {f"c{i + 1:04d}": s for i, s in enumerate(sources)}, annotations, "resegment"))
    warnings.append(
        "已按字词时间码的合法边界重新断句，原文、标点与词级时间保留；无词级时间段只沿现有段边界处理。"
    )
    _raise_if_cancelled(is_cancelled)
    if begin_commit is not None and not begin_commit():
        raise LlmClientError(
            "操作已取消。", category="cancelled", operation="resegment"
        )
    _notify_status(on_status, "toolbox_status_writing")
    return _write(
        processed,
        source_project,
        source_srt,
        "resegment",
        request.output_mode,
        warnings=tuple(warnings),
        output_directory=request.output_directory,
        media_path=request.media_path,
        comparison_source=project if request.generate_comparison else None,
    )
