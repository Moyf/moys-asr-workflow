"""Generate subtitles from a known script and audio, without recognition.

Silence is an acoustic boundary, not evidence of which words were spoken.
Automatic long-audio mapping therefore requires one speech span per script
line; ambiguous recordings need explicit line-group anchors or an ASR workflow.
"""

from __future__ import annotations

import json
import math
import re
import subprocess
import tempfile
import unicodedata
import wave
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Any

from maw.alignment_models import QWEN_FORCED_ALIGNER_MODEL_ID, alignment_model_by_id
from maw.ffmpeg import resolve_ffmpeg_tool
from maw.language import normalize_language_code, split_mode_for_text
from maw.postprocess_io import SubtitleArtifact, write_artifacts
from maw.project_io import enrich_project_media_metadata
from maw.timestamp_alignment import (
    AlignmentBackend,
    QwenForcedAlignerBackend,
    TimedToken,
    TimestampAlignmentError,
    _check_cancel,
    _extract_audio_span,
)


MAX_SCRIPT_ALIGNMENT_MS = 300_000
SCRIPT_ALIGNMENT_WARNINGS = (
    "文稿为字幕真值；未使用 ASR。口误、额外语句和重复可能被忽略，时间码不能证明录音与文稿一致，请听审。",
)


@dataclass(frozen=True, slots=True)
class ScriptAlignmentRequest:
    script_path: Path
    media_path: Path
    model_path: Path | None = None
    model_cache_root: Path | None = None
    device: str = "auto"
    language: str = "zh"
    audio_track: int | None = None
    silence_db: float = -35.0
    silence_ms: int = 500
    anchors_path: Path | None = None
    output_directory: Path | None = None


@dataclass(frozen=True, slots=True)
class ScriptAnchor:
    """Zero-based half-open line range with absolute millisecond bounds."""

    first_line: int
    end_line: int
    start: int
    end: int


@dataclass(frozen=True, slots=True)
class ScriptAlignmentReport:
    strategy: str
    duration_ms: int
    chunks: int
    lines: int
    warnings: tuple[str, ...]
    audio_track: int = 0
    anchors: tuple[ScriptAnchor, ...] = ()

    def to_payload(self) -> dict[str, object]:
        return {
            "strategy": self.strategy, "durationMs": self.duration_ms,
            "chunks": self.chunks, "scriptLines": self.lines,
            "audioTrack": self.audio_track,
            "anchors": [
                {"first_line": anchor.first_line + 1, "last_line": anchor.end_line,
                 "start": anchor.start, "end": anchor.end}
                for anchor in self.anchors
            ],
            "warnings": list(self.warnings),
        }


def read_script_lines(path: Path) -> list[str]:
    if path.suffix.lower() not in {".txt", ".md", ".markdown"}:
        raise TimestampAlignmentError("文稿必须是 UTF-8 .txt / .md / .markdown 文件。")
    # Markdown is treated as literal text, just like TXT; no hidden rewriting.
    lines = [line.strip() for line in path.read_text(encoding="utf-8-sig").splitlines() if line.strip()]
    if not lines:
        raise TimestampAlignmentError("文稿没有非空行。")
    for index, line in enumerate(lines, 1):
        if not _key(line):
            raise TimestampAlignmentError(f"文稿第 {index} 个非空行没有可对齐的文字。")
    return lines


def _key(text: str) -> str:
    # Compose first: Qwen keeps letters/numbers but drops standalone marks.
    return "".join(
        char for char in unicodedata.normalize("NFKC", text).casefold()
        if unicodedata.category(char)[0] in {"L", "N"}
    )


def _lexical_positions(text: str) -> list[int]:
    """Map normalized lexical units to the end of their original cluster.

    Combining marks and composing Hangul jamo stay with their base, so an
    item boundary never separates an accent from its letter. No dependency
    on the model's tokenizer and no rewrite of the subtitle text.
    """
    clusters: list[tuple[str, int]] = []
    for index, char in enumerate(text):
        if clusters and (unicodedata.category(char).startswith("M") or
                unicodedata.normalize("NFC", clusters[-1][0] + char) !=
                unicodedata.normalize("NFC", clusters[-1][0]) + unicodedata.normalize("NFC", char)):
            clusters[-1] = (clusters[-1][0] + char, index + 1)
        else:
            clusters.append((char, index + 1))
    positions = [end for cluster, end in clusters for _ in _key(cluster)]
    if "".join(_key(cluster) for cluster, _ in clusters) != _key(text):
        raise TimestampAlignmentError("文稿含无法映射的组合编码，请先规范化为 NFC UTF-8。")
    return positions


