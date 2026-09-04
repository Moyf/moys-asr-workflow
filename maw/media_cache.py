"""媒体派生缓存生成编排：波形嵌入 + 可选 ReaPeaks 频谱缓存。

各 provider CLI 的 ``--with-waveform`` 统一走这里，避免逐个 CLI 重复
``waveform.embed_waveform`` / ``reapeaks.generate_for_media`` 的调用与
日志样板。本模块只做编排，具体算法仍由 waveform / reapeaks 各自负责。
"""

from __future__ import annotations

import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from maw import reapeaks
from maw.waveform import embed_waveform, media_signature


@dataclass
class MediaCacheResult:
    """一次媒体缓存编排的结果。

    波形失败不阻断 ReaPeaks，反之亦然；两者任一失败都不阻断工程写出。
    """

    project: dict[str, Any]
    waveform_error: Exception | None = None
    reapeaks_path: Path | None = None


# 生成后需要合并进最终工程的缓存键。CLI 在临时目录存活期内先调用
# embed_media_caches，工程其余字段（segments 等）后处理完成后再合并，
# 避免缓存生成被挪到临时目录清理之后（v1.4.0 后回归的根因）。
CACHE_KEYS = ("waveform", "spectral", "waveform_reapeaks")


def merge_media_caches(
    target: dict[str, Any], result: MediaCacheResult
) -> dict[str, Any]:
    """把 ``result.project`` 里生成的缓存键合并进 ``target`` 工程。"""
    for key in CACHE_KEYS:
        if key in result.project:
            target[key] = result.project[key]
    return target


def embed_media_caches(
    project: dict[str, Any],
    media_path: Path | str,
    *,
    source_media_path: Path | str | None = None,
    generate_spectral: bool = False,
    ffmpeg_bin: str | None = None,
) -> MediaCacheResult:
    """嵌入波形缓存并生成 .ReaPeaks 缓存（best-effort）。

    ``source_media_path`` 是工程里记录的原始媒体，也就是编辑器将要打开的那份
    文件：源媒体可解码时，两份缓存的来源签名、``.ReaPeaks`` 的落点都指向它，
    因此临时目录被清理后服务器仍能从源媒体旁读到缓存。``media_path`` 是调用方
    手头的派生文件（测试模式的 2 分钟临时音频、本地 ASR 的 16 kHz 单声道提取），
    只在源媒体已不可读时充当解码兜底；此时缓存必须保留派生文件的真实签名，不能
    被当作源媒体的缓存。

    解码一律优先源媒体：缓存会记住被解码文件的采样率与声道数，头部没有地方
    记录"这些数据其实来自另一个文件"，用派生文件取峰会把整条时间轴重新定基
    （16 kHz 的 peak 率不是整数，取整后误差随播放位置线性累积）并让尾部失去
    覆盖。

    波形失败仅警告、ReaPeaks 失败仅跳过，与既有降级语义一致。
    ``generate_spectral`` 关闭时仍生成 ReaPeaks wave 层，但跳过频谱 FFT
    与工程内的 spectral payload。
    """
    cache_path = Path(media_path)
    source_path = (
        Path(source_media_path) if source_media_path is not None else cache_path
    )
    # 与 reapeaks.generate_for_media 同一策略：源媒体可读就解码源媒体，
    # 派生文件只在源不可用（或解不出音频）时兜底。
    decode_path = cache_path
    if source_path != cache_path and source_path.is_file():
        decode_path = source_path
    waveform_result = embed_waveform(project, decode_path, ffmpeg_bin=ffmpeg_bin)
    if (
        waveform_result.error is not None
        and decode_path != cache_path
        and cache_path.is_file()
    ):
        print(
            "[waveform] 源媒体解码失败，改用派生文件生成缓存: "
            f"{decode_path.name} -> {cache_path.name}"
        )
        decode_path = cache_path
        waveform_result = embed_waveform(project, decode_path, ffmpeg_bin=ffmpeg_bin)
    project = waveform_result.project
    if waveform_result.error is None:
        payload = project.get("waveform")
        if payload is not None:
            # embed_waveform 已按实际解码文件写入签名。这里重新取一次同一文件的
            # 签名，明确禁止回退到派生文件后把它伪装成源媒体缓存。
            payload["source"] = media_signature(decode_path)
            print(
                f"[waveform] 已嵌入 {payload['peak_count']} peaks "
                f"({payload['peaks_per_second']}/秒)"
            )
    else:
        print(f"[waveform] 警告: {waveform_result.error}；已跳过内嵌波形")

    project.pop("spectral", None)
    if generate_spectral:
        print("[reapeaks] 正在生成波形和频谱缓存（可能需要一些时间）……")
    else:
        print("[reapeaks] 正在生成波形缓存（已跳过频谱计算）……")
    reapeaks_path = reapeaks.generate_for_media(
        cache_path,
        ffmpeg_bin=ffmpeg_bin,
        include_spectral=generate_spectral,
        source_media_path=source_path,
    )
    if reapeaks_path is not None:
        cache_kind = "波形和频谱缓存" if generate_spectral else "波形缓存"
        print(f"[reapeaks] 已生成{cache_kind}: {reapeaks_path.name}")
        # generate_for_media 可能在源媒体解码失败后退回派生文件。根据头部
        # provenance 识别真实解码来源，避免嵌入层用源媒体签名覆盖派生数据。
        reapeaks_media_path: Path | None = None
        for candidate in (source_path, cache_path):
            if reapeaks._reapeaks_matches_media(reapeaks_path, candidate):
                reapeaks_media_path = candidate
                break
        if reapeaks_media_path is None:
            print("[reapeaks] 警告: 生成缓存的来源已变化，已跳过内嵌缓存")
        else:
            try:
                if generate_spectral:
                    spectral = reapeaks.extract_spectral_payload(
                        reapeaks_path,
                        reapeaks_media_path,
                    )
                    if spectral is not None:
                        project["spectral"] = spectral
                        print(f"[spectral] 已嵌入 {spectral['peak_count']} 频谱点")
                reapeaks_wave = reapeaks.extract_waveform_payload(
                    reapeaks_path, reapeaks_media_path
                )
                if reapeaks_wave is not None:
                    project["waveform_reapeaks"] = reapeaks_wave
                    print(f"[reapeaks-wave] 已嵌入 {reapeaks_wave['peak_count']} peaks")
            except (OSError, ValueError, IndexError, struct.error) as error:
                print(f"[reapeaks] 警告: 无法读取已生成缓存: {error}")
    elif not source_path.exists() and not cache_path.exists():
        # 常见于调用方把生成挪到了临时目录清理之后；明确指出真实原因，
        # 避免「缺少 ffmpeg 或 numpy」的误导。
        print(f"[reapeaks] 警告: 缓存媒体不存在，已跳过生成: {source_path}")
    else:
        print("[reapeaks] 已跳过频谱缓存生成（原因见上方 [reapeaks] 日志）")
    return MediaCacheResult(
        project=project,
        waveform_error=waveform_result.error,
        reapeaks_path=reapeaks_path,
    )
