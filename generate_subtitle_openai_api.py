"""Generate MAW subtitle projects through an OpenAI-compatible ASR endpoint.

The endpoint must implement ``POST /audio/transcriptions`` and return either
OpenAI ``verbose_json`` data with ``segments``/``words`` timestamps or an
equivalent timestamped JSON structure.  A text-only response is rejected by
default because it cannot produce trustworthy subtitle timing.
"""

from __future__ import annotations

import argparse
import json
import math
import mimetypes
import os
import re as _re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Mapping

import requests

from edit import get_default_sticker_dir
from generate_subtitle_qwen_api import (
    extract_audio,
    generate_srt,
    get_duration_sec,
    parse_duration,
    split_segments_auto,
    WESTERN_MAX_WORDS,
    WESTERN_MIN_WORDS,
)
from maw.app_paths import default_env_path
from maw.console import configure_utf8_stdio
from maw.ffmpeg import resolve_ffmpeg_tools
from maw.gui_config import load_env
from maw.media_cache import embed_media_caches, merge_media_caches
from maw.language import (
    normalize_language_code,
    normalize_timestamp_range,
    resolve_language,
    split_mode_for_text,
    timestamp_items_cover_text,
    timestamp_granularity_for_items,
)
from maw.project import repair_segment_durations
from maw.project_io import write_mosp


DEFAULT_BASE_URL = "https://api.openai.com/v1"
DEFAULT_MODEL = "whisper-1"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)
VIDEO_EXTENSIONS = frozenset({
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v",
})


def _env_value(key: str, default: str = "") -> str:
    return os.environ.get(key, default).strip()


