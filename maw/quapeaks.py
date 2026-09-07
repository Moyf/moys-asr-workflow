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
        import quapeaks as rust_generate
    except ImportError as exc:
        print(f"[reapeaks] 缺少 Rust 生成内核 quapeaks（{exc}），跳过 .ReaPeaks 生成")
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

# MAW 生成的容器后缀。tests/test_reapeaks.py 把它与内核 quapeaks.FILE_SUFFIX
# 钉成同值：两边各写一份的话，改名时会出现内核写 A、MAW 找 B 的哑火。
QUAPEAKS_SUFFIX = ".quapeaks"
# 读取顺序：MAW 自己的产物在前（层更全，含自研层），REAPER 真机的
# .ReaPeaks 在后但必须继续能读。.mopeaks 不在这里 —— 它是波形 sidecar
# （由 maw.mopeaks 自己管），混进来会挡住 .ReaPeaks 的频谱染色。
PEAKS_SUFFIXES = (QUAPEAKS_SUFFIX,) + REAPEAKS_SUFFIXES

DIV_SPECTRAL = -ord("s")  # spectral peaks
DIV_SPECTROGRAM = -ord("g")  # spectrogram
DIV_LOUDNESS = -ord("r")  # loudness (new)
DIV_LOUDNESS_OLD = -ord("l")  # loudness (deprecated)

# quapeaks 自有容器：magic 为 b'QPK' + 1 字节可打印版本号（当前 b'QPK1'）。
# 全局头布局与 RPKN 完全相同，差别只在 magic 与允许的层集合。
QUAPEAKS_MAGIC_PREFIX = b"QPK"
# 已支持的自有容器 magic（前缀 + 版本字节）。**只比前缀是不够的**：未知版本
# （QPK2 / MPK2 …）的字段布局可能已经变了，按旧布局解会把版本升级或损坏文件
# 当成合法缓存读出来 —— 那比崩溃更糟。所以认家族、拒版本：家族对但版本不认识
# 时整份判为不支持，由调用方降级为 cache miss 重建。
SUPPORTED_NATIVE_MAGICS = (b"QPK1", b"MPK1")
# mopeaks：MAW 纯 Python 写出的回退容器（无内核时）。布局与 QPK 相同，
# 只有 magic 与层数不同，所以自研层分支两种都认。
MOPEAKS_MAGIC_PREFIX = b"MPK"

# MAW 自研波形层。div 取负 ASCII 'm'，与 spectral/loudness 同一套 token 约定。
DIV_SELF_WAVE = -ord("m")
# 层数据段前缀：u32 自身 sample_rate + u32 division；npeak 不含前缀。
SELF_WAVE_PREFIX_LEN = 8
# 该层恒单声道（提取侧 ffmpeg 已 -ac 1），每峰 2 字节：int8 min, int8 max。
SELF_WAVE_CHANNELS = 1
SELF_WAVE_BYTES_PER_PEAK = 2


@dataclass
class Peak:
    """One wave peak sample for a single channel."""

    max: float
    min: float


@dataclass
class SelfWaveLayer:
    """MAW 自研波形层解码结果。

    `sample_rate` 是**该层自己**的 PCM 采样率，与容器头的源媒体采样率无关；
    精确刻度 = sample_rate / division，绝不能在这里取整（见 waveform_peaks_per_second）。
    """

    sample_rate: int
    division: int
    peaks: list[tuple[int, int]]  # 逐峰 (min, max)，int8，单声道


@dataclass
class MipMap:
    division_factor: int
    peak_count: int
    kind: str  # "wave" | "spectral" | "spectrogram" | "loudness"
    wave: list[list[Peak]] = field(default_factory=list)
    spectral: list[list[tuple[int, int]]] = field(default_factory=list)
    loudness: list[list[tuple[float, float]]] = field(default_factory=list)
    # 仅 kind == 'self_wave' 时有值
    self_layer: SelfWaveLayer | None = None


def _kind_for(div: int) -> str:
    if div == DIV_SPECTRAL:
        return "spectral"
    if div == DIV_SPECTROGRAM:
        return "spectrogram"
    if div in (DIV_LOUDNESS, DIV_LOUDNESS_OLD):
        return "loudness"
    if div == DIV_SELF_WAVE:
        return "self_wave"
    return "wave"


def _rpk_munge(value: int) -> float:
    """Convert a raw short for RPKL (v1.2 float-range) files."""
    if -24576 <= value <= 24576:
        return value / 24576.0
    if value > 24576:
        return 2.0 ** ((value - 24576) / 1024.0)
    return -(2.0 ** ((-value - 24576) / 1024.0))


