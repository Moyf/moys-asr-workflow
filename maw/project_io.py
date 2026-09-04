"""Shared MAW project serialization and source-media metadata enrichment."""

from __future__ import annotations

import json
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from maw.media import probe_video_fps


def enrich_project_media_metadata(
    project: Mapping[str, Any],
    media_path: Path | str | None = None,
    *,
    ffprobe_path: Path | str | None = None,
) -> dict[str, Any]:
    """Return a project copy with optional source-video FPS metadata.

    Existing ``media_metadata`` is deliberately preserved.  Callers can pass
    the active media explicitly; otherwise the project's ``media`` field is
    used as a best-effort fallback.  FFprobe failures are handled by
    :func:`maw.media.probe_video_fps` and never block serialization.
    """

    enriched = dict(project)
    if "media_metadata" in enriched:
        return enriched

    candidate = media_path
    if candidate is None:
        raw_media = enriched.get("media")
        if isinstance(raw_media, str) and raw_media.strip():
            candidate = raw_media
    if candidate is None or (isinstance(candidate, str) and not candidate.strip()):
        return enriched

    media_metadata = probe_video_fps(candidate, ffprobe_path=ffprobe_path)
    if media_metadata is not None:
        if "media" in enriched:
            media = enriched.pop("media")
            return {"media": media, "media_metadata": media_metadata, **enriched}
        enriched["media_metadata"] = media_metadata
    return enriched


def serialize_mosp(
    project: Mapping[str, Any],
    *,
    media_path: Path | str | None = None,
    ffprobe_path: Path | str | None = None,
) -> str:
    """Serialize a MAW project after optional source-media enrichment.

    Validation and normalization remain the responsibility of the caller.
    """

    enriched = enrich_project_media_metadata(
        project,
        media_path,
        ffprobe_path=ffprobe_path,
    )
    return json.dumps(enriched, ensure_ascii=False, indent=2) + "\n"


def write_mosp(
    path: Path | str,
    project: Mapping[str, Any],
    *,
    media_path: Path | str | None = None,
    ffprobe_path: Path | str | None = None,
) -> Path:
    """Write a UTF-8 LF-terminated ``.mosp`` project and return its path."""

    target = Path(path).expanduser()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(
        serialize_mosp(
            project,
            media_path=media_path,
            ffprobe_path=ffprobe_path,
        ),
        encoding="utf-8",
        newline="\n",
    )
    return target
