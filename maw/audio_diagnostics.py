"""Launcher empty-ASR errors using existing track metadata only.

Never decode audio, probe media again, infer silence, or submit another ASR request.
"""

from __future__ import annotations

import ast
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


def is_audio_extraction_failure(output: list[str] | tuple[str, ...]) -> bool:
    """Recognize the final FFmpeg audio extraction failure without probing.

    A failed mapped extraction cannot establish whether all audio is absent,
    the chosen track is absent, or decoding failed. It only justifies a hint.
    """
    final = "\n".join(output[-40:])
    failures = list(re.finditer(r"^(?:[\w.]+(?:Error|Exception):|错误[:：])", final, re.MULTILINE))
    if failures:
        final = final[failures[-1].start():]
    first = final.splitlines()[0] if final else ""
    match = re.fullmatch(
        r"(?:subprocess\.)?CalledProcessError: Command '(\[.*\])' returned non-zero exit status \d+\.", first,
    )
    if match:
        try:
            command = ast.literal_eval(match.group(1))
        except (ValueError, SyntaxError):
            return False
        if not isinstance(command, list) or not command or not all(isinstance(arg, str) for arg in command):
            return False
        executable = command[0].replace("\\", "/").rsplit("/", 1)[-1].casefold()
        return executable in {"ffmpeg", "ffmpeg.exe"} and "-vn" in command and any(
            arg == "-map" and re.fullmatch(r"0:a:\d+", value)
            for arg, value in zip(command, command[1:])
        )
    # Some engines forward FFmpeg stderr directly rather than a traceback.
    last = next((line for line in reversed(final.splitlines()) if line.strip()), "")
    return not failures and bool(re.fullmatch(
        r"Stream map ['\"]0:a:\d+['\"] matches no streams\.", last,
    ))
