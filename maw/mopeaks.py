"""mopeaks：MAW 自研波形的二进制 sidecar —— 没有 quapeaks 内核时的回退档。

取代原先的 ``<媒体>.waveform.json``：同一份峰数据走 JSON 要先 base64（+33%）
再套引号缩进，而它本来就是字节数组，没有必要。

刻意与 ``.quapeaks`` **同构**，只换 magic：

  18B 全局头  | 1 个 mipmap 表项 | 单个自研层

层 token 与 quapeaks 的自研层完全相同（``div = -(int)'m'``、段内前缀
``u32 sample_rate | u32 division``），所以 MAW 的 ``ReapeaksFile`` 只需一条分支
就能吃两种容器 —— "有没有内核产物"由 magic（``MPK`` vs ``QPK``）区分，
而不是靠发明第二种层类型。这也是本模块不依赖 quapeaks **内核包**的原因：
纯 ``struct``，回退档必须真的能在缺内核时用。

格式与指纹策略保留在这个纯 Python 回退模块内；即使 ``maw.quapeaks`` 或原生
内核无法导入，mopeaks 仍能独立编码、解码和校验。
"""

from __future__ import annotations

import base64
import os
import struct
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from maw.output_naming import (
    audio_track_cache_candidates,
    audio_track_cache_suffix,
    waveform_dirs,
)
from maw.waveform import (
    WAVEFORM_ENCODING,
    WAVEFORM_SCHEMA,
    is_waveform_payload,
    media_signature,
)


# 全局头长度与 REAPER/quapeaks 一致：4s magic | B ch | B layers | <III>
HEADER_LEN = 18
LAYER_HEADER_LEN = 8
MAGIC_PREFIX = b"MPK"
MAGIC = MAGIC_PREFIX + b"1"
CHANNELS = 1
LAYER_COUNT = 1
DIV_SELF_WAVE = -ord("m")
SELF_PREFIX_LEN = 8
BYTES_PER_PEAK = 2
UINT32_MASK = 0xFFFF_FFFF
UINT32_MODULUS = 0x1_0000_0000
MTIME_TOLERANCE_SECONDS = 5



class MopeaksError(ValueError):
    """mopeaks 载荷无法序列化或读回。"""


@dataclass(frozen=True, slots=True)
class MopeaksHit:
    """A validated mopeaks payload and the cache identity that supplied it."""

    payload: dict[str, Any]
    path: Path
    audio_track: int
    kind: Literal["exact", "default_fallback"]


def timestamp_fingerprint_matches(stored: int, actual: int) -> bool:
    """按 low-32 mtime 口径容忍秒级复制漂移与夏令时整小时偏差。"""
    stored &= UINT32_MASK
    actual &= UINT32_MASK
    delta = abs(stored - actual)
    delta = min(delta, UINT32_MODULUS - delta)
    return (
        delta <= MTIME_TOLERANCE_SECONDS
        or abs(delta - 3600) <= MTIME_TOLERANCE_SECONDS
    )


def mopeaks_path(
    media_path: Path | str,
    *,
    audio_track: int = 0,
    default_audio_track: int | None = None,
) -> Path:
    """mopeaks 的**写入点**：由 waveform_dirs() 的第一项决定。

    默认在媒体旁（``ICE.mkv.mopeaks``，与 .ReaPeaks/.quapeaks 同风格、保留完整媒体名）；
    用户勾了「将所有输出放入子文件夹」时进 ``_maw``。当前非 0 音轨加
    ``.track-N`` 段（N 从 1 起），否则两条轨会互相覆盖对方的缓存。
    """
    media_path = Path(media_path)
    _check_track(audio_track)
    track_suffix = audio_track_cache_suffix(
        audio_track,
        default_audio_track=default_audio_track,
    )
    return waveform_dirs(media_path)[0] / (
        media_path.name + track_suffix + ".mopeaks"
    )


def mopeaks_candidates(
    media_path: Path | str,
    *,
    audio_track: int = 0,
    default_audio_track: int | None = None,
) -> list[Path]:
    """读取顺序下的全部候选路径：写入点在前，其余位置在后。

    用户改一次设置就把已有缓存判成过期、整批重抽 ffmpeg，是最难归因的
    "静默慢"，所以所有位置都得找。
    """
    media_path = Path(media_path)
    _check_track(audio_track)
    paths: list[Path] = []
    for _, track_suffix in audio_track_cache_candidates(
        audio_track,
        default_audio_track=default_audio_track,
    ):
        filename = media_path.name + track_suffix + ".mopeaks"
        paths.extend(directory / filename for directory in waveform_dirs(media_path))
    return paths


