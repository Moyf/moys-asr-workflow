"""Optional local ASR adapters and the shared local-transcription flow.

The optional model packages are deliberately imported inside the adapters.  The
cloud-only MAW installation therefore remains importable and testable without
Torch, QwenASR, or FunASR installed.
"""

from __future__ import annotations

import inspect
import json
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from generate_subtitle_qwen_api import (
    extract_audio,
    generate_srt,
    get_duration_sec,
    parse_duration,
    repair_nonpositive_duration_segments,
    split_segments_auto,
)


ProgressCallback = Callable[[str], None]

VIDEO_EXTENSIONS = frozenset({
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v",
})

QWEN_DEFAULT_MODEL = "Qwen/Qwen3-ASR-0.6B"
FUNASR_DEFAULT_MODEL = "paraformer-zh"


class LocalAsrError(RuntimeError):
    """Base error for local model setup or inference failures."""


class MissingLocalDependency(LocalAsrError):
    """Raised when an optional local ASR package has not been installed."""


@dataclass(frozen=True, slots=True)
class LocalTranscription:
    """Provider-neutral result before MAW subtitle segmentation."""

    text: str
    language: str
    items: list[dict[str, Any]]
    segments: list[dict[str, Any]]
    model: str


@dataclass(frozen=True, slots=True)
class LocalOutputPaths:
    srt: Path
    json: Path | None
    html: Path | None


class LocalAsrEngine(Protocol):
    """Small interface implemented by each optional local runtime."""

    model: str

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        batch_size_s: int = 300,
        hotwords: Sequence[str] = (),
        on_event: ProgressCallback | None = None,
    ) -> LocalTranscription: ...


def resolve_device(device: str) -> str:
    """Resolve ``auto`` without importing Torch for the cloud-only path."""
    normalized = device.strip().lower()
    if normalized != "auto":
        if normalized not in {"cpu", "cuda"}:
            raise ValueError("device must be one of: auto, cpu, cuda")
        return normalized

    try:
        import torch  # type: ignore[import-not-found]
    except ImportError:
        return "cpu"
    return "cuda" if torch.cuda.is_available() else "cpu"


def _missing_dependency(package: str, extra: str = "local") -> MissingLocalDependency:
    return MissingLocalDependency(
        f"缺少本地模型依赖 {package}；请先运行 `uv sync --extra {extra}`。"
    )


def _read_field(value: object, name: str, default: object = None) -> object:
    if isinstance(value, Mapping):
        return value.get(name, default)
    return getattr(value, name, default)


def _as_text(value: object) -> str:
    return str(value or "")


def _as_ms(value: object, default: int = 0) -> int:
    if value is None:
        return default
    try:
        return int(round(float(value)))
    except (TypeError, ValueError):
        return default


def _as_seconds_ms(value: object, default: int = 0) -> int:
    """Convert a Qwen timestamp expressed in fractional seconds to ms."""
    if value is None:
        return default
    try:
        return int(round(float(value) * 1000))
    except (TypeError, ValueError):
        return default


def _speaker(value: object) -> str | None:
    if value is None or not str(value).strip():
        return None
    return str(value)


def _item(text: str, start: int, end: int, speaker: object = None) -> dict[str, Any]:
    result: dict[str, Any] = {"text": text, "start": int(start), "end": int(end)}
    speaker_value = _speaker(speaker)
    if speaker_value is not None:
        result["speaker"] = speaker_value
    return result


def _segment(
    text: str,
    start: int,
    end: int,
    items: list[dict[str, Any]],
    speaker: object = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "start": int(start),
        "end": int(end),
        "text": text,
        "items": items,
    }
    speaker_value = _speaker(speaker)
    if speaker_value is not None:
        result["speaker"] = speaker_value
    return result


def _timestamp_pair(value: object) -> tuple[int, int] | None:
    if isinstance(value, Mapping):
        start = value.get(
            "start",
            value.get("start_ms", value.get("begin_time", value.get("start_time"))),
        )
        end = value.get(
            "end",
            value.get("end_ms", value.get("end_time", value.get("end_time_ms"))),
        )
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)) and len(value) >= 2:
        start, end = value[0], value[1]
    else:
        return None
    if start is None or end is None:
        return None
    return _as_ms(start), _as_ms(end)


