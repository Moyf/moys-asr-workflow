"""Shareable burn diagnostics. Never copy arbitrary FFmpeg input into a report."""
from __future__ import annotations

import errno
import re


# Match only the diagnostic phrase, not the whole line: FFmpeg can echo paths,
# filter arguments and malformed subtitle events in the same stderr stream.
_FFMPEG_REASON = re.compile(
    r"permission denied|access is denied|"
    r"read-only file system|input/output error|no such file or directory|"
    r"invalid data found when processing input|moov atom not found|"
    r"error (?:while )?(?:decoding|opening (?:input|output|encoder|decoder)|"
    r"initializing (?:output stream|filter|encoder)|submitting (?:a packet|a frame)|"
    r"reinitializing filters|writing (?:header|trailer)|muxing a packet)|"
    r"no (?:capable devices|device available|decoder found|such filter)|"
    r"cannot load (?:nvcuda\.dll|libcuda\.so(?:\.1)?)|"
    r"out of memory|cannot allocate memory|"
    r"(?:width|height) not divisible by [0-9]{1,4}|"
    r"unsupported (?:pixel format|codec|device)|"
    r"unrecognized option '/filter_complex'|"
    r"failed to (?:inject frame into filter network|configure output pad|initialize encoder)",
    re.IGNORECASE,
)
_FFMPEG_DISK_FULL = re.compile(r"(?:^|:\s+)(no space left on device|disk quota exceeded)\s*$", re.IGNORECASE)
_FFMPEG_FILE_PERMISSION = re.compile(
    r"^(?:\[[^\]]+\]\s*)?error (?:opening (?:input|output)(?! stream)|"
    r"writing (?:header|trailer)|muxing a packet)\b.*:\s*"
    r"(?:permission denied|access is denied|read-only file system)\s*$",
    re.IGNORECASE,
)
_FFMPEG_INVALID_MEDIA = re.compile(
    r"^(?:\[[^\]]+\]\s*)?(?:moov atom not found|"
    r"error opening input(?: file(?:s)?)?\b.*:\s*invalid data found when processing input)\s*$",
    re.IGNORECASE,
)
_SUBTITLE_LINE = re.compile(r"^\s*(?:Dialogue:|Comment:|Event:|\[(?:Parsed_ass|Parsed_subtitles|libass)(?:_|\b))", re.IGNORECASE)
_FFMPEG_VERSION = re.compile(r"^ffmpeg version ([0-9A-Za-z][0-9A-Za-z.+_~-]{0,95})(?=\s|$)")


def ffmpeg_version(stdout: str) -> str | None:
    match = _FFMPEG_VERSION.match(stdout)
    return match[1] if match else None


def ffmpeg_diagnostic(stderr: str) -> dict:
    disk_reasons = []
    other_reasons = []
    for line in stderr.splitlines():
        if _SUBTITLE_LINE.match(line):
            continue
        if match := _FFMPEG_DISK_FULL.search(line):
            disk_reasons.append(match[1].lower())
        other_reasons.extend(match[0].lower() for match in _FFMPEG_REASON.finditer(line))
    reasons = list(dict.fromkeys(disk_reasons + other_reasons))
    return {"stderrPresent": bool(stderr.strip()), "reasons": reasons[:8]}


def ffmpeg_failure_kind(stderr: str) -> str | None:
    """Classify failures with an explicit cause that changing encoders cannot fix."""
    lines = [line.strip() for line in stderr.splitlines() if not _SUBTITLE_LINE.match(line)]
    if any(_FFMPEG_DISK_FULL.search(line) for line in lines):
        return "disk-full"
    if any(_FFMPEG_FILE_PERMISSION.match(line) for line in lines):
        return "permission"
    # An isolated decode warning can be recoverable. Require an input-open
    # failure or an invalid container before ruling out a different encoder.
    if any(_FFMPEG_INVALID_MEDIA.match(line) for line in lines):
        return "media-decode"
    return None


def burn_error_kind(error: BaseException | None) -> str | None:
    if isinstance(error, OSError):
        if error.errno in (errno.ENOSPC, getattr(errno, "EDQUOT", -1)) or getattr(error, "winerror", None) in (39, 112):
            return "disk-full"
        if isinstance(error, PermissionError) or error.errno == errno.EROFS:
            return "permission"
    return None
