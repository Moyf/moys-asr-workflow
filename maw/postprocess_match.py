# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownVariableType=false, reportReturnType=false

"""Match an authoritative script to existing subtitle time slots."""

from __future__ import annotations

import copy
import difflib
import json
import unicodedata
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from pathlib import Path
from collections.abc import Callable, Mapping, Sequence
from typing import Final

from maw.project_mutations import fresh_segment_id, replace_main_segments
from maw.project_tracks import get_main_track, get_tracks_by_role, iter_segments
from maw.postprocess import OutputMode, _reconcile_items
from maw.postprocess_io import SubtitleArtifact, PostprocessFileError, read_project, read_srt, write_artifacts
from maw.project import normalize_project
from maw.project_preview import JsonDict, JsonValue
from scripts.mosp_match_text import (
    AlignmentError,
    MatchCancelledError,
    cancellable_sequence_matcher,
    check_match_cancelled,
    CLOSING_PUNCTUATION,
    MARKDOWN_EXTENSIONS,
    clean_markdown_text,
    clean_markdown_inline_symbols,
    generate_matched_mosp,
    normalize_character,
    normalize_text,
)


SCRIPT_EXTENSIONS = frozenset({".txt", *MARKDOWN_EXTENSIONS})
MIN_MATCH_COVERAGE = 0.55
# 结构性断句：换行始终生效，不可配置。其余断句符号完全来自共享配置
# （「需要断句的符号」默认清单，见 DEFAULT_EXTRA_SPLIT_PUNCTUATION）。
DEFAULT_SPLIT_PUNCTUATION = frozenset({"\n"})
# 共享断句配置的默认值：文稿匹配与转写共用的唯一真源，没有隐式基础集。
# 转写模块（maw.asr.*）的 CLI 参数默认值与本清单保持一致。
DEFAULT_EXTRA_SPLIT_PUNCTUATION: Final[tuple[str, ...]] = (
    "，",
    "。",
    "？",
    "！",
    "；",
    ",",
    ".",
    ";",
)
DEFAULT_PRESERVE_PUNCTUATION: Final[tuple[str, ...]] = DEFAULT_EXTRA_SPLIT_PUNCTUATION
# CLI 参数默认值（strip = 默认断句 − 默认保留；strong = 完整默认断句）。
DEFAULT_STRIP_TAIL_PUNCT: Final[str] = ""
DEFAULT_STRONG_PUNCT: Final[str] = "，。？！；,.;"


class MatchCoverageError(ValueError):
    """Raised when alignment is too uncertain to write a match artifact."""

    def __init__(self, coverage: float, minimum_coverage: float = MIN_MATCH_COVERAGE) -> None:
        self.coverage = coverage
        self.minimum_coverage = minimum_coverage
        super().__init__(
            f"script and subtitle match coverage is too low ({coverage:.0%}); "
            f"at least {minimum_coverage:.0%} of the shorter text must match"
        )


class SubtitleMatchError(ValueError):
    """Raised when a loaded project cannot be used for character matching."""


@dataclass(frozen=True, slots=True)
class ScriptMatchRequest:
    project_path: Path | None
    srt_path: Path | None
    script_path: Path
    output_mode: OutputMode
    output_directory: Path | None = None
    media_path: Path | None = None
    extra_split_punctuation: tuple[str, ...] = DEFAULT_EXTRA_SPLIT_PUNCTUATION
    preserve_punctuation: tuple[str, ...] = DEFAULT_PRESERVE_PUNCTUATION
    match_mode: str = "script"
    clean_markdown_symbols: bool = True


@dataclass(slots=True)
class ScriptMatchTrace:
    """Optional evidence for review, keyed by the relevant cue's time range."""

    candidates: dict[tuple[int, int], str] = field(default_factory=dict)
    issues: dict[tuple[int, int], str] = field(default_factory=dict)
    estimated: set[tuple[int, int]] = field(default_factory=set)
    coverage: tuple[float, float] | None = None


def _match_coverage(matched: int, source: int, manuscript: int, trace: ScriptMatchTrace | None) -> tuple[str, str]:
    coverage = matched / max(1, min(source, manuscript))
    if coverage < MIN_MATCH_COVERAGE:
        raise MatchCoverageError(coverage)
    manuscript_coverage = matched / max(1, manuscript)
    source_coverage = matched / max(1, source)
    if trace is not None:
        trace.coverage = manuscript_coverage, source_coverage
    return (
        f"文稿匹配度：{coverage:.0%}",
        f"覆盖率：文稿 {manuscript_coverage:.0%}，原字幕 {source_coverage:.0%}（按可匹配字符计算）。",
    )


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