def _text_units(text: str, count: int) -> list[str]:
    if count == len(text):
        return list(text)
    units = re.findall(r"\s*\S+", text)
    if len(units) == count and "".join(units) == text:
        return units
    if count == 1:
        return [text]
    return []


def items_from_timestamps(text: str, timestamps: object) -> list[dict[str, Any]]:
    """Map FunASR timestamp pairs to items without inventing word boundaries."""
    if not isinstance(timestamps, Sequence) or isinstance(timestamps, (str, bytes)):
        return []
    pairs = [_timestamp_pair(value) for value in timestamps]
    if not pairs or any(pair is None for pair in pairs):
        if len(pairs) == 1 and pairs[0] is not None and text:
            start, end = pairs[0]
            return [_item(text, start, end)]
        return []
    valid_pairs = [pair for pair in pairs if pair is not None]
    units = _text_units(text, len(valid_pairs))
    if not units:
        return []
    return [_item(unit, pair[0], pair[1]) for unit, pair in zip(units, valid_pairs)]


def _first_mapping(value: object) -> dict[str, Any]:
    if isinstance(value, Mapping):
        nested = value.get("output")
        if isinstance(nested, Mapping):
            return dict(nested)
        if isinstance(nested, Sequence) and not isinstance(nested, (str, bytes)):
            for entry in nested:
                if isinstance(entry, Mapping):
                    return dict(entry)
        return dict(value)
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for entry in value:
            if isinstance(entry, Mapping):
                return dict(entry)
    return {}


def funasr_output_to_transcription(raw: object, model: str) -> LocalTranscription:
    """Normalize common FunASR ``generate`` result shapes.

    FunASR models differ in whether they return ``sentence_info`` and whether
    timestamp pairs are character-level or word-level.  We preserve sentence
    boundaries when available and only create items when their text mapping is
    unambiguous.
    """
    payload = _first_mapping(raw)
    sentence_values = payload.get("sentence_info") or payload.get("sentences") or []
    sentence_info = (
        sentence_values
        if isinstance(sentence_values, Sequence) and not isinstance(sentence_values, (str, bytes))
        else []
    )
    segments: list[dict[str, Any]] = []
    all_items: list[dict[str, Any]] = []

    for sentence in sentence_info:
        if not isinstance(sentence, Mapping):
            continue
        text = _as_text(sentence.get("text"))
        if not text:
            continue
        items = items_from_timestamps(
            text,
            sentence.get("timestamp") or sentence.get("timestamps") or sentence.get("word_timestamps"),
        )
        start = _as_ms(sentence.get("start", sentence.get("begin_time")))
        end = _as_ms(sentence.get("end", sentence.get("end_time")))
        if items:
            start = items[0]["start"] if start == 0 else start
            end = items[-1]["end"] if end == 0 else end
        if end <= start:
            continue
        if not items:
            items = [_item(text, start, end, sentence.get("spk", sentence.get("speaker")))]
        speaker = sentence.get("spk", sentence.get("speaker", sentence.get("speaker_id")))
        if speaker is not None:
            for item in items:
                item.setdefault("speaker", str(speaker))
        segments.append(_segment(text, start, end, items, speaker))
        all_items.extend(items)

    text = _as_text(payload.get("text")) or "".join(segment["text"] for segment in segments)
    if not segments:
        items = items_from_timestamps(
            text,
            payload.get("timestamp") or payload.get("timestamps") or payload.get("word_timestamps"),
        )
        all_items = items

    language = _as_text(payload.get("language") or payload.get("lang"))
    return LocalTranscription(text, language, all_items, segments, model)


_QWEN_LANGUAGE_NAMES = {
    "zh": "Chinese", "yue": "Cantonese", "en": "English", "ja": "Japanese",
    "ko": "Korean", "fr": "French", "de": "German", "es": "Spanish",
}


