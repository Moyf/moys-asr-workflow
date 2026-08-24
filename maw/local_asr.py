"""Optional local ASR adapters and the shared local-transcription flow.

The optional model packages are deliberately imported inside the adapters.  The
cloud-only MAW installation therefore remains importable and testable without
Torch, QwenASR, or FunASR installed.
"""

from __future__ import annotations

import inspect
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
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
QWEN_DEFAULT_FORCED_ALIGNER = "Qwen/Qwen3-ForcedAligner-0.6B"
QWEN_DEFAULT_CHUNK_SECONDS = 30
QWEN_MAX_NEW_TOKENS = 1024
FUNASR_DEFAULT_MODEL = "paraformer-zh"
SENSEVOICE_DEFAULT_MERGE_LENGTH_S = 15


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


def _missing_dependency(
    package: str,
    extra: str = "local",
    cause: ImportError | None = None,
) -> MissingLocalDependency:
    actual = str(getattr(cause, "name", "") or "").strip()
    if actual:
        package = {"qwen_asr": "qwen-asr"}.get(actual, actual)
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


def _alignment_key(value: str) -> str:
    """Normalize text for matching Qwen alignment tokens to ASR text."""
    return "".join(
        "'" if char in {"'", "’"} else char.casefold()
        for char in value
        if char.isalnum() or char in {"'", "’"}
    )


