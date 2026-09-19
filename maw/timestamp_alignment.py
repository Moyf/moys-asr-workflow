"""Provider-neutral word/character timestamp generation.

This module is deliberately usable from three places:

* local ASR (for example MOSS -> Qwen/FireRed alignment),
* the Launcher post-processing toolbox (SRT or MOSP input), and
* future online-ASR adapters whose response contains text but no item timing.

The aligner receives a bounded audio span and the text that should be spoken in
that span.  It never invents a subtitle segment when the input has no usable
range; it only fills or replaces the nested ``items`` of an existing cue.
"""

from __future__ import annotations

import contextlib
import difflib
import math
import os
import re
import subprocess
import tempfile
import unicodedata
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from maw.alignment_models import (
    FIRERED_ASR2_CTC_MODEL_ID,
    QWEN_FORCED_ALIGNER_MODEL_ID,
    alignment_model_by_id,
    model_cache_environment,
    normalize_alignment_model_id,
    resolve_alignment_model_path,
)
from maw.ffmpeg import resolve_ffmpeg_tool
from maw.language import (
    normalize_language_code,
    split_mode_for_text,
    timestamp_granularity_for_items,
    timestamp_items_cover_text,
)
from maw.postprocess_io import SubtitleArtifact, read_project, read_srt, write_artifacts
from maw.project_preview import JsonDict


MAX_ALIGNMENT_CHUNK_MS = 75_000
ALIGNMENT_MODE_FILL = "fill"
ALIGNMENT_MODE_GENERATE = "generate"


class TimestampAlignmentError(RuntimeError):
    """Raised when an aligner cannot produce trustworthy item timings."""


class TimestampAlignmentCancelled(TimestampAlignmentError):
    """Raised when a long alignment operation is cancelled."""


@dataclass(frozen=True, slots=True)
class TimedToken:
    text: str
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class FireRedDecodeResult:
    text: str
    tokens: tuple[str, ...]
    timestamps: tuple[object, ...]
    duration_ms: int


@dataclass(frozen=True, slots=True)
class TimestampAlignmentReport:
    model_id: str
    mode: str
    aligned_segments: int = 0
    skipped_segments: int = 0
    failed_segments: int = 0
    aligned_items: int = 0
    warnings: tuple[str, ...] = ()

    def to_payload(self) -> dict[str, object]:
        return {
            "modelId": self.model_id,
            "mode": self.mode,
            "alignedSegments": self.aligned_segments,
            "skippedSegments": self.skipped_segments,
            "failedSegments": self.failed_segments,
            "alignedItems": self.aligned_items,
            "warnings": list(self.warnings),
        }


@dataclass(frozen=True, slots=True)
class TimestampAlignmentRequest:
    project_path: Path | None
    srt_path: Path | None
    media_path: Path | None
    model_id: str
    output_mode: str = "both"
    mode: str = ALIGNMENT_MODE_FILL
    model_path: Path | None = None
    model_cache_root: Path | None = None
    device: str = "auto"
    output_directory: Path | None = None


class AlignmentBackend(Protocol):
    def align(self, audio_path: Path, text: str, *, language: str | None = None) -> list[TimedToken]: ...


class QwenForcedAlignerBackend:
    """Lazy adapter for Qwen/Qwen3-ForcedAligner-0.6B."""

    def __init__(
        self,
        *,
        model_path: str | Path = "",
        model_cache_root: str | Path | None = None,
        device: str = "auto",
    ) -> None:
        self.model_path = str(model_path or "")
        self.model_cache_root = model_cache_root
        self.device = device
        self._runtime: Any = None

    def _load(self) -> Any:
        if self._runtime is not None:
            return self._runtime
        try:
            import torch  # type: ignore[import-not-found]
            from qwen_asr import Qwen3ForcedAligner  # type: ignore[import-not-found]
        except ImportError as error:
            package = getattr(error, "name", "qwen-asr") or "qwen-asr"
            raise TimestampAlignmentError(
                f"Qwen 对齐模型需要 {package}；请先安装本地模型支持。"
            ) from error
        try:
            from maw.local_asr import resolve_device

            resolved = resolve_device(self.device, allow_mps=True)
        except (ImportError, ValueError) as error:
            raise TimestampAlignmentError(f"无法解析 Qwen 对齐设备：{error}") from error
        device_map = "cuda:0" if resolved == "cuda" else resolved
        dtype = torch.bfloat16 if resolved == "cuda" else torch.float32
        model = resolve_alignment_model_path(
            QWEN_FORCED_ALIGNER_MODEL_ID,
            self.model_path,
            model_cache_root=self.model_cache_root,
        )
        kwargs = {"dtype": dtype, "device_map": device_map}
        with _model_cache_environment(self.model_cache_root):
            try:
                self._runtime = Qwen3ForcedAligner.from_pretrained(str(model), **kwargs)
            except (OSError, RuntimeError, TypeError, ValueError) as error:
                raise TimestampAlignmentError(f"Qwen Forced Aligner 加载失败：{error}") from error
        return self._runtime

    def align(self, audio_path: Path, text: str, *, language: str | None = None) -> list[TimedToken]:
        if not text.strip():
            return []
        runtime = self._load()
        language_name = _qwen_language_name(language, text)
        with _model_cache_environment(self.model_cache_root):
            try:
                raw = runtime.align(audio=str(audio_path), text=text, language=language_name)
            except (OSError, RuntimeError, TypeError, ValueError) as error:
                raise TimestampAlignmentError(f"Qwen Forced Aligner 推理失败：{error}") from error
        tokens = _timed_tokens_from_raw(raw)
        if not tokens:
            raise TimestampAlignmentError("Qwen Forced Aligner 未返回可用的时间码。")
        return tokens