class QwenAsrEngine:
    """Lazy Qwen3-ASR runtime adapter."""

    def __init__(
        self,
        model: str = QWEN_DEFAULT_MODEL,
        *,
        model_path: str | Path | None = None,
        device: str = "auto",
        forced_aligner: str | Path | None = None,
    ) -> None:
        self.model = model
        self.model_path = str(model_path) if model_path else model
        self.device = device
        self.forced_aligner = str(forced_aligner) if forced_aligner else None
        self._runtime: Any = None

    def _load(self, on_event: ProgressCallback | None = None) -> Any:
        if self._runtime is not None:
            return self._runtime
        try:
            from qwen_asr import Qwen3ASRModel  # type: ignore[import-not-found]
        except ImportError as error:
            raise _missing_dependency("qwen-asr") from error
        try:
            import torch  # type: ignore[import-not-found]
        except ImportError as error:
            raise _missing_dependency("torch") from error

        resolved_device = resolve_device(self.device)
        device_map = "cuda:0" if resolved_device == "cuda" else resolved_device
        if on_event:
            on_event(f"[local] loading QwenASR: {self.model_path} ({resolved_device})")
        kwargs: dict[str, Any] = {
            "dtype": torch.float16 if resolved_device == "cuda" else torch.float32,
            "device_map": device_map,
            "max_inference_batch_size": 1,
            "max_new_tokens": 256,
        }
        if self.forced_aligner:
            kwargs["forced_aligner"] = self.forced_aligner
            kwargs["forced_aligner_kwargs"] = {
                "dtype": kwargs["dtype"],
                "device_map": device_map,
            }
        self._runtime = Qwen3ASRModel.from_pretrained(self.model_path, **kwargs)
        if on_event:
            on_event("[local] QwenASR loaded")
        return self._runtime

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        batch_size_s: int = 300,
        hotwords: Sequence[str] = (),
        on_event: ProgressCallback | None = None,
    ) -> LocalTranscription:
        del batch_size_s  # Qwen3-ASR currently controls its own chunking.
        runtime = self._load(on_event)
        if on_event:
            on_event(f"[local] transcribing: {audio_path.name}")
        language_name = _QWEN_LANGUAGE_NAMES.get((language or "").lower(), language or None)
        kwargs: dict[str, Any] = {
            "audio": str(audio_path),
            "language": language_name,
        }
        if self.forced_aligner:
            kwargs["return_time_stamps"] = True
        elif on_event:
            on_event("[local] 未指定 Forced Aligner，QwenASR 将只返回文本")
        if hotwords:
            try:
                signature = inspect.signature(runtime.transcribe)
                supports_context = (
                    "context" in signature.parameters
                    or any(
                        parameter.kind is inspect.Parameter.VAR_KEYWORD
                        for parameter in signature.parameters.values()
                    )
                )
            except (TypeError, ValueError):
                supports_context = False
            if supports_context:
                kwargs["context"] = " ".join(hotwords)
            elif on_event:
                on_event("[local] 当前 QwenASR 运行时不支持 context，已跳过热词")
        result = runtime.transcribe(**kwargs)
        first = result[0] if isinstance(result, Sequence) and not isinstance(result, (str, bytes)) else result
        text = _as_text(_read_field(first, "text"))
        items: list[dict[str, Any]] = []
        timestamps = _read_field(
            first,
            "time_stamps",
            _read_field(first, "timestamps", []),
        ) or []
        if isinstance(timestamps, Sequence):
            for timestamp in timestamps:
                timestamp_text = _as_text(_read_field(timestamp, "text"))
                if not timestamp_text:
                    continue
                start = _as_seconds_ms(_read_field(timestamp, "start_time"))
                end = _as_seconds_ms(_read_field(timestamp, "end_time"))
                if end > start:
                    items.append(_item(timestamp_text, start, end))
        language_value = _as_text(_read_field(first, "language")) or language or ""
        if on_event:
            on_event(f"[local] detected language: {language_value or 'unknown'}")
        return LocalTranscription(text, language_value, items, [], self.model)


