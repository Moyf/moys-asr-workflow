"""mopeaks：MAW 自研波形的二进制 sidecar —— 没有 quapeaks 内核时的回退档。

取代原先的 ``<媒体>.waveform.json``：同一份峰数据走 JSON 要先 base64（+33%）
再套引号缩进，而它本来就是字节数组，没有必要。

刻意与 ``.quapeaks`` **同构**，只换 magic：

  18B 全局头  | 1 个 mipmap 表项 | 单个自研层

层 token 与 quapeaks 的自研层完全相同（``div = -(int)'m'``、段内前缀
``u32 sample_rate | u32 division``），所以 MAW 的 ``ReaPeaksFile`` 只需一条分支
就能吃两种容器 —— "有没有内核产物"由 magic（``MPK`` vs ``QPK``）区分，
而不是靠发明第二种层类型。这也是本模块不依赖 quapeaks **内核包**的原因：
纯 ``struct``，回退档必须真的能在缺内核时用。

自研层的格式常量（层 token、段前缀长度、每峰字节数）与低 32 位指纹判定一律
**从 ``maw.quapeaks`` 借用**，不在这里抄第二份：那个模块的解析部分本就是纯
Python（内核只在生成时按调用点导入），抄一份只会让两级缓存在"媒体变没变"
和"自研层是哪个 token"上各自漂移。
"""

from __future__ import annotations

import base64
import json
import os
import struct
import tempfile
from pathlib import Path
from typing import Any

from maw.quapeaks import (
    DIV_SELF_WAVE,
    SELF_WAVE_BYTES_PER_PEAK as BYTES_PER_PEAK,
    SELF_WAVE_PREFIX_LEN as SELF_PREFIX_LEN,
    UINT32_MASK,
    timestamp_fingerprint_matches,
)
from maw.waveform import (
    WAVEFORM_ENCODING,
    WAVEFORM_SCHEMA,
    is_waveform_payload,
    media_signature,
    waveform_matches_media,
)

# 0.x 版把载荷写成 JSON sidecar（媒体后缀被 with_suffix 整个换掉）。
# 现只写 mopeaks，但旧文件要还能读，否则用户升级后第一次打开=全量重抽。
LEGACY_SIDECAR_SUFFIX = ".waveform.json"

# 全局头长度与 REAPER/quapeaks 一致：4s magic | B ch | B layers | <III>
HEADER_LEN = 18
LAYER_HEADER_LEN = 8
MAGIC_PREFIX = b"MPK"
MAGIC = MAGIC_PREFIX + b"1"
CHANNELS = 1
LAYER_COUNT = 1



class MopeaksError(ValueError):
    """mopeaks 载荷无法序列化或读回。"""


def mopeaks_path(media_path: Path | str) -> Path:
    """返回媒体旁的 mopeaks 路径（保留完整媒体名，与 .ReaPeaks/.quapeaks 同风格）。"""
    media_path = Path(media_path)
    return media_path.with_name(media_path.name + ".mopeaks")


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


def decode_mopeaks(data: bytes, path: str | Path = "<mopeaks>") -> dict[str, Any]:
    """把 mopeaks 字节解回 ``moy.asr.waveform.v1`` 载荷。"""
    if len(data) < HEADER_LEN + LAYER_HEADER_LEN + SELF_PREFIX_LEN:
        raise MopeaksError(f"{path}: 文件过短，无法解析 mopeaks 头部")
    if data[0:3] != MAGIC_PREFIX:
        raise MopeaksError(f"{path}: magic 不是 MPK*（{data[0:4]!r}）")
    channels, layers = data[4], data[5]
    if channels != CHANNELS or layers != LAYER_COUNT:
        raise MopeaksError(
            f"{path}: mopeaks 只支持单声道单层（实得 channels={channels} layers={layers}）"
        )
    div, peak_count = struct.unpack_from("<ii", data, HEADER_LEN)
    if div != DIV_SELF_WAVE:
        raise MopeaksError(f"{path}: 唯一的层必须是自研波形层（实得 div={div}）")
    off = HEADER_LEN + LAYER_HEADER_LEN
    sample_rate, division = struct.unpack_from("<II", data, off)
    off += SELF_PREFIX_LEN
    need = peak_count * BYTES_PER_PEAK
    if off + need > len(data):
        raise MopeaksError(
            f"{path}: 声明 npeak={peak_count}，需 {need} 字节，但文件只剩 {len(data) - off} 字节"
        )
    peaks = data[off : off + need]
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
        "peak_count": peak_count,
        "duration_ms": duration_ms,
        "data": base64.b64encode(peaks).decode("ascii"),
        "source": {
            "name": "",
            "size": struct.unpack_from("<I", data, 14)[0],
            "modified_ms": struct.unpack_from("<I", data, 10)[0] * 1000,
        },
    }