class FireRedCtcBackend:
    """Lazy sherpa-onnx FireRedASR2-CTC adapter."""

    def __init__(
        self,
        *,
        model_path: str | Path = "",
        model_cache_root: str | Path | None = None,
        num_threads: int | None = None,
    ) -> None:
        self.model_path = str(model_path or "")
        self.model_cache_root = model_cache_root
        self.num_threads = max(1, int(num_threads or min(os.cpu_count() or 1, 8)))
        self._recognizer: Any = None

    def _load(self) -> Any:
        if self._recognizer is not None:
            return self._recognizer
        try:
            import sherpa_onnx  # type: ignore[import-not-found]
        except ImportError as error:
            raise TimestampAlignmentError("FireRed 对齐模型需要 sherpa-onnx；请先安装本地模型支持。") from error
        model_dir = resolve_alignment_model_path(
            FIRERED_ASR2_CTC_MODEL_ID,
            self.model_path,
            model_cache_root=self.model_cache_root,
        )
        if not isinstance(model_dir, Path):
            raise TimestampAlignmentError(f"FireRed 对齐模型路径无效：{model_dir}")
        model_file = model_dir / "model.int8.onnx"
        tokens_file = model_dir / "tokens.txt"
        try:
            self._recognizer = sherpa_onnx.OfflineRecognizer.from_fire_red_asr_ctc(
                model=str(model_file),
                tokens=str(tokens_file),
                num_threads=self.num_threads,
                decoding_method="greedy_search",
                debug=False,
                provider="cpu",
            )
        except (OSError, RuntimeError, TypeError, ValueError) as error:
            raise TimestampAlignmentError(f"FireRedASR2-CTC 加载失败：{error}") from error
        return self._recognizer

    def decode(self, audio_path: Path) -> FireRedDecodeResult:
        try:
            import soundfile as sf  # type: ignore[import-not-found]
        except ImportError as error:
            raise TimestampAlignmentError("FireRed 对齐模型需要 soundfile；请先安装本地模型支持。") from error
        try:
            audio, sample_rate = sf.read(str(audio_path), dtype="float32", always_2d=True)
        except (OSError, RuntimeError, ValueError) as error:
            raise TimestampAlignmentError(f"无法读取 FireRed 音频：{error}") from error
        if not sample_rate or getattr(audio, "ndim", 1) != 2:
            raise TimestampAlignmentError("FireRed 音频必须是可读取的单声道或多声道 PCM。")
        mono = audio[:, 0]
        duration_ms = max(int(round(len(mono) / float(sample_rate) * 1000)), 1)
        if _is_silent_waveform(mono):
            return FireRedDecodeResult("", (), (), duration_ms)
        recognizer = self._load()
        try:
            stream = recognizer.create_stream()
            stream.accept_waveform(int(sample_rate), mono)
            recognizer.decode_stream(stream)
            result = stream.result
        except (OSError, RuntimeError, TypeError, ValueError) as error:
            # sherpa-onnx may reject an all-silent chunk before it produces an
            # empty result.  Silent chunks are valid in a long-audio split and
            # should be skipped by the caller rather than aborting the job.
            if _is_silent_waveform(mono):
                return FireRedDecodeResult("", (), (), duration_ms)
            raise TimestampAlignmentError(f"FireRedASR2-CTC 推理失败：{error}") from error
        text = str(_read_field(result, "text", "") or "")
        raw_tokens = _read_field(result, "tokens", ()) or ()
        raw_timestamps = _read_field(result, "timestamps", ()) or ()
        tokens = tuple(str(token) for token in raw_tokens) if _is_sequence(raw_tokens) else ()
        timestamps = tuple(raw_timestamps) if _is_sequence(raw_timestamps) else ()
        if not text.strip() or not tokens or not timestamps:
            raise TimestampAlignmentError("FireRedASR2-CTC 未返回可用的 token 时间码。")
        return FireRedDecodeResult(text, tokens, timestamps, duration_ms)

    def align(self, audio_path: Path, text: str, *, language: str | None = None) -> list[TimedToken]:
        del language
        decoded = self.decode(audio_path)
        return firered_tokens_to_items(
            text,
            decoded.tokens,
            decoded.timestamps,
            decoded.duration_ms,
            decoded_text=decoded.text,
        )


