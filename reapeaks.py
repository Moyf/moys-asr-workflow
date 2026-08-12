"""Parser for REAPER .reapeaks files plus spectral (frequency/density) extraction.

Formats supported: RPKM (v1.0), RPKN (v1.1), RPKL (v1.2 float-range).

Spectral peak mipmaps (division factor == -(int)'s') are detected and decoded
into a versioned ``moy.asr.spectral.v1`` payload that the editor overlays on
the waveform. Loudness / spectrogram mipmaps are parsed but not exposed yet.

The spectral payload is a *cache* derived from the media's .ReaPeaks file, so
looking it up must never block the editor: any missing / unreadable /
non-spectral file degrades to ``None``.
"""
from __future__ import annotations

import base64
import os
import shutil
import struct
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

import reapeaks_generate
import waveform as waveform_module

MAGIC_V10 = b"RPKM"  # v1.0: min == -max (mirrored)
MAGIC_V11 = b"RPKN"  # v1.1: explicit min/max
MAGIC_V12 = b"RPKL"  # v1.2: float-range peaks

SPECTRAL_SCHEMA = "moy.asr.spectral.v1"
SPECTRAL_ENCODING = "u16-freq-density-base64"

# REAPER appends one of these to the full media filename (e.g. ICE.wav.ReaPeaks).
REAPEAKS_SUFFIXES = (".ReaPeaks", ".reapeaks", ".REAPEAKS")

DIV_SPECTRAL = -ord("s")  # spectral peaks
DIV_SPECTROGRAM = -ord("g")  # spectrogram
DIV_LOUDNESS = -ord("r")  # loudness (new)
DIV_LOUDNESS_OLD = -ord("l")  # loudness (deprecated)


@dataclass
class Peak:
    """One wave peak sample for a single channel."""

    max: float
    min: float


@dataclass
class MipMap:
    division_factor: int
    peak_count: int
    kind: str  # "wave" | "spectral" | "spectrogram" | "loudness"
    wave: list[list[Peak]] = field(default_factory=list)
    spectral: list[list[tuple[int, int]]] = field(default_factory=list)
    loudness: list[list[tuple[float, float]]] = field(default_factory=list)


def _kind_for(div: int) -> str:
    if div == DIV_SPECTRAL:
        return "spectral"
    if div == DIV_SPECTROGRAM:
        return "spectrogram"
    if div in (DIV_LOUDNESS, DIV_LOUDNESS_OLD):
        return "loudness"
    return "wave"


def _rpk_munge(value: int) -> float:
    """Convert a raw short for RPKL (v1.2 float-range) files."""
    if -24576 <= value <= 24576:
        return value / 24576.0
    if value > 24576:
        return 2.0 ** ((value - 24576) / 1024.0)
    return -(2.0 ** ((-value - 24576) / 1024.0))