def speech_ranges(log: str, duration_ms: int) -> list[tuple[int, int]]:
    """Parse FFmpeg silence events, including leading and unfinished silence."""
    cursor = 0
    result: list[tuple[int, int]] = []
    in_silence = False
    for kind, seconds in re.findall(r"silence_(start|end):\s*([\d.eE+-]+)", log):
        value = float(seconds)
        if not math.isfinite(value):
            raise TimestampAlignmentError("FFmpeg 返回了无效的静音时间。")
        point = min(duration_ms, max(0, round(value * 1000)))
        if kind == "start":
            if not in_silence and point > cursor:
                result.append((cursor, point))
            in_silence = True
        else:
            cursor = max(cursor, point)
            in_silence = False
    if not in_silence and cursor < duration_ms:
        result.append((cursor, duration_ms))
    return result


def plan_script_anchors(
    lines: list[str], duration_ms: int, spans: list[tuple[int, int]],
    explicit: list[ScriptAnchor] | None = None,
) -> tuple[str, list[ScriptAnchor]]:
    if duration_ms <= 0:
        raise TimestampAlignmentError("录音为空，请检查音轨。")
    if explicit is not None:
        validate_anchors(explicit, len(lines), duration_ms)
        return "manual_anchors", explicit
    if duration_ms <= MAX_SCRIPT_ALIGNMENT_MS:
        return "single", [ScriptAnchor(0, len(lines), 0, duration_ms)]
    if not spans:
        raise TimestampAlignmentError("长录音没有可检测的语音区间，请降低静音阈值或提供人工锚点。")
    if len(spans) != len(lines):
        raise TimestampAlignmentError(
            f"长录音有 {len(spans)} 个语音区间，文稿有 {len(lines)} 个非空行，无法可靠映射。"
            "请调整静音阈值 / 最短停顿，或提供人工锚点 JSON；跳行、重复与口误请先整理录音，"
            "也可使用 ASR 后的口播对齐。不按字数比例猜测时间。"
        )
    anchors = [ScriptAnchor(index, index + 1, start, end) for index, (start, end) in enumerate(spans)]
    validate_anchors(anchors, len(lines), duration_ms)
    # Merge consecutive lines only inside the model's limit. Cuts stay at silence.
    grouped: list[ScriptAnchor] = []
    for anchor in anchors:
        if grouped and anchor.end - grouped[-1].start <= MAX_SCRIPT_ALIGNMENT_MS:
            previous = grouped[-1]
            grouped[-1] = ScriptAnchor(previous.first_line, anchor.end_line, previous.start, anchor.end)
        else:
            grouped.append(anchor)
    return "silence_anchors", grouped


def validate_anchors(anchors: list[ScriptAnchor], line_count: int, duration_ms: int) -> None:
    next_line = 0
    previous_end = 0
    for anchor in anchors:
        if any(type(value) is not int for value in (
            anchor.first_line, anchor.end_line, anchor.start, anchor.end,
        )):
            raise TimestampAlignmentError("锚点的行号与时间必须是整数。")
        if (anchor.first_line != next_line or not next_line < anchor.end_line <= line_count
                or not previous_end <= anchor.start < anchor.end <= duration_ms):
            raise TimestampAlignmentError("锚点必须按顺序覆盖所有非空文稿行一次，且时间范围有效、不重叠。")
        if anchor.end - anchor.start > MAX_SCRIPT_ALIGNMENT_MS:
            raise TimestampAlignmentError(f"第 {anchor.first_line + 1} 行所在语音块超过 300 秒，请在真实停顿处分块。")
        next_line = anchor.end_line
        previous_end = anchor.end
    if next_line != line_count:
        raise TimestampAlignmentError("人工锚点未完整覆盖文稿。")


def read_anchors(path: Path) -> list[ScriptAnchor]:
    raw = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(raw, list) or not raw:
        raise TimestampAlignmentError("人工锚点 JSON 必须是非空数组。")
    anchors = []
    for entry in raw:
        if not isinstance(entry, dict) or any(type(entry.get(key)) is not int for key in (
            "first_line", "last_line", "start", "end",
        )):
            raise TimestampAlignmentError("每个锚点需整数 first_line、last_line（非空行，从 1 开始）、start、end（毫秒）。")
        anchors.append(ScriptAnchor(entry["first_line"] - 1, entry["last_line"], entry["start"], entry["end"]))
    return anchors