def create_alignment_backend(
    model_id: str,
    *,
    model_path: str | Path = "",
    model_cache_root: str | Path | None = None,
    device: str = "auto",
) -> AlignmentBackend:
    normalized = normalize_alignment_model_id(model_id)
    if normalized == QWEN_FORCED_ALIGNER_MODEL_ID:
        return QwenForcedAlignerBackend(
            model_path=model_path,
            model_cache_root=model_cache_root,
            device=device,
        )
    if normalized == FIRERED_ASR2_CTC_MODEL_ID:
        return FireRedCtcBackend(
            model_path=model_path,
            model_cache_root=model_cache_root,
        )
    alignment_model_by_id(normalized)
    raise TimestampAlignmentError(f"不支持的对齐模型：{model_id}")


def firered_tokens_to_items(
    target_text: str,
    tokens: Sequence[object],
    timestamps: Sequence[object],
    duration_ms: int,
    *,
    decoded_text: str = "",
) -> list[TimedToken]:
    """Map FireRed CTC token spans onto the supplied transcript.

    FireRed's CTC output is an ASR hypothesis, so it can differ from a known
    script by punctuation, spacing, or a small number of recognition errors.
    Matching normalized alphanumeric/CJK characters with ``SequenceMatcher``
    keeps the actual target text while retaining the acoustic token timing.
    """
    source_chars = _source_char_timeline(tokens, timestamps, duration_ms)
    if not source_chars:
        raise TimestampAlignmentError("FireRed token 时间码为空或不可用。")
    units = _target_units(target_text)
    if not units:
        return []
    units = _compress_units(units, max(1, int(duration_ms)))
    source_keys: list[str] = []
    source_positions: list[int] = []
    for index, (_start, char, _end) in enumerate(source_chars):
        key = _match_key(char)
        if key:
            source_keys.append(key)
            source_positions.append(index)
    target_keys: list[str] = []
    target_positions: list[int] = []
    for index, unit in enumerate(units):
        for char in unit:
            key = _match_key(char)
            if key:
                target_keys.append(key)
                target_positions.append(index)
    del decoded_text  # retained in the signature for debugging integrations
    anchors: dict[int, tuple[int, int]] = {}
    matcher = difflib.SequenceMatcher(None, source_keys, target_keys, autojunk=False)
    for source_start, target_start, size in matcher.get_matching_blocks():
        for offset in range(size):
            target_index = target_positions[target_start + offset]
            source_index = source_positions[source_start + offset]
            char_start, _, char_end = source_chars[source_index]
            current = anchors.get(target_index)
            anchors[target_index] = (
                min(current[0], char_start) if current else char_start,
                max(current[1], char_end) if current else char_end,
            )
    overall_start = min(start for start, _char, _end in source_chars)
    overall_end = max(end for _start, _char, end in source_chars)
    ranges = _interpolate_ranges(len(units), anchors, overall_start, max(overall_end, overall_start + 1))
    return [TimedToken(unit, start, end) for unit, (start, end) in zip(units, ranges)]


