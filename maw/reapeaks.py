"""Parser for REAPER .reapeaks files plus spectral (frequency/density) extraction.

Formats supported: RPKM (v1.0), RPKN (v1.1), RPKL (v1.2 float-range).

Spectral peak mipmaps (division factor == -(int)'s') are detected and decoded
into a versioned ``moy.asr.spectral.v1`` payload that the editor overlays on
the waveform. Loudness / spectrogram mipmaps are parsed but not exposed yet.

The spectral payload is a *cache* derived from the media's .ReaPeaks file, so
looking it up must never block the editor: any missing / unreadable /
non-spectral file degrades to ``None``.

Decoding is pure Python; only *generation* needs the Rust ``reapeaks``
extension, and it is imported lazily at the call site.  Managed ASR runtimes
are separate environments that may not ship the extension, and a cache
generator must never take down transcription at import time.
"""

from __future__ import annotations

import base64
import struct
import subprocess
import tempfile
from dataclasses import dataclass, field
from pathlib import Path

from maw import waveform as waveform_module
from maw.ffmpeg import resolve_ffmpeg_tool


def _load_rust_kernel():
    """按调用点延迟导入 Rust 生成内核，缺失时返回 None。

    解析（读）路径是纯 Python 的，只有生成（写）才需要内核。托管 Runtime 是独立
    环境（如 MOSS 的 ``local-runtime-moss``），未必装了 ``reapeaks``；放在模块顶层
    导入会让任何 `from maw import reapeaks` 的入口在加载模型之前就崩掉。生成是
    可重建缓存的兜底路径，必须按既有语义打日志说明原因后跳过，而不是拖垮转写。
    """

    try:
        import reapeaks as rust_generate
    except ImportError as exc:
        print(f"[reapeaks] 缺少 Rust 生成内核 reapeaks（{exc}），跳过 .ReaPeaks 生成")
        return None
    return rust_generate


MAGIC_V10 = b"RPKM"  # v1.0: min == -max (mirrored)
MAGIC_V11 = b"RPKN"  # v1.1: explicit min/max
MAGIC_V12 = b"RPKL"  # v1.2: float-range peaks

SPECTRAL_SCHEMA = "moy.asr.spectral.v1"
SPECTRAL_ENCODING = "u16-freq-density-base64"

# REAPER appends one of these to the full media filename (e.g. ICE.wav.ReaPeaks).
REAPEAKS_SUFFIXES = (".ReaPeaks", ".reapeaks", ".REAPEAKS")