def run_script_match(
    request: ScriptMatchRequest,
    *,
    is_cancelled: Callable[[], bool] | None = None,
    begin_commit: Callable[[], bool] | None = None,
    on_status: Callable[[str], None] | None = None,
) -> SubtitleArtifact:
    check_match_cancelled(is_cancelled)
    if on_status is not None:
        on_status("toolbox_status_reading")
    project, source_project, source_srt = _load_input(request.project_path, request.srt_path)
    check_match_cancelled(is_cancelled)
    script_path, script_text = _read_script(request.script_path)
    check_match_cancelled(is_cancelled)
    if request.match_mode not in {"script", "text"}:
        raise ValueError("不支持的文稿匹配模式")
    extra_split_punctuation = request.extra_split_punctuation if request.match_mode == "script" else ()
    preserve_punctuation = request.preserve_punctuation if request.match_mode == "script" else ()
    prepared_script, punctuation_warning = prepare_script_text(
        script_text,
        extra_split_punctuation,
        preserve_punctuation,
        clean_markdown_symbols=request.clean_markdown_symbols,
    )
    check_match_cancelled(is_cancelled)
    if on_status is not None:
        on_status("toolbox_status_matching")
    if (
        request.match_mode == "script"
        and source_project is not None
        and _supports_item_timed_matching(project, is_cancelled=is_cancelled)
    ):
        matched, warnings = _match_project_with_character_timings(
            project,
            prepared_script,
            request.extra_split_punctuation,
            request.preserve_punctuation,
            is_cancelled=is_cancelled,
        )
    else:
        matched, warnings = _match_project(
            project,
            prepared_script,
            DEFAULT_SPLIT_PUNCTUATION | frozenset(request.extra_split_punctuation),
            frozenset(request.preserve_punctuation),
            request.match_mode,
            is_cancelled=is_cancelled,
        )
    # Both character-timed and sentence-level matching must keep the same v2
    # group contract. The fallback must not silently reassign grouped content.
    old_active = [cue for cue in get_main_track(project)["segments"] if not cue.get("disabled")]
    new_active_count = sum(not cue.get("disabled") for cue in get_main_track(matched)["segments"])
    if new_active_count != len(old_active) and any(cue.get("color_group_id") or cue.get("sticker_group_id") for cue in old_active):
        raise ValueError("带独立分组的字幕暂不支持文稿匹配改变条数；请先在编辑器中拆合，避免丢失组关系。")
    check_match_cancelled(is_cancelled)
    if begin_commit is not None and not begin_commit():
        raise MatchCancelledError("文稿匹配已取消。")
    # Cancellation is now rejected by the operation lock. Do not check it
    # after this boundary and claim cancellation once outputs may exist.
    if on_status is not None:
        on_status("toolbox_status_writing")
    return write_artifacts(
        matched,
        source_project_path=source_project,
        source_srt_path=source_srt,
        operation="match",
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
    *,
    clean_markdown_symbols: bool = False,
) -> tuple[str, str]:
    """Validate and apply custom manuscript punctuation before matching."""

    prepared_text = clean_markdown_inline_symbols(script_text) if clean_markdown_symbols else script_text
    split_symbols = tuple(symbol for symbol in extra_split_punctuation if symbol)
    preserve_symbols = tuple(symbol for symbol in preserve_punctuation if symbol)
    # 断句符号完全由共享配置提供，换行始终生效；保留符号必须是已配置
    # 的断句符号之一。
    missing = tuple(
        symbol
        for symbol in preserve_symbols
        if symbol not in split_symbols
    )
    if missing:
        raise ValueError(
            "保留符号必须来自断句符号：" + "、".join(missing)
        )
    if not split_symbols:
        return prepared_text, "未配置断句符号，仅按换行断句。"
    return prepared_text, f"断句符号：{len(split_symbols)} 个；保留：{len(preserve_symbols)} 个。"


def processed_script_text(
    script_text: str,
    *,
    match_mode: str = "script",
    extra_split_punctuation: tuple[str, ...] = (),
    preserve_punctuation: tuple[str, ...] = (),
    clean_markdown_symbols: bool = True,
) -> str:
    """Return the same manuscript representation that matching will consume.

    The Launcher uses this for the manuscript preview so it does not show a
    different line-break or punctuation interpretation from the actual match.
    """

    if match_mode not in {"script", "text"}:
        raise ValueError("不支持的文稿匹配模式")
    prepared_text, _warning = prepare_script_text(
        script_text,
        extra_split_punctuation if match_mode == "script" else (),
        preserve_punctuation if match_mode == "script" else (),
        clean_markdown_symbols=clean_markdown_symbols,
    )
    normalized_text = prepared_text.replace("\r\n", "\n").replace("\r", "\n")
    if match_mode == "text":
        return normalized_text
    split_punctuation = DEFAULT_SPLIT_PUNCTUATION | frozenset(extra_split_punctuation)
    preserved = frozenset(preserve_punctuation)
    return "\n".join(_split_script_segments(normalized_text, split_punctuation, preserved))


def _supports_item_timed_matching(project: JsonDict, *, is_cancelled: Callable[[], bool] | None = None) -> bool:
    """Decide whether the character-timed matcher can carry this project.

    A few segments without word items are normal (the ASR service sometimes
    omits them); those get character timings synthesised from the segment
    bounds before matching.  The timed path is only used when a strict
    majority of enabled segments carry complete item timings, so projects
    without real word timings keep using the structure-preserving path.
    """

    check_match_cancelled(is_cancelled)
    segments = get_main_track(project)["segments"]
    if not isinstance(segments, list) or not segments:
        return False
    enabled_count = 0
    timed_count = 0
    for segment in segments:
        check_match_cancelled(is_cancelled)
        if not isinstance(segment, dict):
            return False
        if segment.get("disabled") is True:
            continue
        enabled_count += 1
        items = segment.get("items")
        if not isinstance(items, list) or not items:
            continue
        for item in items:
            check_match_cancelled(is_cancelled)
            if (
                not isinstance(item, dict)
                or not isinstance(item.get("text"), str)
                or not isinstance(item.get("start"), (int, float))
                or isinstance(item.get("start"), bool)
                or not isinstance(item.get("end"), (int, float))
                or isinstance(item.get("end"), bool)
            ):
                return False
            if item["end"] < item["start"] or (
                item["end"] == item["start"] and _has_matchable_text(item["text"], is_cancelled)
            ):
                return False
        source_text = normalize_text(segment["text"], is_cancelled=is_cancelled)
        item_text = "".join(normalize_text(item["text"], is_cancelled=is_cancelled) for item in items)
        if source_text != item_text:
            return False
        if source_text:
            timed_count += 1
    return enabled_count > 0 and timed_count * 2 > enabled_count


