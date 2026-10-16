"""Bounded key-packet diagnostics, without another demux or decode pass.

Only verified AVC/HEVC IDR access units are accepted as independent entries.
The caller must still prove presentation/decode boundary closure. Unknown is
not evidence that a codec or container is unsupported by the export product.
"""
from __future__ import annotations

import os
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import BinaryIO


@dataclass(frozen=True)
class KeyframeLimits:
    max_point_bytes: int = 65_536
    max_total_bytes: int = 8_388_608
    max_points: int = 1024
    max_nals: int = 128
    max_sei_bytes: int = 4096
    max_container_elements: int = 256
    max_active_seconds: float = 0.25


@dataclass(frozen=True)
class KeyframeResult:
    kind: str
    safe: bool | None
    reason: str
    nal_types: tuple[int, ...] = ()
    recovery_frame_count: int | None = None


class _Unknown(Exception):
    pass


def _integer(value: object) -> int:
    if isinstance(value, bool):
        raise ValueError("boolean packet location")
    result = int(value)  # ffprobe compact records contain strings.
    if str(result) != str(value) or result < 0:
        raise ValueError("invalid packet location")
    return result


def _vint(data: bytes, offset: int = 0) -> tuple[int, int]:
    if offset >= len(data) or not data[offset]:
        raise _Unknown("invalid_packet_layout")
    length = 9 - data[offset].bit_length()
    if offset + length > len(data):
        raise _Unknown("invalid_packet_layout")
    value = data[offset] & ((1 << (8 - length)) - 1)
    for byte in data[offset + 1:offset + length]:
        value = (value << 8) | byte
    if value == (1 << (7 * length)) - 1:
        raise _Unknown("invalid_packet_layout")
    return value, length


def _rbsp(data: bytes) -> bytes:
    return data.replace(b"\x00\x00\x03", b"\x00\x00")


def _ue(data: bytes) -> int:
    bits = "".join(f"{byte:08b}" for byte in _rbsp(data))
    zeroes = bits.find("1")
    if zeroes < 0 or zeroes > 31 or len(bits) < zeroes * 2 + 1:
        raise _Unknown("invalid_packet_layout")
    return (1 << zeroes) - 1 + int(bits[zeroes + 1:zeroes * 2 + 1] or "0", 2)


def _recovery(data: bytes) -> int | None:
    """SEI framing and recovery count only; never decode slice references."""
    data = _rbsp(data)
    position = 0
    while position < len(data) and data[position:] != b"\x80":
        values = []
        for _ in range(2):
            value = 0
            while position < len(data) and data[position] == 255:
                value += 255
                position += 1
            if position >= len(data):
                raise _Unknown("invalid_packet_layout")
            values.append(value + data[position])
            position += 1
        kind, length = values
        if position + length > len(data):
            raise _Unknown("invalid_packet_layout")
        if kind == 6:
            return _ue(data[position:position + length])
        position += length
    return None


