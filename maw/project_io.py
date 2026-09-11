"""Shared MAW project serialization and source-media metadata enrichment."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from maw.media import probe_audio_tracks, probe_video_fps
from maw.project import PROJECT_SCHEMA

# 工程级波形缓存键。生成端把它们合并进运行态工程供页面即时使用，落盘边界
# （serialize_mosp / server 保存）统一剥掉：缓存真源是媒体旁的 .quapeaks /
# .mopeaks，写进工程只会让文件被 base64 撑大 33% 且每次保存"复活"。
# loudness（整文件响度标量）同样是 reapeaks 响度层的运行态派生物，随保存
# 一并恢复/剥离，编辑器据此自动定波形振幅。
INLINE_CACHE_KEYS: tuple[str, ...] = ("waveform", "spectral", "waveform_reapeaks", "loudness")


def strip_inline_caches(project: Mapping[str, Any]) -> dict[str, Any]:
    """Return a shallow copy without the inline waveform cache payloads.

    只移除顶层这几个键，绝不触碰入参对象：server 的运行态工程与落盘副本共用
    同一个 dict，在这里原地删除会让页面波形当场消失。
    """
    stripped = dict(project)
    for key in INLINE_CACHE_KEYS:
        stripped.pop(key, None)
    return stripped


def selected_audio_track_from_metadata(metadata: object) -> int | None:
    """Return the persisted logical audio-track selection, when valid."""
    if not isinstance(metadata, Mapping):
        return None
    value = metadata.get("selected_audio_track")
    if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
        return value
    return None


def default_audio_track_from_metadata(metadata: object) -> int:
    """Return the container default track, falling back to audio index 0."""
    if not isinstance(metadata, Mapping):
        return 0
    tracks = metadata.get("audio_tracks")
    if not isinstance(tracks, list):
        return 0
    for track in tracks:
        if not isinstance(track, Mapping) or track.get("default") is not True:
            continue
        value = track.get("audio_index")
        if isinstance(value, int) and not isinstance(value, bool) and value >= 0:
            return value
    return 0


def enrich_project_media_metadata(
    project: Mapping[str, Any],
    media_path: Path | str | None = None,
    *,
    ffprobe_path: Path | str | None = None,
) -> dict[str, Any]:
    """Return a project copy with optional source-media metadata.

    Existing metadata fields are deliberately preserved. Callers can pass the
    active media explicitly; otherwise the project's ``media`` field is used
    as a best-effort fallback. FFprobe failures are handled by the media probe
    helpers and never block serialization.
    """

    enriched = dict(project)
    existing_metadata = enriched.get("media_metadata")
    if existing_metadata is not None and not isinstance(existing_metadata, Mapping):
        return enriched
    metadata = dict(existing_metadata) if isinstance(existing_metadata, Mapping) else {}
    need_video_fps = "video_fps" not in metadata
    need_audio_tracks = "audio_tracks" not in metadata
    if not need_video_fps and not need_audio_tracks:
        return enriched

    candidate = media_path
    if candidate is None:
        raw_media = enriched.get("media")
        if isinstance(raw_media, str) and raw_media.strip():
            candidate = raw_media
    if candidate is None or (isinstance(candidate, str) and not candidate.strip()):
        return enriched

    if need_video_fps:
        video_metadata = probe_video_fps(candidate, ffprobe_path=ffprobe_path)
        if video_metadata is not None:
            metadata.update(video_metadata)
    if need_audio_tracks:
        audio_tracks = probe_audio_tracks(candidate, ffprobe_path=ffprobe_path)
        if audio_tracks is not None:
            metadata["audio_tracks"] = audio_tracks
    if metadata:
        if "media" in enriched and "media_metadata" not in enriched:
            media = enriched.pop("media")
            return {"media": media, "media_metadata": metadata, **enriched}
        enriched["media_metadata"] = metadata
    return enriched


def serialize_mosp(
    project: Mapping[str, Any],
    *,
    media_path: Path | str | None = None,
    ffprobe_path: Path | str | None = None,
    selected_audio_track: int | None = None,
) -> str:
    """Serialize a MAW project after optional source-media enrichment.

    Validation and normalization remain the responsibility of the caller.
    """

    enriched = enrich_project_media_metadata(
        project,
        media_path,
        ffprobe_path=ffprobe_path,
    )
    if selected_audio_track is not None:
        metadata = enriched.get("media_metadata")
        merged_metadata = dict(metadata) if isinstance(metadata, Mapping) else {}
        merged_metadata["selected_audio_track"] = selected_audio_track
        enriched["media_metadata"] = merged_metadata
    enriched.pop("schema", None)
    canonical = {"schema": PROJECT_SCHEMA, **enriched}
    # canonical 是本函数新建的顶层 dict，在这里剥离不影响调用方的运行态。
    for key in INLINE_CACHE_KEYS:
        canonical.pop(key, None)
    return json.dumps(canonical, ensure_ascii=False, indent=2) + "\n"


def write_mosp(
    path: Path | str,
    project: Mapping[str, Any],
    *,
    media_path: Path | str | None = None,
    ffprobe_path: Path | str | None = None,
    selected_audio_track: int | None = None,
) -> Path:
    """Write a UTF-8 LF-terminated ``.mosp`` project and return its path."""

    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        serialize_mosp(
            project,
            media_path=media_path,
            ffprobe_path=ffprobe_path,
            selected_audio_track=selected_audio_track,
        ),
        encoding="utf-8",
        newline="\n",
    )
    return target
