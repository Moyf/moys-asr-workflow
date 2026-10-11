"""Sample-accurate audio reconstruction with bounded memory and cancellable I/O.

Decode once, then copy the selected PCM frames. This avoids packet-boundary
cuts, long filter graphs, and command-line limits for large edit timelines.
"""
from __future__ import annotations

import json
import os
import signal
import struct
import subprocess
import tempfile
import threading
import time
from fractions import Fraction
from pathlib import Path

from maw.gui_platform import (popen_process_tree, process_group_kwargs,
                              release_process_tree, terminate_process_tree)

_COPY_BYTES = 1024 * 1024
_STDOUT_LIMIT = 2 * 1024 * 1024
_STDERR_LIMIT = 64 * 1024


class GapRemovedAudioExportError(ValueError):
    def __init__(self, message: str, *, details: str | None = None):
        super().__init__(message)
        self.details = (details or "")[-4000:]


def _run_command(command, *, job=None, timeout=120, duration_ms=None):
    if job is not None:
        return job.run_command(command, timeout=timeout, duration_ms=duration_ms)
    # Both pipes are drained concurrently, but retained output remains bounded.
    process = popen_process_tree(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                 **process_group_kwargs())
    buffers = [bytearray(), bytearray()]
    overflow = threading.Event()

    def drain(pipe, index, limit):
        while block := pipe.read(4096):
            buffers[index].extend(block)
            if len(buffers[index]) > limit:
                if index == 0:
                    overflow.set()
                del buffers[index][:-limit]

    readers = [threading.Thread(target=drain, args=(process.stdout, 0, _STDOUT_LIMIT), daemon=True),
               threading.Thread(target=drain, args=(process.stderr, 1, _STDERR_LIMIT), daemon=True)]
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + timeout
    try:
        while process.poll() is None:
            if overflow.is_set():
                raise GapRemovedAudioExportError("读取音频信息失败：媒体信息过大")
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(command, timeout)
            time.sleep(0.05)
    finally:
        terminate_process_tree(process)
        if os.name != "nt":
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
        for reader in readers:
            reader.join(timeout=5)
        for pipe, reader in zip((process.stdout, process.stderr), readers):
            if not reader.is_alive():
                pipe.close()
        release_process_tree(process)
    if any(reader.is_alive() for reader in readers):
        raise GapRemovedAudioExportError("无法关闭音频处理进程")
    if overflow.is_set():
        raise GapRemovedAudioExportError("读取音频信息失败：媒体信息过大")
    return subprocess.CompletedProcess(command, process.returncode,
        buffers[0].decode("utf-8", "replace"), buffers[1].decode("utf-8", "replace"))


def _probe(path, ffprobe_path, *, job=None, audio_track=0):
    result = _run_command([str(ffprobe_path), "-v", "error", "-select_streams", f"a:{audio_track}",
        "-show_entries", "stream=sample_rate,channels,channel_layout,sample_fmt,bits_per_raw_sample,bits_per_sample,codec_name,duration,duration_ts,time_base:format=duration",
        "-of", "json", str(path)], job=job)
    if result.returncode:
        raise GapRemovedAudioExportError("无法读取音频文件，请检查文件是否完整", details=result.stderr)
    try:
        data = json.loads(result.stdout)
        streams = data["streams"]
        if not streams:
            raise GapRemovedAudioExportError("文件中没有可导出的音轨")
        stream = streams[0]
        rate, channels = int(stream["sample_rate"]), int(stream["channels"])
        if rate <= 0 or not 1 <= channels <= 64 or rate * channels * 8 > 0xFFFFFFFF:
            raise ValueError("Invalid sample rate or channel count")
        duration = stream.get("duration") or data.get("format", {}).get("duration")
        try:
            duration_ms = max(1, int(float(duration) * 1000))
        except (TypeError, ValueError, OverflowError):
            duration_ms = None
        return stream, rate, channels, duration_ms
    except (KeyError, TypeError, ValueError, IndexError) as error:
        if isinstance(error, GapRemovedAudioExportError):
            raise
        raise GapRemovedAudioExportError("音频信息不完整，无法导出", details=str(error)) from error