def _has_matchable_text(text: str, is_cancelled: Callable[[], bool] | None) -> bool:
    for character in text:
        check_match_cancelled(is_cancelled)
        if normalize_character(character):
            return True
    return False


def _synthesize_missing_item_timings(
    segments: list[JsonDict],
    *,
    is_cancelled: Callable[[], bool] | None = None,
) -> int:
    """Give segments without word items a single segment-wide item.

    The timed matcher distributes characters across an item's timespan, so a
    segment-wide item yields uniform character timing.  Segments whose text
    has no matchable characters contribute nothing, matching the item-based
    behaviour.
    """

    check_match_cancelled(is_cancelled)
    synthesized = 0
    for segment in segments:
        check_match_cancelled(is_cancelled)
        items = segment.get("items")
        if isinstance(items, list) and items:
            continue
        text = segment.get("text")
        if not isinstance(text, str):
            continue
        try:
            start = _integer_field(segment, "start")
            end = _integer_field(segment, "end")
        except ValueError:
            continue
        if end <= start:
            continue
        segment["items"] = [{"start": start, "end": end, "text": text}]
        if _has_matchable_text(text, is_cancelled):
            synthesized += 1
    return synthesized


def _match_project_with_character_timings(
    project: JsonDict,
    script_text: str,
    extra_split_punctuation: tuple[str, ...],
    preserve_punctuation: tuple[str, ...],
    *,
    is_cancelled: Callable[[], bool] | None = None,
    trace: ScriptMatchTrace | None = None,
) -> tuple[JsonDict, tuple[str, ...]]:
    check_match_cancelled(is_cancelled)
    split_punctuation = DEFAULT_SPLIT_PUNCTUATION | frozenset(extra_split_punctuation)
    preserved = frozenset(preserve_punctuation)
    if any(len(symbol) != 1 for symbol in split_punctuation | preserved):
        return _match_project(project, script_text, split_punctuation, preserved, "script", is_cancelled=is_cancelled, trace=trace)

    source_segments = get_main_track(project)["segments"]
    if not isinstance(source_segments, list):
        raise ValueError("project segments must be an array")
    matcher_project = copy.deepcopy(project)
    matcher_main = get_main_track(matcher_project)
    matcher_main["segments"] = [
        segment
        for segment in matcher_main["segments"]
        if isinstance(segment, dict) and segment.get("disabled") is not True
    ]
    synthesized = _synthesize_missing_item_timings(matcher_main["segments"], is_cancelled=is_cancelled)
    active_ids = {segment["id"] for segment in matcher_main["segments"]}
    # The filtered project is only a temporary matcher input. Keep disabled
    # cues and their relations in the original until the final transaction.
    matcher_project["bindings"] = [binding for binding in matcher_project["bindings"]
                                   if all(identifier in active_ids for identifier in [binding["source"]["segment_id"]])]
    mosp_text = json.dumps(matcher_project, ensure_ascii=False)
    try:
        _cues, report, matched_text = generate_matched_mosp(
            mosp_text,
            script_text,
            split_punctuation=split_punctuation,
            preserve_punctuation=preserved,
            is_cancelled=is_cancelled,
            reserved_cue_ids={cue["id"] for cue in iter_segments(project)},
            require_cue_anchor=True,
        )
    except AlignmentError as error:
        raise SubtitleMatchError(str(error)) from error

    asr_characters = _report_integer(report, "asr_characters")
    manuscript_characters = _report_integer(report, "manuscript_characters")
    matched_characters = _report_integer(report, "matched_characters")
    rate, coverage_note = _match_coverage(matched_characters, asr_characters, manuscript_characters, trace)

    raw_matched: JsonValue = json.loads(matched_text)
    if not isinstance(raw_matched, dict):
        raise ValueError("character matcher returned an invalid project")
    enabled = [cue for cue in source_segments if not cue.get("disabled")]
    for cue, contributors in zip(get_main_track(raw_matched)["segments"], report["cue_source_counts"], strict=True):
        check_match_cancelled(is_cancelled)
        _inherit_majority_speaker(cue, enabled, contributors)
        first = enabled[contributors[0][0]]
        for key in ("assStyle", "assOverride"):
            if key in first and all(enabled[i].get(key) == first[key] for i, _ in contributors):
                cue[key] = copy.deepcopy(first[key])
        if trace is not None:
            trace.candidates[_cue_range(cue)] = cue["text"]
    if trace is not None:
        trace.estimated.update(_cue_range(cue) for cue in enabled if not cue.get("items") and _has_matchable_text(cue["text"], is_cancelled))
    preserved_extras, clipped, dropped = _merge_unmatched_source_segments(
        enabled,
        raw_matched,
        report,
        issues=trace.issues if trace else None,
        is_cancelled=is_cancelled,
    )
    restored = copy.deepcopy(project)
    moved = _restore_disabled_segments(restored, get_main_track(raw_matched)["segments"], is_cancelled=is_cancelled)
    matched = normalize_project(restored)
    warnings: list[str] = [
        f"{rate}；已按字词时间码重新生成字幕段。", coverage_note,
    ]
    if synthesized:
        warnings.append(f"{synthesized} 个字幕段缺少字词时间码，已按原字幕起止时间估算。")
    if unanchored := _report_integer(report, "unanchored_manuscript_cues"):
        warnings.append(f"{unanchored} 个文稿段没有对应的原字幕字符，未生成字幕。")
    if _report_integer(report, "unplaced_manuscript_characters"):
        warnings.append("部分新增或改写文字没有可靠的独立时间码，已并入同段相邻字词，未拉长字幕时间。")
    if preserved_extras:
        warnings.append(f"已保留 {preserved_extras} 个文稿之外的 ASR 字幕段。")
    if clipped:
        warnings.append(f"{clipped} 个文稿之外的 ASR 字幕段与匹配结果重叠，已收窄到空隙内。")
    if dropped:
        warnings.append(f"{dropped} 个文稿之外的 ASR 字幕段与匹配结果完全重叠，未保留。")
    if moved:
        warnings.append(f"{moved} 个禁用字幕与匹配结果重叠，已按原时间和词码移至叠加轨。")
    return matched, tuple(warnings)


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