class ReapeaksFile:
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
        # quapeaks 自有容器：magic 前缀 QPK，末字节是可打印 ASCII 版本位。
        self.is_quapeaks = self.magic == b"QPK1"
        self.is_mopeaks = self.magic == b"MPK1"
        native_family = self.magic[:3] in (QUAPEAKS_MAGIC_PREFIX, MOPEAKS_MAGIC_PREFIX)
        if native_family and self.magic not in SUPPORTED_NATIVE_MAGICS:
            raise ValueError(
                f"{self.path}: 自有容器版本不认识（magic={self.magic!r}，本版本只支持 "
                f"{SUPPORTED_NATIVE_MAGICS!r}），拒绝按旧布局解析"
            )
        self.format_version = self.magic[3] if (self.is_quapeaks or self.is_mopeaks) else None
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
            elif mip.kind == "self_wave":
                off = self._read_self_wave(mip, off)
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

    def _read_self_wave(self, mip: MipMap, off: int) -> int:
        """读取 MAW 自研波形层。

        两处刻意的不信任：

        1. **绝不能用 ``self.channels``**。该层恒单声道，而容器头的 channels 是
           媒体原生声道数（双声道素材上就是 2）；按 2 声道读 1 声道数据会字节
           错位，连带把后续所有层的偏移搞坏。
        2. **只在 quapeaks 容器里承认这个 token**。REAPER 的 RPKN 文件若哪天自己
           用了 ``-'m'``，我们静默按自研层解就等于误读，宁可报错。
        """
        if not (self.is_quapeaks or self.is_mopeaks):
            raise ValueError(
                f"{self.path}: 发现自研波形层 token（div={DIV_SELF_WAVE}）"
                f"但 magic 既非 QPK* 也非 MPK*（{self.magic!r}），拒绝猜测"
            )
        need = SELF_WAVE_PREFIX_LEN + mip.peak_count * SELF_WAVE_BYTES_PER_PEAK
        if off + need > len(self.data):
            raise ValueError(
                f"{self.path}: 自研波形层声明 npeak={mip.peak_count}，"
                f"需 {need} 字节，但文件只剩 {len(self.data) - off} 字节"
            )
        sample_rate, division = struct.unpack_from("<II", self.data, off)
        off += SELF_WAVE_PREFIX_LEN
        if sample_rate <= 0 or division <= 0:
            raise ValueError(
                f"{self.path}: 自研波形层刻度无效 sample_rate={sample_rate} division={division}"
            )
        peaks: list[tuple[int, int]] = []
        for _ in range(mip.peak_count):
            low = struct.unpack_from("<b", self.data, off)[0]
            high = struct.unpack_from("<b", self.data, off + 1)[0]
            off += SELF_WAVE_BYTES_PER_PEAK
            peaks.append((low, high))
        mip.self_layer = SelfWaveLayer(sample_rate, division, peaks)
        return off

    # ------------- helpers -------------
    def wave_mipmaps(self) -> list[MipMap]:
        return [m for m in self.mipmaps if m.kind == "wave"]

    def spectral_mipmaps(self) -> list[MipMap]:
        return [m for m in self.mipmaps if m.kind == "spectral"]

    def self_wave_mipmaps(self) -> list[MipMap]:
        return [m for m in self.mipmaps if m.kind == "self_wave"]

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


def _header_provenance(path: Path) -> tuple[int, int] | None:
    """只读 18 字节全局头，取出 (src_timestamp, src_filesize) 指纹。

    给候选排序用，所以刻意不构造 ReapeaksFile —— 那会把几百万个峰全解一遍。
    """
    try:
        with open(path, "rb") as handle:
            head = handle.read(18)
    except OSError:
        return None
    if len(head) < 18:
        return None
    try:
        _, timestamp, filesize = struct.unpack_from("<iII", head, 6)
    except struct.error:
        return None
    return timestamp, filesize


def _header_matches_media(path: Path, media_path: Path) -> bool:
    """头部指纹是否指向当前媒体（与 _reapeaks_matches_media 同一口径）。"""
    stored = _header_provenance(path)
    if stored is None or stored == (0, 0):
        return False
    try:
        st = media_path.stat()
    except OSError:
        return False
    return (
        stored[1] == st.st_size & _UINT32_MASK
        and _timestamp_fingerprint_matches(stored[0], int(st.st_mtime))
    )