def load_cli_config(
    env_path: Path | None = None,
    environment: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Load OpenAI ASR and FFmpeg settings with process env taking priority."""
    file_values = load_env(env_path or default_env_path())
    values = os.environ if environment is None else environment

    def pick(key: str, default: str = "") -> str:
        return str(values.get(key) or file_values.get(key, default)).strip()

    return {
        "api_key": pick("MAW_OPENAI_ASR_API_KEY"),
        "base_url": pick("MAW_OPENAI_ASR_BASE_URL", DEFAULT_BASE_URL),
        "model": pick("MAW_OPENAI_ASR_MODEL", DEFAULT_MODEL),
        "ffmpeg_path": pick("FFMPEG_PATH"),
    }


def normalize_base_url(value: str) -> str:
    """Normalize a base URL while accepting either a root domain or ``/v1``."""
    base = value.strip().rstrip("/")
    if not base:
        base = DEFAULT_BASE_URL
    if base.endswith("/audio/transcriptions"):
        base = base[: -len("/audio/transcriptions")]
    if not base.endswith("/v1"):
        base = f"{base}/v1"
    return base


def transcription_url(base_url: str) -> str:
    return f"{normalize_base_url(base_url)}/audio/transcriptions"


def _number(value: object, *, default: float | None = None) -> float | None:
    if value is None or value == "":
        return default
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return number if math.isfinite(number) else default


def _milliseconds(value: object, *, default: int | None = None) -> int | None:
    """Convert an OpenAI-compatible timestamp value expressed in seconds."""
    number = _number(value)
    if number is None:
        return default
    milliseconds = number * 1000
    if not math.isfinite(milliseconds):
        return default
    try:
        return int(round(milliseconds))
    except (OverflowError, ValueError):
        return default


def _timestamp_milliseconds(
    raw: Mapping[str, Any],
    field: str,
    *,
    default: int | None = None,
) -> int | None:
    """Read one timestamp without guessing its unit from the magnitude.

    OpenAI's ``start``/``end`` fields are seconds.  A few compatible gateways
    expose explicit ``start_ms``/``end_ms`` (or ``*_time_ms``) fields instead;
    only those names are interpreted as milliseconds.  A magnitude heuristic
    would misread valid timestamps from long recordings.
    """
    for key in (f"{field}_ms", f"{field}_time_ms"):
        if key in raw and raw[key] is not None:
            number = _number(raw[key])
            return int(round(number)) if number is not None else default
    for key in (field, f"{field}_time"):
        if key in raw and raw[key] is not None:
            return _milliseconds(raw[key], default=default)
    return default


def _text(value: object) -> str:
    return str(value or "")


def _as_mapping(value: object) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _timestamp_item(raw: Mapping[str, Any]) -> dict[str, Any] | None:
    text = _text(raw.get("word") or raw.get("text") or raw.get("token")).strip()
    start = _timestamp_milliseconds(raw, "start")
    end = _timestamp_milliseconds(raw, "end")
    timestamp = normalize_timestamp_range(start, end)
    if not text or timestamp is None:
        return None
    start, end = timestamp
    item: dict[str, Any] = {"text": text, "start": start, "end": end}
    speaker = raw.get("speaker")
    if speaker is not None and str(speaker).strip():
        item["speaker"] = str(speaker)
    return item


def _normalize_western_item_spacing(items: list[dict[str, Any]]) -> None:
    """Add separators when an API returns western words without leading spaces."""
    if not items:
        return
    cjk_items = sum(
        any("\u3400" <= char <= "\u9fff" or "\u3040" <= char <= "\u30ff" for char in str(item.get("text", "")))
        for item in items
    )
    if cjk_items * 2 >= len(items):
        return

    closing = set(".,!?;:%…)]}，。！？；：、'’")
    opening = set("([{\"“‘")
    previous = ""
    for index, item in enumerate(items):
        text = str(item.get("text", "")).strip()
        if index and text and not text.startswith(tuple(closing)) and not previous.endswith(tuple(opening)):
            text = f" {text}"
        item["text"] = text
        previous = text.rstrip()


def _timestamp_segment(raw: Mapping[str, Any]) -> dict[str, Any] | None:
    text = _text(raw.get("text")).strip()
    start = _timestamp_milliseconds(raw, "start")
    end = _timestamp_milliseconds(raw, "end")
    timestamp = normalize_timestamp_range(start, end)
    if not text or timestamp is None:
        return None
    start, end = timestamp
    result: dict[str, Any] = {"start": start, "end": end, "text": text}
    speaker = raw.get("speaker")
    if speaker is not None and str(speaker).strip():
        result["speaker"] = str(speaker)
    return result


def _timestamp_word_list(
    raw_words: object,
) -> tuple[list[dict[str, Any]], bool]:
    """Parse one word list and flag a partial/invalid timestamp response."""
    words = raw_words if isinstance(raw_words, list) else []
    items: list[dict[str, Any]] = []
    invalid = False
    for raw_word in words:
        if not isinstance(raw_word, Mapping):
            invalid = True
            continue
        word = _as_mapping(raw_word)
        word_text = _text(word.get("word") or word.get("text") or word.get("token")).strip()
        if not word_text:
            continue
        item = _timestamp_item(word)
        if item is None:
            invalid = True
        else:
            items.append(item)
    return items, invalid


def _timestamp_envelope(items: list[dict[str, Any]]) -> tuple[int, int] | None:
    if not items:
        return None
    return (
        min(item["start"] for item in items),
        max(item["end"] for item in items),
    )


def parse_timestamped_response(body: Mapping[str, Any]) -> dict[str, Any]:
    """Map common OpenAI-compatible timestamp shapes to MAW's contract."""
    payload = _as_mapping(body.get("data")) or body
    text = _text(payload.get("text")).strip()
    raw_segments = payload.get("segments")
    raw_segments = raw_segments if isinstance(raw_segments, list) else []
    raw_words = payload.get("words")
    raw_words = raw_words if isinstance(raw_words, list) else []

    segments: list[dict[str, Any]] = []
    nested_items: list[dict[str, Any]] = []
    nested_segment_items: list[list[dict[str, Any]]] = []
    nested_segment_invalid: list[bool] = []
    nested_invalid = False
    segment_texts: list[str] = []
    has_unranged_segment = False
    for raw_segment in raw_segments:
        if not isinstance(raw_segment, Mapping):
            # A malformed segment must not be silently discarded.  If the
            # response still has a usable text/range envelope below, the
            # caller can preserve it as one coarse cue.
            has_unranged_segment = True
            continue
        segment = _as_mapping(raw_segment)
        segment_text = _text(segment.get("text")).strip()
        if segment_text:
            segment_texts.append(segment_text)
        segment_items, invalid_segment_word = _timestamp_word_list(segment.get("words"))
        parsed = _timestamp_segment(segment)
        segment_items_complete = not invalid_segment_word
        if (
            segment_items_complete
            and segment_items
            and segment_text
            and not timestamp_items_cover_text(segment_text, segment_items)
        ):
            segment_items_complete = False
        nested_invalid = nested_invalid or not segment_items_complete
        if segment_items and segment_items_complete:
            # Keep valid nested words even if the enclosing segment range is
            # malformed; they can still provide a conservative fallback span.
            nested_items.extend(segment_items)
        if parsed is not None:
            segments.append(parsed)
            nested_segment_items.append(
                [] if not segment_items_complete else [dict(item) for item in segment_items]
            )
            nested_segment_invalid.append(not segment_items_complete)
        elif segment_text:
            has_unranged_segment = True

    top_level_items, top_level_invalid = _timestamp_word_list(raw_words)
    has_top_level_words = bool(top_level_items or top_level_invalid)

    # OpenAI's verbose_json commonly puts sentence ranges in segments[] and
    # all word ranges in a separate top-level words[] array.  Without this
    # association the words remain globally usable but disappear whenever a
    # mixed segment-only response is preserved.  Prefer top-level words when
    # present; they are the complete word list for that response shape.
    precise_items = top_level_items if has_top_level_words else nested_items
    language = normalize_language_code(payload.get("language") or payload.get("lang"))
    if not text:
        if segment_texts:
            combined = "".join(segment_texts)
            separator = " " if split_mode_for_text(combined, language) == "word" else ""
            text = separator.join(segment_texts).strip()
        elif precise_items:
            combined = "".join(str(item.get("text", "")) for item in precise_items)
            separator = " " if split_mode_for_text(combined, language) == "word" else ""
            text = separator.join(
                str(item.get("text", "")).strip() for item in precise_items
            ).strip()

    top_level_text_incomplete = (
        has_top_level_words
        and bool(top_level_items)
        and bool(text)
        and not timestamp_items_cover_text(text, top_level_items)
    )
    items = precise_items
    has_invalid_words = (
        top_level_invalid or top_level_text_incomplete
        if has_top_level_words
        else nested_invalid
    )
    if has_top_level_words and (top_level_invalid or top_level_text_incomplete):
        # An invalid top-level word cannot be assigned to a sentence safely.
        # Discard all word precision for this response and retain only valid
        # sentence ranges below.
        items = []
    elif has_top_level_words and segments:
        mapped_count = 0
        for item in top_level_items:
            candidates: list[tuple[int, int, int]] = []
            for index, segment in enumerate(segments):
                overlap = min(item["end"], segment["end"]) - max(item["start"], segment["start"])
                if overlap <= 0:
                    continue
                contained = int(
                    item["start"] >= segment["start"]
                    and item["end"] <= segment["end"]
                )
                candidates.append((contained, overlap, -index))
            if candidates:
                _, _, negative_index = max(candidates)
                segment = segments[-negative_index]
                segment.setdefault("items", []).append(item)
                segment["start"] = min(segment["start"], item["start"])
                segment["end"] = max(segment["end"], item["end"])
                mapped_count += 1
        if mapped_count != len(top_level_items):
            # A top-level word outside every sentence cannot be safely
            # assigned by time. Collapse to one envelope below so its text is
            # not lost while preserving a valid timeline range.
            has_unranged_segment = True
        # A segment with no overlapping top-level words is a sentence-level
        # fallback. Do not copy nested words into it: top-level words are the
        # authoritative list for this response shape.
        for segment in segments:
            if not segment.get("items"):
                segment.pop("items", None)
    elif not has_top_level_words:
        for segment, segment_items, invalid in zip(
            segments, nested_segment_items, nested_segment_invalid
        ):
            if segment_items and not invalid:
                segment["items"] = segment_items
                segment["start"] = min(
                    segment["start"], *(item["start"] for item in segment_items)
                )
                segment["end"] = max(
                    segment["end"], *(item["end"] for item in segment_items)
                )

    # ``nested_segment_items`` contains only segments with usable sentence
    # ranges. The top-level mapping above is the normal OpenAI shape; nested
    # words retain their own segment association without shifting after a
    # malformed range.
    if items:
        _normalize_western_item_spacing(items)
    for segment in segments:
        if segment.get("items"):
            # Top-level words are shared with ``items``; copy them before
            # normalizing the per-sentence view so a leading separator at a
            # later sentence boundary is not stripped from the flat list.
            segment["items"] = [dict(item) for item in segment["items"]]
            _normalize_western_item_spacing(segment["items"])
    if (
        text
        and segment_texts
        and _re.sub(r"\s+", "", text) != _re.sub(r"\s+", "", "".join(segment_texts))
    ):
        has_unranged_segment = True
    if has_unranged_segment:
        fallback_ranges = [
            (segment["start"], segment["end"])
            for segment in segments
        ]
        precise_range = _timestamp_envelope(precise_items)
        if precise_range is not None:
            fallback_ranges.append(precise_range)
        if not text or not fallback_ranges:
            raise RuntimeError(
                "ASR 接口返回了无法定位的字幕文本，且没有可用的句级或词级时间范围；"
                "无法安全生成字幕时间码。"
            )
        start = min(item[0] for item in fallback_ranges)
        end = max(item[1] for item in fallback_ranges)
        segments = [{"start": start, "end": end, "text": text}]
        items = []
        has_invalid_words = False
    precise_range = _timestamp_envelope(precise_items)
    if has_invalid_words and not segments and precise_range is not None and text:
        # With no sentence array there is no finer boundary to preserve. Use
        # the valid-item envelope as one conservative sentence fallback.
        start, end = precise_range
        segments = [{"start": start, "end": end, "text": text}]
        items = []
    has_fallback_segment = has_invalid_words or any(
        segment.get("text") and not segment.get("items")
        for segment in segments
    )
    if segments:
        return {
            "text": text,
            "language": language,
            "items": items,
            "segments": segments,
            "timestamp_granularity": "segment" if has_fallback_segment else "word" if items else "segment",
        }
    if items:
        if has_invalid_words:
            raise RuntimeError(
                "ASR 接口返回了不完整的词级时间戳，且没有可用的句级时间范围；"
                "无法安全生成字幕时间码。"
            )
        return {
            "text": text,
            "language": language,
            "items": items,
            "segments": [],
            "timestamp_granularity": "word",
        }
    raise RuntimeError(
        "ASR 接口只返回了文本，没有返回 segments/words 时间戳；"
        "请让中转接口支持 response_format=verbose_json 和 timestamp_granularities，"
        "否则无法生成可精确对轨的字幕。"
    )


def _error_detail(response: requests.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        return response.text.strip()[:1000] or "服务端未返回错误正文"
    if isinstance(body, Mapping):
        error = _as_mapping(body.get("error"))
        message = error.get("message") or body.get("message")
        if message:
            return str(message)
    return json.dumps(body, ensure_ascii=False)[:1000]


def request_transcription(
    audio_path: Path,
    *,
    base_url: str,
    api_key: str,
    model: str,
    language: str | None,
) -> dict[str, Any]:
    if not api_key:
        raise RuntimeError(
            "未配置自定义 ASR API Key；请在 GUI 中填写，或设置 MAW_OPENAI_ASR_API_KEY。"
        )
    if not model.strip():
        raise RuntimeError("未配置自定义 ASR 模型名。")

    data: list[tuple[str, str]] = [
        ("model", model.strip()),
        ("response_format", "verbose_json"),
        ("timestamp_granularities[]", "segment"),
        ("timestamp_granularities[]", "word"),
    ]
    if language:
        data.append(("language", language.strip()))
    content_type = mimetypes.guess_type(audio_path.name)[0] or "application/octet-stream"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "User-Agent": _env_value("MAW_OPENAI_ASR_USER_AGENT", DEFAULT_USER_AGENT),
    }
    print(f"[openai-asr] 请求: {transcription_url(base_url)} | model={model}")
    with audio_path.open("rb") as handle:
        response = requests.post(
            transcription_url(base_url),
            headers=headers,
            data=data,
            files={"file": (audio_path.name, handle, content_type)},
            timeout=(30, 3600),
        )
    if not response.ok:
        raise RuntimeError(
            f"自定义 ASR 请求失败 (HTTP {response.status_code}): {_error_detail(response)}"
        )
    try:
        body = response.json()
    except ValueError as error:
        raise RuntimeError("自定义 ASR 返回的不是 JSON，无法读取字幕时间戳。") from error
    parsed = parse_timestamped_response(_as_mapping(body))
    parsed["_raw_response"] = body
    return parsed


def _prepare_audio(
    input_path: Path,
    temp_dir: Path,
    length_limit: float | None,
    *,
    ffmpeg_path: Path | None,
    ffprobe_path: Path | None,
) -> tuple[Path, float]:
    if input_path.suffix.lower() in VIDEO_EXTENSIONS:
        audio_path = temp_dir / "audio.wav"
        source_duration = get_duration_sec(str(input_path), ffprobe_path=ffprobe_path)
        limit = length_limit if length_limit and length_limit < source_duration else None
        extract_audio(str(input_path), str(audio_path), duration_limit=limit, ffmpeg_path=ffmpeg_path)
    else:
        audio_path = temp_dir / input_path.name
        shutil.copy2(input_path, audio_path)

    duration = get_duration_sec(str(audio_path), ffprobe_path=ffprobe_path)
    if length_limit and length_limit < duration:
        limited = temp_dir / "audio_limited.wav"
        extract_audio(
            str(audio_path),
            str(limited),
            duration_limit=length_limit,
            ffmpeg_path=ffmpeg_path,
        )
        audio_path = limited
        duration = length_limit
    return audio_path, duration


def _segments_from_result(
    result: Mapping[str, Any],
    *,
    max_len: int,
    min_len: int,
    gap_split: int,
    max_words: int = WESTERN_MAX_WORDS,
    min_words: int = WESTERN_MIN_WORDS,
) -> list[dict[str, Any]]:
    items = [dict(item) for item in result.get("items", [])]
    if result.get("timestamp_granularity") == "segment" and result.get("segments"):
        return [dict(segment) for segment in result["segments"]]
    if items:
        split_mode = split_mode_for_text(str(result.get("text") or ""), result.get("language"))
        return split_segments_auto(
            items,
            max_len=max_len,
            min_len=min_len,
            gap_split_ms=gap_split,
            max_words=max_words,
            min_words=min_words,
            split_mode=split_mode,
        )
    return [dict(segment) for segment in result.get("segments", [])]


def _strip_trailing_punct(
    segments: list[dict[str, Any]],
    strip_chars: str,
) -> None:
    """Strip cue/item tail punctuation without retaining punctuation-only items."""
    if not strip_chars:
        return
    for segment in segments:
        segment["text"] = str(segment.get("text") or "").rstrip(strip_chars)
        segment_items = segment.get("items")
        if not isinstance(segment_items, list):
            continue
        for index in range(len(segment_items) - 1, -1, -1):
            item = segment_items[index]
            if not isinstance(item, dict):
                segment_items.pop(index)
                continue
            item["text"] = str(item.get("text") or "").rstrip(strip_chars)
            if item["text"]:
                break
            segment_items.pop(index)


def main() -> None:
    configure_utf8_stdio()
    config = load_cli_config()
    parser = argparse.ArgumentParser(description="通过 OpenAI 兼容 ASR 接口生成 MAW 字幕工程")
    parser.add_argument("input", help="输入视频或音频路径")
    parser.add_argument("-o", "--output", help="输出 SRT 路径")
    parser.add_argument("--base-url", default=config["base_url"])
    parser.add_argument("--model", default=config["model"])
    parser.add_argument("--language", default=None)
    parser.add_argument("--max-len", type=int, default=18)
    parser.add_argument("--min-len", type=int, default=5)
    parser.add_argument("--max-words", type=int, default=WESTERN_MAX_WORDS)
    parser.add_argument("--min-words", type=int, default=WESTERN_MIN_WORDS)
    parser.add_argument("--gap-split", type=int, default=800)
    parser.add_argument("-ll", "--length-limit", type=parse_duration, default=None)
    parser.add_argument("--keep-punct", action="store_true")
    parser.add_argument(
        "--strip-tail-punct",
        default="，。",
        help="句尾剥除的标点集合；传空串禁用剥除（默认剥逗号和句号）",
    )
    parser.add_argument("--json", dest="json_out", action="store_true")
    parser.add_argument("--with-waveform", action="store_true")
    parser.add_argument("--with-spectral", action="store_true")
    parser.add_argument("--no-html", action="store_true")
    parser.add_argument("-s", "--stickers", default=get_default_sticker_dir())
    parser.add_argument("--debug", action="store_true", help="输出时间戳解析摘要")
    parser.add_argument("--debug-raw", action="store_true")
    args = parser.parse_args()
    if args.with_spectral and not args.with_waveform:
        parser.error("--with-spectral 需要同时指定 --with-waveform")
    if args.max_len < 1 or args.min_len < 1 or args.max_words < 1 or args.min_words < 1 or args.gap_split < 0:
        parser.error("字幕切分参数无效")
    if args.max_len < args.min_len or args.max_words < args.min_words:
        parser.error("最大值不能小于对应的短句合并阈值")

    input_path = Path(args.input).expanduser()
    if not input_path.is_file():
        print(f"错误: 文件不存在 - {input_path}", file=sys.stderr)
        raise SystemExit(1)
    output_path = Path(args.output).expanduser() if args.output else input_path.with_suffix(".srt")
    api_key = config["api_key"]
    ffmpeg_tools = resolve_ffmpeg_tools(configured_path=config["ffmpeg_path"] or None)

    started = time.perf_counter()
    with tempfile.TemporaryDirectory() as temp_name:
        temp_dir = Path(temp_name)
        print(f"[媒体] 正在准备输入媒体: {input_path.name}")
        audio_path, duration = _prepare_audio(
            input_path,
            temp_dir,
            args.length_limit,
            ffmpeg_path=ffmpeg_tools.ffmpeg,
            ffprobe_path=ffmpeg_tools.ffprobe,
        )
        print(f"[媒体] 音频时长: {int(duration // 60)}分{int(duration % 60)}秒")
        result = request_transcription(
            audio_path,
            base_url=args.base_url,
            api_key=api_key,
            model=args.model,
            language=args.language,
        )
        if not result.get("text"):
            print("错误: 未识别到任何内容", file=sys.stderr)
            raise SystemExit(2)
        segments = _segments_from_result(
            result,
            max_len=args.max_len,
            min_len=args.min_len,
            gap_split=args.gap_split,
            max_words=args.max_words,
            min_words=args.min_words,
        )
        if not segments:
            raise RuntimeError("ASR 返回内容为空，未生成字幕段。")
        if args.debug:
            print("\n--- debug ---")
            print(f"text: {result['text'][:200]}...")
            print(f"items count: {len(result.get('items', []))}")
            print(f"segments count: {len(result.get('segments', []))}")
            print("--- end debug ---\n")
        cache_result = None
        if args.json_out and args.with_waveform:
            cache_result = embed_media_caches(
                {"media": str(input_path)},
                audio_path,
                source_media_path=input_path,
                generate_spectral=args.with_spectral,
            )

    if not args.keep_punct:
        _strip_trailing_punct(segments, args.strip_tail_punct)
    repair_segment_durations(segments)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(generate_srt(segments), encoding="utf-8")
    print(f"字幕已保存到: {output_path}")
    print(f"共 {len(segments)} 条字幕")

    raw_response = result.get("_raw_response")
    if args.debug_raw and raw_response is not None:
        raw_path = output_path.with_suffix(".asr-response.json")
        raw_path.write_text(json.dumps(raw_response, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"[调试] ASR 原始返回已保存到: {raw_path}")

    if args.json_out:
        language, language_source = resolve_language(
            result.get("language"),
            args.language,
            str(result.get("text") or ""),
        )
        split_mode = split_mode_for_text(str(result.get("text") or ""), language)
        json_data: dict[str, Any] = {
            "media": str(input_path),
            "language": language,
            "language_source": language_source,
            "split_mode": split_mode,
            "timestamp_granularity": result.get("timestamp_granularity") or timestamp_granularity_for_items(
                result.get("items") or [], split_mode, has_segments=bool(segments)
            ),
            "model": args.model,
            "segments": segments,
        }
        if cache_result is not None:
            json_data = merge_media_caches(json_data, cache_result)
        json_path = output_path.with_suffix(".mosp")
        write_mosp(
            json_path,
            json_data,
            media_path=input_path,
            ffprobe_path=ffmpeg_tools.ffprobe,
        )
        print(f"工程文件已保存到: {json_path}")
        if not args.no_html:
            edit_script = Path(__file__).parent / "edit.py"
            if edit_script.exists():
                command = [sys.executable, str(edit_script), str(json_path)]
                if args.stickers and Path(args.stickers).exists():
                    command.extend(["-s", args.stickers])
                subprocess.run(command, check=True)

    elapsed = time.perf_counter() - started
    speed = duration / elapsed if elapsed > 0 and duration > 0 else 0
    print(f"处理用时: {int(elapsed // 60)}分{int(elapsed % 60)}秒 ({speed:.1f}x 实时)")


if __name__ == "__main__":
    main()