def _restore_disabled_segments(project: JsonDict, enabled: list[JsonDict], *, is_cancelled=None) -> int:
    """Reinsert disabled cues without changing their timing, identity or annotations."""
    ends = [cue["end"] for cue in enabled]
    main = list(enabled)
    moved = []
    bound_ids = {binding["source"]["segment_id"] for binding in project["bindings"]}
    for cue in get_main_track(project)["segments"]:
        check_match_cancelled(is_cancelled)
        if not cue.get("disabled"):
            continue
        index = bisect_right(ends, cue["start"])
        if index < len(enabled) and enabled[index]["start"] < cue["end"]:
            if cue["id"] in bound_ids:
                raise SubtitleMatchError("重叠的禁用字幕带有主副轨绑定，无法移至叠加轨。")
            moved.append(cue)
        else:
            main.append(cue)
    if moved:
        overlays = get_tracks_by_role(project, "overlay")
        if overlays:
            overlay = overlays[0]
            if overlay.get("variant", "plain") != "plain":
                raise SubtitleMatchError("已有叠加轨使用其他类型，无法放入重叠的禁用字幕。")
        else:
            track_id = fresh_segment_id("overlay", {track["id"] for track in project["tracks"]})
            overlay = {"id": track_id, "role": "overlay", "name": "叠加字幕", "enabled": False, "segments": []}
            project["tracks"].append(overlay)
        combined = sorted([*overlay["segments"], *moved], key=_cue_range)
        if any(left["end"] > right["start"] for left, right in zip(combined, combined[1:])):
            raise SubtitleMatchError("已有叠加轨在该时段有字幕，无法原样放入重叠的禁用字幕。")
        overlay["segments"] = combined
    replace_main_segments(project, sorted(main, key=_cue_range))
    return len(moved)


def _cue_range(segment: JsonDict) -> tuple[int, int]:
    return _integer_field(segment, "start"), _integer_field(segment, "end")


def _fit_segments_into_gaps(
    candidates: list[JsonDict],
    matched_segments: list[JsonValue],
    *,
    is_cancelled: Callable[[], bool] | None = None,
    issues: dict[tuple[int, int], str] | None = None,
) -> tuple[list[JsonDict], int, int]:
    """Fit candidate cues into the gaps between matched manuscript cues.

    Manuscript cues are authoritative and never move.  A candidate that only
    partially overlaps them keeps the largest free part of its original
    range (its stale word items are dropped); one that is fully covered is
    dropped because two subtitles cannot share the same timespan.  Returns
    the fitted segments plus how many were clipped and dropped.
    """

    check_match_cancelled(is_cancelled)
    occupied: list[tuple[int, int]] = []
    for segment in matched_segments:
        check_match_cancelled(is_cancelled)
        if not isinstance(segment, dict):
            continue
        start = segment.get("start")
        end = segment.get("end")
        if isinstance(start, (int, float)) and isinstance(end, (int, float)):
            occupied.append((round(start), round(end)))
    occupied.sort()
    fitted: list[JsonDict] = []
    clipped = 0
    dropped = 0
    first_overlap = 0
    for piece in sorted(candidates, key=lambda segment: (_integer_field(segment, "start"), _integer_field(segment, "end"))):
        check_match_cancelled(is_cancelled)
        start = _integer_field(piece, "start")
        end = _integer_field(piece, "end")
        while first_overlap < len(occupied) and occupied[first_overlap][1] <= start:
            check_match_cancelled(is_cancelled)
            first_overlap += 1
        cursor = start
        best = (start, start)
        for index in range(first_overlap, len(occupied)):
            check_match_cancelled(is_cancelled)
            occupied_start, occupied_end = occupied[index]
            if occupied_start >= end or cursor >= end:
                break
            if occupied_start - cursor > best[1] - best[0]:
                best = (cursor, occupied_start)
            cursor = max(cursor, occupied_end)
        if end - cursor > best[1] - best[0]:
            best = (cursor, end)
        if best[1] <= best[0]:
            dropped += 1
            if issues is not None:
                issues[(start, end)] = "dropped"
            continue
        if best != (start, end):
            clipped += 1
            if issues is not None:
                issues[(start, end)] = "clipped"
            piece = copy.deepcopy(piece)
            piece["start"] = best[0]
            piece["end"] = best[1]
            # 原 items / 帧号对应的时间范围已不再成立。
            piece.pop("items", None)
            piece.pop("start_frame", None)
            piece.pop("end_frame", None)
        fitted.append(piece)
    return fitted, clipped, dropped