class ReaPeaksFile:
    """Read-only parser for REAPER .reapeaks files.

    All multi-byte integers are little-endian; v1.1+ store per-peak min/max
    pairs, v1.2 stores float-range pairs, v1.0 stores mirrored min == -max.
    """

    def __init__(self, path: str) -> None:
        self.path = path
        with open(path, "rb") as f:
            self.data = f.read()
        if len(self.data) < 18:
            raise ValueError("reapeaks 文件过短，无法解析头部")
        self.magic = self.data[0:4]
        self.is_v12 = self.magic == MAGIC_V12
        self.channels = self.data[4]
        self.mipmap_count = self.data[5]
        self.sample_rate, self.src_timestamp, self.src_filesize = struct.unpack_from(
            "<iii", self.data, 6
        )
        self.mipmaps: list[MipMap] = []
        self._parse_headers()
        self._parse_data()

    # ------------- headers -------------
    def _parse_headers(self) -> None:
        off = 18
        for _ in range(self.mipmap_count):
            div, npeak = struct.unpack_from("<ii", self.data, off)
            self.mipmaps.append(MipMap(div, npeak, _kind_for(div)))
            off += 8

    # ------------- data -------------
    def _parse_data(self) -> None:
        off = 18 + 8 * self.mipmap_count
        for mip in self.mipmaps:
            if mip.kind == "wave":
                off = self._read_wave(mip, off)
            elif mip.kind == "spectral":
                off = self._read_spectral(mip, off)
            elif mip.kind == "spectrogram":
                off = self._read_spectrogram(mip, off)
            elif mip.kind == "loudness":
                off = self._read_loudness(mip, off)
        self.data_end = off

    def _read_wave(self, mip: MipMap, off: int) -> int:
        for _ in range(mip.peak_count):
            channels: list[Peak] = []
            for _ch in range(self.channels):
                mx = struct.unpack_from("<h", self.data, off)[0]
                off += 2
                if self.magic == MAGIC_V10:
                    mn = -mx
                else:
                    mn = struct.unpack_from("<h", self.data, off)[0]
                    off += 2
                if self.is_v12:
                    mx = _rpk_munge(mx)
                    mn = _rpk_munge(mn)
                channels.append(Peak(mx, mn))
            mip.wave.append(channels)
        return off

    def _read_spectral(self, mip: MipMap, off: int) -> int:
        for _ in range(mip.peak_count):
            channels: list[tuple[int, int]] = []
            for _ch in range(self.channels):
                value = struct.unpack_from("<i", self.data, off)[0]
                off += 4
                freq = value & 0x7FFF  # low 15 bits
                density = (value >> 15) & 0x3FFF  # next 14 bits
                channels.append((freq, density))
            mip.spectral.append(channels)
        return off

    def _read_spectrogram(self, mip: MipMap, off: int) -> int:
        # 128 12-bit bins packed as 3 bytes per pair (192 bytes / channel / sample)
        width = 128 * 3 // 2  # 192
        for _ in range(mip.peak_count):
            channels: list[list[int]] = []
            for _ch in range(self.channels):
                raw = self.data[off : off + width]
                off += width
                channels.append(_unpack_12bit_bins(raw))
            mip.spectral.append(channels)
        return off

    def _read_loudness(self, mip: MipMap, off: int) -> int:
        # Observed: this REAPER build stores ONE float per peak per channel
        # (weighted RMS), not the two-float LUFS-M/LUFS-S pair of the old spec.
        for _ in range(mip.peak_count):
            channels: list[tuple[float, float]] = []
            for _ch in range(self.channels):
                value = struct.unpack_from("<f", self.data, off)[0]
                off += 4
                channels.append((value, 0.0))
            mip.loudness.append(channels)
        return off

    # ------------- helpers -------------
    def wave_mipmaps(self) -> list[MipMap]:
        return [m for m in self.mipmaps if m.kind == "wave"]

    def spectral_mipmaps(self) -> list[MipMap]:
        return [m for m in self.mipmaps if m.kind == "spectral"]

    def summary(self) -> str:
        lines = [
            f"magic={self.magic!r} channels={self.channels} "
            f"mipmaps={self.mipmap_count} sampleRate={self.sample_rate} "
            f"srcTimestamp={self.src_timestamp} srcFilesize={self.src_filesize}",
            f"parsed data ends at 0x{self.data_end:05X}, file size "
            f"{len(self.data)} (match={self.data_end == len(self.data)})",
        ]
        for index, mip in enumerate(self.mipmaps):
            lines.append(
                f"  mipmap[{index}] div={mip.division_factor} peaks={mip.peak_count} "
                f"kind={mip.kind}"
            )
        return "\n".join(lines)


def _unpack_12bit_bins(raw: bytes) -> list[int]:
    """Unpack 128 12-bit bins from 192 bytes (3 bytes per 2 bins)."""
    bins: list[int] = []
    for i in range(0, len(raw), 3):
        b0, b1, b2 = raw[i], raw[i + 1], raw[i + 2]
        bins.append((b0 << 4) | (b1 >> 4))
        bins.append(((b1 & 0x0F) << 8) | b2)
    return bins