def tokens_to_script_segments(
    lines: list[str], tokens: list[TimedToken], start: int, end: int,
) -> list[dict[str, Any]]:
    """Restore exact punctuation/spacing; never fill missing spoken tokens."""
    expected = "".join(_key(line) for line in lines)
    lexical_tokens = [(token, _key(token.text)) for token in tokens if _key(token.text)]
    if not lexical_tokens or "".join(key for _, key in lexical_tokens) != expected:
        raise TimestampAlignmentError("模型返回文字未完整覆盖文稿；请检查语言、文稿与录音，不输出插值补齐的工程。")
    previous = 0
    offsets = []
    cursor = 0
    for token, key in lexical_tokens:
        if (type(token.start) is not int or type(token.end) is not int
                or not previous <= token.start < token.end <= end - start):
            raise TimestampAlignmentError("模型返回零时长、倒序、重叠或超出音频范围的时间码；请复核录音与锚点。")
        offsets.append((cursor, cursor + len(key), token))
        cursor += len(key)
        previous = token.end
    segments = []
    line_offset = 0
    for line in lines:
        positions = _lexical_positions(line)
        line_end = line_offset + len(positions)
        items = []
        raw_cursor = 0
        for token_start, token_end, token in offsets:
            left, right = max(line_offset, token_start), min(line_end, token_end)
            if left >= right:
                continue
            raw_end = positions[right - line_offset - 1]
            if raw_end <= raw_cursor:
                raise TimestampAlignmentError("模型 token 切在单个规范化字符内部，请将文稿中的合字展开后重试。")
            item_start = start + token.start + round((token.end - token.start) * (left - token_start) / (token_end - token_start))
            item_end = start + token.start + round((token.end - token.start) * (right - token_start) / (token_end - token_start))
            if item_end <= item_start:
                raise TimestampAlignmentError("跨行 token 的时间范围不足，请调整文稿换行。")
            items.append({"text": line[raw_cursor:raw_end], "start": item_start, "end": item_end})
            raw_cursor = raw_end
        items[-1]["text"] += line[raw_cursor:]
        if "".join(item["text"] for item in items) != line:
            raise TimestampAlignmentError("文稿文字无法完整还原，请检查字符编码。")
        segments.append({"text": line, "start": items[0]["start"], "end": items[-1]["end"], "items": items})
        line_offset = line_end
    return segments