def _header_has_spectral_layer(path: Path) -> bool:
    """只读全局头 + 层表，判断容器里有没有 spectral 层（不解峰数据）。

    给候选过滤用：构造 ReapeaksFile 会把几百万个峰全解一遍，拿它来挑文件等于
    为了选对文件先把最贵的活干完。层数按头里的字节数夹住，损坏文件不致多读。
    """
    try:
        with open(path, "rb") as handle:
            head = handle.read(18)
            if len(head) < 18:
                return False
            table = handle.read(min(head[5], 64) * 8)
    except OSError:
        return False
    for index in range(len(table) // 8):
        if struct.unpack_from("<i", table, index * 8)[0] == -ord("s"):
            return True
    return False


def find_reapeaks(
    media_path: Path, *, audio_track: int = 0, need_spectral: bool = False
) -> Path | None:
    """Locate a peaks container next to a media file.

    MAW 自己产出的 .quapeaks 排在 REAPER 的 .ReaPeaks 之前，但**过期的一方
    不得挡住新鲜的一方**：先返回头部指纹与当前媒体相符的候选，都不相符时
    退回第一个存在的文件（保持既有语义，由调用方的签名校验决定降级）。

    多音轨沿用上游的 ``<媒体>.track-N`` 段（N 从 1 起，第 0 轨不带标记）：
    同一素材的不同轨必须有各自的容器，否则后写的会把前一轨整份覆盖掉。
    """
    if not isinstance(audio_track, int) or isinstance(audio_track, bool) or audio_track < 0:
        raise ValueError("audio_track must be a non-negative integer")
    parent = media_path.parent
    name = media_path.name
    track_suffix = f".track-{audio_track + 1}" if audio_track else ""
    candidates = [
        parent / (name + track_suffix + suffix) for suffix in PEAKS_SUFFIXES
    ]
    candidates += [
        media_path.with_suffix(track_suffix + suffix) for suffix in PEAKS_SUFFIXES
    ]
    seen: set[Path] = set()
    first_existing: Path | None = None
    for candidate in candidates:
        if candidate in seen:
            continue
        seen.add(candidate)
        try:
            if not candidate.is_file():
                continue
        except OSError:
            continue
        # 先按调用方需要的能力过滤：一份新鲜但只有 wave 层的 .quapeaks 不该
        # 挡住同样新鲜、带 spectral 层的 .ReaPeaks —— 否则频谱染色会被静默短路，
        # 而日志上看着"缓存是好的"。连回退候选也一并要求，不给它当选的机会。
        if need_spectral and not _header_has_spectral_layer(candidate):
            continue
        if first_existing is None:
            first_existing = candidate
        if _header_matches_media(candidate, media_path):
            return candidate
    return first_existing


def find_self_wave_container(
    media_path: Path | str, *, audio_track: int = 0
) -> Path | None:
    """媒体旁哪个 peaks 容器已带有属于**当前媒体**的自研波形层，没有则 None。

    mopeaks 回退的唯一判据（见 maw.media_cache）：不管是没装内核、内核抛错、
    产物损坏还是压根没生成，只要这里回答 None，回退档就该写。
    """
    media_path = Path(media_path)
    container = find_reapeaks(media_path, audio_track=audio_track)
    if container is None:
        return None
    try:
        ra = ReapeaksFile(str(container))
    except (OSError, ValueError, IndexError, struct.error):
        return None
    if not ra.self_wave_mipmaps():
        return None
    return container if _reapeaks_matches_media(container, media_path) else None


def _paired_spectral_rates(ra: ReapeaksFile) -> list[tuple[int, MipMap]]:
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
    audio_track: int = 0,
) -> dict | None:
    """Parse a .ReaPeaks file into a versioned spectral payload, or None.

    Uses the spectral mipmap whose rate best matches ``peaks_per_second`` so the
    payload size stays comparable to the waveform cache. Channel 0 is used for
    display; the source signature is that of the media itself.
    """
    ra = ReapeaksFile(str(reapeaks_path))
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
        "audio_track": audio_track,
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
    *,
    audio_track: int = 0,
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
    ra = ReapeaksFile(str(reapeaks_path))
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
        "audio_track": audio_track,
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
        ra = ReapeaksFile(str(reapeaks_path))
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