def _merge_unmatched_source_segments(
    matcher_segments: object,
    matched: JsonDict,
    report: Mapping[str, object],
    *,
    is_cancelled: Callable[[], bool] | None = None,
    issues: dict[tuple[int, int], str] | None = None,
) -> tuple[int, int, int]:
    """Keep complete source cues without a reliable character match.

    The timed matcher intentionally builds output cues from manuscript
    characters.  A source cue that is deleted by the character alignment has
    no manuscript character to anchor it, so it would otherwise disappear
    from the regenerated project.  Keep those complete cues at their source
    timestamps; gaps around them are already left by the neighbouring
    manuscript character timings.  Cues whose timestamps collide with a
    manuscript cue are narrowed into the free gaps (or dropped when fully
    covered) so the merged project stays valid.
    """

    check_match_cancelled(is_cancelled)
    matched_segments = get_main_track(matched)["segments"]
    if not isinstance(matched_segments, list) or not isinstance(matcher_segments, list):
        raise ValueError("character matcher returned invalid segments")
    raw_indexes = report.get("unmatched_source_segment_indexes")
    if not isinstance(raw_indexes, list):
        return 0, 0, 0
    extras: list[JsonDict] = []
    for raw_index in raw_indexes:
        check_match_cancelled(is_cancelled)
        if type(raw_index) is not int or raw_index < 0 or raw_index >= len(matcher_segments):
            continue
        source_segment = matcher_segments[raw_index]
        if isinstance(source_segment, dict):
            if issues is not None:
                issues[_cue_range(source_segment)] = "unmatched"
            extras.append(copy.deepcopy(source_segment))
    if not extras:
        return 0, 0, 0
    fitted, clipped, dropped = _fit_segments_into_gaps(
        extras, matched_segments, is_cancelled=is_cancelled, issues=issues,
    )
    combined = sorted([*matched_segments, *fitted], key=_cue_range)
    replace_main_segments(matched, combined)
    return len(fitted), clipped, dropped


