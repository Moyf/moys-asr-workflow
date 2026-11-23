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


def burn_error_kind(error: Exception) -> str | None:
    if isinstance(error, OSError):
        if error.errno in (errno.ENOSPC, getattr(errno, "EDQUOT", -1)) or getattr(error, "winerror", None) in (39, 112):
            return "disk-full"
        if isinstance(error, PermissionError) or error.errno == errno.EROFS:
            return "permission"
    return None