def _pcm_format(stream):
    sample_fmt = str(stream.get("sample_fmt", "")).rstrip("p")
    if sample_fmt in {"flt", "dbl"}:
        bits = 64 if sample_fmt == "dbl" else 32
        return f"pcm_f{bits}le", f"f{bits}le", bits // 8, 3
    try:
        bits = int(stream.get("bits_per_raw_sample") or stream.get("bits_per_sample") or 0)
    except (TypeError, ValueError):
        bits = 0
    if not bits:
        bits = {"u8": 8, "s16": 16, "s32": 32, "s64": 64}.get(sample_fmt, 0)
    if not 0 < bits <= 32:
        raise GapRemovedAudioExportError("此音频的采样格式暂不支持精确导出")
    bits = 16 if bits <= 16 else 24 if bits <= 24 else 32
    return f"pcm_s{bits}le", f"s{bits}le", bits // 8, 1


_CHANNEL_MASKS = {
    "mono": 0x4, "stereo": 0x3, "2.1": 0xB, "3.0": 0x7, "3.0(back)": 0x103,
    "4.0": 0x107, "quad": 0x33, "quad(side)": 0x603, "3.1": 0xF,
    "5.0": 0x37, "5.0(side)": 0x607, "4.1": 0x10F,
    "5.1": 0x3F, "5.1(side)": 0x60F, "6.0": 0x707, "6.1": 0x70F,
    "7.0": 0x637, "7.1": 0x63F, "7.1(wide)": 0xFF,
}


def _wave_header(*, rate, channels, sample_width, format_tag, samples, channel_layout):
    """RIFF for ordinary files; RF64 for data beyond the 32-bit chunk limit."""
    frame_bytes = channels * sample_width
    data_bytes = samples * frame_bytes
    bits = sample_width * 8
    mask = _CHANNEL_MASKS.get(channel_layout, 0)
    # Extensible headers preserve known surround channel assignments. Unknown
    # layouts use an unspecified mask instead of relabelling channel positions.
    extensible = channels > 2
    tag = 0xFFFE if extensible else format_tag
    fmt = struct.pack("<HHIIHH", tag, channels, rate, rate * frame_bytes, frame_bytes, bits)
    if extensible:
        guid = struct.pack("<IHH8s", format_tag, 0, 0x10, b"\x80\x00\x00\xaa\x00\x38\x9b\x71")
        fmt += struct.pack("<HHI", 22, bits, mask) + guid
    elif format_tag == 3:
        fmt += struct.pack("<H", 0)
    chunks = b"fmt " + struct.pack("<I", len(fmt)) + fmt
    if format_tag == 3:
        chunks += b"fact" + struct.pack("<II", 4, min(samples, 0xFFFFFFFF))
    padding = data_bytes % 2
    riff_size = 4 + len(chunks) + 8 + data_bytes + padding
    if riff_size <= 0xFFFFFFFF:
        return b"RIFF" + struct.pack("<I", riff_size) + b"WAVE" + chunks + b"data" + struct.pack("<I", data_bytes)
    riff_size += 36
    ds64 = b"ds64" + struct.pack("<IQQQI", 28, riff_size, data_bytes, samples, 0)
    return b"RF64\xff\xff\xff\xffWAVE" + ds64 + chunks + b"data\xff\xff\xff\xff"