def align_project(
    project: JsonDict,
    *,
    media_path: Path,
    model_id: str,
    mode: str = ALIGNMENT_MODE_FILL,
    model_path: str | Path = "",
    model_cache_root: str | Path | None = None,
    device: str = "auto",
    ffmpeg_path: str | Path | None = None,
    on_event: Callable[[str], None] | None = None,
    cancel_event: Any = None,
) -> TimestampAlignmentReport:
    """Fill or regenerate item timestamps in every subtitle track."""
    normalized_mode = _normalize_mode(mode)
    normalized_model = normalize_alignment_model_id(model_id)
    if not media_path.is_file():
        raise TimestampAlignmentError(f"媒体文件不存在：{media_path}")
    backend = create_alignment_backend(
        normalized_model,
        model_path=model_path,
        model_cache_root=model_cache_root,
        device=device,
    )
    emit = on_event or (lambda _message: None)
    aligned_segments = 0
    skipped_segments = 0
    failed_segments = 0
    aligned_items = 0
    warnings: list[str] = []
    with tempfile.TemporaryDirectory(prefix="maw-align-") as temp_dir:
        span_index = 0
        for collection, language in _project_segment_collections(project):
            for segment in collection:
                if not isinstance(segment, dict):
                    continue
                text = str(segment.get("text") or "")
                if not text.strip():
                    continue
                if normalized_mode == ALIGNMENT_MODE_FILL and _segment_has_complete_items(segment):
                    skipped_segments += 1
                    continue
                start = segment.get("start")
                end = segment.get("end")
                if type(start) is not int or type(end) is not int or end <= start:
                    failed_segments += 1
                    warnings.append(f"跳过无有效时间范围的字幕：{text[:32]}")
                    continue
                _check_cancel(cancel_event)
                span_index += 1
                emit(f"[aligner] 正在对齐第 {span_index} 段：{text[:40]}")
                try:
                    items = _align_span(
                        backend,
                        media_path,
                        text,
                        start,
                        end,
                        language=language,
                        ffmpeg_path=ffmpeg_path,
                        temp_dir=Path(temp_dir),
                        cancel_event=cancel_event,
                    )
                except TimestampAlignmentCancelled:
                    raise
                except (OSError, RuntimeError, ValueError, TimestampAlignmentError) as error:
                    failed_segments += 1
                    warnings.append(f"字幕对齐失败（{text[:32]}）：{error}")
                    continue
                item_payloads = [
                    {"text": item.text, "start": item.start, "end": item.end}
                    for item in items
                ]
                if not item_payloads or not timestamp_items_cover_text(text, item_payloads):
                    failed_segments += 1
                    warnings.append(f"字幕对齐结果未覆盖完整文本：{text[:32]}")
                    continue
                speaker = segment.get("speaker")
                segment["items"] = [
                    {
                        **item,
                        **({"speaker": str(speaker)} if isinstance(speaker, str) and speaker.strip() else {}),
                    }
                    for item in item_payloads
                ]
                aligned_segments += 1
                aligned_items += len(items)
        granularity = _project_granularity(project)
        if granularity:
            project["timestamp_granularity"] = granularity
    if failed_segments:
        emit(f"[aligner] 完成：成功 {aligned_segments} 段，跳过 {skipped_segments} 段，失败 {failed_segments} 段。")
    else:
        emit(f"[aligner] 完成：成功 {aligned_segments} 段，跳过 {skipped_segments} 段。")
    return TimestampAlignmentReport(
        normalized_model,
        normalized_mode,
        aligned_segments,
        skipped_segments,
        failed_segments,
        aligned_items,
        tuple(warnings),
    )


def align_local_transcription(
    transcription: Any,
    *,
    audio_path: Path,
    model_id: str,
    mode: str = ALIGNMENT_MODE_FILL,
    model_path: str | Path = "",
    model_cache_root: str | Path | None = None,
    device: str = "auto",
    ffmpeg_path: str | Path | None = None,
    on_event: Callable[[str], None] | None = None,
    cancel_event: Any = None,
) -> Any:
    """Add aligned items to a provider-neutral ``LocalTranscription``."""
    from maw.local_asr import LocalTranscription

    segments = [dict(segment) for segment in getattr(transcription, "segments", [])]
    items = [dict(item) for item in getattr(transcription, "items", [])]
    text = str(getattr(transcription, "text", "") or "")
    if not segments and text:
        if items:
            start = min(int(item.get("start", 0)) for item in items)
            end = max(int(item.get("end", 1)) for item in items)
        else:
            start, end = 0, _audio_duration_ms(audio_path)
        segments = [{"start": start, "end": max(end, start + 1), "text": text}]
        if items:
            segments[0]["items"] = items
    project: JsonDict = {
        "segments": segments,
        "language": str(getattr(transcription, "language", "") or ""),
        "split_mode": str(getattr(transcription, "split_mode", "") or ""),
    }
    report = align_project(
        project,
        media_path=audio_path,
        model_id=model_id,
        mode=mode,
        model_path=model_path,
        model_cache_root=model_cache_root,
        device=device,
        ffmpeg_path=ffmpeg_path,
        on_event=on_event,
        cancel_event=cancel_event,
    )
    aligned_segments = [dict(segment) for segment in project.get("segments", []) if isinstance(segment, dict)]
    all_items = [
        dict(item)
        for segment in aligned_segments
        for item in (segment.get("items") or [])
        if isinstance(item, dict)
    ]
    if not all_items and items:
        all_items = items
    split_mode = str(getattr(transcription, "split_mode", "") or "") or split_mode_for_text(text, getattr(transcription, "language", ""))
    granularity = timestamp_granularity_for_items(
        all_items,
        split_mode,
        explicit_items=bool(all_items) and report.failed_segments == 0,
        has_segments=bool(aligned_segments),
    )
    return LocalTranscription(
        text,
        str(getattr(transcription, "language", "") or ""),
        all_items,
        aligned_segments,
        str(getattr(transcription, "model", "") or ""),
        str(getattr(transcription, "language_source", "unknown") or "unknown"),
        split_mode,
        granularity,
    )


