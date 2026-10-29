"""Shared MAW project serialization and source-media metadata enrichment."""

from __future__ import annotations

import json
import copy
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from maw.media import probe_audio_tracks, probe_video_fps, project_media_reference
from maw.project import normalize_project

# 工程级波形缓存键。生成端把它们合并进运行态工程供页面即时使用，落盘边界
# （serialize_mosp / server 保存）统一剥掉：缓存真源是媒体旁的 .quapeaks /
# .mopeaks，写进工程只会让文件被 base64 撑大 33% 且每次保存"复活"。
# loudness（整文件响度标量）同样是 reapeaks 响度层的运行态派生物，随保存
# 一并恢复/剥离，编辑器据此自动定波形振幅。
INLINE_CACHE_KEYS: tuple[str, ...] = ("waveform", "spectral", "waveform_reapeaks", "loudness")


def rebase_project_media(
    project: Mapping[str, Any],
    target: Path | str,
    *,
    media_path: Path | str | None = None,
    source_project_path: Path | str | None = None,
) -> dict[str, Any]:
    """Copy a project with its media reference rebased to a known save target.

    Explicit media is a native path (relative to cwd); existing relative
    references belong to the source project, not the process working directory.
    """
    result = dict(project)
    raw = result.get("media")
    source = media_path
    if source is None and isinstance(raw, str) and raw.strip():
        source = Path(raw.strip()).expanduser()
        if not source.is_absolute():
            origin = Path(source_project_path or target).expanduser().resolve().parent
            source = origin / source
    if source is not None:
        result["media"] = project_media_reference(target, source)
    return result


def strip_inline_caches(project: Mapping[str, Any]) -> dict[str, Any]:
    """Copy persistent content without caches or reserved session highlights."""
    stripped = copy.deepcopy(dict(project))
    for key in INLINE_CACHE_KEYS:
        stripped.pop(key, None)
    stripped.pop("_dirty", None)

    def strip_track(track: object) -> None:
        if not isinstance(track, dict):
            return
        track.pop("_dirty", None)
        segments = track.get("segments")
        if isinstance(segments, list):
            for segment in segments:
                if isinstance(segment, dict):
                    segment.pop("_dirty", None)

    strip_track(stripped)
    tracks = stripped.get("tracks")
    if isinstance(tracks, list):
        for track in tracks:
            strip_track(track)
    strip_track(stripped.get("overlay_track"))
    multi = stripped.get("multi_subtitle")
    if isinstance(multi, dict):
        multi.pop("_dirty", None)
        tracks = multi.get("tracks")
        if isinstance(tracks, list):
            for track in tracks:
                strip_track(track)
    bilingual = stripped.get("bilingual")
    if isinstance(bilingual, dict):
        bilingual.pop("_dirty", None)
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
    need_video_dimensions = (
        "video_width" not in metadata or "video_height" not in metadata
    )
    need_audio_tracks = "audio_tracks" not in metadata
    if not need_video_fps and not need_video_dimensions and not need_audio_tracks:
        return enriched

    candidate = media_path
    if candidate is None:
        raw_media = enriched.get("media")
        if isinstance(raw_media, str) and raw_media.strip():
            candidate = raw_media
    if candidate is None or (isinstance(candidate, str) and not candidate.strip()):
        return enriched

    if need_video_fps or need_video_dimensions:
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
    """Validate/import a detached project and serialize only canonical v3."""

    enriched = enrich_project_media_metadata(
        normalize_project(dict(project)),
        media_path,
        ffprobe_path=ffprobe_path,
    )
    if selected_audio_track is not None:
        metadata = enriched.get("media_metadata")
        merged_metadata = dict(metadata) if isinstance(metadata, Mapping) else {}
        merged_metadata["selected_audio_track"] = selected_audio_track
        enriched["media_metadata"] = merged_metadata
    canonical = normalize_project(strip_inline_caches(enriched))
    canonical = {"schema": canonical["schema"], **canonical}
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
    portable = rebase_project_media(project, target, media_path=media_path)
    probe_media_path = media_path
    raw_media = project.get("media")
    if probe_media_path is None and isinstance(raw_media, str) and raw_media.strip():
        probe_media_path = Path(raw_media.strip()).expanduser()
        if not probe_media_path.is_absolute():
            probe_media_path = target.resolve().parent / probe_media_path
    content = serialize_mosp(
            portable,
            media_path=probe_media_path,
            ffprobe_path=ffprobe_path,
            selected_audio_track=selected_audio_track,
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{target.name}-", suffix=".tmp", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as output:
            output.write(content)
        os.replace(temporary, target)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    return target