def _check_track(audio_track: int) -> None:
    """音轨号必须是非负整数：与 maw.waveform / maw.quapeaks 同一套入口校验。"""
    if not isinstance(audio_track, int) or isinstance(audio_track, bool) or audio_track < 0:
        raise MopeaksError("audio_track 必须是非负整数")


def _exact_rate(payload: dict[str, Any]) -> tuple[int, int]:
    """取出精确刻度 (sample_rate, division)，缺失时用整数峰率等价式补齐。

    自研峰由 ``bucket_samples = round(pcm_rate / pps)`` 得来，
    ``peaks_per_second`` 是它的取整结果；若只留下取整值，就把 PR #102 修掉的
    刻度漂移又请回来了 —— 所以这里显式补一对能精确还原该比率的值。
    """
    sample_rate = payload.get("sample_rate")
    division = payload.get("division")
    if isinstance(sample_rate, int) and isinstance(division, int) and sample_rate > 0 and division > 0:
        return sample_rate, division
    pps = payload.get("peaks_per_second")
    if isinstance(pps, bool) or not isinstance(pps, (int, float)) or pps <= 0:
        raise MopeaksError("mopeaks 需要精确刻度，但载荷既无 (sample_rate, division) 也无有效 peaks_per_second")
    return int(round(pps)), 1


def encode_mopeaks(payload: dict[str, Any], media_path: Path | str) -> bytes:
    """把 ``moy.asr.waveform.v1`` 载荷编码成 mopeaks 字节。"""
    if not is_waveform_payload(payload):
        raise MopeaksError("不是有效的 moy.asr.waveform.v1 载荷")
    try:
        peaks = base64.b64decode(payload["data"], validate=True)
    except Exception as exc:  # binascii.Error 等
        raise MopeaksError(f"data 不是合法 base64: {exc}") from exc
    if not peaks or len(peaks) % BYTES_PER_PEAK:
        raise MopeaksError(f"峰数据长度 {len(peaks)} 不是 {BYTES_PER_PEAK} 的整数倍")
    peak_count = len(peaks) // BYTES_PER_PEAK
    if payload.get("peak_count") != peak_count:
        raise MopeaksError(
            f"peak_count={payload.get('peak_count')} 与 data 实际峰数 {peak_count} 不符"
        )
    sample_rate, division = _exact_rate(payload)
    st = Path(media_path).stat()
    body = struct.pack("<II", sample_rate, division) + peaks
    out = bytearray()
    out += MAGIC
    out += bytes([CHANNELS, LAYER_COUNT])
    # 全局头 sample_rate 记自研层的 PCM 率：本容器只有这一层，没有别的采样率可表。
    out += struct.pack(
        "<III", sample_rate, int(st.st_mtime) & UINT32_MASK, st.st_size & UINT32_MASK
    )
    out += struct.pack("<ii", DIV_SELF_WAVE, peak_count)
    out += body
    return bytes(out)


def decode_mopeaks(
    data: bytes,
    path: str | Path = "<mopeaks>",
    *,
    audio_track: int = 0,
) -> dict[str, Any]:
    """把 mopeaks 字节解回 ``moy.asr.waveform.v1`` 载荷。"""
    if len(data) < HEADER_LEN + LAYER_HEADER_LEN + SELF_PREFIX_LEN:
        raise MopeaksError(f"{path}: 文件过短，无法解析 mopeaks 头部")
    # 精确到版本字节：未知 MPK2/MPK9 的布局可能已变，按旧布局解会把损坏或
    # 升级产物当合法缓存。家族对但版本不认识 → 一律 cache miss。
    if data[0:3] != MAGIC_PREFIX:
        raise MopeaksError(f"{path}: magic 不是 MPK*（{data[0:4]!r}）")
    if data[0:4] != MAGIC:
        raise MopeaksError(
            f"{path}: mopeaks 版本不认识（{data[0:4]!r}，只支持 {MAGIC!r}）"
        )
    channels, layers = data[4], data[5]
    if channels != CHANNELS or layers != LAYER_COUNT:
        raise MopeaksError(
            f"{path}: mopeaks 只支持单声道单层（实得 channels={channels} layers={layers}）"
        )
    div, peak_count = struct.unpack_from("<ii", data, HEADER_LEN)
    if div != DIV_SELF_WAVE:
        raise MopeaksError(f"{path}: 唯一的层必须是自研波形层（实得 div={div}）")
    # 负数或 0 都会让下面的 need 变成非正数，从而**绕过**截断检查：
    # 0 峰不是可用缓存，负数则是损坏文件。
    if peak_count <= 0:
        raise MopeaksError(f"{path}: npeak={peak_count} 不是可用的峰数")
    off = HEADER_LEN + LAYER_HEADER_LEN
    sample_rate, division = struct.unpack_from("<II", data, off)
    off += SELF_PREFIX_LEN
    need = peak_count * BYTES_PER_PEAK
    if off + need > len(data):
        raise MopeaksError(
            f"{path}: 声明 npeak={peak_count}，需 {need} 字节，但文件只剩 {len(data) - off} 字节"
        )
    peaks = data[off : off + need]
    # 刻度必须为正：文件被截断/篡改后这里可能是 0，而除数 0 抛的是
    # ZeroDivisionError，不在 load_mopeaks 捕获的 (OSError, ValueError, struct.error)
    # 里 —— 会在耗时转写完成之后把编辑器炸掉，而不是安静地重抽一次。
    if sample_rate <= 0 or division <= 0:
        raise MopeaksError(f"{path}: 自研层刻度非法（sample_rate={sample_rate}, division={division}）")
    duration_ms = round(peak_count * division / sample_rate * 1000)
    # 签名里只放能诚实还原的部分：头存的是 low-32 的秒级 mtime 与 size，
    # modified_ms 因此只有秒精度 —— load_mopeaks 会按同一口径复核后再回填
    # 完整的 media_signature()，调用方看到的始终是这套字段。
    return {
        "schema": WAVEFORM_SCHEMA,
        "encoding": WAVEFORM_ENCODING,
        "peaks_per_second": round(sample_rate / division),
        "sample_rate": sample_rate,
        "division": division,
        "audio_track": audio_track,
        "peak_count": peak_count,
        "duration_ms": duration_ms,
        "data": base64.b64encode(peaks).decode("ascii"),
        "source": {
            "name": "",
            "size": struct.unpack_from("<I", data, 14)[0],
            "modified_ms": struct.unpack_from("<I", data, 10)[0] * 1000,
        },
    }




