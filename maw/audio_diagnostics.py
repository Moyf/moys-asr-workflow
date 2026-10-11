"""Launcher empty-ASR errors using existing track metadata only.

Never decode audio, probe media again, infer silence, or submit another ASR request.
"""

from __future__ import annotations

import re


class AudioInputError(RuntimeError):
    """A friendly Launcher error preserving the original empty-result details."""

    def __init__(self, code: str, detail: str) -> None:
        self.code = code
        super().__init__(detail)


def is_empty_transcription_error(output: list[str]) -> bool:
    """Only explicit final empty-ASR failures, never earlier retry warnings."""
    final = "\n".join(output[-40:])
    failures = list(re.finditer(r"^(?:[\w.]+(?:Error|Exception):|错误[:：])", final, re.MULTILINE))
    if failures:
        final = final[failures[-1].start():]
    return final.startswith((
        "RuntimeError: ASR 返回内容为空，未生成字幕段。",
        "错误: 本地模型没有返回可用的转写文本",
        "错误: 未识别到任何内容",
    ))


def empty_transcription_error(
    audio_track_count: int | None, *, audio_track: int = 0,
    detail: str = "ASR returned no usable subtitle text.",
) -> AudioInputError:
    multiple = isinstance(audio_track_count, int) and not isinstance(audio_track_count, bool) and audio_track_count > 1
    code = "asr_empty_result_multitrack" if multiple else "asr_empty_result"
    return AudioInputError(code, detail + f"\n[audio tracks] known_count={audio_track_count}, selected audio_index={audio_track} (zero-based)")
