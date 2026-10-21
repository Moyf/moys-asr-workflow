"""Small canonical-track mutations shared by Python subtitle operations."""

from __future__ import annotations

import copy
from collections.abc import Mapping, Sequence
from typing import Any

from maw.project_tracks import get_main_track, project_tracks, validate_tracks_project
from maw.project import ProjectValidationFailed


def fresh_segment_id(base: str, reserved: set[str]) -> str:
    """Reserve a bounded cue ID without colliding with another subtitle track."""
    candidate = base[:150]
    suffix = 2
    while candidate in reserved:
        candidate = f"{base[:150]}-{suffix}"
        suffix += 1
    reserved.add(candidate)
    return candidate


def replace_main_segments(project: dict[str, Any], segments: Sequence[Mapping[str, Any]], *, allow_unbind: bool = False) -> int:
    """Replace main cues and reconcile explicit relations in one transaction.

    Missing IDs belong to newly generated cues; malformed explicit IDs remain
    errors. Discarding existing relations requires explicit authorization from
    the calling operation. Existing cues and
    relation metadata survive, with offsets recalculated in source-media time.
    """
    main = get_main_track(project)
    reserved = {cue["id"] for track in project_tracks(project) if track is not main
                for cue in track["segments"]}
    replacement = copy.deepcopy(list(segments))
    for index, cue in enumerate(replacement):
        if not isinstance(cue, dict):
            raise ValueError(f"main segments[{index}] must be an object")
        if "id" in cue:
            identifier = cue["id"]
            if (not isinstance(identifier, str) or not identifier or identifier != identifier.strip()
                    or len(identifier) > 160 or identifier in reserved):
                raise ValueError(f"main segments[{index}].id must be globally unique")
            reserved.add(identifier)
    reserved.update(cue["id"] for cue in main["segments"])
    for index, cue in enumerate(replacement):
        if "id" not in cue:
            cue["id"] = fresh_segment_id(f"main-cue-{index + 1}", reserved)
    for kind in ("color", "sticker"):
        field = f"{kind}_group_id"
        previous = {cue[field] for cue in main["segments"] if field in cue}
        retained = {cue[field] for track in project_tracks(project)
                    for cue in (replacement if track is main else track["segments"]) if field in cue}
        if previous - retained:
            raise ValueError(f"operation cannot discard {kind} group membership")
    by_track = {track["id"]: {cue["id"]: cue for cue in
                (replacement if track is main else track["segments"])}
                for track in project_tracks(project)}
    bindings = []
    for relation in project.get("bindings", []):
        source = by_track[relation["source_track_id"]].get(relation["source_segment_ids"][0])
        target = by_track[relation["target_track_id"]].get(relation["target_segment_ids"][0])
        if source is None or target is None:
            continue
        binding = copy.deepcopy(relation)
        for edge in ("start", "end"):
            binding[f"{edge}_offset_ms"] = target[edge] - source[edge]
        bindings.append(binding)
    removed = len(project.get("bindings", [])) - len(bindings)
    if removed and not allow_unbind:
        raise ValueError("operation cannot discard bilingual bindings; detach affected cues first")
    candidate = {**project, "tracks": [{**track, "segments": replacement} if track is main else track
                                      for track in project_tracks(project)], "bindings": bindings}
    validation = validate_tracks_project(candidate)
    if not validation.ok:
        raise ProjectValidationFailed(validation.errors)
    main["segments"] = replacement
    project["bindings"] = bindings
    return removed