def find_reapeaks(media_path: Path) -> Path | None:
    """Locate the .ReaPeaks cache REAPER would write next to a media file."""
    parent = media_path.parent
    name = media_path.name
    candidates = [parent / (name + suffix) for suffix in REAPEAKS_SUFFIXES]
    candidates += [media_path.with_suffix(suffix) for suffix in REAPEAKS_SUFFIXES]
    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            continue
    return None


def _paired_spectral_rates(ra: ReaPeaksFile) -> list[tuple[int, MipMap]]:
    """Pair spectral mipmaps with their wave mipmap by order.

    Spectral mipmaps carry ``-(int)'s'`` as their division_factor token but their
    real rate mirrors the paired main-sample mipmap, so the wave mipmap's
    division factor is what aligns them on the time axis.
    """
    wave_mips = ra.wave_mipmaps()
    spectral_mips = ra.spectral_mipmaps()
    return [
        (abs(wm.division_factor), sm)
        for wm, sm in zip(wave_mips, spectral_mips)
    ]


def extract_spectral_payload(
    reapeaks_path: Path | str,
    media_path: Path,
    *,
    peaks_per_second: int = 100,
) -> dict | None:
    """Parse a .ReaPeaks file into a versioned spectral payload, or None.

    Uses the spectral mipmap whose rate best matches ``peaks_per_second`` so the
    payload size stays comparable to the waveform cache. Channel 0 is used for
    display; the source signature is that of the media itself.
    """
    ra = ReaPeaksFile(str(reapeaks_path))
    pairs = _paired_spectral_rates(ra)
    if not pairs:
        return None
    if peaks_per_second and peaks_per_second > 0:
        target_div = max(1, round(ra.sample_rate / peaks_per_second))
        eff_div, spectral = min(pairs, key=lambda pair: abs(pair[0] - target_div))
    else:
        eff_div, spectral = min(pairs, key=lambda pair: pair[0])
    buffer = bytearray()
    for peak in spectral.spectral:
        freq, density = peak[0]  # channel 0 for display
        freq = max(0, min(0x7FFF, freq))
        density = max(0, min(0x3FFF, density))
        buffer += struct.pack("<HH", freq, density)
    return {
        "schema": SPECTRAL_SCHEMA,
        "encoding": SPECTRAL_ENCODING,
        "sample_rate": ra.sample_rate,
        "division": eff_div,
        "peak_count": spectral.peak_count,
        "source": waveform_module.media_signature(media_path),
        "data": base64.b64encode(bytes(buffer)).decode("ascii"),
    }


def _wave_to_int8(value: float | int) -> int:
    """Quantize a .ReaPeaks wave peak to a signed int8 sample (for i8-minmax).

    v1.1 wave peaks are int16; v1.2 float-range peaks (may exceed |1|) are
    clamped to [-1, 1] first. Mirrors waveform._quantize_sample.
    """
    if isinstance(value, float):
        integer = round(max(-1.0, min(1.0, value)) * 32768)
    else:
        integer = int(value)
    scaled = round(integer * 127 / 32768)
    return max(-127, min(127, scaled))