# 官方规格允许的 mtime 指纹容差：小漂移几秒，以及夏令时造成的约一小时偏差。
_MTIME_TOLERANCE_SECONDS = 5
_UINT32_MASK = 0xFFFF_FFFF
_UINT32_MODULUS = 0x1_0000_0000

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
        # 官方规格：mtime/size 是 stat() 值的低 32 位（"low 32 bits"），仅作
        # 更新检测指纹；>2GiB / 2038 后的大值按无符号位型记录，按 i32 解读
        # 会得到无意义的负数（REAPER 真机即按此语义写入）。
        self.sample_rate, self.src_timestamp, self.src_filesize = struct.unpack_from(
            "<iII", self.data, 6
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

    The spectral layer usually has *fewer* peaks than its paired wave layer
    (7 fewer for a 44.1 kHz REAPER file, 25 for 16 kHz) because the last FFT
    windows cannot be filled.  That deficit is at the tail, not a head offset:
    measured with a narrow-band burst at a known instant, the spectral response
    is centered on the same bin the wave layer reports (48 kHz: 4207.5 vs 4207;
    16 kHz: 4234 vs 4233).  So index ``i`` on both layers means the same moment
    and no shift may be introduced here; the uncovered tail simply draws no
    color, which the editor already handles with a bounds check.
    """
    wave_mips = ra.wave_mipmaps()
    spectral_mips = ra.spectral_mipmaps()
    return [(abs(wm.division_factor), sm) for wm, sm in zip(wave_mips, spectral_mips)]


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
    waveform cache).

    All channels are merged into one outline (min of mins, max of maxes), which
    is what the browser-side ``decodeReapeaksFile`` does too, so a project
    opened by the server and a ``.ReaPeaks`` dropped into the editor produce the
    same shape.  Picking a single channel instead would draw a flat line for the
    dual-mono material that is common in broadcast and game audio (voice only on
    the right channel).  Spectral data stays channel 0 on both sides.

    The bin rate is ``sample_rate / division`` and is fractional for most media
    (16 kHz with ``div=53`` is 301.8868 peaks/s).  It must never be rounded to
    an integer here: the editor maps peak indices to timestamps through that
    number, so a rounding error would scale the entire time axis and drift
    linearly with the media length.  The exact pair is published alongside, and
    ``peaks_per_second`` carries the exact ratio as well (an int only when the
    division is exact) so that consumers which have not migrated still draw
    correctly.
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
        low = 127
        high = -127
        for peak in peak_row:
            low = min(low, _wave_to_int8(peak.min))
            high = max(high, _wave_to_int8(peak.max))
        if not peak_row:  # 声道数为 0 的损坏文件：留一条中线而不是画反的包络
            low = high = 0
        buffer += bytes((low & 0xFF, high & 0xFF))
    exact_rate = ra.sample_rate / div
    return {
        "schema": waveform_module.WAVEFORM_SCHEMA,
        "encoding": waveform_module.WAVEFORM_ENCODING,
        "peaks_per_second": (
            int(exact_rate) if exact_rate.is_integer() else round(exact_rate, 6)
        ),
        "sample_rate": ra.sample_rate,
        "division": div,
        "peak_count": len(finest.wave),
        "duration_ms": round(len(finest.wave) * div / ra.sample_rate * 1000),
        "source": waveform_module.media_signature(media_path),
        "data": base64.b64encode(bytes(buffer)).decode("ascii"),
    }


def _reapeaks_matches_media(reapeaks_path: Path | str, media_path: Path | str) -> bool:
    """True when a .ReaPeaks cache is acceptable for the *current* media.

    Provenance is the header's ``(src_timestamp, src_filesize)`` pair, which
    ``generate_for_media`` records from the file it actually decoded.  Because
    generation now decodes the source media itself, both halves are
    comparable again and both are required: a cache that survives as a
    timestamp match but was built from a different file (a 16 kHz mono
    extraction of a 48 kHz stereo video, or a length-limited clip) fails the
    size check and gets rebuilt instead of silently stretching the editor's
    time axis.  A zero timestamp/filesize pair means a legacy MAW cache with no
    provenance and is treated as stale for the same reason.

    对齐官方规格的容差：mtime/size 都只有 stat() 值的低 32 位精度，且
    "REAPER will allow for small variations (a few seconds), as well as
    within a few seconds of one hour off (to allow for DST changes)"——
    跨盘拷贝导致的秒级 / 恰好一小时的 mtime 漂移不应误杀缓存。
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
    if ra.src_filesize != st.st_size & _UINT32_MASK:
        return False
    return _timestamp_fingerprint_matches(ra.src_timestamp, int(st.st_mtime))


def _timestamp_fingerprint_matches(stored: int, actual: int) -> bool:
    """mtime 指纹比对：精确相等，或容许秒级漂移 / DST 整小时偏差。"""
    # Header stores only stat()'s low 32 bits. Compare in that same unsigned
    # domain so the check remains correct after the counter wraps around.
    stored &= _UINT32_MASK
    actual &= _UINT32_MASK
    delta = abs(stored - actual)
    delta = min(delta, _UINT32_MODULUS - delta)
    return delta <= _MTIME_TOLERANCE_SECONDS or abs(delta - 3600) <= _MTIME_TOLERANCE_SECONDS


def _reapeaks_contains_spectral(reapeaks_path: Path | str) -> bool:
    """Return whether a readable cache contains at least one spectral mipmap."""
    try:
        return bool(ReaPeaksFile(str(reapeaks_path)).spectral_mipmaps())
    except (OSError, struct.error, ValueError, IndexError):
        return False


def load_waveform_payload(media_path: Path) -> dict | None:
    """Return a waveform payload from the media's .ReaPeaks, or None."""
    reapeaks_path = find_reapeaks(media_path)
    if reapeaks_path is None or not _reapeaks_matches_media(reapeaks_path, media_path):
        return None
    try:
        return extract_waveform_payload(reapeaks_path, media_path)
    except (OSError, struct.error, ValueError, IndexError):
        return None


def load_spectral_payload(
    media_path: Path, *, peaks_per_second: int = 100
) -> dict | None:
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
    """Locate FFmpeg through the shared application-wide resolver."""
    resolved = resolve_ffmpeg_tool(
        "ffmpeg",
        ffmpeg_bin,
        allow_missing_explicit=bool(ffmpeg_bin),
    )
    return str(resolved) if resolved is not None else None


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
    include_spectral: bool = True,
) -> bytes | None:
    """Stream .ReaPeaks bytes straight from ffmpeg's WAV pipe.

    Only the current ffmpeg chunk and the generator's bounded accumulators are
    in memory; the full PCM never materializes. Returns None when ffmpeg is
    missing, the Rust kernel is unavailable, the media has no decodable audio,
    or the Rust kernel fails; each failure mode logs a distinct reason instead
    of degrading silently.
    """
    ffmpeg = resolve_ffmpeg(ffmpeg_bin)
    if not ffmpeg:
        print("[reapeaks] 缺少 ffmpeg，跳过 .ReaPeaks 生成")
        return None
    rust_generate = _load_rust_kernel()
    if rust_generate is None:
        return None
    stderr_file = tempfile.TemporaryFile()
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
            stderr=stderr_file,
        )
    except OSError as exc:
        stderr_file.close()
        print(f"[reapeaks] 启动 ffmpeg 失败: {exc}")
        return None
    assert proc.stdout is not None
    try:
        header = proc.stdout.read(4096)
        parsed = _parse_wav_header(header)
        if parsed is None:
            print("[reapeaks] 解码失败：无法解析 ffmpeg 输出的 WAV 头")
            return None
        channels, sample_rate, data_off = parsed
        try:
            features = (
                ["wave", "spectral", "loudness"]
                if include_spectral
                else ["wave", "loudness"]
            )
            streamer = rust_generate.ReapeaksStreamer(
                sample_rate,
                channels,
                features=features,
                mipmap_levels=3,
            )
        except Exception as exc:  # noqa: BLE001 - 构造失败必须响亮，不静默降级
            print(f"[reapeaks] Rust 内核初始化失败: {exc}")
            return None
        read_size = 1 * 1024 * 1024
        if data_off < len(header):
            streamer.feed(header[data_off:])
        while True:
            chunk = proc.stdout.read(read_size)
            if not chunk:
                break
            streamer.feed(chunk)
        retcode = proc.wait()
        stderr_file.seek(0)
        stderr = stderr_file.read().decode("utf-8", errors="replace").strip()
        if retcode != 0:
            print(
                f"[reapeaks] 解码失败：ffmpeg 退出码 {retcode}"
                + (f"（{stderr}）" if stderr else "")
            )
            return None
        if stderr:
            print(f"[reapeaks] 解码失败：{stderr}")
            return None
        try:
            return streamer.finish(
                src_timestamp=src_timestamp, src_filesize=src_filesize
            )
        except Exception as exc:  # noqa: BLE001
            print(f"[reapeaks] Rust 内核生成失败: {exc}")
            return None
    except Exception as exc:  # noqa: BLE001
        print(f"[reapeaks] .ReaPeaks 生成失败: {exc}")
        return None
    finally:
        proc.stdout.close()
        stderr_file.close()
        if proc.poll() is None:
            proc.kill()
            proc.wait()