def _restore_qwen_alignment_text(text: str, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Restore ASR spaces and punctuation onto forced-alignment timestamps.

    Qwen's forced aligner returns normalized word/character tokens without most
    punctuation, while the accompanying ASR text retains it.  Map each aligned
    token back to the source text so MAW's sentence splitter can prefer actual
    sentence boundaries instead of falling back to word-count cuts.
    """
    restored = [dict(item) for item in items]
    cursor = 0

    for index, item in enumerate(restored):
        token = _alignment_key(_as_text(item.get("text")))
        if not token:
            continue

        match_start: int | None = None
        match_end: int | None = None
        for start in range(cursor, len(text)):
            candidate = ""
            for end in range(start, len(text)):
                candidate += _alignment_key(text[end])
                if not token.startswith(candidate):
                    break
                if candidate == token:
                    match_start = start
                    match_end = end + 1
                    break
            if match_end is not None:
                break

        if match_start is None or match_end is None:
            continue

        # Attach punctuation immediately following the aligned token. Whitespace
        # starts the next item so western-language spaces remain intact.
        while (
            match_end < len(text)
            and not text[match_end].isspace()
            and not text[match_end].isalnum()
            and text[match_end] not in {"'", "’"}
        ):
            match_end += 1
        item["text"] = text[cursor:match_end]
        cursor = match_end

    if cursor < len(text) and restored:
        restored[-1]["text"] = f"{restored[-1]['text']}{text[cursor:]}"
    return restored


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
    uses_seconds = False
    if isinstance(value, Mapping):
        if "start_time" in value or "end_time" in value:
            start = value.get("start_time")
            end = value.get("end_time")
            uses_seconds = True
        else:
            start = value.get(
                "start",
                value.get("start_ms", value.get("begin_time")),
            )
            end = value.get(
                "end",
                value.get("end_ms", value.get("end_time_ms")),
            )
    elif isinstance(value, Sequence) and not isinstance(value, (str, bytes)) and len(value) >= 2:
        start, end = value[0], value[1]
    else:
        return None
    if start is None or end is None:
        return None
    converter = _as_seconds_ms if uses_seconds else _as_ms
    return converter(start), converter(end)


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
    if len(valid_pairs) == len(text) and any(char.isspace() for char in text):
        # Fun-ASR-Nano returns character-level timestamps for western-language
        # text.  MAW's western splitter works on words, so fold each character
        # span into a whitespace-preserving word span before splitting cues.
        word_matches = list(re.finditer(r"\s*\S+", text))
        if word_matches and "".join(match.group(0) for match in word_matches) == text:
            return [
                _item(
                    match.group(0),
                    valid_pairs[match.start()][0],
                    valid_pairs[match.end() - 1][1],
                )
                for match in word_matches
            ]
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


def _rich_funasr_text(value: object, *, enabled: bool) -> str:
    text = _as_text(value)
    if not enabled or not text:
        return text
    try:
        from funasr.utils.postprocess_utils import rich_transcription_postprocess  # type: ignore[import-not-found]
    except ImportError:
        return text
    return _as_text(rich_transcription_postprocess(text))


def funasr_output_to_transcription(
    raw: object,
    model: str,
    *,
    rich_postprocess: bool = False,
) -> LocalTranscription:
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
        text = _rich_funasr_text(
            sentence.get("text") or sentence.get("sentence"),
            enabled=rich_postprocess,
        )
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

    text = _rich_funasr_text(payload.get("text"), enabled=rich_postprocess) or "".join(
        segment["text"] for segment in segments
    )
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

_QWEN_SPACE_SEPARATED_LANGUAGES = frozenset({
    "arabic", "czech", "danish", "dutch", "english", "finnish", "french",
    "german", "greek", "hindi", "hungarian", "indonesian", "italian", "malay",
    "macedonian", "persian", "polish", "portuguese", "romanian", "russian",
    "spanish", "swedish", "thai", "turkish", "vietnamese",
})


class QwenAsrEngine:
    """Lazy Qwen3-ASR runtime adapter."""

    def __init__(
        self,
        model: str = QWEN_DEFAULT_MODEL,
        *,
        model_path: str | Path | None = None,
        device: str = "auto",
        forced_aligner: str | Path | None = QWEN_DEFAULT_FORCED_ALIGNER,
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
            raise _missing_dependency("qwen-asr", cause=error) from error
        try:
            import torch  # type: ignore[import-not-found]
        except ImportError as error:
            raise _missing_dependency("torch", cause=error) from error

        resolved_device = resolve_device(self.device)
        device_map = "cuda:0" if resolved_device == "cuda" else resolved_device
        if on_event:
            on_event(f"[local] loading QwenASR: {self.model_path} ({resolved_device})")
        kwargs: dict[str, Any] = {
            "dtype": torch.float16 if resolved_device == "cuda" else torch.float32,
            "device_map": device_map,
            "max_inference_batch_size": 1,
            # Keep each request bounded by the chunk size, while leaving enough
            # room for timestamp tokens and a dense speech segment.
            "max_new_tokens": QWEN_MAX_NEW_TOKENS,
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

    def _transcribe_one(
        self,
        runtime: Any,
        audio_path: Path,
        *,
        language: str | None,
        hotwords: Sequence[str],
        on_event: ProgressCallback | None,
    ) -> LocalTranscription:
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
        language_value = _as_text(_read_field(first, "language")) or language or ""
        uses_spaces = language_value.lower() in _QWEN_SPACE_SEPARATED_LANGUAGES
        items: list[dict[str, Any]] = []
        timestamps = _read_field(
            first,
            "time_stamps",
            _read_field(first, "timestamps", []),
        ) or []
        if isinstance(timestamps, Iterable) and not isinstance(timestamps, (str, bytes, Mapping)):
            for timestamp in timestamps:
                timestamp_text = _as_text(_read_field(timestamp, "text"))
                if not timestamp_text:
                    continue
                if uses_spaces and items and not timestamp_text.startswith(" "):
                    timestamp_text = f" {timestamp_text}"
                start = _as_seconds_ms(_read_field(timestamp, "start_time"))
                end = _as_seconds_ms(_read_field(timestamp, "end_time"))
                if end > start:
                    items.append(_item(timestamp_text, start, end))
        if items:
            items = _restore_qwen_alignment_text(text, items)
        if on_event:
            on_event(f"[local] detected language: {language_value or 'unknown'}")
        return LocalTranscription(text, language_value, items, [], self.model)

    @staticmethod
    def _extract_chunk(
        source_path: Path,
        target_path: Path,
        *,
        start_s: float,
        duration_s: float,
    ) -> None:
        command = [
            "ffmpeg",
            "-v", "error",
            "-ss", f"{start_s:.3f}",
            "-i", str(source_path),
            "-t", f"{duration_s:.3f}",
            "-vn",
            "-acodec", "pcm_s16le",
            "-ar", "16000",
            "-ac", "1",
            "-y", str(target_path),
        ]
        subprocess.run(command, check=True, capture_output=True)

    @staticmethod
    def _shift_chunk_result(
        transcription: LocalTranscription,
        offset_ms: int,
        *,
        add_leading_space: bool = False,
    ) -> LocalTranscription:
        items: list[dict[str, Any]] = []
        for item_index, item in enumerate(transcription.items):
            shifted = dict(item)
            shifted["start"] = _as_ms(item.get("start")) + offset_ms
            shifted["end"] = _as_ms(item.get("end")) + offset_ms
            if (
                add_leading_space
                and item_index == 0
                and shifted.get("text")
                and not str(shifted["text"]).startswith(" ")
            ):
                shifted["text"] = f" {shifted['text']}"
            items.append(shifted)

        segments: list[dict[str, Any]] = []
        for segment in transcription.segments:
            shifted_segment = dict(segment)
            shifted_segment["start"] = _as_ms(segment.get("start")) + offset_ms
            shifted_segment["end"] = _as_ms(segment.get("end")) + offset_ms
            shifted_items: list[dict[str, Any]] = []
            for item_index, item in enumerate(segment.get("items") or []):
                shifted_item = dict(item)
                shifted_item["start"] = _as_ms(item.get("start")) + offset_ms
                shifted_item["end"] = _as_ms(item.get("end")) + offset_ms
                if (
                    add_leading_space
                    and item_index == 0
                    and shifted_item.get("text")
                    and not str(shifted_item["text"]).startswith(" ")
                ):
                    shifted_item["text"] = f" {shifted_item['text']}"
                shifted_items.append(shifted_item)
            shifted_segment["items"] = shifted_items
            if (
                add_leading_space
                and shifted_segment.get("text")
                and not str(shifted_segment["text"]).startswith(" ")
            ):
                shifted_segment["text"] = f" {shifted_segment['text']}"
            segments.append(shifted_segment)

        return LocalTranscription(
            transcription.text,
            transcription.language,
            items,
            segments,
            transcription.model,
        )

    def transcribe(
        self,
        audio_path: Path,
        *,
        language: str | None = None,
        batch_size_s: int = QWEN_DEFAULT_CHUNK_SECONDS,
        hotwords: Sequence[str] = (),
        on_event: ProgressCallback | None = None,
    ) -> LocalTranscription:
        if batch_size_s <= 0:
            raise ValueError("batch_size_s must be greater than 0")
        runtime = self._load(on_event)
        if not audio_path.exists():
            return self._transcribe_one(
                runtime,
                audio_path,
                language=language,
                hotwords=hotwords,
                on_event=on_event,
            )

        duration_s = get_duration_sec(str(audio_path))
        if not math.isfinite(duration_s) or duration_s <= batch_size_s:
            return self._transcribe_one(
                runtime,
                audio_path,
                language=language,
                hotwords=hotwords,
                on_event=on_event,
            )

        chunk_count = math.ceil(duration_s / batch_size_s)
        if on_event:
            on_event(
                f"[local] 长音频 {duration_s:.1f}s，将分为 {chunk_count} 段识别"
                f"（每段不超过 {batch_size_s}s）"
            )

        chunk_results: list[LocalTranscription] = []
        with tempfile.TemporaryDirectory(prefix="maw-qwen-chunks-") as temp_dir:
            for chunk_index in range(chunk_count):
                start_s = chunk_index * batch_size_s
                chunk_duration_s = min(batch_size_s, duration_s - start_s)
                if chunk_duration_s <= 0:
                    break
                if on_event:
                    on_event(
                        f"[local] 正在识别第 {chunk_index + 1}/{chunk_count} 段"
                        f"（{start_s:.1f}s - {start_s + chunk_duration_s:.1f}s）"
                    )
                chunk_path = Path(temp_dir) / f"chunk-{chunk_index:04d}.wav"
                self._extract_chunk(
                    audio_path,
                    chunk_path,
                    start_s=start_s,
                    duration_s=chunk_duration_s,
                )
                chunk_result = self._transcribe_one(
                    runtime,
                    chunk_path,
                    language=language,
                    hotwords=hotwords,
                    on_event=on_event,
                )
                chunk_results.append(
                    self._shift_chunk_result(
                        chunk_result,
                        int(round(start_s * 1000)),
                    )
                )

        language_value = next(
            (result.language for result in chunk_results if result.language),
            language or "",
        )
        uses_spaces = language_value.lower() in _QWEN_SPACE_SEPARATED_LANGUAGES
        merged_items: list[dict[str, Any]] = []
        merged_segments: list[dict[str, Any]] = []
        texts: list[str] = []
        for chunk_index, result in enumerate(chunk_results):
            add_leading_space = uses_spaces and chunk_index > 0
            if add_leading_space:
                result = self._shift_chunk_result(result, 0, add_leading_space=True)
            merged_items.extend(result.items)
            merged_segments.extend(result.segments)
            if result.text:
                texts.append(result.text.strip())
        text = (" ".join(texts) if uses_spaces else "".join(texts)).strip()
        if on_event:
            on_event(f"[local] 长音频分块识别完成，共 {len(chunk_results)} 段")
        return LocalTranscription(text, language_value, merged_items, merged_segments, self.model)


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
        trust_remote_code: bool = False,
        rich_postprocess: bool = False,
    ) -> None:
        self.model = model
        self.model_path = str(model_path) if model_path else model
        self.device = device
        model_key = model.casefold()
        self.is_sensevoice = "sensevoice" in model_key
        self.is_fun_asr_nano = "fun-asr-nano" in model_key
        self.uses_vad = self.is_sensevoice or self.is_fun_asr_nano
        self.vad_model = vad_model or ("fsmn-vad" if self.uses_vad else None)
        self.punc_model = punc_model
        self.speaker_model = speaker_model
        self.vad_max_single_segment_time = 30000 if self.uses_vad else 0
        self.trust_remote_code = trust_remote_code or self.is_fun_asr_nano
        self.rich_postprocess = rich_postprocess or self.is_sensevoice
        self._runtime: Any = None

    def _load(self, on_event: ProgressCallback | None = None) -> Any:
        if self._runtime is not None:
            return self._runtime
        try:
            from funasr import AutoModel  # type: ignore[import-not-found]
        except ImportError as error:
            raise _missing_dependency("funasr", cause=error) from error

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
            if self.vad_max_single_segment_time:
                kwargs["vad_kwargs"] = {
                    "max_single_segment_time": self.vad_max_single_segment_time,
                }
        if self.punc_model:
            kwargs["punc_model"] = self.punc_model
        if self.speaker_model:
            kwargs["spk_model"] = self.speaker_model
        if self.trust_remote_code:
            kwargs["trust_remote_code"] = True
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
        if self.is_fun_asr_nano:
            # Older Nano checkpoints may expose text without timestamps.  The
            # FunASR pipeline can still return one cue per VAD region when
            # sentence timestamps are requested.
            kwargs["sentence_timestamp"] = True
        if self.is_sensevoice:
            # SenseVoice does not reliably return ``sentence_info`` unless the
            # caller asks for sentence timestamps.  Keep VAD regions merged
            # into manageable chunks so punctuation/AED has enough context,
            # while retaining the region boundaries for subtitle cues.
            kwargs.update({
                "sentence_timestamp": True,
                "use_itn": True,
                "merge_vad": bool(self.vad_model),
                "merge_length_s": SENSEVOICE_DEFAULT_MERGE_LENGTH_S,
            })
        if language:
            kwargs["language"] = language
        if hotwords:
            kwargs["hotword"] = " ".join(hotwords)
        raw = runtime.generate(**kwargs)
        return funasr_output_to_transcription(
            raw,
            self.model,
            rich_postprocess=self.rich_postprocess,
        )


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
    trust_remote_code: bool = False,
    rich_postprocess: bool = False,
) -> LocalAsrEngine:
    normalized = engine.strip().lower()
    if normalized in {"qwen", "qwen-asr", "qwen3-asr"}:
        return QwenAsrEngine(
            model or QWEN_DEFAULT_MODEL,
            model_path=model_path,
            device=device,
            forced_aligner=forced_aligner or QWEN_DEFAULT_FORCED_ALIGNER,
        )
    if normalized in {"funasr", "fun-asr"}:
        return FunAsrEngine(
            model or FUNASR_DEFAULT_MODEL,
            model_path=model_path,
            device=device,
            vad_model=vad_model,
            punc_model=punc_model,
            speaker_model=speaker_model,
            trust_remote_code=trust_remote_code,
            rich_postprocess=rich_postprocess,
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
def prepared_audio(
    input_path: Path,
    length_limit_s: float | None = None,
    *,
    on_event: ProgressCallback | None = None,
) -> Iterator[tuple[Path, int]]:
    """Provide a local 16 kHz mono WAV for video or limited-length inputs."""
    if not input_path.exists():
        raise FileNotFoundError(f"媒体文件不存在: {input_path}")
    if length_limit_s is not None and length_limit_s <= 0:
        raise ValueError("length limit must be greater than 0")
    needs_temp = input_path.suffix.lower() in VIDEO_EXTENSIONS or length_limit_s is not None
    if not needs_temp:
        duration_ms = max(int(round(get_duration_sec(str(input_path)) * 1000)), 1)
        if on_event:
            on_event("[local] 正在准备加载模型……")
        yield input_path, duration_ms
        return

    with tempfile.TemporaryDirectory(prefix="maw-local-") as temp_dir:
        audio_path = Path(temp_dir) / "audio.wav"
        if input_path.suffix.lower() in VIDEO_EXTENSIONS or length_limit_s is not None:
            extract_audio(str(input_path), str(audio_path), duration_limit=length_limit_s)
        else:
            shutil.copy2(input_path, audio_path)
        duration_s = get_duration_sec(str(audio_path))
        if length_limit_s is not None:
            duration_s = min(duration_s, length_limit_s)
        if on_event:
            on_event("[local] 正在准备加载模型……")
        yield audio_path, max(int(round(duration_s * 1000)), 1)


def write_local_outputs(
    *,
    input_path: Path,
    cache_media_path: Path | None = None,
    output_srt: Path,
    transcription: LocalTranscription,
    segments: list[dict[str, Any]],
    write_json: bool,
    generate_html: bool,
    with_waveform: bool,
    generate_spectral: bool = False,
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
        from maw.media_cache import embed_media_caches

        project = embed_media_caches(
            project,
            cache_media_path or input_path,
            source_media_path=input_path,
            generate_spectral=generate_spectral,
        ).project
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
    "QWEN_DEFAULT_FORCED_ALIGNER",
    "QWEN_DEFAULT_CHUNK_SECONDS",
    "QWEN_MAX_NEW_TOKENS",
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