class FunAsrEngine:
    """Lazy FunASR ``AutoModel`` adapter."""

    def __init__(
        self,
        model: str = FUNASR_DEFAULT_MODEL,
        *,
        model_path: str | Path | None = None,
        device: str = "auto",
        vad_model: str | None = None,
        punc_model: str | None = None,
        speaker_model: str | None = None,
    ) -> None:
        self.model = model
        self.model_path = str(model_path) if model_path else model
        self.device = device
        self.vad_model = vad_model
        self.punc_model = punc_model
        self.speaker_model = speaker_model
        self._runtime: Any = None

    def _load(self, on_event: ProgressCallback | None = None) -> Any:
        if self._runtime is not None:
            return self._runtime
        try:
            from funasr import AutoModel  # type: ignore[import-not-found]
        except ImportError as error:
            raise _missing_dependency("funasr") from error

        resolved_device = resolve_device(self.device)
        if on_event:
            on_event(f"[local] loading FunASR: {self.model_path} ({resolved_device})")
        kwargs: dict[str, Any] = {
            "model": self.model_path,
            "device": resolved_device,
            "disable_update": True,
        }
        if self.vad_model:
            kwargs["vad_model"] = self.vad_model
        if self.punc_model:
            kwargs["punc_model"] = self.punc_model
        if self.speaker_model:
            kwargs["spk_model"] = self.speaker_model
        self._runtime = AutoModel(**kwargs)
        if on_event:
            on_event("[local] FunASR loaded")
        return self._runtime

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        batch_size_s: int = 300,
        hotwords: Sequence[str] = (),
        on_event: ProgressCallback | None = None,
    ) -> LocalTranscription:
        runtime = self._load(on_event)
        if language and on_event:
            on_event(f"[local] FunASR model controls language: {language}")
        if on_event:
            on_event(f"[local] transcribing: {audio_path.name}")
        kwargs: dict[str, Any] = {
            "input": str(audio_path),
            "batch_size_s": batch_size_s,
        }
        if hotwords:
            kwargs["hotword"] = " ".join(hotwords)
        raw = runtime.generate(**kwargs)
        return funasr_output_to_transcription(raw, self.model)


def create_local_engine(
    engine: str,
    *,
    model: str | None = None,
    model_path: str | Path | None = None,
    device: str = "auto",
    forced_aligner: str | Path | None = None,
    vad_model: str | None = None,
    punc_model: str | None = None,
    speaker_model: str | None = None,
) -> LocalAsrEngine:
    normalized = engine.strip().lower()
    if normalized in {"qwen", "qwen-asr", "qwen3-asr"}:
        return QwenAsrEngine(
            model or QWEN_DEFAULT_MODEL,
            model_path=model_path,
            device=device,
            forced_aligner=forced_aligner,
        )
    if normalized in {"funasr", "fun-asr"}:
        return FunAsrEngine(
            model or FUNASR_DEFAULT_MODEL,
            model_path=model_path,
            device=device,
            vad_model=vad_model,
            punc_model=punc_model,
            speaker_model=speaker_model,
        )
    raise ValueError("engine must be one of: qwen-asr, funasr")


def build_local_segments(
    transcription: LocalTranscription,
    *,
    duration_ms: int,
    max_len: int = 21,
    min_len: int = 5,
    gap_split_ms: int = 1000,
) -> list[dict[str, Any]]:
    """Turn adapter output into MAW's integer-millisecond subtitle segments."""
    if transcription.segments:
        segments = [dict(segment) for segment in transcription.segments]
    elif transcription.items:
        segments = split_segments_auto(
            transcription.items,
            max_len=max_len,
            min_len=min_len,
            gap_split_ms=gap_split_ms,
        )
    elif transcription.text:
        segments = [{"start": 0, "end": max(duration_ms, 1), "text": transcription.text, "items": []}]
    else:
        return []
    return repair_nonpositive_duration_segments(segments)