# maw.mopeaks（无内核时的回退档）与内核缓存必须对"媒体变没变"给同一个答案，
# 所以这里给上游那两个私有实现加公开别名。刻意用别名而不是改名或复制一份：
# 上游随时可能再动 _timestamp_fingerprint_matches 的实现，别名不会造成合并冲突，
# 而抄第二份必然漂移。
timestamp_fingerprint_matches = _timestamp_fingerprint_matches
UINT32_MASK = _UINT32_MASK


def _reapeaks_contains_spectral(reapeaks_path: Path | str) -> bool:
    """Return whether a readable cache contains at least one spectral mipmap."""
    try:
        return bool(ReapeaksFile(str(reapeaks_path)).spectral_mipmaps())
    except (OSError, struct.error, ValueError, IndexError):
        return False


def load_waveform_payload(media_path: Path, *, audio_track: int = 0) -> dict | None:
    """Return a waveform payload from the media's .ReaPeaks, or None."""
    reapeaks_path = find_reapeaks(media_path, audio_track=audio_track)
    if reapeaks_path is None or not _reapeaks_matches_media(reapeaks_path, media_path):
        return None
    try:
        return extract_waveform_payload(
            reapeaks_path, media_path, audio_track=audio_track
        )
    except (OSError, struct.error, ValueError, IndexError):
        return None