def run_timestamp_alignment(request: TimestampAlignmentRequest) -> tuple[SubtitleArtifact, TimestampAlignmentReport]:
    project, source_project, source_srt = _load_input(request.project_path, request.srt_path)
    media = request.media_path
    if media is None:
        raw_media = project.get("media")
        if isinstance(raw_media, str) and raw_media.strip():
            media = Path(raw_media).expanduser()
            if not media.is_absolute() and source_project is not None:
                media = source_project.parent / media
    if media is None:
        raise TimestampAlignmentError("生成字词时间码需要选择原始媒体文件。")
    media = media.expanduser().resolve(strict=False)
    report = align_project(
        project,
        media_path=media,
        model_id=request.model_id,
        mode=request.mode,
        model_path=request.model_path or "",
        model_cache_root=request.model_cache_root,
        device=request.device,
    )
    warnings = report.warnings
    if report.failed_segments:
        warnings = (*warnings, f"共有 {report.failed_segments} 段未能生成字词时间码，原字幕时间范围已保留。")
    artifact = write_artifacts(
        project,
        source_project_path=source_project,
        source_srt_path=source_srt,
        operation="timestamps",
        write_project=request.output_mode in {"json", "both"},
        write_srt=request.output_mode in {"srt", "both"},
        warnings=warnings,
        output_directory=request.output_directory,
        media_path=media,
    )
    return artifact, report


def _align_span(
    backend: AlignmentBackend,
    media_path: Path,
    text: str,
    start_ms: int,
    end_ms: int,
    *,
    language: str | None,
    ffmpeg_path: str | Path | None,
    temp_dir: Path,
    cancel_event: Any,
) -> list[TimedToken]:
    duration = end_ms - start_ms
    chunks = _split_text_for_duration(text, duration)
    all_items: list[TimedToken] = []
    cursor_ms = start_ms
    for index, (chunk_text, chunk_duration) in enumerate(chunks):
        _check_cancel(cancel_event)
        chunk_path = temp_dir / f"span-{start_ms}-{index}.wav"
        _extract_audio_span(media_path, chunk_path, cursor_ms, chunk_duration, ffmpeg_path=ffmpeg_path)
        raw_items = backend.align(chunk_path, chunk_text, language=language)
        all_items.extend(
            TimedToken(item.text, item.start + cursor_ms, item.end + cursor_ms)
            for item in raw_items
        )
        cursor_ms += chunk_duration
    return _normalize_timed_items(all_items, start_ms, end_ms)


def _extract_audio_span(
    media_path: Path,
    output_path: Path,
    start_ms: int,
    duration_ms: int,
    *,
    ffmpeg_path: str | Path | None,
) -> None:
    ffmpeg = resolve_ffmpeg_tool("ffmpeg", ffmpeg_path, allow_missing_explicit=bool(ffmpeg_path))
    if ffmpeg is None:
        raise TimestampAlignmentError("找不到 ffmpeg，无法为对齐模型切分音频。")
    output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        str(ffmpeg),
        "-v", "error",
        "-ss", f"{max(start_ms, 0) / 1000:.3f}",
        "-i", str(media_path),
        "-t", f"{max(duration_ms, 1) / 1000:.3f}",
        "-vn",
        "-acodec", "pcm_s16le",
        "-ar", "16000",
        "-ac", "1",
        "-y", str(output_path),
    ]
    try:
        subprocess.run(command, check=True, capture_output=True)
    except subprocess.CalledProcessError as error:
        detail = error.stderr.decode("utf-8", errors="replace") if isinstance(error.stderr, bytes) else str(error.stderr or "")
        raise TimestampAlignmentError(f"FFmpeg 切分对齐音频失败：{detail[-400:]}") from error