def save_mopeaks(
    payload: dict[str, Any],
    media_path: Path | str,
    *,
    audio_track: int = 0,
    default_audio_track: int | None = None,
) -> Path:
    """原子写入 mopeaks（临时文件 + replace，绝不做"先删后写"）。"""
    target = mopeaks_path(
        media_path,
        audio_track=audio_track,
        default_audio_track=default_audio_track,
    )
    blob = encode_mopeaks(payload, media_path)
    target.parent.mkdir(parents=True, exist_ok=True)  # _maw 可能还不存在
    fd, tmp = tempfile.mkstemp(prefix=".mopeaks-", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return target


def load_waveform_cache(
    media_path: Path | str,
    *,
    audio_track: int = 0,
    default_audio_track: int | None = None,
) -> dict[str, Any] | None:
    """读媒体旁的自研波形缓存；缺失/损坏/签名不符一律 None（= 该重抽）。

    旧 <媒体>.waveform.json **不再读**：本次任务已彻底去掉 JSON sidecar，
    历史文件留在盘上不管，代价是老用户第一次打开重抽一次 ffmpeg（换取只有一种缓存）。
    """
    return load_mopeaks(
        media_path,
        audio_track=audio_track,
        default_audio_track=default_audio_track,
    )


def load_mopeaks(
    media_path: Path | str,
    *,
    audio_track: int = 0,
    default_audio_track: int | None = None,
) -> dict[str, Any] | None:
    """读取并校验媒体旁的 mopeaks；缺失/损坏/签名不符时返回 None。"""
    hit = load_mopeaks_hit(
        media_path,
        audio_track=audio_track,
        default_audio_track=default_audio_track,
    )
    return hit.payload if hit is not None and hit.kind == "exact" else None


def load_mopeaks_hit(
    media_path: Path | str,
    *,
    audio_track: int = 0,
    default_audio_track: int | None = None,
) -> MopeaksHit | None:
    """Return a validated exact or default-fallback mopeaks cache hit."""
    media_path = Path(media_path)
    try:
        st = media_path.stat()
    except OSError:
        return None
    for candidate_track, track_suffix in audio_track_cache_candidates(
        audio_track,
        default_audio_track=default_audio_track,
    ):
        filename = media_path.name + track_suffix + ".mopeaks"
        for path in (directory / filename for directory in waveform_dirs(media_path)):
            try:
                payload = decode_mopeaks(
                    path.read_bytes(),
                    path,
                    audio_track=candidate_track,
                )
            except (OSError, ValueError, struct.error):
                continue  # 这个位置没有/坏了，接着找下一个
            if payload["source"]["size"] != st.st_size & UINT32_MASK:
                continue
            if not timestamp_fingerprint_matches(
                payload["source"]["modified_ms"] // 1000, int(st.st_mtime)
            ):
                continue
            payload["source"] = media_signature(media_path)
            if is_waveform_payload(payload):
                return MopeaksHit(
                    payload=payload,
                    path=path,
                    audio_track=candidate_track,
                    kind="exact" if candidate_track == audio_track else "default_fallback",
                )
    return None