def _run_ffmpeg(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(command, capture_output=True, text=True, encoding="utf-8", errors="replace", check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        detail = error.stderr[-800:] if isinstance(error, subprocess.CalledProcessError) else str(error)
        raise TimestampAlignmentError(f"FFmpeg 文稿对齐音频处理失败：{detail}") from error


@dataclass(frozen=True, slots=True)
class _PreparedAlignment:
    media: Path
    audio: Path
    lines: list[str]
    language: str
    audio_track: int
    duration: int
    strategy: str
    anchors: list[ScriptAnchor]
    spans: list[tuple[int, int]]
    ffmpeg: Path

    def report(self) -> ScriptAlignmentReport:
        return ScriptAlignmentReport(
            self.strategy, self.duration, len(self.anchors), len(self.lines),
            SCRIPT_ALIGNMENT_WARNINGS, self.audio_track, tuple(self.anchors),
        )


@contextmanager
def _prepare_script_alignment(
    request: ScriptAlignmentRequest, *, ffmpeg_path: str | Path | None = None,
    cancel_event: Any = None,
) -> Iterator[_PreparedAlignment]:
    script = request.script_path.expanduser().resolve()
    media = request.media_path.expanduser().resolve()
    if not media.is_file():
        raise TimestampAlignmentError("录音 / 视频文件不存在。")
    lines = read_script_lines(script)
    for line in lines:
        _lexical_positions(line)
    explicit = read_anchors(request.anchors_path) if request.anchors_path else None
    if (not math.isfinite(request.silence_db) or not -100 <= request.silence_db <= -1
            or type(request.silence_ms) is not int or not 80 <= request.silence_ms <= 10_000):
        raise TimestampAlignmentError("静音阈值应为 -100 至 -1 dB，最短停顿应为 80 至 10000 毫秒。")
    if request.audio_track is not None and (type(request.audio_track) is not int or request.audio_track < 0):
        raise TimestampAlignmentError("声音轨道索引必须是非负整数。")
    language = normalize_language_code(request.language)
    if language not in alignment_model_by_id(QWEN_FORCED_ALIGNER_MODEL_ID).languages:
        raise TimestampAlignmentError("请指定对齐模型支持的语言：zh、yue、en、ja、ko、fr、de、es。")
    ffmpeg = resolve_ffmpeg_tool("ffmpeg", ffmpeg_path)
    if ffmpeg is None:
        raise TimestampAlignmentError("找不到 FFmpeg，无法读取文稿对齐音频。")
    from maw.media import resolve_default_audio_track

    audio_track = resolve_default_audio_track(media, request.audio_track)
    _check_cancel(cancel_event)
    with tempfile.TemporaryDirectory(prefix="maw-script-align-") as temporary:
        root = Path(temporary)
        audio = root / "audio.wav"
        _run_ffmpeg([
            str(ffmpeg), "-v", "error", "-i", str(media), "-map", f"0:a:{audio_track}",
            "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", str(audio),
        ])
        with wave.open(str(audio), "rb") as stream:
            duration = round(stream.getnframes() * 1000 / stream.getframerate())
            signal = False
            while data := stream.readframes(65536):
                _check_cancel(cancel_event)
                if any(data):
                    signal = True
                    break
            if not signal:
                raise TimestampAlignmentError("所选音轨为空或波形全零，请检查录音与音轨。")
        _check_cancel(cancel_event)
        spans = []
        if duration > MAX_SCRIPT_ALIGNMENT_MS and request.anchors_path is None:
            detection = _run_ffmpeg([
                str(ffmpeg), "-hide_banner", "-nostats", "-i", str(audio),
                "-af", f"silencedetect=noise={request.silence_db}dB:d={request.silence_ms / 1000}", "-f", "null", "-",
            ])
            spans = speech_ranges(detection.stderr, duration)
        strategy, anchors = plan_script_anchors(
            lines, duration, spans, explicit,
        )
        yield _PreparedAlignment(media, audio, lines, language, audio_track, duration, strategy, anchors, spans, ffmpeg)


def check_script_alignment(
    request: ScriptAlignmentRequest, *, ffmpeg_path: str | Path | None = None,
    cancel_event: Any = None,
) -> ScriptAlignmentReport:
    """Check inputs and acoustic chunk boundaries without a model or outputs.

    Passing this check does not establish that the recording matches the script.
    The execution path prepares again, so changed files are never trusted from
    a stale preview.
    """
    with _prepare_script_alignment(request, ffmpeg_path=ffmpeg_path, cancel_event=cancel_event) as prepared:
        return prepared.report()


def run_script_alignment(
    request: ScriptAlignmentRequest, *, backend: AlignmentBackend | None = None,
    ffmpeg_path: str | Path | None = None, cancel_event: Any = None,
) -> tuple[SubtitleArtifact, ScriptAlignmentReport]:
    with _prepare_script_alignment(request, ffmpeg_path=ffmpeg_path, cancel_event=cancel_event) as prepared:
        media, lines, language, audio_track = prepared.media, prepared.lines, prepared.language, prepared.audio_track
        audio, strategy = prepared.audio, prepared.strategy
        anchors, spans, ffmpeg = prepared.anchors, prepared.spans, prepared.ffmpeg
        root = audio.parent
        aligner = backend or QwenForcedAlignerBackend(
            model_path=request.model_path or "", model_cache_root=request.model_cache_root, device=request.device,
        )
        segments = []
        for index, anchor in enumerate(anchors):
            _check_cancel(cancel_event)
            chunk = audio
            if strategy != "single":
                chunk = root / f"chunk-{index}.wav"
                _extract_audio_span(audio, chunk, anchor.start, anchor.end - anchor.start, ffmpeg_path=ffmpeg)
            chunk_lines = lines[anchor.first_line:anchor.end_line]
            try:
                tokens = aligner.align(chunk, unicodedata.normalize("NFC", "\n".join(chunk_lines)), language=language)
                cues = tokens_to_script_segments(chunk_lines, tokens, anchor.start, anchor.end)
            except TimestampAlignmentError as error:
                raise TimestampAlignmentError(f"文稿第 {anchor.first_line + 1}–{anchor.end_line} 行对齐失败：{error}") from error
            if strategy == "silence_anchors":
                # Every automatic line-to-speech assignment is independently checked.
                for line_index, cue in enumerate(cues, anchor.first_line):
                    speech_start, speech_end = spans[line_index]
                    if cue["start"] < speech_start - 160 or cue["end"] > speech_end + 160:
                        raise TimestampAlignmentError(f"第 {line_index + 1} 行时间码跨越静音锚点，请提供人工锚点或整理录音。")
            segments.extend(cues)
    _check_cancel(cancel_event)
    warnings = SCRIPT_ALIGNMENT_WARNINGS
    script = request.script_path.expanduser().resolve()
    mode = split_mode_for_text("".join(lines))
    project = enrich_project_media_metadata({
        "schema": "moy.asr.project.v1", "media": str(media),
        "language": language, "language_source": "hint", "split_mode": mode,
        "timestamp_granularity": "char" if mode == "continuous" else "word",
        "model": QWEN_FORCED_ALIGNER_MODEL_ID, "segments": segments,
        "preserve_punctuation": True,
        "media_metadata": {"selected_audio_track": audio_track},
    }, media)
    artifact = write_artifacts(
        project, source_project_path=None, source_srt_path=script,
        operation="script-aligned", write_project=True, write_srt=True,
        warnings=warnings, output_directory=request.output_directory, media_path=media,
    )
    return replace(artifact, source_srt_path=None), prepared.report()
