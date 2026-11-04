"""On-demand whole-programme LUFS analysis; output processing is fixed gain only.

The quapeaks RMS layer serves waveform scaling and is not a BS.1770 meter.
Analysis runs against the media served to the preview, without modifying it.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import threading
import time
from pathlib import Path

from maw.gui_platform import (popen_process_tree, process_group_kwargs,
                              release_process_tree, terminate_process_tree)

MIN_GAIN_DB = -60.0
MAX_GAIN_DB = 24.0


def validate_gain_db(value: object = 0) -> float:
    if (isinstance(value, bool) or not isinstance(value, (int, float))
            or not MIN_GAIN_DB <= value <= MAX_GAIN_DB or not math.isfinite(value)):
        raise ValueError("音量增益必须是 -60 到 +24 dB 之间的有限数值")
    return float(value)


def volume_filter(value: object) -> str:
    return f"volume={validate_gain_db(value):.6f}dB"


def _signature(path: Path) -> tuple:
    stat = path.stat()
    return str(path.resolve()), stat.st_size, stat.st_mtime_ns, stat.st_ino


def parse_loudnorm_report(stderr: str) -> dict:
    """Read input measurements only; loudnorm's processed output is discarded."""
    start = stderr.rfind('{')
    try:
        report = json.JSONDecoder().raw_decode(stderr[start:])[0]
        integrated = float(report['input_i'])
        peak = float(report['input_tp'])
    except (ValueError, TypeError, KeyError) as error:
        raise ValueError("无法读取响度测量结果，请检查 FFmpeg 后重新测量") from error
    if integrated == -math.inf and peak == -math.inf:
        return {"status": "silence", "integratedLufs": None, "truePeakDbtp": None}
    # A sub-gate signal can have a finite peak but no measurable integrated LUFS.
    if integrated == -math.inf and math.isfinite(peak):
        return {"status": "silence", "integratedLufs": None, "truePeakDbtp": peak}
    if not math.isfinite(integrated) or not math.isfinite(peak):
        raise ValueError("响度测量结果无效，请重新测量")
    return {"status": "measured", "integratedLufs": integrated, "truePeakDbtp": peak}


class _AnalysisCancelled(Exception):
    pass


class LoudnessAnalyzer:
    """One cached media identity; repeat POSTs poll instead of decoding again."""

    def __init__(self):
        self.lock = threading.Lock()
        self.key = None
        self.result: dict = {}
        self.cancelled = threading.Event()
        self.thread: threading.Thread | None = None
        self.closed = False

    def invalidate(self):
        with self.lock:
            self.cancelled.set()
            self.key = None
            self.result = {}

    def close(self):
        with self.lock:
            self.closed = True
            self.cancelled.set()
            worker = self.thread
        if worker:
            worker.join(timeout=6)

    def request(self, path: Path, binding: tuple[int, str], ffmpeg: Path,
                ffprobe: Path, *, force: bool = False) -> dict:
        signature = _signature(path)
        key = (binding, signature, str(ffmpeg), str(ffprobe))
        with self.lock:
            if self.closed:
                raise ValueError("响度分析服务已关闭")
            if self.key == key and (not force or self.result.get('status') == 'measuring'):
                return dict(self.result)
            self.cancelled.set()
            cancelled = threading.Event()
            self.cancelled = cancelled
            self.key = key
            identity = {"ok": True, "bindingGeneration": binding[0], "sourceMediaId": binding[1],
                        "measurementSource": "preview", "audioTrack": None,
                        "sourceFingerprint": hashlib.sha256(repr(signature).encode()).hexdigest()}
            self.result = {**identity, "status": "measuring"}
            self.thread = threading.Thread(target=self._measure,
                args=(path, signature, key, identity, cancelled, ffmpeg, ffprobe),
                daemon=True, name='maw-loudness')
            self.thread.start()
            return dict(self.result)

    @staticmethod
    def _run(command: list[str], cancelled: threading.Event) -> subprocess.CompletedProcess:
        if cancelled.is_set():
            raise _AnalysisCancelled()
        process = popen_process_tree(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, encoding='utf-8', errors='replace', **process_group_kwargs())
        deadline = time.monotonic() + 3600
        try:
            while True:
                if cancelled.is_set():
                    raise _AnalysisCancelled()
                if time.monotonic() > deadline:
                    raise ValueError("响度测量超时，请重新测量或使用较短的媒体")
                try:
                    stdout, stderr = process.communicate(timeout=0.25)
                    break
                except subprocess.TimeoutExpired:
                    continue
            if process.returncode:
                raise ValueError("响度测量失败，请检查媒体与 FFmpeg 后重试")
            return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
        finally:
            if process.poll() is None:
                terminate_process_tree(process)
                process.communicate()
            release_process_tree(process)

    def _measure(self, path, signature, key, identity, cancelled, ffmpeg, ffprobe):
        try:
            probe = self._run([str(ffprobe), '-v', 'error', '-select_streams', 'a',
                '-show_entries', 'stream=index:stream_disposition=default', '-of', 'json', str(path)], cancelled)
            streams = json.loads(probe.stdout)['streams']
            if not isinstance(streams, list):
                raise ValueError("无法读取媒体音轨")
            if not streams:
                result = {"status": "no_audio", "integratedLufs": None, "truePeakDbtp": None}
            else:
                track = next((i for i, stream in enumerate(streams)
                    if stream.get('disposition', {}).get('default') == 1), 0)
                identity = {**identity, "audioTrack": track}
                measured = self._run([str(ffmpeg), '-nostdin', '-hide_banner', '-nostats',
                    '-loglevel', 'info', '-i', str(path), '-map', f'0:a:{track}', '-vn', '-sn', '-dn',
                    '-af', 'loudnorm=I=-23:TP=-1:LRA=7:print_format=json', '-f', 'null', '-'], cancelled)
                result = parse_loudnorm_report(measured.stderr)
            if _signature(path) != signature:
                raise ValueError("媒体文件已变更，请重新测量")
        except _AnalysisCancelled:
            return
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            # Do not expose FFmpeg diagnostics or local file paths over the API.
            result = {"status": "error", "error": "响度测量失败，请检查媒体与 FFmpeg 后重新测量",
                      "integratedLufs": None, "truePeakDbtp": None}
        with self.lock:
            if self.key == key and not cancelled.is_set():
                self.result = {**identity, **result}
