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
) -> MediaCacheResult:
    """嵌入波形缓存并生成 .ReaPeaks 缓存（best-effort）。

    ``media_path`` 是实际用于解码和生成缓存的文件；``source_media_path``
    是工程中记录的原始媒体。测试模式会把前者指向临时的 2 分钟音频，
    但缓存的来源签名仍指向后者，避免工程加载时被误判为缓存失效；
    ``.ReaPeaks`` 也写到源媒体旁（而非临时文件旁），临时目录清理后
    服务器仍能从源媒体旁读到它。

    波形失败仅警告、ReaPeaks 失败仅跳过，与既有降级语义一致。
    ``generate_spectral`` 关闭时仍生成 ReaPeaks wave 层，但跳过频谱 FFT
    与工程内的 spectral payload。
    """
    cache_path = Path(media_path)
    source_path = (
        Path(source_media_path) if source_media_path is not None else cache_path
    )
    waveform_result = embed_waveform(project, cache_path)
    project = waveform_result.project
    if waveform_result.error is None:
        payload = project.get("waveform")
        if payload is not None:
            payload["source"] = media_signature(source_path)
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
        include_spectral=generate_spectral,
        source_media_path=source_path,
    )
    if reapeaks_path is not None:
        cache_kind = "波形和频谱缓存" if generate_spectral else "波形缓存"
        print(f"[reapeaks] 已生成{cache_kind}: {reapeaks_path.name}")
        try:
            if generate_spectral:
                spectral = reapeaks.extract_spectral_payload(
                    reapeaks_path,
                    source_path,
                )
                if spectral is not None:
                    project["spectral"] = spectral
                    print(f"[spectral] 已嵌入 {spectral['peak_count']} 频谱点")
            reapeaks_wave = reapeaks.extract_waveform_payload(
                reapeaks_path, source_path
            )
            if reapeaks_wave is not None:
                project["waveform_reapeaks"] = reapeaks_wave
                print(f"[reapeaks-wave] 已嵌入 {reapeaks_wave['peak_count']} peaks")
        except (OSError, ValueError, IndexError, struct.error) as error:
            print(f"[reapeaks] 警告: 无法读取已生成缓存: {error}")
    elif not cache_path.exists():
        # 常见于调用方把生成挪到了临时目录清理之后；明确指出真实原因，
        # 避免「缺少 ffmpeg 或 numpy」的误导。
        print(f"[reapeaks] 警告: 缓存媒体不存在，已跳过生成: {cache_path}")
    else:
        print("[reapeaks] 已跳过频谱缓存生成（原因见上方 [reapeaks] 日志）")
    return MediaCacheResult(
        project=project,
        waveform_error=waveform_result.error,
        reapeaks_path=reapeaks_path,
    )