def _match_project(
    project: JsonDict,
    script_text: str,
    split_punctuation: frozenset[str] = DEFAULT_SPLIT_PUNCTUATION,
    preserve_punctuation: frozenset[str] = frozenset(),
    match_mode: str = "script",
    *,
    is_cancelled: Callable[[], bool] | None = None,
    trace: ScriptMatchTrace | None = None,
) -> tuple[JsonDict, tuple[str, ...]]:
    check_match_cancelled(is_cancelled)
    if match_mode not in {"script", "text"}:
        raise ValueError("不支持的文稿匹配模式")
    segments = get_main_track(project)["segments"]
    if not isinstance(segments, list):
        raise ValueError("project segments must be an array")

    punctuation_segments = _split_script_segments(script_text, split_punctuation, preserve_punctuation, is_cancelled=is_cancelled) if match_mode == "script" else ()
    alignment_text = "".join(punctuation_segments) if punctuation_segments else script_text.replace("\r", "").replace("\n", "")
    script = _normalize_text(alignment_text, is_cancelled=is_cancelled)
    source_parts: list[str] = []
    spans: list[_CueSpan] = []
    offset = 0
    for index, raw_segment in enumerate(segments):
        check_match_cancelled(is_cancelled)
        if not isinstance(raw_segment, dict) or raw_segment.get("disabled") is True:
            continue
        text = raw_segment.get("text")
        if not isinstance(text, str):
            continue
        normalized = _normalize_text(text, is_cancelled=is_cancelled)
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

    matcher = cancellable_sequence_matcher(source_text, script.value, is_cancelled=is_cancelled)
    opcodes = tuple(matcher.get_opcodes())
    blocks = tuple(block for block in matcher.get_matching_blocks() if block.size)
    matched_chars = sum(block.size for block in blocks)
    rate, coverage_note = _match_coverage(matched_chars, len(source_text), len(script.value), trace)
    source_match_ranges = [(block.a, block.a + block.size) for block in blocks]

    has_manuscript_boundaries = len(punctuation_segments) > 1 and (
        "\n" in script_text or "\r" in script_text or any(symbol in script_text for symbol in split_punctuation)
    )
    script_boundary_positions = {0}
    script_offset = 0
    for manuscript_segment in punctuation_segments:
        check_match_cancelled(is_cancelled)
        script_offset += len(_normalize_text(manuscript_segment, is_cancelled=is_cancelled).value)
        script_boundary_positions.add(script_offset)
    has_boundary_source_only_text = any(
        tag == "delete"
        and i1 < i2
        and j1 == j2
        and j1 in script_boundary_positions
        for tag, i1, i2, j1, j2 in opcodes
    )
    explicit_newlines = "\n" in script_text or "\r" in script_text
    same_aligned_lines = len(punctuation_segments) == len(spans) and _matches_stay_in_same_lines(
        spans, sorted(script_boundary_positions - {0}), blocks, is_cancelled=is_cancelled,
    )
    boundaries = _alignment_boundaries(len(source_text), len(script.value), blocks)
    kept_source_segmentation = False
    if has_manuscript_boundaries and (
        len(punctuation_segments) != len(spans) or has_boundary_source_only_text
        or (explicit_newlines and not same_aligned_lines)
    ):
        result = _resegment_project(
            project,
            segments,
            spans,
            punctuation_segments,
            source_text,
            script,
            boundaries,
            opcodes,
            blocks[-1].a + blocks[-1].size if blocks else 0,
            is_cancelled=is_cancelled,
            trace=trace,
        )
        if result is not None:
            return result, (f"{rate}；已按文稿换行更新。", coverage_note)
        kept_source_segmentation = True

    result = copy.deepcopy(project)
    result_segments = get_main_track(result)["segments"]
    if not isinstance(result_segments, list):
        raise ValueError("project segments must be an array")
    unmatched = 0
    changed = 0
    for index, span in enumerate(spans):
        check_match_cancelled(is_cancelled)
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
        replacement = (
            punctuation_segments[index] if explicit_newlines and same_aligned_lines
            else _slice_normalized(alignment_text, script, script_start, script_end)
        )
        if trace is not None and replacement:
            trace.candidates[_cue_range(source_segment)] = replacement
        if not replacement:
            if trace is not None:
                trace.issues[_cue_range(source_segment)] = "unmatched"
            unmatched += 1
            continue
        replacement_length = len(_normalize_text(replacement, is_cancelled=is_cancelled).value)
        source_length = span.normalized_end - span.normalized_start
        if not _plausible_replacement(replacement_length, source_length):
            # 边界插值把文稿新增内容摊到了不相干的字幕段上（例如整句被
            # 替换成单个字母）；保留原字幕，避免破坏正确文本。
            unmatched += 1
            if trace is not None:
                trace.issues[_cue_range(source_segment)] = "fragment"
            continue
        if not _range_has_match(source_match_ranges, span.normalized_start, span.normalized_end):
            unmatched += 1
            if trace is not None:
                trace.issues[_cue_range(source_segment)] = "unmatched"
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

    warnings: list[str] = [f"{rate}；已更新 {changed} 个字幕段。", coverage_note]
    if kept_source_segmentation:
        warnings.append("无法可靠地按文稿重建全部分段，已保留原字幕分段。")
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
    opcodes: Sequence[tuple[str, int, int, int, int]],
    matched_source_end: int,
    *,
    is_cancelled: Callable[[], bool] | None = None,
    trace: ScriptMatchTrace | None = None,
) -> JsonDict | None:
    check_match_cancelled(is_cancelled)
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
        check_match_cancelled(is_cancelled)
        offset += len(_normalize_text(value, is_cancelled=is_cancelled).value)
        script_offsets.append(offset)
    script_boundaries = (0, *script_offsets)
    equal_runs = [(j1, j2, i1) for tag, i1, _i2, j1, j2 in opcodes if tag == "equal"]
    script_match_ranges = [(start, end) for start, end, _ in equal_runs]
    if any(not _range_has_match(script_match_ranges, start, end) for start, end in zip(script_boundaries, script_offsets)):
        # No line-level match: fall back to cue-preserving corrections rather
        # than building timestamps for the unmatched manuscript line.
        return None
    source_offsets = [
        _map_script_boundary(boundary, boundaries, source_length)
        for boundary in script_boundaries
    ]
    source_offsets = [min(offset, matched_source_end) for offset in source_offsets]
    source_starts = list(source_offsets)
    source_ends = list(source_offsets)
    # A deletion at a manuscript boundary has two valid source positions: the
    # previous manuscript cue must end before the deleted source range, while
    # the next cue must start after it.  The old single boundary mapping chose
    # the left side for both and consequently swallowed the deletion into the
    # next cue.
    for tag, source_start, source_end, script_start, script_end in opcodes:
        check_match_cancelled(is_cancelled)
        if tag != "delete" or script_start != script_end or source_start >= source_end:
            continue
        for boundary_index, boundary in enumerate(script_boundaries):
            check_match_cancelled(is_cancelled)
            if boundary != script_start:
                continue
            source_starts[boundary_index] = max(
                source_starts[boundary_index],
                min(source_end, matched_source_end),
            )
            source_ends[boundary_index] = min(
                source_ends[boundary_index],
                min(source_start, matched_source_end),
            )

    span_ends = [span.normalized_end for span in spans]

    def source_span(position: int, *, start_boundary: bool) -> _CueSpan:
        # In the flattened text, the end of A and start of B share the same
        # offset even when they are separated by silence on the timeline.
        find = bisect_right if start_boundary else bisect_left
        return spans[min(find(span_ends, position), len(spans) - 1)]

    def source_time(position: int, *, start_boundary: bool) -> int:
        span = source_span(position, start_boundary=start_boundary)
        segment = original_segments[span.segment_index]
        ratio = (position - span.normalized_start) / (span.normalized_end - span.normalized_start)
        start, end = _cue_range(segment)
        return round(start + ratio * (end - start))

    def aligned_counts(script_start: int, script_end: int) -> list[tuple[int, int]]:
        counts: list[tuple[int, int]] = []
        run_index = bisect_right(equal_runs, script_start, key=lambda run: run[1])
        for j in range(run_index, len(equal_runs)):
            check_match_cancelled(is_cancelled)
            run_start, run_end, source_start = equal_runs[j]
            if run_start >= script_end:
                break
            source_left = source_start + max(run_start, script_start) - run_start
            source_right = source_start + min(run_end, script_end) - run_start
            span_index = bisect_right(span_ends, source_left)
            while source_left < source_right:
                check_match_cancelled(is_cancelled)
                span = spans[span_index]
                right = min(span.normalized_end, source_right)
                counts.append((span.segment_index, right - source_left))
                source_left = right
                span_index += 1
        return counts

    reserved = {cue["id"] for cue in iter_segments(project)}
    source_for: dict[str, set[int]] = {}
    rebuilt: list[tuple[int, int, JsonDict]] = []
    for index, text in enumerate(manuscript_segments):
        check_match_cancelled(is_cancelled)
        start = source_time(source_starts[index], start_boundary=True)
        end = source_time(source_ends[index + 1], start_boundary=False)
        if end <= start:
            return None
        source_index = source_span(source_starts[index], start_boundary=True).segment_index
        segment = copy.deepcopy(original_segments[source_index])
        segment["id"] = fresh_segment_id(f"main-matched-{index + 1:03d}", reserved)
        segment["start"] = start
        segment["end"] = end
        segment["text"] = text
        segment.pop("items", None)
        segment.pop("start_frame", None)
        segment.pop("end_frame", None)
        contributors = aligned_counts(script_boundaries[index], script_boundaries[index + 1])
        source_for[segment['id']] = {i for i, _ in contributors}
        _inherit_majority_speaker(segment, original_segments, contributors)
        rebuilt.append((source_starts[index], source_ends[index + 1], segment))

    delete_ranges = [
        (i1, i2)
        for tag, i1, i2, _j1, _j2 in opcodes
        if tag == "delete" and i1 < i2
    ]
    extra_segments: list[tuple[int, int, JsonDict]] = []
    extra_piece_index = 0
    matched_ranges = [
        (start, end)
        for start, end, _segment in rebuilt
        if start < end
    ]
    for delete_start, delete_end in delete_ranges:
        # A deletion inside one manuscript cue cannot be represented as an
        # additional non-overlapping cue without splitting that manuscript
        # cue as well.  Boundary deletions (the common "extra sentence between
        # two script lines" case) are unambiguous and are retained below.
        check_match_cancelled(is_cancelled)
        if any(
            delete_start < matched_end and delete_end > matched_start
            for matched_start, matched_end in matched_ranges
        ):
            continue
        for span in spans:
            check_match_cancelled(is_cancelled)
            overlap_start = max(delete_start, span.normalized_start)
            overlap_end = min(delete_end, span.normalized_end)
            if overlap_start >= overlap_end:
                continue
            source_segment = original_segments[span.segment_index]
            source_text = str(source_segment.get("text") or "")
            normalized_source = _normalize_text(source_text, is_cancelled=is_cancelled)
            local_start = overlap_start - span.normalized_start
            local_end = overlap_end - span.normalized_start
            original_start = normalized_source.original_boundary(local_start, len(source_text))
            original_end = normalized_source.original_boundary(local_end, len(source_text))
            text = source_text[original_start:original_end].strip()
            if not text or not _normalize_text(text, is_cancelled=is_cancelled).value:
                continue
            extra_piece_index += 1
            piece = copy.deepcopy(source_segment)
            is_full_segment = local_start == 0 and local_end == len(normalized_source.value)
            if not is_full_segment:
                start = source_time(overlap_start, start_boundary=True)
                end = source_time(overlap_end, start_boundary=False)
                if end <= start:
                    continue
                piece["start"] = start
                piece["end"] = end
                piece["text"] = text
                piece.pop("items", None)
                piece.pop("start_frame", None)
                piece.pop("end_frame", None)
                base_id = str(piece.get("id") or f"main-{span.segment_index + 1:03d}")
                suffix = f"-unmatched-{extra_piece_index:03d}"
                piece["id"] = fresh_segment_id(base_id[:150 - len(suffix)] + suffix, reserved)
            source_for[piece["id"]] = {span.segment_index}
            extra_segments.append((overlap_start, overlap_end, piece))

    entries: list[tuple[int, int, int, JsonDict]] = [
        (start, end, 1, segment)
        for start, end, segment in rebuilt
    ] + [
        (start, end, 0, segment)
        for start, end, segment in extra_segments
    ]
    entries.sort(key=lambda item: (item[0], item[1], item[2]))
    replacement = [cue for _, _, _, cue in entries]
    protected = project["bindings"] or any(cue.get("color_group_id") or cue.get("sticker_group_id") for cue in original_segments)
    if protected:
        if len(replacement) != len(original_segments):
            raise SubtitleMatchError("带独立分组或双语绑定的工程暂不支持文稿匹配改变字幕条数。")
        for index, cue in enumerate(replacement):
            if source_for[cue["id"]] != {index}:
                raise SubtitleMatchError("文稿重新分段后不能逐句对应已有分组或双语绑定。")
            cue["id"] = original_segments[index]["id"]
    replace_main_segments(result, replacement)
    normalized = normalize_project(result)
    if trace is not None:
        for _start, _end, segment in rebuilt:
            trace.candidates[_cue_range(segment)] = str(segment["text"])
    return normalized


