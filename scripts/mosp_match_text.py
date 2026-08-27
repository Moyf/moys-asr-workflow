#!/usr/bin/env python3
"""Align a MAW ``.mosp`` project with a corrected manuscript and emit SRT.

The implementation intentionally uses only Python's standard library.  MAW's
word/item-level timing is spread uniformly over the normalized characters in
each item, then difflib anchors those characters to the corrected manuscript.
"""

from __future__ import annotations

import argparse
import difflib
import json
import math
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Sequence


PRESERVED_END_PUNCTUATION = frozenset("！？：!?:")
REMOVED_END_PUNCTUATION = frozenset("，。；、,.;")
SPLIT_PUNCTUATION = PRESERVED_END_PUNCTUATION | REMOVED_END_PUNCTUATION | frozenset("\n")
CLOSING_PUNCTUATION = frozenset("”’」』】〕〉》）)]}」』】〕〉》")


class AlignmentError(ValueError):
    """Raised when input or alignment cannot produce a valid result."""


@dataclass(frozen=True)
class TimedChar:
    char: str
    start_ms: float
    end_ms: float
    cue_index: int


@dataclass(frozen=True)
class ManuscriptSegment:
    text: str
    normalized_start: int
    normalized_end: int


@dataclass(frozen=True)
class OutputCue:
    start_ms: int
    end_ms: int
    text: str


