"""Keyframe-expanded packet-copy plans for the editor's gap-removed video.

One sequential demux avoids concat's independent stream seeks. Packet selection
uses each video's decode boundaries, while timestamp translation uses the common
presentation timeline. Neither codec payloads nor the PTS/DTS relationship change.
"""
from __future__ import annotations

from bisect import bisect_left, bisect_right
from contextlib import ExitStack
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path


class VideoTimelineError(ValueError):
    def __init__(self, message, *, details=None):
        super().__init__(message)
        self.details = details


@dataclass
class VideoCopyPlan:
    timeline: dict
    # Absolute (source start, source end, source-to-output shift), per stream.
    windows: list[list[tuple[Decimal, Decimal, Decimal]]]
    index_path: Path
    initial_dts: list[Decimal | None]


def _number(value):
    try:
        result = Decimal(value)
        return result if result.is_finite() else None
    except (InvalidOperation, TypeError):
        return None


def packets(path, initial_dts=None):
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
            yield index, _number(fields.get("pts_time")), dts, duration, "K" in fields.get("flags", "")


def scan_packets(source, destination, ffprobe, run):
    command = [str(ffprobe), "-v", "error", "-show_packets", "-show_entries",
               "packet=stream_index,pts_time,dts_time,duration_time,flags",
               "-of", "compact=p=0", "-o", str(destination), str(source)]
    result = run(command, timeout=86_400)
    if result.returncode != 0 or not destination.is_file():
        raise VideoTimelineError("无法读取视频包时间线，请检查媒体工具及源文件")


def prepare_video_copy(source, intervals, streams, origin, directory, ffprobe, run, check_cancelled=lambda: None):
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
    for count, (index, pts, dts, duration, key) in enumerate(packets(index_path)):
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
        elif not saw_dts[index]:
            saw_dts[index] = True
            if missing_duration[index]:
                initial_dts[index] = dts - missing_duration[index]
                if groups[index] and groups[index][0][1] is None:
                    groups[index][0][1] = initial_dts[index]
        if key:
            # [key PTS, key DTS, minimum PTS in GOP, maximum PTS in GOP]
            groups[index].append([pts, dts, pts, pts])
        if not groups[index]:
            raise VideoTimelineError("视频流没有可安全解码的起始关键帧")
        groups[index][-1][2] = min(groups[index][-1][2], pts)
        groups[index][-1][3] = max(groups[index][-1][3], pts)
        if len(groups[index]) == 1:
            first_gop_pts[index].append(pts)
    videos = [index for index, kind in enumerate(streams) if kind == "video"]
    if not videos:
        raise VideoTimelineError("当前媒体没有可重组的视频轨")
    safe = {}
    for index in videos:
        if not groups[index] or last[index] is None or groups[index][0][1] is None:
            raise VideoTimelineError("视频流中没有可用的关键帧")
        if initial_dts[index] is not None:
            ordered = sorted(first_gop_pts[index])
            if any(abs(right - left - leading_packet_duration[index]) > Decimal("0.0011")
                   for left, right in zip(ordered, ordered[1:])):
                raise VideoTimelineError("可变帧率视频的起始包缺少解码时间，无法安全推导")
        previous_max = None
        safe[index] = {}
        for pts, dts, minimum, maximum in groups[index]:
            # Open GOP / CRA leading pictures can refer across a keyframe.
            # Such a mark is not a cut boundary: expand to a closed boundary.
            if dts is not None and minimum >= pts and (previous_max is None or previous_max < pts):
                safe[index][pts] = dts
            previous_max = maximum
    common = set.intersection(*(set(safe[index]) for index in videos))
    source_end = max(value for index, value in enumerate(last)
                     if value is not None and streams[index] in {"video", "audio"})
    # Container origin and EOF also delimit an intact source, including initial
    # inter-stream delay and audio priming. Synthetic EOF has no next keyframe.
    boundaries = sorted({origin, source_end, *(value for value in common if origin < value < source_end)})
    actual = []
    for start_ms, end_ms in intervals:
        start = origin + Decimal(start_ms) / 1000
        end = origin + Decimal(end_ms) / 1000
        if start >= source_end or end > source_end + Decimal("0.1"):
            raise VideoTimelineError("保留区间超出源媒体时长，请重新读取媒体后导出")
        start = boundaries[max(0, bisect_right(boundaries, start) - 1)]
        end = boundaries[min(len(boundaries) - 1, bisect_left(boundaries, end))]
        if actual and start <= actual[-1][1]:
            actual[-1] = (actual[-1][0], max(actual[-1][1], end))
        else:
            actual.append((start, end))
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
                packet_start = safe[index][start] if start != origin else groups[index][0][1]
                packet_end = safe[index][end] if end != source_end else source_end + 1
            elif start == origin and first[index] is not None:
                # Preserve codec priming at the beginning of the original file.
                packet_start = min(start, first[index])
            windows[index].append((packet_start, packet_end, start - output))
        output += end - start
    requested = sum(end - start for start, end in intervals)
    timeline = {"intervals": mapped, "keyframeExpansionMs": float(max(0, round(output * 1000 - requested, 3))),
                "noGapsRemoved": len(actual) == 1 and actual[0] == (origin, source_end)
                and requested < (source_end - origin) * 1000}
    return VideoCopyPlan(timeline, windows, index_path, initial_dts)


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