def _source_char_timeline(
    tokens: Sequence[object],
    timestamps: Sequence[object],
    duration_ms: int,
) -> list[tuple[int, str, int]]:
    entries: list[tuple[str, int, int | None]] = []
    for index, token in enumerate(tokens):
        text = _clean_token(token)
        if not text:
            continue
        if index >= len(timestamps):
            break
        start, explicit_end = _timestamp_value(timestamps[index])
        if start is None:
            continue
        next_start = None
        for next_value in timestamps[index + 1 :]:
            next_start, _ = _timestamp_value(next_value)
            if next_start is not None:
                break
        end = explicit_end if explicit_end is not None else next_start
        entries.append((text, start, end))
    if not entries:
        return []
    result: list[tuple[int, str, int]] = []
    for index, (text, start, end) in enumerate(entries):
        resolved_end = end
        if resolved_end is None:
            resolved_end = duration_ms if index == len(entries) - 1 else start + 1
        resolved_end = max(resolved_end, start + 1)
        chars = list(text)
        if not chars:
            continue
        span = max(resolved_end - start, len(chars))
        for char_index, char in enumerate(chars):
            char_start = start + round(span * char_index / len(chars))
            char_end = start + round(span * (char_index + 1) / len(chars))
            result.append((char_start, char, max(char_end, char_start + 1)))
    return result


def _timed_tokens_from_raw(raw: object) -> list[TimedToken]:
    entries = _timed_entries(raw)
    result: list[TimedToken] = []
    for entry in entries:
        text = str(_read_field(entry, "text", _read_field(entry, "token", _read_field(entry, "word", ""))) or "")
        if not text.strip():
            continue
        start = _read_field(entry, "start_time", _read_field(entry, "start", None))
        end = _read_field(entry, "end_time", _read_field(entry, "end", None))
        start_ms = _seconds_to_ms(start)
        end_ms = _seconds_to_ms(end)
        if start_ms is None or end_ms is None:
            continue
        if end_ms < start_ms:
            continue
        result.append(TimedToken(text, start_ms, end_ms))
    return result


def _timed_entries(value: object) -> list[object]:
    if isinstance(value, Mapping):
        if any(key in value for key in ("start_time", "end_time", "start", "end")):
            return [value]
        for key in ("items", "timestamps", "time_stamps", "words", "tokens", "result", "results"):
            nested = value.get(key)
            if nested is not None:
                found = _timed_entries(nested)
                if found:
                    return found
        return []
    if _is_sequence(value):
        result: list[object] = []
        for item in value:
            result.extend(_timed_entries(item))
        return result
    # Qwen3-ForcedAligner returns dataclass-like output objects rather than
    # dictionaries.  Keep the adapter object intact; _read_field handles both
    # attribute and mapping access.
    if value is not None and any(
        hasattr(value, name) for name in ("start_time", "end_time", "start", "end")
    ):
        return [value]
    return []


def _split_text_for_duration(text: str, duration_ms: int) -> list[tuple[str, int]]:
    units = _target_units(text)
    if not units:
        return []
    chunk_count = max(1, math.ceil(duration_ms / MAX_ALIGNMENT_CHUNK_MS))
    # Keep every text unit when a very long cue contains fewer units than the
    # requested number of audio chunks.  A single unusually long word/character
    # cannot be split semantically; returning fewer (possibly longer) chunks is
    # safer than dropping the leading audio span while building empty chunks.
    chunk_count = min(chunk_count, len(units))
    if chunk_count == 1:
        return [(text, duration_ms)]
    chunks: list[tuple[str, int]] = []
    unit_count = len(units)
    for index in range(chunk_count):
        first = round(unit_count * index / chunk_count)
        last = round(unit_count * (index + 1) / chunk_count)
        if last <= first:
            continue
        chunk_text = "".join(units[first:last])
        first_ms = round(duration_ms * index / chunk_count)
        last_ms = round(duration_ms * (index + 1) / chunk_count)
        chunks.append((chunk_text, max(last_ms - first_ms, 1)))
    if not chunks:
        return [(text, duration_ms)]
    # Rounding above can leave a one-ms discrepancy; assign it to the final
    # chunk so the outer segment boundary remains exact.
    used = sum(duration for _text, duration in chunks)
    if used != duration_ms:
        text_value, last_duration = chunks[-1]
        chunks[-1] = (text_value, max(last_duration + duration_ms - used, 1))
    return chunks


def _target_units(text: str) -> list[str]:
    mode = split_mode_for_text(text)
    if mode == "word":
        return [match.group(0) for match in re.finditer(r"\s*\S+", text)]
    units: list[str] = []
    pending = ""
    for char in text:
        if char.isspace():
            pending += char
            continue
        units.append(pending + char)
        pending = ""
    if pending:
        if units:
            units[-1] += pending
        else:
            units.append(pending)
    return units