class KeyframeInspector:
    """One read-only handle and a bounded per-task candidate cache.

    Active-time limits exclude caller scan/planning time. Checks between reads
    cannot interrupt a blocked OS read. Cancellation exceptions propagate.
    """

    def __init__(self, path: Path, *, container_name: str,
                 limits: KeyframeLimits | None = None,
                 check_cancelled: Callable[[], None] = lambda: None):
        self.path = Path(path)
        self.container_name = container_name
        self.limits = limits or KeyframeLimits()
        self.check_cancelled = check_cancelled
        self._file: BinaryIO | None = None
        self._file_size = 0
        self._cache: dict[tuple, KeyframeResult] = {}
        self._bytes = self._points = self._cache_hits = 0
        self._read_calls = 0
        self._elapsed = 0.0
        self._point_start = 0.0
        self._point_bytes = 0
        self._budget_exceeded = self._exhausted = False
        self._closed = False
        self._tracks: dict[int, tuple[str, bool]] | None = None
        self._tracks_error: str | None = None
        self._elements = 0

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

    def close(self):
        if self._file is not None:
            self._file.close()
            self._file = None
        self._closed = True

    @property
    def stats(self) -> dict[str, int | float | bool]:
        return {"bytes_read": self._bytes, "points": self._points,
                "cache_hits": self._cache_hits, "elapsed_ms": round(self._elapsed * 1000, 3),
                "read_calls": self._read_calls,
                "budget_exceeded": self._budget_exceeded, "exhausted": self._exhausted}

    def _check(self):
        self.check_cancelled()
        if self._elapsed + time.monotonic() - self._point_start >= self.limits.max_active_seconds:
            self._budget_exceeded = self._exhausted = True
            raise _Unknown("budget_exhausted")

    def _read(self, offset: int, length: int) -> bytes:
        self._check()
        if offset < 0 or length < 0 or offset + length > self._file_size:
            raise _Unknown("invalid_packet_layout")
        if self._bytes + length > self.limits.max_total_bytes:
            self._budget_exceeded = self._exhausted = True
            raise _Unknown("budget_exhausted")
        if self._point_bytes + length > self.limits.max_point_bytes:
            self._budget_exceeded = True
            raise _Unknown("point_budget_exhausted")
        assert self._file is not None
        self._read_calls += 1
        try:
            self._file.seek(offset)
            data = self._file.read(length)
        except OSError as error:
            raise _Unknown("read_error") from error
        self._bytes += len(data)
        self._point_bytes += len(data)
        self._check()
        if len(data) != length:
            raise _Unknown("invalid_packet_layout")
        return data

    def classify(self, *, stream_index: int, codec_name: str, pos: object,
                 size: object, nal_length_size: object = None) -> KeyframeResult:
        self.check_cancelled()
        codec = str(codec_name).lower()
        try:
            position, length = _integer(pos), _integer(size)
            width = None if nal_length_size in (None, "", "N/A", 0, "0") else _integer(nal_length_size)
            if not length or width is not None and width not in (1, 2, 3, 4):
                raise ValueError("invalid packet size or NAL length")
        except (ValueError, TypeError, OverflowError):
            return KeyframeResult("unknown", None, "invalid_packet_metadata")
        key = (stream_index, codec, position, length, width)
        if key in self._cache:
            self._cache_hits += 1
            return self._cache[key]
        if self._closed:
            return KeyframeResult("unknown", None, "closed")
        if self._exhausted or self._points >= self.limits.max_points:
            self._budget_exceeded = self._exhausted = True
            return KeyframeResult("unknown", None, "budget_exhausted")
        self._points += 1
        self._point_bytes = 0
        self._point_start = time.monotonic()
        try:
            self._check()
            if codec not in {"h264", "hevc"}:
                raise _Unknown("unsupported_codec")
            if self._file is None:
                try:
                    self._file = self.path.open("rb")
                    self._file_size = os.fstat(self._file.fileno()).st_size
                except OSError as error:
                    raise _Unknown("read_error") from error
            names = set(self.container_name.split(","))
            if names & {"mov", "mp4", "m4a", "3gp", "3g2", "mj2"}:
                start = position
            elif names & {"matroska", "webm"}:
                start = self._matroska(position, length, codec)
            elif "mpegts" in names:
                data = self._transport(position, length)
                result = self._annexb(data, codec)
                self._cache[key] = result
                return result
            else:
                raise _Unknown("unsupported_container")
            if start + length > self._file_size:
                raise _Unknown("invalid_packet_layout")
            choices = []
            for candidate in (width,) if width else (1, 2, 3, 4):
                try:
                    choices.append(self._length_prefixed(start, length, candidate, codec))
                except _Unknown as error:
                    if str(error) not in {"invalid_packet_layout"}:
                        raise
            if not choices:
                raise _Unknown("invalid_packet_layout")
            if len(choices) != 1:
                raise _Unknown("ambiguous_nal_length")
            result = choices[0]
        except _Unknown as error:
            result = KeyframeResult("unknown", None, str(error))
        finally:
            self._elapsed += time.monotonic() - self._point_start
        self._cache[key] = result
        return result

    def _element(self, position: int, end: int) -> tuple[int, int, int | None]:
        self._elements += 1
        if self._elements > self.limits.max_container_elements:
            self._budget_exceeded = True
            raise _Unknown("container_element_limit")
        header = self._read(position, min(12, end - position))
        if not header or not header[0]:
            raise _Unknown("invalid_packet_layout")
        id_size = 9 - header[0].bit_length()
        if id_size > 4 or id_size >= len(header) or not header[id_size]:
            raise _Unknown("invalid_packet_layout")
        element_id = int.from_bytes(header[:id_size], "big")
        size_size = 9 - header[id_size].bit_length()
        if id_size + size_size > len(header):
            raise _Unknown("invalid_packet_layout")
        raw_size = int.from_bytes(header[id_size:id_size + size_size], "big")
        size = raw_size & ((1 << (size_size * 7)) - 1)
        start = position + id_size + size_size
        element_end = None if size == (1 << (size_size * 7)) - 1 else start + size
        if element_end is not None and element_end > end:
            raise _Unknown("invalid_packet_layout")
        return element_id, start, element_end

    def _children(self, start: int, end: int):
        while start < end:
            kind, payload, next_position = self._element(start, end)
            if next_position is None:
                raise _Unknown("payload_position_unverified")
            yield kind, payload, next_position
            start = next_position

    def _read_tracks(self) -> dict[int, tuple[str, bool]]:
        kind, _start, end = self._element(0, self._file_size)
        if kind != 0x1A45DFA3 or end is None:
            raise _Unknown("payload_position_unverified")
        while end < self._file_size:
            kind, start, next_position = self._element(end, self._file_size)
            if kind == 0x18538067:
                break
            if kind != 0xEC or next_position is None:
                raise _Unknown("payload_position_unverified")
            end = next_position
        else:
            raise _Unknown("payload_position_unverified")
        segment_end = next_position or self._file_size
        for kind, start, end in self._children(start, segment_end):
            if kind == 0x1F43B675:  # Do not scan any Cluster/media to find metadata.
                break
            if kind != 0x1654AE6B:
                continue
            tracks = {}
            for kind, entry_start, entry_end in self._children(start, end):
                if kind != 0xAE:
                    continue
                number, codec, transformed = None, "", False
                for field, value_start, value_end in self._children(entry_start, entry_end):
                    length = value_end - value_start
                    if field == 0xD7 and 0 < length <= 8:
                        number = int.from_bytes(self._read(value_start, length), "big")
                    elif field == 0x86 and length <= 64:
                        codec = self._read(value_start, length).decode("ascii", errors="replace")
                    elif field == 0x6D80:
                        transformed = True  # Compression, header stripping or encryption.
                if number is not None:
                    if number in tracks:
                        raise _Unknown("invalid_packet_layout")
                    tracks[number] = (codec, transformed)
            return tracks
        raise _Unknown("payload_position_unverified")

    def _matroska(self, position: int, size: int, codec: str) -> int:
        header = self._read(position, min(11, self._file_size - position))
        track, count = _vint(header)
        if not track or count + 3 > len(header):
            raise _Unknown("invalid_packet_layout")
        if header[count + 2] & 6:
            raise _Unknown("unsupported_lacing")
        before = self._read(max(0, position - 9), min(9, position))
        verified = False
        for offset in range(len(before)):
            if before[offset] not in (0xA1, 0xA3):
                continue
            try:
                block_size, vint_size = _vint(before, offset + 1)
                if offset + 1 + vint_size == len(before) and block_size == size + count + 3:
                    verified = True
            except _Unknown:
                continue
        if not verified:
            raise _Unknown("payload_position_unverified")
        if self._tracks_error:
            raise _Unknown(self._tracks_error)
        if self._tracks is None:
            try:
                self._tracks = self._read_tracks()
            except _Unknown as error:
                self._tracks_error = str(error)
                raise
        track_codec, transformed = self._tracks.get(track, ("", False))
        if transformed:
            raise _Unknown("unsupported_packet_transform")
        if track_codec != {"h264": "V_MPEG4/ISO/AVC", "hevc": "V_MPEGH/ISO/HEVC"}[codec]:
            raise _Unknown("payload_position_unverified")
        return position + count + 3

    def _transport(self, position: int, size: int) -> bytes:
        """Only an entire unencrypted, single-PES AU at a TS188 boundary."""
        if size > self.limits.max_point_bytes:
            self._budget_exceeded = True
            raise _Unknown("point_budget_exhausted")
        data = bytearray()
        pid = None
        expected_counter = None
        declared = None
        cursor = position
        while cursor + 188 <= self._file_size:
            packet = self._read(cursor, 188)
            cursor += 188
            if packet[0] != 0x47 or packet[1] & 0x80 or packet[3] & 0xC0:
                raise _Unknown("invalid_packet_layout")
            packet_pid = ((packet[1] & 31) << 8) | packet[2]
            if pid is not None and packet_pid != pid:
                continue
            control = (packet[3] >> 4) & 3
            if not control:
                raise _Unknown("invalid_packet_layout")
            offset = 4
            if control & 2:
                offset += 1 + packet[4]
            if offset > 188:
                raise _Unknown("invalid_packet_layout")
            if not control & 1 or offset == 188:
                if pid is None:
                    raise _Unknown("payload_position_unverified")
                continue
            if pid is not None and packet[1] & 0x40:
                break
            counter = packet[3] & 15
            if expected_counter is not None and counter != expected_counter:
                raise _Unknown("invalid_packet_layout")
            expected_counter = (counter + 1) & 15
            payload = packet[offset:]
            if pid is None:
                if not packet[1] & 0x40 or len(payload) < 9 or payload[:3] != b"\0\0\1" or not 0xE0 <= payload[3] <= 0xEF:
                    raise _Unknown("payload_position_unverified")
                if payload[6] & 0xC0 != 0x80:
                    raise _Unknown("invalid_packet_layout")
                header_size = 9 + payload[8]
                if header_size > len(payload):
                    raise _Unknown("invalid_packet_layout")
                pes_length = int.from_bytes(payload[4:6], "big")
                declared = pes_length - (header_size - 6) if pes_length else None
                if declared is not None and declared != size:
                    raise _Unknown("payload_position_unverified")
                pid = packet_pid
                payload = payload[header_size:]
            data.extend(payload)
            if len(data) > size:
                raise _Unknown("payload_position_unverified")
            if declared is not None and len(data) == declared:
                return bytes(data)
        if len(data) != size:
            raise _Unknown("payload_position_unverified")
        return bytes(data)

    def _length_prefixed(self, start: int, size: int, width: int, codec: str) -> KeyframeResult:
        end = start + size
        nals = []
        while start < end:
            if len(nals) >= self.limits.max_nals:
                self._budget_exceeded = True
                raise _Unknown("nal_limit")
            if start + width > end:
                raise _Unknown("invalid_packet_layout")
            length = int.from_bytes(self._read(start, width), "big")
            start += width
            if not length or start + length > end:
                raise _Unknown("invalid_packet_layout")
            header = self._read(start, min(length, 9))
            sei = self._read(start + 1, length - 1) if codec == "h264" and header[0] & 31 == 6 and length <= self.limits.max_sei_bytes else None
            nals.append((header, sei))
            start += length
        return self._classify_nals(nals, codec)

    def _annexb(self, data: bytes, codec: str) -> KeyframeResult:
        nals = []
        starts = []
        position = 0
        while position < len(data) - 2:
            self._check()
            position = data.find(b"\0\0\1", position)
            if position < 0:
                break
            starts.append(position + 3)
            if len(starts) > self.limits.max_nals:
                self._budget_exceeded = True
                raise _Unknown("nal_limit")
            position += 3
        if not starts or any(data[:starts[0] - 3]):
            raise _Unknown("invalid_packet_layout")
        for index, start in enumerate(starts):
            end = starts[index + 1] - 3 if index + 1 < len(starts) else len(data)
            nal = data[start:end].rstrip(b"\0")
            if not nal:
                raise _Unknown("invalid_packet_layout")
            nals.append((nal[:9], nal[1:] if codec == "h264" and nal[0] & 31 == 6 and len(nal) <= self.limits.max_sei_bytes else None))
        return self._classify_nals(nals, codec)

    def _classify_nals(self, nals: list[tuple[bytes, bytes | None]], codec: str) -> KeyframeResult:
        kinds = []
        first_vcl = None
        recovery = None
        for header, sei in nals:
            self._check()
            if not header or header[0] & 128:
                raise _Unknown("invalid_packet_layout")
            if codec == "h264":
                kind = header[0] & 31
                if kind not in {1, 5, 6, 7, 8, 9, 10, 11, 12}:
                    raise _Unknown("invalid_packet_layout")
                is_vcl = kind in (1, 5)
                first_slice = _ue(header[1:]) == 0 if is_vcl else False
                if kind == 5 and not header[0] & 0x60:
                    raise _Unknown("invalid_packet_layout")
                if sei is not None:
                    found = _recovery(sei)
                    if recovery is not None and found is not None and found != recovery:
                        raise _Unknown("invalid_packet_layout")
                    if found is not None:
                        recovery = found
            else:
                if len(header) < 2 or not header[1] & 7 or (header[0] & 1) or header[1] >> 3:
                    raise _Unknown("invalid_packet_layout")
                kind = (header[0] >> 1) & 63
                is_vcl = kind <= 31
                if is_vcl and len(header) < 3:
                    raise _Unknown("invalid_packet_layout")
                first_slice = bool(header[2] & 128) if is_vcl else False
            kinds.append(kind)
            if first_vcl is not None and kind == (9 if codec == "h264" else 35):
                raise _Unknown("invalid_packet_layout")
            if is_vcl:
                if first_vcl is None:
                    if not first_slice:
                        raise _Unknown("invalid_packet_layout")
                    first_vcl = kind
                elif first_slice or kind != first_vcl:
                    raise _Unknown("invalid_packet_layout")
        types = tuple(kinds)
        if codec == "h264":
            if first_vcl == 5:
                return KeyframeResult("h264_idr", True, "idr", types)
            if first_vcl == 1:
                kind = "h264_recovery" if recovery is not None else "h264_non_idr"
                return KeyframeResult(kind, False, kind, types, recovery)
        else:
            if first_vcl in (19, 20):
                return KeyframeResult("hevc_idr", True, "idr", types)
            if first_vcl == 21:
                return KeyframeResult("hevc_cra", False, "hevc_cra", types)
            if first_vcl is not None:
                return KeyframeResult("hevc_non_idr", False, "hevc_non_idr", types)
        raise _Unknown("invalid_packet_layout")