def load_legacy_json_sidecar(media_path: Path | str) -> dict[str, Any] | None:
    """只读兼容：旧版本写在媒体旁的 JSON sidecar；缺失/损坏/签名不符给 None。

    没有任何地方再写它，所以这是一个只会萎缩的入口。
    """
    legacy = Path(media_path).with_suffix(LEGACY_SIDECAR_SUFFIX)
    try:
        value = json.loads(legacy.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        return None
    return value if is_waveform_payload(value) else None


def load_waveform_cache(media_path: Path | str) -> dict[str, Any] | None:
    """读媒体旁的自研波形缓存：mopeaks 优先，回退旧 JSON 并就地迁移。

    调用方拿到 None 就该重新提取——签名校验、结构校验都在这里做完，
    坏文件不会被当成"有缓存"从而让编辑器画出一条空波形。
    """
    payload = load_mopeaks(media_path)
    if payload is not None:
        return payload
    legacy = load_legacy_json_sidecar(media_path)
    if legacy is None or not waveform_matches_media(legacy, Path(media_path)):
        return None
    try:
        save_mopeaks(legacy, media_path)
    except (OSError, MopeaksError):
        # 迁移只是省一次重抽，不值得为它让读取失败。
        return legacy
    # 交回迁移后的版本：老 JSON 只有取整的 peaks_per_second，
    # 而 mopeaks 里补好了精确刻度 (sample_rate, division)。
    return load_mopeaks(media_path) or legacy


def save_mopeaks(payload: dict[str, Any], media_path: Path | str) -> Path:
    """原子写入 mopeaks（临时文件 + replace，绝不做"先删后写"）。"""
    target = mopeaks_path(media_path)
    blob = encode_mopeaks(payload, media_path)
    fd, tmp = tempfile.mkstemp(prefix=".mopeaks-", dir=str(target.parent))
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(blob)
        os.replace(tmp, target)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    return target


def load_mopeaks(media_path: Path | str) -> dict[str, Any] | None:
    """读取并校验媒体旁的 mopeaks；缺失/损坏/签名不符时返回 None。"""
    media_path = Path(media_path)
    path = mopeaks_path(media_path)
    try:
        payload = decode_mopeaks(path.read_bytes(), path)
    except (OSError, ValueError, struct.error):
        return None
    # source 里只存了秒级 mtime 与 size，按同口径复核。判定直接借用内核
    # 缓存那一套（低 32 位掩码 + mtime 环形指纹，容秒级漂移与 DST 整小时），
    # 否则同一份跨盘拷贝会出现 .quapeaks 认、mopeaks 不认的分叉。
    try:
        st = media_path.stat()
    except OSError:
        return None
    if payload["source"]["size"] != st.st_size & UINT32_MASK:
        return None
    if not timestamp_fingerprint_matches(
        payload["source"]["modified_ms"] // 1000, int(st.st_mtime)
    ):
        return None
    payload["source"] = media_signature(media_path)
    if not is_waveform_payload(payload):
        return None
    return payload
