"""Keyframe-expanded packet-copy plans for the editor's gap-removed video.

One sequential demux avoids concat's independent stream seeks. Packet selection
uses each video's decode boundaries, while timestamp translation uses the common
presentation timeline. Neither codec payloads nor the PTS/DTS relationship change.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right, insort
from collections import Counter
from contextlib import ExitStack
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path


class VideoTimelineError(ValueError):
    def __init__(self, message, *, details=None):
        super().__init__(message)
        self.details = details


class VideoNoOutput(Exception):
    def __init__(self, timeline):
        super().__init__("未能安全移除空隙，未生成视频")
        self.timeline = timeline


@dataclass
class VideoCopyPlan:
    timeline: dict
    # Absolute (source start, source end, source-to-output shift), per stream.
    windows: list[list[tuple[Decimal, Decimal, Decimal]]]
    index_path: Path
    initial_dts: list[Decimal | None]
    leading_dts_count: list[int] | None = None


def _number(value):
    try:
        result = Decimal(value)
        return result if result.is_finite() else None
    except (InvalidOperation, TypeError):
        return None


def packets(path, initial_dts=None, *, include_position=False):
    """Read the file-backed compact index without retaining all packets in RAM."""
    inferred = list(initial_dts) if initial_dts else None
    with path.open(encoding="utf-8") as source:
        for line in source:
            fields = dict(part.split("=", 1) for part in line.strip().split("|") if "=" in part)
            if "stream_index" not in fields:
                continue
            index = int(fields["stream_index"])
            dts, duration = _number(fields.get("dts_time")), _number(fields.get("duration_time"))
            if inferred is not None and dts is None and inferred[index] is not None:
                dts = inferred[index]
            if inferred is not None and dts is not None:
                inferred[index] = dts + (duration or Decimal(0))
            record = (index, _number(fields.get("pts_time")), dts, duration, "K" in fields.get("flags", ""))
            yield (*record, fields.get("pos"), fields.get("size")) if include_position else record


def scan_packets(source, destination, ffprobe, run):
    command = [str(ffprobe), "-v", "error", "-show_packets", "-show_entries",
               "packet=stream_index,pts_time,dts_time,duration_time,flags,pos,size",
               "-of", "compact=p=0", "-o", str(destination), str(source)]
    result = run(command, timeout=86_400)
    if result.returncode != 0 or not destination.is_file():
        raise VideoTimelineError("无法读取视频包时间线，请检查媒体工具及源文件")


def _overlap_length(intervals, start, end):
    low, high = 0, len(intervals)
    while low < high:
        middle = (low + high) // 2
        if intervals[middle][1] <= start:
            low = middle + 1
        else:
            high = middle
    total = Decimal(0)
    for index in range(low, len(intervals)):
        left, right = intervals[index]
        if left >= end:
            break
        total += max(Decimal(0), min(end, right) - max(start, left))
    return total


def removed_gap_diagnostics(requested, actual, origin, source_end, edge_reasons):
    """Measure the user's requested deletion set, including explicit trims.

    Expansion outside an internal gap is never substituted for retained gap
    length. Detail rows are bounded independently of aggregate counts.
    """
    gaps = []
    cursor = origin
    for index, (start, end) in enumerate(requested):
        start, end = max(origin, start), min(source_end, end)
        if start > cursor:
            reasons = set(edge_reasons[index][0])
            if index:
                reasons.update(edge_reasons[index - 1][1])
            gaps.append((cursor, start, "leading" if cursor == origin else "internal", reasons))
        cursor = max(cursor, end)
    if cursor < source_end:
        gaps.append((cursor, source_end, "trailing", set(edge_reasons[-1][1])))
    requested_total = removed_total = retained_total = Decimal(0)
    incomplete = internal_incomplete = 0
    rows = []
    for start, end, position, reasons in gaps:
        requested_length = end - start
        retained_length = _overlap_length(actual, start, end)
        removed_length = requested_length - retained_length
        requested_total += requested_length
        retained_total += retained_length
        removed_total += removed_length
        if retained_length <= 0:
            continue
        incomplete += 1
        internal_incomplete += position == "internal"
        if len(rows) < 128:
            rows.append({"sourceStartMs": float((start - origin) * 1000),
                         "sourceEndMs": float((end - origin) * 1000), "position": position,
                         "requestedRemovedMs": float(requested_length * 1000),
                         "actualRemovedMs": float(removed_length * 1000),
                         "retainedGapMs": float(retained_length * 1000),
                         "reasons": sorted(reasons or {"keyframe_alignment"})})
    return {"requestedRemovedMs": float(requested_total * 1000),
            "actualRemovedMs": float(removed_total * 1000),
            "retainedGapMs": float(retained_total * 1000),
            "unremovedGapCount": incomplete, "internalUnremovedGapCount": internal_incomplete,
            "gaps": rows, "gapDetailsTruncated": incomplete > len(rows)}


def prepare_video_copy(source, intervals, streams, origin, directory, ffprobe, run, check_cancelled=lambda: None,
                       *, stream_metadata=None, container_name="", inspector_factory=None):
    directory.mkdir(parents=True, exist_ok=True)
    index_path = directory / "source-packets.txt"
    scan_packets(source, index_path, ffprobe, run)
    groups = [[] for _ in streams]
    first = [None for _ in streams]
    last = [None for _ in streams]
    initial_dts = [None for _ in streams]
    missing_duration = [Decimal(0) for _ in streams]
    leading_packet_duration = [None for _ in streams]
    first_gop_pts = [[] for _ in streams]
    saw_dts = [False for _ in streams]
    leading_dts_count = [0 for _ in streams]
    for count, (index, pts, dts, duration, key, pos, size) in enumerate(packets(index_path, include_position=True)):
        if count % 4096 == 0:
            check_cancelled()
        if not 0 <= index < len(streams):
            raise VideoTimelineError("视频包含无效的媒体流索引")
        if pts is None:
            if streams[index] != "attachment":
                raise VideoTimelineError("媒体流缺少显示时间，无法在保留全部流的同时安全重组")
            continue
        duration = duration or Decimal(0)
        first[index] = pts if first[index] is None else min(first[index], pts)
        last[index] = pts + duration if last[index] is None else max(last[index], pts + duration)
        if streams[index] != "video":
            continue
        if dts is None:
            if saw_dts[index] or not duration:
                raise VideoTimelineError("视频流缺少解码时间，无法安全重组")
            if leading_packet_duration[index] is not None and duration != leading_packet_duration[index]:
                raise VideoTimelineError("视频起始包缺少解码时间且帧时长不一致，无法安全重组")
            leading_packet_duration[index] = duration
            missing_duration[index] += duration
            leading_dts_count[index] += 1
        elif not saw_dts[index]:
            saw_dts[index] = True
            if missing_duration[index]:
                initial_dts[index] = dts - missing_duration[index]
                if groups[index] and groups[index][0][1] is None:
                    groups[index][0][1] = initial_dts[index]
        if key:
            # [key PTS, key DTS, minimum PTS in GOP, maximum PTS in GOP]
            groups[index].append([pts, dts, pts, pts, pos, size])
        if not groups[index]:
            raise VideoTimelineError("视频流没有可安全解码的起始关键帧")
        groups[index][-1][2] = min(groups[index][-1][2], pts)
        groups[index][-1][3] = max(groups[index][-1][3], pts)
        if len(groups[index]) == 1 and leading_dts_count[index]:
            first_gop_pts[index].append(pts)
    videos = [index for index, kind in enumerate(streams) if kind == "video"]
    if not videos:
        raise VideoTimelineError("当前媒体没有可重组的视频轨")
    entries = {}
    video_start_dts = {}
    for index in videos:
        if not groups[index] or last[index] is None or groups[index][0][1] is None:
            raise VideoTimelineError("视频流中没有可用的关键帧")
        if initial_dts[index] is not None:
            ordered = sorted(first_gop_pts[index])
            if any(abs(right - left - leading_packet_duration[index]) > Decimal("0.0011")
                   for left, right in zip(ordered, ordered[1:])):
                raise VideoTimelineError("可变帧率视频的起始包缺少解码时间，无法安全推导")
        previous_max = None
        entries[index] = {}
        video_start_dts[index] = groups[index][0][1]
        for position, group in enumerate(groups[index]):
            pts, dts, minimum, maximum, pos, size = group
            # Open GOP / CRA leading pictures can refer across a keyframe.
            # Such a mark is not a cut boundary: expand to a closed boundary.
            temporal_safe = dts is not None and minimum >= pts and (previous_max is None or previous_max < pts)
            entries[index][pts] = (dts, pos, size, temporal_safe)
            previous_max = maximum
            # Do not retain both the full GOP and a second per-key index.
            groups[index][position] = None
        groups[index].clear()
        first_gop_pts[index].clear()
    del groups, first_gop_pts
    source_end = max(value for index, value in enumerate(last)
                     if value is not None and streams[index] in {"video", "audio"})
    # Container origin and EOF also delimit an intact source, including initial
    # inter-stream delay and audio priming. Synthetic EOF has no next keyframe.
    smallest = min(videos, key=lambda index: len(entries[index]))
    candidates = sorted(value for value in entries[smallest] if origin < value < source_end
                        and all(value in entries[index] for index in videos if index != smallest))
    actual = []
    requested_intervals = []
    edge_reasons = []
    reason_counts = Counter()
    candidate_results = {}
    nearest_cache = {}
    proven = []
    unprovable_format = set()
    if inspector_factory is None:
        from maw.media_keyframes import KeyframeInspector
        inspector_factory = KeyframeInspector
    metadata = stream_metadata or [{} for _ in streams]
    with inspector_factory(source, container_name=container_name, check_cancelled=check_cancelled) as inspector:
        def classify(point):
            if point in candidate_results:
                return candidate_results[point]
            reasons = set()
            for index in videos:
                _dts, pos, size, temporal_safe = entries[index][point]
                info = metadata[index]
                result = inspector.classify(stream_index=index, codec_name=info.get("codec_name"),
                    pos=pos, size=size, nal_length_size=info.get("nal_length_size"))
                if result.safe is not True:
                    reasons.add(result.reason)
                    reason_counts[result.reason] += 1
                    if result.reason in {"unsupported_codec", "unsupported_container"}:
                        unprovable_format.add(result.reason)
                elif not temporal_safe:
                    reasons.add("display_boundary_overlap")
                    reason_counts["display_boundary_overlap"] += 1
            accepted = not reasons
            candidate_results[point] = (accepted, reasons)
            if accepted:
                insort(proven, point)
            return accepted, reasons

        def nearest(time, direction):
            if direction < 0 and time <= origin:
                return origin, set()
            if direction > 0 and time >= source_end:
                return source_end, set()
            cursor = bisect_right(candidates, time) - 1 if direction < 0 else bisect_left(candidates, time)
            sentinel = origin if direction < 0 else source_end
            trail = []
            reasons = set()
            while 0 <= cursor < len(candidates):
                check_cancelled()
                if unprovable_format:
                    boundary = sentinel
                    reasons.update(unprovable_format)
                    break
                cached = nearest_cache.get((cursor, direction))
                if cached is not None:
                    boundary, cached_reasons = cached
                    reasons.update(cached_reasons)
                    break
                if inspector.stats.get("exhausted"):
                    position = bisect_right(proven, time) - 1 if direction < 0 else bisect_left(proven, time)
                    boundary = proven[position] if 0 <= position < len(proven) else sentinel
                    reasons.add("budget_exhausted")
                    break
                point = candidates[cursor]
                accepted, point_reasons = classify(point)
                if accepted:
                    boundary = point
                    nearest_cache[(cursor, direction)] = (point, frozenset())
                    break
                trail.append((cursor, set(point_reasons)))
                cursor += direction
            else:
                boundary = sentinel
                if not candidates:
                    reasons.add("no_common_video_boundary")
            for position, point_reasons in reversed(trail):
                reasons.update(point_reasons)
                nearest_cache[(position, direction)] = (boundary, frozenset(reasons))
            return boundary, reasons

        for start_ms, end_ms in intervals:
            start = origin + Decimal(start_ms) / 1000
            end = origin + Decimal(end_ms) / 1000
            if start >= source_end or end > source_end + Decimal("0.1"):
                raise VideoTimelineError("保留区间超出源媒体时长，请重新读取媒体后导出")
            requested_intervals.append((start, min(end, source_end)))
            start, start_reasons = nearest(start, -1)
            end, end_reasons = nearest(end, 1)
            edge_reasons.append((start_reasons, end_reasons))
            if actual and start <= actual[-1][1]:
                actual[-1] = (actual[-1][0], max(actual[-1][1], end))
            else:
                actual.append((start, end))
        diagnosis = dict(inspector.stats)
        diagnosis.update({"candidateChecks": len(candidate_results), "reasonCounts": dict(reason_counts)})
    windows = [[] for _ in streams]
    mapped = []
    output = Decimal(0)
    for start, end in actual:
        mapped.append({"sourceStartMs": float((start - origin) * 1000),
                       "sourceEndMs": float((end - origin) * 1000),
                       "outputStartMs": float(output * 1000),
                       "outputEndMs": float((output + end - start) * 1000)})
        for index, kind in enumerate(streams):
            packet_start, packet_end = start, end
            if kind == "video":
                packet_start = entries[index][start][0] if start != origin else video_start_dts[index]
                packet_end = entries[index][end][0] if end != source_end else source_end + 1
            elif kind != "subtitle" and start == origin and first[index] is not None:
                # Preserve codec priming at the beginning of the original file.
                packet_start = min(start, first[index])
            windows[index].append((packet_start, packet_end, start - output))
        output += end - start
    requested = sum(end - start for start, end in intervals)
    timeline = {"intervals": mapped, "keyframeExpansionMs": float(max(0, round(output * 1000 - requested, 3))),
                "noGapsRemoved": len(actual) == 1 and actual[0] == (origin, source_end)
                and requested < (source_end - origin) * 1000}
    timeline.update(removed_gap_diagnostics(requested_intervals, actual, origin, source_end, edge_reasons))
    timeline["diagnosis"] = diagnosis
    return VideoCopyPlan(timeline, windows, index_path, initial_dts, leading_dts_count)


def _lookup(windows, variable, value, otherwise):
    """Balanced lazy if tree: O(log intervals) work per packet, O(n) text."""
    if not windows:
        return otherwise
    middle = len(windows) // 2
    start, end, shift = windows[middle]
    hit = value(start, end, shift)
    left = _lookup(windows[:middle], variable, value, otherwise)
    right = _lookup(windows[middle + 1:], variable, value, otherwise)
    # FFprobe prints six decimal places, while BSFs see exact stream ticks.
    # Half a microsecond makes equality agree with that rounded index.
    epsilon = Decimal("0.0000005")
    return f"if(lt({variable},{start - epsilon}),{left},if(lt({variable},{end - epsilon}),{hit},{right}))"


def _mapped_time_expression(windows, variable):
    """Clamp gaps onto their shared output boundary without a linear scan."""
    if not windows:
        return "0"
    middle = len(windows) // 2
    start, end, shift = windows[middle]
    left = _mapped_time_expression(windows[:middle], variable) if middle else str(start - shift)
    right = _mapped_time_expression(windows[middle + 1:], variable) if middle + 1 < len(windows) else str(end - shift)
    return f"if(lt({variable},{start}),{left},if(lt({variable},{end}),({variable})-{shift},{right}))"


def map_retained_time(windows, time):
    """Independent Decimal projection used to verify subtitle packet duration."""
    low, high = 0, len(windows)
    while low < high:
        middle = (low + high) // 2
        if time >= windows[middle][1]:
            low = middle + 1
        else:
            high = middle
    if low == len(windows):
        return windows[-1][1] - windows[-1][2]
    start, _end, shift = windows[low]
    return max(start, time) - shift


def packet_filter(windows, video, *, subtitle=False):
    variable = "dts*tb" if video else "pts*tb"
    keep = _lookup(windows, variable, lambda *_: "1", "0")
    shift = _lookup(windows, "DTS*TB" if video else "PTS*TB", lambda _s, _e, delta: str(delta), "0")
    if not subtitle:
        return f"noise=amount=0:drop='not({keep})',setts=pts='PTS-({shift})/TB':dts='DTS-({shift})/TB'"
    # A text subtitle is an interval, not merely a packet start. A caption
    # spanning several kept parts remains contiguous after concatenation;
    # captions starting in a removed gap can still have a retained tail.
    noise_start = _mapped_time_expression(windows, "pts*tb")
    noise_end = _mapped_time_expression(windows, "(pts+duration)*tb")
    mapped_start = _mapped_time_expression(windows, "PTS*TB")
    mapped_end = _mapped_time_expression(windows, "(PTS+DURATION)*TB")
    mapped_dts = _mapped_time_expression(windows, "DTS*TB")
    # Zero/unknown-duration event packets retain the existing point selection
    # and translation. Do not reinterpret them as subtitle display intervals.
    return (f"noise=amount=0:drop='if(gt(duration,0),lte(({noise_end})-({noise_start}),tb/2),not({keep}))',"
            f"setts=pts='if(gt(DURATION,0),({mapped_start})/TB,PTS-({shift})/TB)':"
            f"dts='if(gt(DURATION,0),if(eq(DTS,NOPTS),DTS,({mapped_dts})/TB),DTS-({shift})/TB)':"
            f"duration='if(gt(DURATION,0),(({mapped_end})-({mapped_start}))/TB,DURATION)'")


def verify_video_packets(plan, output, streams, directory, ffprobe, run, check_cancelled=lambda: None):
    """Compare every retained timestamp, not muxer-repaired DTS monotonicity."""
    expected_paths = [directory / f"expected-{index}.txt" for index in range(len(streams))]
    cursors = [0] * len(streams)
    with ExitStack() as stack:
        writers = [stack.enter_context(path.open("w", encoding="utf-8", newline="\n")) for path in expected_paths]
        for count, (index, pts, dts, duration, _key) in enumerate(packets(plan.index_path, plan.initial_dts)):
            if count % 4096 == 0:
                check_cancelled()
            if streams[index] == "attachment":
                continue
            windows = plan.windows[index]
            if streams[index] == "subtitle" and duration is not None and duration > 0:
                mapped_start = map_retained_time(windows, pts)
                mapped_end = map_retained_time(windows, pts + duration)
                if mapped_end > mapped_start:
                    mapped_dts = map_retained_time(windows, dts) if dts is not None else "N/A"
                    writers[index].write(f"{mapped_start}|{mapped_dts}|{mapped_end - mapped_start}\n")
                continue
            position = dts if streams[index] == "video" else pts
            if position is None:
                continue
            while cursors[index] < len(windows) and position >= windows[cursors[index]][1]:
                cursors[index] += 1
            if cursors[index] == len(windows):
                continue
            start, end, shift = windows[cursors[index]]
            if start <= position < end:
                writers[index].write(f"{pts - shift if pts is not None else 'N/A'}|{dts - shift if dts is not None else 'N/A'}|N/A\n")
    result_index = directory / "output-packets.txt"
    scan_packets(output, result_index, ffprobe, run)
    previous = [None] * len(streams)
    missing_output_dts = [0] * len(streams)
    with ExitStack() as stack:
        readers = [stack.enter_context(path.open(encoding="utf-8")) for path in expected_paths]
        for count, (index, pts, dts, duration, _key) in enumerate(packets(result_index)):
            if count % 4096 == 0:
                check_cancelled()
            if streams[index] == "attachment":
                continue
            fields = readers[index].readline().strip().split("|")
            if len(fields) != 3:
                raise VideoTimelineError("导出结果出现重复媒体包，未保存结果")
            expected_pts, expected_dts, expected_duration = map(_number, fields)
            if expected_pts is not None and pts is None:
                raise VideoTimelineError("导出结果缺少显示时间，未保存结果")
            if expected_duration is not None and duration is None:
                raise VideoTimelineError("导出结果缺少字幕持续时间，未保存结果")
            if expected_dts is not None and dts is None:
                missing_output_dts[index] += 1
                allowed = plan.leading_dts_count[index] if plan.leading_dts_count else 0
                if streams[index] != "video" or previous[index] is not None or missing_output_dts[index] > allowed:
                    raise VideoTimelineError("导出结果缺少解码时间，未保存结果")
            for actual, expected in ((pts, expected_pts), (dts, expected_dts), (duration, expected_duration)):
                if actual is not None and expected is not None and abs(actual - expected) > Decimal("0.0021"):
                    raise VideoTimelineError("导出结果的包时间线不符合保留区间，未保存结果",
                                             details=f"stream={index}; pts/dts/duration={pts}/{dts}/{duration}; "
                                             f"expected={expected_pts}/{expected_dts}/{expected_duration}")
            if dts is not None:
                if previous[index] is not None and dts < previous[index]:
                    raise VideoTimelineError("导出结果的解码时间倒退，未保存结果")
                previous[index] = dts
        if any(reader.readline() for reader in readers):
            raise VideoTimelineError("导出结果缺少媒体包，未保存结果")
