"""媒体派生缓存生成编排：波形嵌入 + ReaPeaks 频谱缓存。

各 provider CLI 的 ``--with-waveform`` 统一走这里，避免逐个 CLI 重复
``waveform.embed_waveform`` / ``reapeaks.generate_for_media`` 的调用与
日志样板。本模块只做编排，具体算法仍由 waveform / reapeaks 各自负责。
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import reapeaks
from waveform import embed_waveform


@dataclass
class MediaCacheResult:
    """一次媒体缓存编排的结果。

    波形失败不阻断 ReaPeaks，反之亦然；两者任一失败都不阻断工程写出。
    """

    project: dict[str, Any]
    waveform_error: Exception | None = None
    reapeaks_path: Path | None = None


def embed_media_caches(
    project: dict[str, Any],
    media_path: Path | str,
) -> MediaCacheResult:
    """嵌入波形缓存并生成 .ReaPeaks 频谱缓存（best-effort）。

    波形失败仅警告、ReaPeaks 失败仅跳过，与既有降级语义一致。
    """
    waveform_result = embed_waveform(project, media_path)
    project = waveform_result.project
    if waveform_result.error is None:
        payload = project.get("waveform")
        if payload is not None:
            print(
                f"[waveform] 已嵌入 {payload['peak_count']} peaks "
                f"({payload['peaks_per_second']}/秒)"
            )
    else:
        print(f"[waveform] 警告: {waveform_result.error}；已跳过内嵌波形")

    reapeaks_path = reapeaks.generate_for_media(Path(media_path))
    if reapeaks_path is not None:
        print(f"[reapeaks] 已生成频谱缓存: {reapeaks_path.name}")
    else:
        print("[reapeaks] 已跳过频谱缓存生成（缺少 ffmpeg 或 numpy）")
    return MediaCacheResult(
        project=project,
        waveform_error=waveform_result.error,
        reapeaks_path=reapeaks_path,
    )