def _matches_stay_in_same_lines(spans, script_ends, blocks, *, is_cancelled) -> bool:
    if len(script_ends) != len(spans):
        return False
    source_ends = [span.normalized_end for span in spans]
    matched_lines = set()
    for block in blocks:
        source, script, remaining = block.a, block.b, block.size
        while remaining:
            check_match_cancelled(is_cancelled)
            index = bisect_right(source_ends, source)
            if index != bisect_right(script_ends, script):
                return False
            matched_lines.add(index)
            step = min(remaining, source_ends[index] - source, script_ends[index] - script)
            source += step
            script += step
            remaining -= step
    return len(matched_lines) == len(spans)


def _range_has_match(ranges: Sequence[tuple[int, int]], start: int, end: int) -> bool:
    index = bisect_right(ranges, start, key=lambda pair: pair[1])
    return start < end and index < len(ranges) and ranges[index][0] < end


def _plausible_replacement(replacement_length: int, source_length: int) -> bool:
    """Reject boundary-interpolated slices whose size is implausible.

    Inside a replace region the manuscript slice assigned to a source cue is
    a linear interpolation, not a correspondence.  When the slice is far
    shorter (or longer) than the cue's own text it is smearing unrelated
    manuscript characters onto the cue, so the original text must win.
    """

    if source_length <= 0:
        return replacement_length > 0
    return replacement_length * 2 >= source_length and replacement_length <= source_length * 2 + 2