def _compress_units(units: list[str], max_count: int) -> list[str]:
    if len(units) <= max_count:
        return units
    group_size = math.ceil(len(units) / max_count)
    return ["".join(units[index : index + group_size]) for index in range(0, len(units), group_size)]


def _interpolate_ranges(
    count: int,
    anchors: Mapping[int, tuple[int, int]],
    outer_start: int,
    outer_end: int,
) -> list[tuple[int, int]]:
    if count <= 0:
        return []
    ranges: list[tuple[int, int]] = []
    anchor_indices = sorted(index for index in anchors if 0 <= index < count)
    for index in range(count):
        direct = anchors.get(index)
        if direct is not None:
            ranges.append(direct)
            continue
        previous = max((anchor for anchor in anchor_indices if anchor < index), default=None)
        following = min((anchor for anchor in anchor_indices if anchor > index), default=None)
        left_index = previous if previous is not None else -1
        right_index = following if following is not None else count
        left_edge = anchors[previous][1] if previous is not None else outer_start
        right_edge = anchors[following][0] if following is not None else outer_end
        denominator = max(right_index - left_index, 1)
        start = left_edge + round((right_edge - left_edge) * (index - left_index) / denominator)
        end = left_edge + round((right_edge - left_edge) * (index + 1 - left_index) / denominator)
        ranges.append((start, end))
    return _normalize_timed_ranges(ranges, outer_start, outer_end)


def _normalize_timed_items(items: Sequence[TimedToken], start: int, end: int) -> list[TimedToken]:
    return [
        TimedToken(item.text, item_start, item_end)
        for item, (item_start, item_end) in zip(items, _normalize_timed_ranges([(item.start, item.end) for item in items], start, end))
    ]


def _normalize_timed_ranges(ranges: Sequence[tuple[int, int]], start: int, end: int) -> list[tuple[int, int]]:
    if not ranges:
        return []
    outer_start = max(0, int(start))
    outer_end = max(outer_start + 1, int(end))
    count = len(ranges)
    result: list[tuple[int, int]] = []
    cursor = outer_start
    for index, (raw_start, raw_end) in enumerate(ranges):
        minimum_remaining = count - index - 1
        item_start = max(cursor, min(outer_end - minimum_remaining - 1, int(raw_start)))
        item_start = min(item_start, outer_end - 1)
        item_end = max(item_start + 1, int(raw_end))
        item_end = min(item_end, outer_end - minimum_remaining)
        if item_end <= item_start:
            item_start = max(outer_start, outer_end - (count - index))
            item_end = item_start + 1
        result.append((item_start, item_end))
        cursor = item_end
    return result


def _segment_has_complete_items(segment: Mapping[str, object]) -> bool:
    text = str(segment.get("text") or "")
    items = segment.get("items")
    if not isinstance(items, list) or not text.strip():
        return False
    valid = [item for item in items if isinstance(item, Mapping)]
    if not valid or len(valid) != len(items):
        return False
    return all(
        type(item.get("start")) is int
        and type(item.get("end")) is int
        and int(item["end"]) > int(item["start"])
        for item in valid
    ) and timestamp_items_cover_text(text, valid)


def _project_segment_collections(project: Mapping[str, object]) -> Iterable[tuple[list[object], str | None]]:
    main = project.get("segments")
    language = str(project.get("language") or "")
    if isinstance(main, list):
        yield main, language
    overlay = project.get("overlay_track")
    if isinstance(overlay, Mapping) and isinstance(overlay.get("segments"), list):
        yield overlay["segments"], language
    multi = project.get("multi_subtitle")
    if isinstance(multi, Mapping) and isinstance(multi.get("tracks"), list):
        for track in multi["tracks"]:
            if isinstance(track, Mapping) and isinstance(track.get("segments"), list):
                yield track["segments"], str(track.get("language") or language)


def _project_granularity(project: Mapping[str, object]) -> str:
    main = project.get("segments")
    if not isinstance(main, list):
        return ""
    text_segments = [
        segment
        for segment in main
        if isinstance(segment, Mapping) and str(segment.get("text") or "").strip()
    ]
    if not text_segments:
        return "segment"
    # A partially aligned project must remain conservative: the top-level
    # marker describes what downstream consumers can trust for every cue, not
    # just the subset that happened to align successfully.
    if any(not _segment_has_complete_items(segment) for segment in text_segments):
        return "segment"
    items = [
        item
        for segment in text_segments
        for item in (segment.get("items") or [])
        if isinstance(item, Mapping)
    ]
    if not items:
        return "segment"
    text = "".join(str(segment.get("text") or "") for segment in main if isinstance(segment, Mapping))
    return "char" if split_mode_for_text(text) == "continuous" else "word"