def generate_for_media(
    media_path: Path,
    *,
    ffmpeg_bin: str | None = None,
    include_spectral: bool = True,
    source_media_path: Path | str | None = None,
) -> Path | None:
    """Best-effort .ReaPeaks generation for a media file, or the existing path.

    Returns the .ReaPeaks path when a matching cache already existed or was
    generated, else None (missing ffmpeg or decode failure). An existing cache
    is only reused when its header matches the current media and, when
    ``include_spectral`` is true, already contains a spectral mipmap; stale or
    incomplete caches are rebuilt. The file is written next to the media so
    the server only ever reads it.

    ``source_media_path`` is the media the editor will open: when it can be
    decoded, the cache is written next to it and its ``(mtime, size)`` is
    recorded in the header as the provenance the server later checks.
    ``media_path`` is a fallback decode input for callers that only have a
    derived file around (e.g. a temporary extraction).  When the source itself
    is readable it is always preferred,
    because the .ReaPeaks header stores the decoded file's sample rate and
    channel count and has no room to record that they came from somewhere else:
    deriving a cache from a 16 kHz mono ASR extraction of a 48 kHz stereo video,
    or from a ``--length-limit`` clip, silently re-bases the editor's whole time
    axis and stops covering the tail.
    """
    media_path = Path(media_path)
    signature_path = (
        Path(source_media_path) if source_media_path is not None else media_path
    )
    existing = find_reapeaks(signature_path)
    if existing is not None and _reapeaks_matches_media(existing, signature_path):
        if not include_spectral or _reapeaks_contains_spectral(existing):
            return existing
    # 优先解码源媒体；源不可读或解不出音频时退回调用方给的派生文件，
    # 让缓存至少覆盖"编辑器能看到的那部分"，而不是整体失效。回退缓存
    # 必须写在派生文件旁，避免把派生数据伪装成源媒体的缓存。
    candidates = (
        [media_path] if signature_path == media_path else [signature_path, media_path]
    )
    missing = True
    for decode_path in candidates:
        if not decode_path.is_file():
            continue
        missing = False
        try:
            src = decode_path.stat()
            # 官方规格：头里只存 stat() 值的低 32 位，大文件（>2GiB 的媒体、
            # 2038 后的 mtime）照常生成，指纹自然按位型回绕，无需守卫。
            media_timestamp = int(src.st_mtime) & _UINT32_MASK
            media_filesize = src.st_size & _UINT32_MASK
            data = generate_reapeaks_stream_bytes(
                decode_path,
                ffmpeg_bin=ffmpeg_bin,
                src_timestamp=media_timestamp,
                src_filesize=media_filesize,
                include_spectral=include_spectral,
            )
        except Exception as exc:  # noqa: BLE001
            # 生成是兜底：任何失败都不阻断转写/启动流程。具体原因（缺 ffmpeg /
            # 解码失败 / Rust 内核故障）由 generate_reapeaks_stream_bytes 打日志，
            # 这里的异常仅剩写文件或取 stat 等罕见兜底路径。
            print(f"[reapeaks] .ReaPeaks 生成失败: {exc}")
            return None
        if data is None:
            if decode_path is candidates[0] and len(candidates) > 1:
                print(
                    "[reapeaks] 源媒体解码失败，改用派生文件生成缓存: "
                    f"{decode_path.name} -> {candidates[1].name}"
                )
            continue
        target = decode_path.with_name(decode_path.name + ".ReaPeaks")
        try:
            target.write_bytes(data)
        except OSError as exc:
            print(f"[reapeaks] .ReaPeaks 写入失败: {exc}")
            return None
        return target
    if missing:
        print(f"[reapeaks] 警告: 缓存媒体不存在，已跳过生成: {candidates[0]}")
    else:
        print("[reapeaks] ReaPeaks 数据为空")
    return None


if __name__ == "__main__":
    import sys

    file = ReaPeaksFile(sys.argv[1])
    print(file.summary())
    wave_mips = file.wave_mipmaps()
    if wave_mips:
        print(
            "first 5 wave peaks (mip 0):",
            [(round(p[0].max), round(p[0].min)) for p in wave_mips[0].wave[:5]],
        )
    spec_mips = file.spectral_mipmaps()
    if spec_mips:
        print("first 5 spectral peaks (mip 0):", spec_mips[0].spectral[:5])