def load_spectral_payload(
    media_path: Path,
    *,
    peaks_per_second: int = 100,
    audio_track: int = 0,
) -> dict | None:
    """Find the media's .ReaPeaks and return a spectral payload, or None.

    Any missing / unreadable / non-spectral / stale .ReaPeaks degrades to None
    so the editor keeps working without spectral coloring.

    候选按 need_spectral 过滤：不然一份更新的 wave-only .quapeaks 会挡住
    带 spectral 层的 .ReaPeaks，读出来是 None 而不是退去读那份能用的。
    """
    reapeaks_path = find_reapeaks(
        media_path, audio_track=audio_track, need_spectral=True
    )
    if reapeaks_path is None or not _reapeaks_matches_media(reapeaks_path, media_path):
        return None
    try:
        return extract_spectral_payload(
            reapeaks_path,
            media_path,
            peaks_per_second=peaks_per_second,
            audio_track=audio_track,
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


def self_peaks_from_payload(payload: dict) -> tuple[int, int, bytes] | None:
    """把 ``moy.asr.waveform.v1`` 载荷换成内核 set_self_peaks 的入参。

    峰数据本身是字节数组，载荷里为了走 JSON 才 base64；这里解回去。
    刻度必须用精确的 (sample_rate, division)：只传取整后的
    peaks_per_second 等于把 PR #102 修掉的时间轴漂移又请回来。
    """
    sample_rate = payload.get("sample_rate")
    division = payload.get("division")
    if not (
        isinstance(sample_rate, int)
        and not isinstance(sample_rate, bool)
        and sample_rate > 0
        and isinstance(division, int)
        and not isinstance(division, bool)
        and division > 0
    ):
        pps = payload.get("peaks_per_second")
        if isinstance(pps, bool) or not isinstance(pps, (int, float)) or pps <= 0:
            return None
        sample_rate, division = int(round(pps)), 1
    try:
        peaks = base64.b64decode(payload["data"], validate=True)
    except Exception:  # noqa: BLE001 - binascii.Error 等，交给回退档报错
        return None
    if not peaks or len(peaks) % SELF_WAVE_BYTES_PER_PEAK:
        return None
    return sample_rate, division, peaks


def generate_reapeaks_stream_bytes(
    media_path: Path | str,
    *,
    ffmpeg_bin: str | None = None,
    src_timestamp: int = 0,
    src_filesize: int = 0,
    include_spectral: bool = True,
    audio_track: int = 0,
    flavor: str = "quapeaks",
    self_peaks: tuple[int, int, bytes] | None = None,
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
    if not isinstance(audio_track, int) or isinstance(audio_track, bool) or audio_track < 0:
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
                "-map",
                f"0:a:{audio_track}",
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
                flavor=flavor,
            )
        except Exception as exc:  # noqa: BLE001 - 构造失败必须响亮，不静默降级
            print(f"[reapeaks] Rust 内核初始化失败: {exc}")
            return None
        if self_peaks is not None:
            try:
                streamer.set_self_peaks(*self_peaks)
            except Exception as exc:  # noqa: BLE001
                # 自研层进不去就等于这一档整体不成立：早失败早回退，
                # 别把 ffmpeg 的解码时间花在一个拿不到峰的容器上。
                print(f"[reapeaks] 自研波形层注入失败，改用 mopeaks: {exc}")
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


def _self_check(container: Path, *, want_self_wave: bool) -> bool:
    """刚写出的容器是否真能用：损坏、magic 不对、缺自研层都在这里挡下。

    自检不过就等于这次生成失败，让调用方按判据回退 mopeaks —— 留下一个
    后续读取会静默降级的半成品，比明确失败更难查。

    刻意**不**在这里复核头部指纹是否指向源媒体：源不可解、改用派生文件解码时，
    头部记的就是真正解码过的那个文件的指纹（上游既有语义，见 generate_for_media
    的 candidates 注释）。读取端各自按自己的口径校验，生成端不替它做决定。
    """
    try:
        ra = ReapeaksFile(str(container))
    except (OSError, ValueError, IndexError, struct.error) as exc:
        print(f"[reapeaks] 自检失败：{container.name} 无法解析（{exc}）")
        return False
    if not ra.is_quapeaks:
        print(
            f"[reapeaks] 自检失败：{container.name} 的 magic 是 {ra.magic!r}，不是 QPK*"
        )
        return False
    if want_self_wave and not ra.self_wave_mipmaps():
        print(f"[reapeaks] 自检失败：{container.name} 缺自研波形层")
        return False
    return True


def generate_for_media(
    media_path: Path,
    *,
    ffmpeg_bin: str | None = None,
    include_spectral: bool = True,
    source_media_path: Path | str | None = None,
    audio_track: int = 0,
    cache_audio_track: int | None = None,
    self_peaks: tuple[int, int, bytes] | None = None,
) -> Path | None:
    """Best-effort peaks-container generation for a media file, or the existing path.

    MAW 写的是自有容器 ``<媒体>.quapeaks``（flavor=quapeaks，可带自研波形层）；
    REAPER 真机的 ``.ReaPeaks`` 仍然照读。传了 ``self_peaks`` 时，产物还要过
    一遍 :func:`_self_check`，不过就返回 None 让调用方回退 mopeaks。

    Returns the container path when a matching cache already existed or was
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
    if not isinstance(audio_track, int) or isinstance(audio_track, bool) or audio_track < 0:
        return None
    if cache_audio_track is None:
        cache_audio_track = audio_track
    if (
        not isinstance(cache_audio_track, int)
        or isinstance(cache_audio_track, bool)
        or cache_audio_track < 0
    ):
        return None

    media_path = Path(media_path)
    signature_path = (
        Path(source_media_path) if source_media_path is not None else media_path
    )
    existing = find_reapeaks(signature_path, audio_track=cache_audio_track)
    if existing is not None and _reapeaks_matches_media(existing, signature_path):
        if not include_spectral or _reapeaks_contains_spectral(existing):
            return existing
    # 优先解码源媒体；源不可读或解不出音频时退回调用方给的派生文件，
    # 让缓存至少覆盖"编辑器能看到的那部分"，而不是整体失效。回退缓存
    # 必须写在派生文件旁，避免把派生数据伪装成源媒体的缓存。
    track_suffix = f".track-{cache_audio_track + 1}" if cache_audio_track else ""
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
                audio_track=audio_track if decode_path == signature_path else 0,
                self_peaks=self_peaks,
            )
        except Exception as exc:  # noqa: BLE001
            # 生成是兜底：任何失败都不阻断转写/启动流程。具体原因（缺 ffmpeg /
            # 解码失败 / Rust 内核故障）由 generate_reapeaks_stream_bytes 打日志，
            # 这里的异常仅剩写文件或取 stat 等罕见兜底路径。
            print(f"[reapeaks] {QUAPEAKS_SUFFIX} 生成失败: {exc}")
            return None
        if data is None:
            if decode_path is candidates[0] and len(candidates) > 1:
                print(
                    "[reapeaks] 源媒体解码失败，改用派生文件生成缓存: "
                    f"{decode_path.name} -> {candidates[1].name}"
                )
            continue
        target = decode_path.with_name(
            decode_path.name + track_suffix + QUAPEAKS_SUFFIX
        )
        try:
            target.write_bytes(data)
        except OSError as exc:
            print(f"[reapeaks] {QUAPEAKS_SUFFIX} 写入失败: {exc}")
            return None
        if not _self_check(target, want_self_wave=self_peaks is not None):
            return None
        return target
    if missing:
        print(f"[reapeaks] 警告: 缓存媒体不存在，已跳过生成: {candidates[0]}")
    else:
        print("[reapeaks] 生成结果为空")
    return None


if __name__ == "__main__":
    import sys

    file = ReapeaksFile(sys.argv[1])
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