def format_timestamp(milliseconds: int) -> str:
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    seconds, millis = divmod(remainder, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{millis:03d}"


def normalize_character(character: str) -> str:
    result: list[str] = []
    for normalized in unicodedata.normalize("NFKC", character).casefold():
        if normalized.isspace() or unicodedata.category(normalized).startswith("P"):
            continue
        result.append(normalized)
    return "".join(result)


def normalize_text(text: str) -> str:
    return "".join(normalize_character(character) for character in text)


def _milliseconds(value: object, location: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
    ):
        raise AlignmentError(f"{location} 必须是毫秒数")
    milliseconds = round(value)
    if milliseconds < 0:
        raise AlignmentError(f"{location} 不能为负数")
    return milliseconds


def parse_mosp(text: str) -> tuple[list[TimedChar], int, int]:
    try:
        project = json.loads(text.lstrip("\ufeff"))
    except json.JSONDecodeError as exc:
        raise AlignmentError(f"MOSP JSON 无效：第 {exc.lineno} 行第 {exc.colno} 列") from exc
    if not isinstance(project, dict):
        raise AlignmentError("MOSP 顶层必须是 JSON 对象")
    segments = project.get("segments")
    if not isinstance(segments, list) or not segments:
        raise AlignmentError("MOSP 缺少非空 segments 数组")

    timed: list[TimedChar] = []
    item_count = 0
    previous_segment_end = -1
    previous_item_end = -1
    for segment_index, segment in enumerate(segments):
        location = f"segments[{segment_index}]"
        if not isinstance(segment, dict):
            raise AlignmentError(f"{location} 必须是 JSON 对象")
        segment_start = _milliseconds(segment.get("start"), f"{location}.start")
        segment_end = _milliseconds(segment.get("end"), f"{location}.end")
        if segment_end <= segment_start:
            raise AlignmentError(f"{location}.end 必须晚于 start")
        if segment_start < previous_segment_end:
            raise AlignmentError(f"{location} 与上一段重叠或顺序错误")
        previous_segment_end = segment_end

        items = segment.get("items")
        if not isinstance(items, list) or not items:
            raise AlignmentError(f"{location} 缺少字词级 items 时间数据")
        for item_index, item in enumerate(items):
            item_count += 1
            item_location = f"{location}.items[{item_index}]"
            if not isinstance(item, dict):
                raise AlignmentError(f"{item_location} 必须是 JSON 对象")
            item_text = item.get("text")
            if not isinstance(item_text, str):
                raise AlignmentError(f"{item_location}.text 必须是字符串")
            item_start = _milliseconds(item.get("start"), f"{item_location}.start")
            item_end = _milliseconds(item.get("end"), f"{item_location}.end")
            if item_end <= item_start:
                raise AlignmentError(f"{item_location}.end 必须晚于 start")
            if item_start < segment_start or item_end > segment_end:
                raise AlignmentError(f"{item_location} 时间超出所属 segment 范围")
            if item_start < previous_item_end:
                raise AlignmentError(f"{item_location} 与上一 item 重叠或顺序错误")
            previous_item_end = item_end

            characters = [
                normalized
                for source_character in item_text
                for normalized in normalize_character(source_character)
            ]
            if not characters:
                continue
            duration = item_end - item_start
            count = len(characters)
            for character_index, character in enumerate(characters):
                start = item_start + duration * character_index / count
                end = item_start + duration * (character_index + 1) / count
                timed.append(TimedChar(character, start, end, segment_index))
    if not timed:
        raise AlignmentError("MOSP items 中没有可用于匹配的文字、字母或数字")
    return timed, len(segments), item_count


def _clean_manuscript_for_display(text: str) -> str:
    return (
        text.lstrip("\ufeff")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
    )


def _raw_manuscript_segments(
    text: str,
    split_punctuation: frozenset[str],
    preserve_punctuation: frozenset[str],
) -> list[str]:
    segments: list[str] = []
    current: list[str] = []
    index = 0
    while index < len(text):
        character = text[index]
        if character in split_punctuation:
            if character in preserve_punctuation:
                current.append(character)
            index += 1
            while index < len(text) and (
                text[index] in split_punctuation or text[index] in CLOSING_PUNCTUATION
            ):
                if (
                    text[index] in preserve_punctuation
                    or text[index] in CLOSING_PUNCTUATION
                ):
                    current.append(text[index])
                index += 1
            value = "".join(current).strip()
            if value:
                segments.append(value)
            current = []
            continue
        current.append(character)
        index += 1
    value = "".join(current).strip()
    if value:
        segments.append(value)
    return segments


def split_manuscript(
    text: str,
    split_punctuation: frozenset[str] = SPLIT_PUNCTUATION,
    preserve_punctuation: frozenset[str] = PRESERVED_END_PUNCTUATION,
) -> tuple[str, list[ManuscriptSegment]]:
    display_text = _clean_manuscript_for_display(text)
    if "\n" not in split_punctuation:
        display_text = display_text.replace("\n", "")
    raw_segments = _raw_manuscript_segments(
        display_text, split_punctuation, preserve_punctuation
    )
    if not raw_segments:
        raise AlignmentError("文稿为空")

    # A punctuation-only fragment must never become an independent SRT cue.
    merged: list[str] = []
    leading = ""
    for raw in raw_segments:
        if not normalize_text(raw):
            if merged:
                merged[-1] += raw
            else:
                leading += raw
            continue
        merged.append(leading + raw)
        leading = ""
    if leading and merged:
        merged[-1] += leading
    if not merged:
        raise AlignmentError("文稿中没有可用于匹配的文字、字母或数字")

    normalized_parts: list[str] = []
    segments: list[ManuscriptSegment] = []
    cursor = 0
    for value in merged:
        normalized = normalize_text(value)
        start = cursor
        cursor += len(normalized)
        normalized_parts.append(normalized)
        segments.append(ManuscriptSegment(value, start, cursor))
    return "".join(normalized_parts), segments


def _allocate_interval(
    timings: list[tuple[float, float] | None],
    start_index: int,
    end_index: int,
    start_ms: float,
    end_ms: float,
) -> None:
    count = end_index - start_index
    if count <= 0:
        return
    end_ms = max(start_ms, end_ms)
    for offset, index in enumerate(range(start_index, end_index)):
        item_start = start_ms + (end_ms - start_ms) * offset / count
        item_end = start_ms + (end_ms - start_ms) * (offset + 1) / count
        timings[index] = (item_start, item_end)


def align_character_timings(
    asr_chars: Sequence[TimedChar],
    manuscript_text: str,
    policy: str,
) -> tuple[list[tuple[float, float]], dict[str, object]]:
    asr_text = "".join(item.char for item in asr_chars)
    matcher = difflib.SequenceMatcher(None, asr_text, manuscript_text, autojunk=False)
    opcodes = matcher.get_opcodes()
    matched_count = sum(i2 - i1 for tag, i1, i2, _j1, _j2 in opcodes if tag == "equal")
    asr_unmatched = sum(i2 - i1 for tag, i1, i2, _j1, _j2 in opcodes if tag != "equal")
    manuscript_unmatched = sum(
        j2 - j1 for tag, _i1, _i2, j1, j2 in opcodes if tag != "equal"
    )

    if policy == "strict" and asr_text != manuscript_text:
        raise AlignmentError(
            "strict 模式要求归一化后的 ASR 与文稿完全一致；"
            f"匹配 {matched_count}/{len(manuscript_text)} 个文稿字符"
        )

    timings: list[tuple[float, float] | None] = [None] * len(manuscript_text)
    for tag, i1, i2, j1, _j2 in opcodes:
        if tag != "equal":
            continue
        for offset in range(i2 - i1):
            source = asr_chars[i1 + offset]
            timings[j1 + offset] = (source.start_ms, source.end_ms)

    global_start = float(asr_chars[0].start_ms)
    global_end = float(asr_chars[-1].end_ms)
    anchor_indexes = [
        index for index, timing in enumerate(timings) if timing is not None
    ]

    if policy == "nearest" and anchor_indexes:
        previous_anchor: list[int | None] = []
        nearest: int | None = None
        for index in range(len(timings)):
            if timings[index] is not None:
                nearest = index
            previous_anchor.append(nearest)
        next_anchor: list[int | None] = [None] * len(timings)
        nearest = None
        for index in range(len(timings) - 1, -1, -1):
            if timings[index] is not None:
                nearest = index
            next_anchor[index] = nearest
        for index, timing in enumerate(timings):
            if timing is not None:
                continue
            left = previous_anchor[index]
            right = next_anchor[index]
            chosen = (
                right
                if left is None
                else left
                if right is None
                else (left if index - left <= right - index else right)
            )
            assert chosen is not None and timings[chosen] is not None
            timings[index] = timings[chosen]
    else:
        index = 0
        while index < len(timings):
            if timings[index] is not None:
                index += 1
                continue
            run_start = index
            while index < len(timings) and timings[index] is None:
                index += 1
            run_end = index
            left_timing = timings[run_start - 1] if run_start > 0 else None
            right_timing = timings[run_end] if run_end < len(timings) else None
            interval_start = left_timing[1] if left_timing is not None else global_start
            interval_end = right_timing[0] if right_timing is not None else global_end
            _allocate_interval(
                timings, run_start, run_end, interval_start, interval_end
            )

    resolved = [timing for timing in timings if timing is not None]
    if len(resolved) != len(timings):
        raise AlignmentError("内部错误：部分文稿字符未能获得时间")

    low_confidence: list[dict[str, object]] = []
    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "equal":
            continue
        region: dict[str, object] = {
            "operation": tag,
            "asr_range": [i1, i2],
            "manuscript_range": [j1, j2],
            "asr_text": asr_text[i1:i2],
            "manuscript_text": manuscript_text[j1:j2],
        }
        if j1 < j2:
            region["estimated_start_ms"] = round(resolved[j1][0])
            region["estimated_end_ms"] = round(resolved[j2 - 1][1])
        low_confidence.append(region)

    denominator = max(len(asr_text), len(manuscript_text), 1)
    report: dict[str, object] = {
        "policy": policy,
        "asr_characters": len(asr_text),
        "manuscript_characters": len(manuscript_text),
        "matched_characters": matched_count,
        "match_ratio": matched_count / denominator,
        "asr_unmatched_characters": asr_unmatched,
        "manuscript_unmatched_characters": manuscript_unmatched,
        "low_confidence_regions": low_confidence,
    }
    return resolved, report


def _repair_output_timings(
    raw: Sequence[tuple[float, float, str]], global_start: int, global_end: int
) -> list[OutputCue]:
    count = len(raw)
    if global_end - global_start < count:
        raise AlignmentError(f"ASR 总时长不足以为 {count} 条字幕各分配至少 1 ms")
    output: list[OutputCue] = []
    previous_end = global_start
    for index, (raw_start, raw_end, text) in enumerate(raw):
        remaining_after = count - index - 1
        latest_start = global_end - remaining_after - 1
        start = min(max(round(raw_start), previous_end, global_start), latest_start)
        latest_end = global_end - remaining_after
        end = min(max(round(raw_end), start + 1), latest_end)
        output.append(OutputCue(start, end, text))
        previous_end = end
    return output


def build_output_cues(
    segments: Sequence[ManuscriptSegment],
    timings: Sequence[tuple[float, float]],
    global_start: int,
    global_end: int,
) -> list[OutputCue]:
    raw: list[tuple[float, float, str]] = []
    for segment in segments:
        if segment.normalized_start >= segment.normalized_end:
            continue
        start = timings[segment.normalized_start][0]
        end = timings[segment.normalized_end - 1][1]
        raw.append((start, end, segment.text))
    if not raw:
        raise AlignmentError("没有生成任何字幕")
    return _repair_output_timings(raw, global_start, global_end)


def build_mosp_segments(
    segments: Sequence[ManuscriptSegment],
    timings: Sequence[tuple[float, float]],
    output_cues: Sequence[OutputCue],
) -> list[dict[str, object]]:
    if len(segments) != len(output_cues):
        raise AlignmentError("内部错误：文稿分段与输出字幕数量不一致")
    result: list[dict[str, object]] = []
    for segment, output_cue in zip(segments, output_cues):
        raw_items: list[tuple[float, float, str]] = []
        pending_prefix = ""
        normalized_index = segment.normalized_start
        for source_character in segment.text:
            normalized = normalize_character(source_character)
            if not normalized:
                if raw_items:
                    start, end, item_text = raw_items[-1]
                    raw_items[-1] = (start, end, item_text + source_character)
                else:
                    pending_prefix += source_character
                continue
            normalized_end = normalized_index + len(normalized)
            if normalized_end > segment.normalized_end:
                raise AlignmentError("内部错误：MOSP item 的文稿索引越界")
            start = timings[normalized_index][0]
            end = timings[normalized_end - 1][1]
            raw_items.append((start, end, pending_prefix + source_character))
            pending_prefix = ""
            normalized_index = normalized_end
        if pending_prefix:
            if not raw_items:
                raise AlignmentError("内部错误：MOSP segment 没有可计时的 item")
            start, end, item_text = raw_items[-1]
            raw_items[-1] = (start, end, item_text + pending_prefix)
        if normalized_index != segment.normalized_end:
            raise AlignmentError("内部错误：MOSP item 未覆盖完整文稿分段")

        repaired_items = _repair_output_timings(
            raw_items, output_cue.start_ms, output_cue.end_ms
        )
        result.append(
            {
                "start": output_cue.start_ms,
                "end": output_cue.end_ms,
                "text": segment.text,
                "items": [
                    {"text": item.text, "start": item.start_ms, "end": item.end_ms}
                    for item in repaired_items
                ],
            }
        )
    return result


def generate_srt(cues: Iterable[OutputCue]) -> str:
    blocks = [
        f"{index}\n{format_timestamp(cue.start_ms)} --> {format_timestamp(cue.end_ms)}\n{cue.text}"
        for index, cue in enumerate(cues, 1)
    ]
    return "\n\n".join(blocks) + "\n"


def _align_mosp_and_manuscript(
    mosp_text: str,
    manuscript_text: str,
    policy: str = "fuzzy",
    split_punctuation: frozenset[str] = SPLIT_PUNCTUATION,
    preserve_punctuation: frozenset[str] = PRESERVED_END_PUNCTUATION,
) -> tuple[
    list[OutputCue],
    dict[str, object],
    list[ManuscriptSegment],
    list[tuple[float, float]],
]:
    if policy not in {"fuzzy", "strict", "nearest"}:
        raise AlignmentError(f"不支持的错漏策略：{policy}")
    asr_chars, segment_count, item_count = parse_mosp(mosp_text)
    normalized_manuscript, segments = split_manuscript(
        manuscript_text, split_punctuation, preserve_punctuation
    )
    timings, report = align_character_timings(asr_chars, normalized_manuscript, policy)
    global_start = round(asr_chars[0].start_ms)
    global_end = round(asr_chars[-1].end_ms)
    output = build_output_cues(segments, timings, global_start, global_end)
    report["input_segments"] = segment_count
    report["input_items"] = item_count
    report["output_cues"] = len(output)
    return output, report, segments, timings


def align_mosp_and_manuscript(
    mosp_text: str,
    manuscript_text: str,
    policy: str = "fuzzy",
    split_punctuation: frozenset[str] = SPLIT_PUNCTUATION,
    preserve_punctuation: frozenset[str] = PRESERVED_END_PUNCTUATION,
) -> tuple[list[OutputCue], dict[str, object]]:
    output, report, _segments, _timings = _align_mosp_and_manuscript(
        mosp_text,
        manuscript_text,
        policy,
        split_punctuation,
        preserve_punctuation,
    )
    return output, report


def generate_matched_mosp(
    mosp_text: str,
    manuscript_text: str,
    policy: str = "fuzzy",
    split_punctuation: frozenset[str] = SPLIT_PUNCTUATION,
    preserve_punctuation: frozenset[str] = PRESERVED_END_PUNCTUATION,
) -> tuple[list[OutputCue], dict[str, object], str]:
    output, report, segments, timings = _align_mosp_and_manuscript(
        mosp_text,
        manuscript_text,
        policy,
        split_punctuation,
        preserve_punctuation,
    )
    try:
        project = json.loads(mosp_text.lstrip("\ufeff"))
    except json.JSONDecodeError as exc:  # parse_mosp normally reports this first.
        raise AlignmentError("MOSP JSON 无效") from exc
    project["segments"] = build_mosp_segments(segments, timings, output)
    content = json.dumps(project, ensure_ascii=False, indent=2) + "\n"
    return output, report, content


def _safe_resolved(path: Path) -> Path:
    return path.expanduser().resolve(strict=False)


def _validate_output_paths(
    input_path: Path,
    manuscript_path: Path,
    output_path: Path,
    report_path: Path | None,
    mosp_output_path: Path | None = None,
) -> None:
    protected = {_safe_resolved(input_path), _safe_resolved(manuscript_path)}
    resolved_output = _safe_resolved(output_path)
    if resolved_output in protected:
        raise AlignmentError("输出路径不能覆盖输入 MOSP 或文稿")
    if report_path is not None:
        resolved_report = _safe_resolved(report_path)
        if resolved_report in protected or resolved_report == resolved_output:
            raise AlignmentError("报告路径不能覆盖输入文件或输出 SRT")
    if mosp_output_path is not None:
        resolved_mosp_output = _safe_resolved(mosp_output_path)
        conflicts = protected | {resolved_output}
        if report_path is not None:
            conflicts.add(_safe_resolved(report_path))
        if resolved_mosp_output in conflicts:
            raise AlignmentError("MOSP 输出路径不能覆盖输入文件、输出 SRT 或报告")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="将 MOSP 字词时间码对齐到校订文稿")
    parser.add_argument(
        "-m",
        "--input-mosp",
        required=True,
        type=Path,
        help="MAW 生成的 .mosp JSON 工程（必填）",
    )
    parser.add_argument(
        "-t",
        "--input-text",
        dest="input_text",
        type=Path,
        help="UTF-8 TXT/Markdown 文稿；默认与 MOSP 同名的 .txt",
    )
    parser.add_argument(
        "--os",
        "--output-srt",
        dest="output_srt",
        type=Path,
        help="输出 SRT；默认 <MOSP 文件名>.match_text.srt",
    )
    parser.add_argument(
        "--om",
        "--output-mosp",
        dest="output_mosp",
        type=Path,
        help="输出 MOSP；默认 <MOSP 文件名>.match_text.mosp",
    )
    parser.add_argument(
        "--mismatch-policy",
        choices=("fuzzy", "strict", "nearest"),
        default="fuzzy",
        help="错漏字策略（默认：fuzzy）",
    )
    parser.add_argument("--report", type=Path, help="可选的 JSON 匹配报告路径")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    input_mosp = args.input_mosp
    input_text = args.input_text or input_mosp.with_suffix(".txt")
    output_srt = args.output_srt or input_mosp.with_suffix(".match_text.srt")
    output_mosp = args.output_mosp or input_mosp.with_suffix(".match_text.mosp")
    try:
        _validate_output_paths(
            input_mosp, input_text, output_srt, args.report, output_mosp
        )
        mosp_text = input_mosp.read_text(encoding="utf-8-sig")
        manuscript_text = input_text.read_text(encoding="utf-8-sig")
        output_cues, report, matched_mosp = generate_matched_mosp(
            mosp_text, manuscript_text, args.mismatch_policy
        )
        output_srt.parent.mkdir(parents=True, exist_ok=True)
        output_srt.write_text(generate_srt(output_cues), encoding="utf-8", newline="\n")
        output_mosp.parent.mkdir(parents=True, exist_ok=True)
        output_mosp.write_text(matched_mosp, encoding="utf-8", newline="\n")
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
                newline="\n",
            )
    except (AlignmentError, OSError, UnicodeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2

    print(f"SRT：{output_srt}")
    print(
        "匹配："
        f"{report['matched_characters']}/{report['manuscript_characters']} 个文稿字符，"
        f"匹配率 {report['match_ratio']:.2%}"
    )
    print(
        f"错漏：ASR {report['asr_unmatched_characters']} 字符，"
        f"文稿 {report['manuscript_unmatched_characters']} 字符；"
        f"低置信区段 {len(report['low_confidence_regions']) if isinstance(report['low_confidence_regions'], list) else 0} 个"
    )
    print(
        f"数据：{report['input_segments']} 个 MOSP 段、{report['input_items']} 个字词 item -> "
        f"{report['output_cues']} 条输出字幕"
    )
    if args.report:
        print(f"报告：{args.report}")
    print(f"MOSP：{output_mosp}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