def _inherit_majority_speaker(
    cue: JsonDict, source: Sequence[JsonDict], counts: Sequence[tuple[int, int]],
) -> None:
    # Unlabelled aligned characters count towards the total, not towards a
    # speaker. Punctuation and inserted characters have no alignment vote.
    total = 0
    votes: dict[str, int] = {}
    for index, count in counts:
        total += count
        speaker = source[index].get("speaker")
        if isinstance(speaker, str) and speaker.strip():
            votes[speaker] = votes.get(speaker, 0) + count
    cue.pop("speaker", None)
    for speaker, count in votes.items():
        if count * 2 > total:
            cue["speaker"] = speaker
            break


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
    *,
    is_cancelled: Callable[[], bool] | None = None,
) -> tuple[str, ...]:
    """Split a manuscript at configured symbols while keeping selected marks."""

    check_match_cancelled(is_cancelled)
    if not punctuation:
        return ()
    segments: list[str] = []
    current: list[str] = []
    symbols = tuple(sorted(punctuation, key=len, reverse=True))
    index = 0
    while index < len(text):
        check_match_cancelled(is_cancelled)
        symbol = next((candidate for candidate in symbols if text.startswith(candidate, index)), "")
        if symbol:
            if symbol in preserve_punctuation:
                current.append(symbol)
            index += len(symbol)
            while index < len(text):
                check_match_cancelled(is_cancelled)
                following = next((candidate for candidate in symbols if text.startswith(candidate, index)), "")
                if following:
                    if following in preserve_punctuation or following in CLOSING_PUNCTUATION:
                        current.append(following)
                    index += len(following)
                    continue
                if text[index] in CLOSING_PUNCTUATION:
                    current.append(text[index])
                    index += 1
                    continue
                break
            value = "".join(current).strip()
            if _normalize_text(value, is_cancelled=is_cancelled).value:
                segments.append(value)
            current = []
            continue
        current.append(text[index])
        index += 1
    value = "".join(current).strip()
    if _normalize_text(value, is_cancelled=is_cancelled).value:
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


def _normalize_text(value: str, *, is_cancelled: Callable[[], bool] | None = None) -> _NormalizedText:
    check_match_cancelled(is_cancelled)
    chars: list[str] = []
    original_starts: list[int] = []
    for index, original_char in enumerate(value):
        check_match_cancelled(is_cancelled)
        normalized_char = unicodedata.normalize("NFKC", original_char).casefold()
        for char in normalized_char:
            check_match_cancelled(is_cancelled)
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
    if source.suffix.lower() in MARKDOWN_EXTENSIONS:
        text = clean_markdown_text(text)
    if not text.strip():
        raise PostprocessFileError(source, "script is empty")
    return source, text


def _load_input(project_path: Path | None, srt_path: Path | None) -> tuple[JsonDict, Path | None, Path | None]:
    if project_path is not None:
        resolved = project_path.expanduser().resolve()
        return read_project(resolved), resolved, srt_path.expanduser().resolve() if srt_path else None
    if srt_path is not None:
        resolved = srt_path.expanduser().resolve()
        return read_srt(resolved, strict=True), None, resolved
    raise ValueError("a project or SRT input is required")