def extract_waveform_payload(
    reapeaks_path: Path | str,
    media_path: Path,
) -> dict | None:
    """Convert the finest .ReaPeaks wave mipmap into a ``moy.asr.waveform.v1`` payload.

    Lets the editor render the waveform outline from REAPER's own peaks (raw
    sample-rate, immune to the 1000 Hz re-sample aliasing of the built-in
    waveform cache). Channel 0 is used for display.
    """
    ra = ReaPeaksFile(str(reapeaks_path))
    wave_mips = ra.wave_mipmaps()
    if not wave_mips:
        return None
    finest = wave_mips[0]
    div = abs(finest.division_factor)
    if div <= 0 or not finest.wave:
        return None
    buffer = bytearray()
    for peak_row in finest.wave:
        peak = peak_row[0]  # channel 0 for display
        low = _wave_to_int8(peak.min)
        high = _wave_to_int8(peak.max)
        buffer += bytes((low & 0xFF, high & 0xFF))
    return {
        "schema": waveform_module.WAVEFORM_SCHEMA,
        "encoding": waveform_module.WAVEFORM_ENCODING,
        "peaks_per_second": round(ra.sample_rate / div),
        "peak_count": len(finest.wave),
        "duration_ms": round(len(finest.wave) * div / ra.sample_rate * 1000),
        "source": waveform_module.media_signature(media_path),
        "data": base64.b64encode(bytes(buffer)).decode("ascii"),
    }


def _reapeaks_matches_media(reapeaks_path: Path | str, media_path: Path | str) -> bool:
    """True when a .ReaPeaks cache was generated for the *current* media.

    The header stores the generating media's mtime and size; a zero pair means a
    legacy MAW cache with no provenance, which is treated as stale so it gets
    rebuilt instead of silently reused.
    """
    try:
        ra = ReaPeaksFile(str(reapeaks_path))
    except (OSError, struct.error, ValueError, IndexError):
        return False
    if ra.src_timestamp == 0 and ra.src_filesize == 0:
        return False
    try:
        st = Path(media_path).stat()
    except OSError:
        return False
    return ra.src_filesize == st.st_size and ra.src_timestamp == int(st.st_mtime)


def load_waveform_payload(media_path: Path) -> dict | None:
    """Return a waveform payload from the media's .ReaPeaks, or None."""
    reapeaks_path = find_reapeaks(media_path)
    if reapeaks_path is None or not _reapeaks_matches_media(reapeaks_path, media_path):
        return None
    try:
        return extract_waveform_payload(reapeaks_path, media_path)
    except (OSError, struct.error, ValueError, IndexError):
        return None


def load_spectral_payload(media_path: Path, *, peaks_per_second: int = 100) -> dict | None:
    """Find the media's .ReaPeaks and return a spectral payload, or None.

    Any missing / unreadable / non-spectral / stale .ReaPeaks degrades to None
    so the editor keeps working without spectral coloring.
    """
    reapeaks_path = find_reapeaks(media_path)
    if reapeaks_path is None or not _reapeaks_matches_media(reapeaks_path, media_path):
        return None
    try:
        return extract_spectral_payload(
            reapeaks_path, media_path, peaks_per_second=peaks_per_second
        )
    except (OSError, struct.error, ValueError, IndexError):
        return None


def resolve_ffmpeg(ffmpeg_bin: str | None = None) -> str | None:
    """Locate an ffmpeg executable: explicit path, FFMPEG_PATH, then PATH."""
    if ffmpeg_bin:
        return str(ffmpeg_bin)
    configured = os.environ.get("FFMPEG_PATH", "").strip()
    if configured:
        candidate = Path(configured)
        if candidate.is_file():
            return str(candidate)
        if candidate.is_dir():
            exe = candidate / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
            if exe.is_file():
                return str(exe)
    return shutil.which("ffmpeg")


def _parse_wav_header(header: bytes) -> tuple[int, int, int] | None:
    """(channels, sample_rate, data_offset) from an ffmpeg WAV pipe header."""
    if len(header) < 12 or header[0:4] != b"RIFF" or header[8:12] != b"WAVE":
        return None
    channels = 0
    sample_rate = 0
    off = 12
    while off + 8 <= len(header):
        cid = header[off : off + 4]
        size = struct.unpack_from("<I", header, off + 4)[0]
        if cid == b"fmt ":
            if off + 16 > len(header):
                return None
            channels = struct.unpack_from("<H", header, off + 10)[0]
            sample_rate = struct.unpack_from("<I", header, off + 12)[0]
        elif cid == b"data":
            if channels <= 0 or sample_rate <= 0:
                return None
            return channels, sample_rate, off + 8
        off += 8 + size + (size & 1)
    return None