@contextmanager
def prepared_audio(input_path: Path, length_limit_s: float | None = None) -> Iterator[tuple[Path, int]]:
    """Provide a local 16 kHz mono WAV for video or limited-length inputs."""
    if not input_path.exists():
        raise FileNotFoundError(f"媒体文件不存在: {input_path}")
    if length_limit_s is not None and length_limit_s <= 0:
        raise ValueError("length limit must be greater than 0")
    needs_temp = input_path.suffix.lower() in VIDEO_EXTENSIONS or length_limit_s is not None
    if not needs_temp:
        duration_ms = max(int(round(get_duration_sec(str(input_path)) * 1000)), 1)
        yield input_path, duration_ms
        return

    with tempfile.TemporaryDirectory(prefix="maw-local-") as temp_dir:
        audio_path = Path(temp_dir) / "audio.wav"
        if input_path.suffix.lower() in VIDEO_EXTENSIONS or length_limit_s is not None:
            extract_audio(str(input_path), str(audio_path))
        else:
            shutil.copy2(input_path, audio_path)
        duration_s = get_duration_sec(str(audio_path))
        if length_limit_s is not None and length_limit_s < duration_s:
            limited_path = Path(temp_dir) / "audio-limited.wav"
            subprocess.run(
                [
                    "ffmpeg", "-i", str(audio_path), "-t", str(length_limit_s),
                    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y", str(limited_path),
                ],
                check=True,
                capture_output=True,
            )
            audio_path = limited_path
            duration_s = length_limit_s
        yield audio_path, max(int(round(duration_s * 1000)), 1)


def write_local_outputs(
    *,
    input_path: Path,
    output_srt: Path,
    transcription: LocalTranscription,
    segments: list[dict[str, Any]],
    write_json: bool,
    generate_html: bool,
    with_waveform: bool,
) -> LocalOutputPaths:
    """Write SRT and optional MAW project/portable editor outputs."""
    output_srt.parent.mkdir(parents=True, exist_ok=True)
    output_srt.write_text(generate_srt(segments), encoding="utf-8", newline="\n")
    if not write_json:
        return LocalOutputPaths(output_srt, None, None)

    json_path = output_srt.with_suffix(".mosp")
    project: dict[str, Any] = {
        "media": str(input_path),
        "language": transcription.language,
        "model": transcription.model,
        "segments": segments,
    }
    if with_waveform:
        from waveform import embed_waveform

        waveform_result = embed_waveform(project, input_path)
        project = waveform_result.project
        if waveform_result.error:
            print(f"[waveform] 警告: {waveform_result.error}；已跳过内嵌波形")
    json_path.write_text(
        json.dumps(project, ensure_ascii=False, indent=2),
        encoding="utf-8",
        newline="\n",
    )

    html_path: Path | None = None
    if generate_html:
        edit_script = Path(__file__).resolve().parents[1] / "edit.py"
        candidate = json_path.with_name(f"{json_path.stem}.edit.html")
        completed = subprocess.run(
            [sys.executable, str(edit_script), str(json_path), "-m", str(input_path)],
            cwd=str(edit_script.parent),
            capture_output=True,
            text=True,
            check=False,
        )
        if completed.returncode == 0 and candidate.exists():
            html_path = candidate
        else:
            detail = (completed.stderr or completed.stdout or "edit.py failed").strip()
            print(f"[html] 警告: 未生成便携编辑器: {detail[:300]}")
    return LocalOutputPaths(output_srt, json_path, html_path)


__all__ = [
    "FUNASR_DEFAULT_MODEL",
    "LocalAsrEngine",
    "LocalAsrError",
    "LocalOutputPaths",
    "LocalTranscription",
    "MissingLocalDependency",
    "QWEN_DEFAULT_MODEL",
    "FunAsrEngine",
    "QwenAsrEngine",
    "build_local_segments",
    "create_local_engine",
    "funasr_output_to_transcription",
    "items_from_timestamps",
    "parse_duration",
    "prepared_audio",
    "resolve_device",
    "write_local_outputs",
]