def packet_filter(windows, video):
    variable = "dts*tb" if video else "pts*tb"
    keep = _lookup(windows, variable, lambda *_: "1", "0")
    shift = _lookup(windows, "DTS*TB" if video else "PTS*TB", lambda _s, _e, delta: str(delta), "0")
    return f"noise=amount=0:drop='not({keep})',setts=pts='PTS-({shift})/TB':dts='DTS-({shift})/TB'"


def verify_video_packets(plan, output, streams, directory, ffprobe, run, check_cancelled=lambda: None):
    """Compare every retained timestamp, not muxer-repaired DTS monotonicity."""
    expected_paths = [directory / f"expected-{index}.txt" for index in range(len(streams))]
    cursors = [0] * len(streams)
    with ExitStack() as stack:
        writers = [stack.enter_context(path.open("w", encoding="utf-8", newline="\n")) for path in expected_paths]
        for count, (index, pts, dts, _duration, _key) in enumerate(packets(plan.index_path, plan.initial_dts)):
            if count % 4096 == 0:
                check_cancelled()
            if streams[index] == "attachment":
                continue
            position = dts if streams[index] == "video" else pts
            if position is None:
                continue
            windows = plan.windows[index]
            while cursors[index] < len(windows) and position >= windows[cursors[index]][1]:
                cursors[index] += 1
            if cursors[index] == len(windows):
                continue
            start, end, shift = windows[cursors[index]]
            if start <= position < end:
                writers[index].write(f"{pts - shift if pts is not None else 'N/A'}|{dts - shift if dts is not None else 'N/A'}\n")
    result_index = directory / "output-packets.txt"
    scan_packets(output, result_index, ffprobe, run)
    previous = [None] * len(streams)
    with ExitStack() as stack:
        readers = [stack.enter_context(path.open(encoding="utf-8")) for path in expected_paths]
        for count, (index, pts, dts, _duration, _key) in enumerate(packets(result_index)):
            if count % 4096 == 0:
                check_cancelled()
            if streams[index] == "attachment":
                continue
            fields = readers[index].readline().strip().split("|")
            if len(fields) != 2:
                raise VideoTimelineError("导出结果出现重复媒体包，未保存结果")
            expected_pts, expected_dts = map(_number, fields)
            for actual, expected in ((pts, expected_pts), (dts, expected_dts)):
                if actual is not None and expected is not None and abs(actual - expected) > Decimal("0.0021"):
                    raise VideoTimelineError("导出结果的包时间线不符合保留区间，未保存结果",
                                             details=f"stream={index}; pts/dts={pts}/{dts}; expected={expected_pts}/{expected_dts}")
            if dts is not None:
                if previous[index] is not None and dts < previous[index]:
                    raise VideoTimelineError("导出结果的解码时间倒退，未保存结果")
                previous[index] = dts
        if any(reader.readline() for reader in readers):
            raise VideoTimelineError("导出结果缺少媒体包，未保存结果")