def generate_reapeaks_stream_bytes(
    media_path: Path | str,
    *,
    ffmpeg_bin: str | None = None,
    src_timestamp: int = 0,
    src_filesize: int = 0,
) -> bytes | None:
    """Stream .ReaPeaks bytes straight from ffmpeg's WAV pipe.

    Only the current ffmpeg chunk and the generator's bounded accumulators are
    in memory; the full PCM never materializes. Returns None when ffmpeg is
    missing, the media has no decodable audio, or generation fails.
    """
    ffmpeg = resolve_ffmpeg(ffmpeg_bin)
    if not ffmpeg:
        return None
    try:
        proc = subprocess.Popen(
            [
                ffmpeg,
                "-nostdin",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(media_path),
                "-vn",
                "-acodec",
                "pcm_s16le",
                "-f",
                "wav",
                "pipe:1",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        assert proc.stdout is not None
        assert proc.stderr is not None
        header = proc.stdout.read(4096)
        parsed = _parse_wav_header(header)
        if parsed is None:
            proc.kill()
            proc.stdout.close()
            proc.stderr.close()
            proc.wait()
            return None
        channels, sample_rate, data_off = parsed
        streamer = reapeaks_generate._ReaPeaksStreamer(sample_rate, channels)
        if data_off < len(header):
            streamer.feed(header[data_off:])
        while True:
            chunk = proc.stdout.read(64 * 1024)
            if not chunk:
                break
            streamer.feed(chunk)
        stderr = proc.stderr.read().decode("utf-8", errors="replace").strip()
        proc.stdout.close()
        proc.stderr.close()
        if proc.wait() != 0:
            return None
        if stderr:
            return None
        return streamer.finish(src_timestamp=src_timestamp, src_filesize=src_filesize)
    except Exception:
        return None


def generate_for_media(
    media_path: Path,
    *,
    ffmpeg_bin: str | None = None,
) -> Path | None:
    """Best-effort .ReaPeaks generation for a media file, or the existing path.

    Returns the .ReaPeaks path when a matching cache already existed or was
    generated, else None (missing ffmpeg or decode failure). An existing cache
    is only reused when its header matches the current media; stale caches are
    rebuilt. The file is written next to the media so the server only ever
    reads it.
    """
    media_path = Path(media_path)
    existing = find_reapeaks(media_path)
    if existing is not None and _reapeaks_matches_media(existing, media_path):
        return existing
    target = media_path.with_name(media_path.name + ".ReaPeaks")
    try:
        src = media_path.stat()
        src_timestamp = int(src.st_mtime)
        src_filesize = src.st_size
        if src_timestamp > 0x7FFFFFFF or src_filesize > 0x7FFFFFFF:
            # 超出 .ReaPeaks 头部 int32 字段范围，无法可靠记录来源，跳过生成。
            return None
        data = generate_reapeaks_stream_bytes(
            media_path,
            ffmpeg_bin=ffmpeg_bin,
            src_timestamp=src_timestamp,
            src_filesize=src_filesize,
        )
        if data is None:
            return None
        target.write_bytes(data)
    except Exception:
        # 生成是兜底：任何失败（含 numpy 缺失）都不阻断转写/启动流程。
        return None
    return target


if __name__ == "__main__":
    import sys

    file = ReaPeaksFile(sys.argv[1])
    print(file.summary())
    wave_mips = file.wave_mipmaps()
    if wave_mips:
        print("first 5 wave peaks (mip 0):", [
            (round(p[0].max), round(p[0].min)) for p in wave_mips[0].wave[:5]
        ])
    spec_mips = file.spectral_mipmaps()
    if spec_mips:
        print("first 5 spectral peaks (mip 0):", spec_mips[0].spectral[:5])