def _is_silent_waveform(samples: Any, *, peak_threshold: float = 1e-5) -> bool:
    """Return whether a decoded PCM channel contains only near-zero samples."""
    try:
        if int(getattr(samples, "size")) == 0:
            return True
    except (AttributeError, TypeError, ValueError):
        try:
            if len(samples) == 0:
                return True
        except (TypeError, ValueError):
            return False
    try:
        peak = max(abs(float(samples.max())), abs(float(samples.min())))
    except (AttributeError, TypeError, ValueError):
        try:
            peak = max(abs(float(sample)) for sample in samples)
        except (TypeError, ValueError):
            return False
    return math.isfinite(peak) and peak <= peak_threshold


def _load_input(project_path: Path | None, srt_path: Path | None) -> tuple[JsonDict, Path | None, Path | None]:
    if project_path is not None:
        resolved = project_path.expanduser().resolve()
        return read_project(resolved), resolved, srt_path.expanduser().resolve() if srt_path else None
    if srt_path is not None:
        resolved = srt_path.expanduser().resolve()
        return read_srt(resolved), None, resolved
    raise TimestampAlignmentError("需要提供 .mosp/.json 工程或 .srt 字幕。")


def _normalize_mode(mode: str) -> str:
    value = str(mode or ALIGNMENT_MODE_FILL).strip().casefold()
    if value not in {ALIGNMENT_MODE_FILL, ALIGNMENT_MODE_GENERATE}:
        raise ValueError("时间码模式必须是 fill 或 generate")
    return value


def _check_cancel(cancel_event: Any) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise TimestampAlignmentCancelled("字词时间码生成已取消。")


def _audio_duration_ms(path: Path) -> int:
    try:
        import soundfile as sf  # type: ignore[import-not-found]

        info = sf.info(str(path))
        return max(int(round(info.frames / float(info.samplerate) * 1000)), 1)
    except (ImportError, OSError, RuntimeError, ValueError, ZeroDivisionError):
        return 1


def _clean_token(value: object) -> str:
    text = str(value or "")
    if text in {"<blank>", "[blank]", "<eps>", "<unk>"}:
        return ""
    return text.replace("▁", " ").replace("\u2581", " ")


def _timestamp_value(value: object) -> tuple[int | None, int | None]:
    if _is_sequence(value) and not isinstance(value, (str, bytes)):
        if len(value) >= 2:
            return _seconds_to_ms(value[0]), _seconds_to_ms(value[1])
        if len(value) == 1:
            return _seconds_to_ms(value[0]), None
    return _seconds_to_ms(value), None


def _seconds_to_ms(value: object) -> int | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    if not math.isfinite(number) or number < 0:
        return None
    return int(round(number * 1000))


def _match_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(char for char in normalized if char.isalnum() or _is_cjk(char))


def _is_cjk(char: str) -> bool:
    return any(
        start <= ord(char) <= end
        for start, end in ((0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF))
    )


def _qwen_language_name(language: str | None, text: str) -> str:
    names = {
        "zh": "Chinese",
        "yue": "Cantonese",
        "en": "English",
        "ja": "Japanese",
        "ko": "Korean",
        "fr": "French",
        "de": "German",
        "es": "Spanish",
    }
    code = normalize_language_code(language) or normalize_language_code("zh" if any(_is_cjk(char) for char in text) else "en")
    return names.get(code, "Chinese" if any(_is_cjk(char) for char in text) else "English")


def _read_field(value: object, name: str, default: object = None) -> object:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _is_sequence(value: object) -> bool:
    return isinstance(value, Sequence) and not isinstance(value, (str, bytes, bytearray))


@contextlib.contextmanager
def _model_cache_environment(model_cache_root: str | Path | None):
    if model_cache_root is None:
        yield
        return
    values = model_cache_environment(model_cache_root)
    old = {key: os.environ.get(key) for key in values}
    os.environ.update(values)
    try:
        yield
    finally:
        for key, value in old.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


__all__ = [
    "ALIGNMENT_MODE_FILL",
    "ALIGNMENT_MODE_GENERATE",
    "MAX_ALIGNMENT_CHUNK_MS",
    "FireRedCtcBackend",
    "FireRedDecodeResult",
    "QwenForcedAlignerBackend",
    "TimedToken",
    "TimestampAlignmentError",
    "TimestampAlignmentCancelled",
    "TimestampAlignmentReport",
    "TimestampAlignmentRequest",
    "align_local_transcription",
    "align_project",
    "create_alignment_backend",
    "firered_tokens_to_items",
    "run_timestamp_alignment",
]
