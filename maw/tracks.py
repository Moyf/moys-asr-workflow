"""Read-only TrackStore/CueRef protocol over the unchanged v1 project tree.

No normalization, serialization or mutation belongs here. Callers that require
validated IDs still use project.normalize_project at their existing boundary.
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal

MAIN_TRACK_ID = 'main'
OVERLAY_TRACK_ID = 'overlay'
TrackRole = Literal['main', 'secondary', 'overlay']
Project = Mapping[str, Any]


def secondary_track_id(legacy_id: str) -> str:
    """Namespace persisted secondary IDs without changing their stored values."""
    return f'secondary:{legacy_id}'


@dataclass(frozen=True, slots=True)
class TrackView:
    id: str
    role: TrackRole
    source: Project
    _enabled: Callable[[], bool]
    legacy_id: str | None = None

    @property
    def segments(self) -> list[dict[str, Any]]:
        return self.source['segments']

    @property
    def enabled(self) -> bool:
        return self._enabled()


@dataclass(frozen=True, slots=True)
class ResolvedCue:
    track: TrackView
    index: int
    segment: dict[str, Any]


class LegacyProjectAdapter:
    """Live project accessor; re-resolve after restore/reorder/project switching.

    Only transient descriptors are allocated. All sources, arrays and cues are
    the caller's original objects. Disabled tracks and unbound cues are included.
    """
    def __init__(self, project: Project | Callable[[], Project]) -> None:
        self._get_project = project if callable(project) else lambda: project

    @property
    def project(self) -> Project:
        return self._get_project()

    def tracks(self) -> list[TrackView]:
        project = self.project
        if isinstance(project.get('tracks'), list):
            return [TrackView(source['id'], source['role'], source,
                              lambda source=source: source.get('enabled') is True)
                    for source in project['tracks']
                    if isinstance(source, Mapping) and isinstance(source.get('id'), str)
                    and isinstance(source.get('segments'), list)]
        tracks = []
        if isinstance(project.get('segments'), list):
            tracks.append(TrackView(MAIN_TRACK_ID, 'main', project, lambda: True))
        multi = project.get('multi_subtitle') or {}
        for source in multi.get('tracks') or []:
            if isinstance(source.get('id'), str) and isinstance(source.get('segments'), list):
                tracks.append(TrackView(secondary_track_id(source['id']), 'secondary', source,
                                        lambda multi=multi: multi.get('enabled') is True, source['id']))
        overlay = project.get('overlay_track')
        if isinstance(overlay, Mapping) and isinstance(overlay.get('segments'), list):
            tracks.append(TrackView(OVERLAY_TRACK_ID, 'overlay', overlay,
                                    lambda: overlay.get('enabled') is True))
        return tracks

    def get_track(self, track_id: str) -> TrackView | None:
        matches = [track for track in self.tracks() if track.id == track_id]
        return matches[0] if len(matches) == 1 else None

    def get_segments(self, track_id: str) -> list[dict[str, Any]] | None:
        track = self.get_track(track_id)
        return track.segments if track is not None else None

    def resolve(self, ref: Mapping[str, str]) -> ResolvedCue | None:
        if not isinstance(ref, Mapping):
            return None
        track_id, segment_id = ref.get('track_id'), ref.get('segment_id')
        if not isinstance(track_id, str) or not isinstance(segment_id, str) or not segment_id:
            return None
        track = self.get_track(track_id)
        if track is None:
            return None
        indices = [index for index, segment in enumerate(track.segments) if segment.get('id') == segment_id]
        return ResolvedCue(track, indices[0], track.segments[indices[0]]) if len(indices) == 1 else None

    def get_legacy_extension_track(self, track_id: str | None = None) -> Project | None:
        multi = self.project.get('multi_subtitle') or {}
        return next((track for track in multi.get('tracks') or [] if not track_id or track['id'] == track_id), None)

    def get_legacy_overlay_track(self) -> Project | None:
        return self.project.get('overlay_track')