def rebuild_gap_removed_audio(source_path: Path, intervals: list[tuple[int, int]], output_path: Path,
    *, ffmpeg_path: Path, ffprobe_path: Path, job=None, audio_track: int = 0) -> Path:
    """Export half-open millisecond ranges, rounded to the nearest PCM sample.

    Ties round up. Bounds use decoded sample count rather than inaccurate
    compressed-stream duration metadata. Float and lossless PCM depth are kept.
    """
    source, output = Path(source_path), Path(output_path)
    if source.resolve() == output.resolve() or output.exists():
        raise GapRemovedAudioExportError("请使用新的 WAV 文件名，避免覆盖已有文件")
    if output.suffix.lower() != ".wav":
        raise GapRemovedAudioExportError("重组后音频需要保存为 WAV 文件")
    if not source.is_file():
        raise GapRemovedAudioExportError("源音频文件不存在")
    if isinstance(audio_track, bool) or not isinstance(audio_track, int) or audio_track < 0:
        raise GapRemovedAudioExportError("选择的音轨无效")
    if not intervals:
        raise GapRemovedAudioExportError("没有需要保留的音频片段")
    previous_end = 0
    for interval in intervals:
        if not isinstance(interval, (tuple, list)) or len(interval) != 2:
            raise GapRemovedAudioExportError("音频保留区间无效")
        start, end = interval
        if any(isinstance(value, bool) or not isinstance(value, int) for value in (start, end)):
            raise GapRemovedAudioExportError("音频保留区间需要使用整数毫秒")
        if start < previous_end or end <= start:
            raise GapRemovedAudioExportError("音频保留区间无效或相互重叠")
        previous_end = end

    def check():
        if job is not None:
            job.check_cancelled()

    def update(stage, progress=None):
        check()
        if job is not None:
            job.update(stage, progress)

    try:
        update("preparing")
        stream, rate, channels, duration_ms = _probe(source, ffprobe_path, job=job, audio_track=audio_track)
        codec, raw_format, width, tag = _pcm_format(stream)
        frame_bytes = channels * width
        sample_intervals = [((start * rate + 500) // 1000, (end * rate + 500) // 1000)
                            for start, end in intervals]
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="maw-audio-rebuild-", dir=output.parent) as temporary:
            raw_path, wave_path = Path(temporary) / "decoded.pcm", Path(temporary) / "output.wav"
            command = [str(ffmpeg_path), "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
            if job is not None and duration_ms is not None:
                command += ["-progress", "pipe:1", "-nostats"]
            command += ["-i", str(source), "-map", f"0:a:{audio_track}", "-vn", "-sn", "-dn",
                        "-c:a", codec, "-f", raw_format, str(raw_path)]
            result = _run_command(command, job=job, timeout=86_400, duration_ms=duration_ms)
            if result.returncode:
                raise GapRemovedAudioExportError("音频解码失败，请检查源文件是否完整", details=result.stderr)
            check()
            decoded_bytes = raw_path.stat().st_size
            if not decoded_bytes or decoded_bytes % frame_bytes:
                raise GapRemovedAudioExportError("源文件没有完整的音频样本")
            decoded_samples = decoded_bytes // frame_bytes
            # The editor rounds the natural media end to integer milliseconds.
            # Allow only that half-millisecond upward rounding, then retain the
            # actual final sample. Larger overflows still indicate stale ranges.
            tail_tolerance = (rate + 1999) // 2000
            if any(start >= decoded_samples or end > decoded_samples + tail_tolerance
                   for start, end in sample_intervals):
                raise GapRemovedAudioExportError("保留区间超出了音频实际时长，请重新加载工程后再试")
            sample_intervals = [(start, min(end, decoded_samples)) for start, end in sample_intervals]
            expected_samples = sum(end - start for start, end in sample_intervals)
            if not expected_samples:
                raise GapRemovedAudioExportError("保留区间过短，没有可导出的音频样本")
            header = _wave_header(rate=rate, channels=channels, sample_width=width, format_tag=tag,
                                  samples=expected_samples, channel_layout=stream.get("channel_layout"))
            copied = 0
            update("exporting", 0)
            with raw_path.open("rb") as pcm, wave_path.open("wb") as wav:
                wav.write(header)
                for start, end in sample_intervals:
                    check()
                    pcm.seek(start * frame_bytes)
                    remaining = (end - start) * frame_bytes
                    while remaining:
                        check()
                        block = pcm.read(min(remaining, _COPY_BYTES))
                        if not block:
                            raise GapRemovedAudioExportError("音频样本读取不完整，导出已停止")
                        wav.write(block)
                        copied += len(block)
                        remaining -= len(block)
                        update("exporting", copied / (expected_samples * frame_bytes))
                if copied % 2:
                    wav.write(b"\0")
            update("validating")
            if copied != expected_samples * frame_bytes or wave_path.stat().st_size != len(header) + copied + copied % 2:
                raise GapRemovedAudioExportError("导出音频的样本数不正确")
            output_stream, output_rate, output_channels, _ = _probe(wave_path, ffprobe_path, job=job)
            if output_rate != rate or output_channels != channels or output_stream.get("codec_name") != codec:
                raise GapRemovedAudioExportError("导出音频的采样格式校验失败")
            try:
                verified_samples = int(output_stream["duration_ts"]) * Fraction(output_stream["time_base"]) * rate
            except (KeyError, TypeError, ValueError, ZeroDivisionError) as error:
                raise GapRemovedAudioExportError("无法确认导出音频的准确时长") from error
            if verified_samples != expected_samples:
                raise GapRemovedAudioExportError("导出音频的样本数不正确")
            check()
            # Only publish a complete, validated file. Cancellation/failure leaves
            # no partial output, and the private PCM directory is always removed.
            os.replace(wave_path, output)
        return output
    except (OSError, subprocess.TimeoutExpired) as error:
        raise GapRemovedAudioExportError("音频导出失败，请检查磁盘空间或源文件", details=str(error)) from error
