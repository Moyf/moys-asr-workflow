"""Canonical subtitle tracks and lossless v1/v2 import boundary.

The v2 group contract follows PR #239 at 740953e2093c8a54fe17cabbe1b2d07d44ccd607.
Legacy containers are read only in this module; all returned projects use v2.
"""

from __future__ import annotations

import copy
from dataclasses import dataclass
from typing import Any, Iterator

from maw.project import (
    ProjectValidationError, ProjectValidationFailed, ProjectValidationResult,
    _validate_head_refs, _validate_media_metadata, _validate_segment,
    _validate_timebase, _validate_transcription_metadata,
)
from maw.project_preview import JsonDict, JsonValue, validate_preview

TRACKS_PROJECT_SCHEMA = "moy.asr.project.v2"
LEGACY_PROJECT_SCHEMA = "moy.asr.project.v1"
GROUP_PROJECT_SCHEMA = "moy.asr.project.v1.5"
GROUP_PROJECT_SCHEMAS = frozenset({GROUP_PROJECT_SCHEMA})
TRACK_ROLES = frozenset({"main", "secondary", "overlay"})
TRACK_SOURCE_FIELDS = (
    "language", "language_source", "split_mode", "timestamp_granularity",
    "model", "preserve_punctuation", "source_name",
)
LEGACY_CONTAINERS = ("segments", "overlay_track", "multi_subtitle")


def _fail(path: str, message: str) -> None:
    raise ProjectValidationFailed((ProjectValidationError(path, message),))


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        _fail(path, "must be an object")
    return value


def _array(value: Any, path: str) -> list[Any]:
    if not isinstance(value, list):
        _fail(path, "must be an array")
    return value


def _identifier(value: Any, path: str, *, trim: bool = False) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 160:
        _fail(path, "must be a non-empty string of at most 160 characters")
    if not trim and value != value.strip():
        _fail(path, "must not have surrounding whitespace")
    return value.strip() if trim else value


def _fresh_id(base: str, reserved: set[str]) -> str:
    base = base[:150]
    result = base
    suffix = 2
    while result in reserved:
        result = f"{base}-{suffix}"
        suffix += 1
    reserved.add(result)
    return result


def project_tracks(project: dict[str, Any]) -> list[dict[str, Any]]:
    """Return canonical track entities, never a legacy projection."""
    return project["tracks"]


def get_track(project: dict[str, Any], track_id: str) -> dict[str, Any] | None:
    return next((track for track in project_tracks(project) if track["id"] == track_id), None)


def get_tracks_by_role(project: dict[str, Any], role: str) -> list[dict[str, Any]]:
    return [track for track in project_tracks(project) if track["role"] == role]


def get_main_track(project: dict[str, Any]) -> dict[str, Any]:
    tracks = get_tracks_by_role(project, "main")
    if len(tracks) != 1:
        _fail("$.tracks", "must contain exactly one main track")
    return tracks[0]


def iter_segments(project: dict[str, Any]) -> Iterator[dict[str, Any]]:
    for track in project_tracks(project):
        yield from track["segments"]


def make_project(
    segments: list[JsonValue],
    *,
    main_fields: dict[str, Any] | None = None,
    project_fields: dict[str, Any] | None = None,
) -> JsonDict:
    """Create a new v2 project for ASR/SRT producers, preserving cue payloads.

    Missing cue IDs are generated only here (and in legacy import), never in
    strict v2 validation. Explicit invalid or duplicate IDs remain errors.
    """
    project = copy.deepcopy(project_fields if project_fields is not None else {})
    for key in ("schema", "tracks"):
        if key in project:
            _fail(f"$.{key}", "is owned by the project factory")
    main = copy.deepcopy(main_fields if main_fields is not None else {})
    if "segments" in main:
        _fail("$.tracks[0].segments", "pass segments to the project factory directly")
    main.setdefault("id", "main")
    main.setdefault("name", "主字幕")
    main.setdefault("role", "main")
    main.setdefault("enabled", True)
    main["segments"] = copy.deepcopy(_array(segments, "$.tracks[0].segments"))
    reserved: set[str] = set()
    for index, raw_cue in enumerate(main["segments"]):
        cue = _object(raw_cue, f"$.tracks[0].segments[{index}]")
        if "id" in cue:
            identifier = _identifier(cue["id"], f"$.tracks[0].segments[{index}].id")
            if identifier in reserved:
                _fail(f"$.tracks[0].segments[{index}].id", "must be a unique cue ID")
            reserved.add(identifier)
    for index, cue in enumerate(main["segments"]):
        if "id" not in cue:
            cue["id"] = _fresh_id(f"{main['id']}-cue-{index + 1}", reserved)
    project.update(schema=TRACKS_PROJECT_SCHEMA, tracks=[main])
    project.setdefault("bindings", [])
    project.setdefault("bilingual", {"display_mode": "both"})
    project.setdefault("subtitle_groups", {"next_id": 1, "color": [], "sticker": []})
    _validate_canonical(project)
    return project


def _validate_groups(project: dict[str, Any]) -> None:
    table = _object(project.get("subtitle_groups"), "$.subtitle_groups")
    if "next_id" in table and (type(table["next_id"]) is not int or not 1 <= table["next_id"] <= 9007199254740991):
        _fail("$.subtitle_groups.next_id", "must be a positive safe integer")
    for kind in ("color", "sticker"):
        groups = _array(table.get(kind), f"$.subtitle_groups.{kind}")
        group_ids: set[str] = set()
        for index, raw in enumerate(groups):
            path = f"$.subtitle_groups.{kind}[{index}]"
            group = _object(raw, path)
            identifier = _identifier(group.get("id"), f"{path}.id")
            if identifier in group_ids:
                _fail(f"{path}.id", "must be unique within its collection")
            group_ids.add(identifier)
            value = _object(group.get("value"), f"{path}.value")
            if not isinstance(value.get("name"), str):
                _fail(f"{path}.value.name", "must be a string")
            if "start" in value or "end" in value:
                _fail(f"{path}.value", "group range is derived from members")
        for ti, track in enumerate(project["tracks"]):
            for si, cue in enumerate(track["segments"]):
                path = f"$.tracks[{ti}].segments[{si}]"
                field = f"{kind}_group_id"
                if field in cue and (not isinstance(cue[field], str) or cue[field] not in group_ids):
                    _fail(f"{path}.{field}", "must reference an existing group")
                if kind in cue or f"{kind}_ref" in cue:
                    _fail(f"{path}.{kind}", "legacy group fields are not allowed in v2")


def _validate_bindings(project: dict[str, Any]) -> None:
    bindings = _array(project.get("bindings"), "$.bindings")
    tracks = {track["id"]: track for track in project["tracks"]}
    binding_ids: set[str] = set()
    used_source: set[tuple[str, str]] = set()
    used_target: set[str] = set()
    for index, raw in enumerate(bindings):
        path = f"$.bindings[{index}]"
        binding = _object(raw, path)
        identifier = _identifier(binding.get("id"), f"{path}.id")
        if identifier in binding_ids:
            _fail(f"{path}.id", "must be unique within its collection")
        binding_ids.add(identifier)
        for field in ("source_track_id", "target_track_id", "source_segment_ids", "target_segment_ids"):
            if field in binding:
                _fail(f"{path}.{field}", "legacy binding field is not allowed")
        endpoints = []
        for side, role in (("source", "main"), ("target", "secondary")):
            ref = _object(binding.get(side), f"{path}.{side}")
            track_id = ref.get("track_id")
            if not isinstance(track_id, str) or track_id not in tracks or tracks[track_id]["role"] != role:
                _fail(f"{path}.{side}.track_id", f"must reference an existing {role} track")
            cue_id = _identifier(ref.get("segment_id"), f"{path}.{side}.segment_id")
            cue = next((cue for cue in tracks[track_id]["segments"] if cue["id"] == cue_id), None)
            if cue is None:
                _fail(f"{path}.{side}.segment_id", "must reference a cue on the specified track")
            endpoints.append(cue)
        source, target = endpoints
        pair = (binding["target"]["track_id"], source["id"])
        if pair in used_source or target["id"] in used_target:
            _fail(path, "must be one-to-one within the source/target track pair")
        used_source.add(pair)
        used_target.add(target["id"])
        for edge in ("start", "end"):
            field = f"{edge}_offset_ms"
            if type(binding.get(field)) is not int or binding[field] != target[edge] - source[edge]:
                _fail(f"{path}.{field}", "must equal the segment time offset in integer milliseconds")


def _validate_canonical(project: dict[str, Any]) -> None:
    if project.get("schema") != TRACKS_PROJECT_SCHEMA:
        _fail("$.schema", f"must be {TRACKS_PROJECT_SCHEMA}")
    for field in (*LEGACY_CONTAINERS, *TRACK_SOURCE_FIELDS):
        if field in project:
            _fail(f"$.{field}", "legacy field is not allowed in v2")
    tracks = _array(project.get("tracks"), "$.tracks")
    seen_tracks: set[str] = set()
    seen_cues: set[str] = set()
    main_count = overlay_count = 0
    errors: list[ProjectValidationError] = []
    _validate_timebase(project, errors)
    _validate_media_metadata(project, errors)
    _validate_transcription_metadata(project, errors)
    errors.extend(ProjectValidationError(path, message) for path, message in validate_preview(project))
    for ti, raw_track in enumerate(tracks):
        path = f"$.tracks[{ti}]"
        track = _object(raw_track, path)
        identifier = _identifier(track.get("id"), f"{path}.id")
        if identifier in seen_tracks:
            _fail(f"{path}.id", "must be a unique track ID")
        seen_tracks.add(identifier)
        role = track.get("role")
        if not isinstance(role, str) or role not in TRACK_ROLES:
            _fail(f"{path}.role", "must be main, secondary, or overlay")
        main_count += role == "main"
        overlay_count += role == "overlay"
        if type(track.get("enabled")) is not bool:
            _fail(f"{path}.enabled", "must be a boolean")
        if role == "main" and track["enabled"] is not True:
            _fail(f"{path}.enabled", "main track must be enabled")
        if "preview_visible" in track and type(track["preview_visible"]) is not bool:
            _fail(f"{path}.preview_visible", "must be a boolean")
        if "variant" in track and not isinstance(track["variant"], str):
            _fail(f"{path}.variant", "must be a string")
        if "export" in track:
            export = _object(track["export"], f"{path}.export")
            if "enabled" in export and type(export["enabled"]) is not bool:
                _fail(f"{path}.export.enabled", "must be a boolean")
        for field in ("name", "model", "source_name"):
            if (field == "name" or field in track) and not isinstance(track.get(field), str):
                _fail(f"{path}.{field}", "must be a string")
        if "preserve_punctuation" in track and type(track["preserve_punctuation"]) is not bool:
            _fail(f"{path}.preserve_punctuation", "must be a boolean")
        if "metadata" in track:
            _object(track["metadata"], f"{path}.metadata")
        if "split_mode_override" in track and track["split_mode_override"] not in ("continuous", "word"):
            _fail(f"{path}.split_mode_override", "must be continuous or word")
        track_errors: list[ProjectValidationError] = []
        # Root-only settings with the same spelling can be vendor fields on a
        # track. Validate only the source metadata defined by the track schema.
        _validate_transcription_metadata({field: track[field] for field in TRACK_SOURCE_FIELDS if field in track}, track_errors)
        errors.extend(ProjectValidationError(path + error.path[1:], error.message) for error in track_errors)
        previous_end = None
        for si, raw_cue in enumerate(_array(track.get("segments"), f"{path}.segments")):
            cue_path = f"{path}.segments[{si}]"
            cue = _object(raw_cue, cue_path)
            cue_id = _identifier(cue.get("id"), f"{cue_path}.id")
            if cue_id in seen_cues:
                _fail(f"{cue_path}.id", "must be a unique project-wide cue ID")
            seen_cues.add(cue_id)
            # Existing ASS validation normalizes its argument; validate a copy so
            # v2 validation and unknown ASS metadata round trips are non-mutating.
            _validate_segment(copy.deepcopy(cue), cue_path, previous_end, errors)
            timed_values = [(cue, cue_path)]
            if isinstance(cue.get("items"), list):
                timed_values.extend((item, f"{cue_path}.items[{index}]")
                                    for index, item in enumerate(cue["items"]) if isinstance(item, dict))
            for timed, timed_path in timed_values:
                for field in ("start", "end", "start_frame", "end_frame"):
                    if field in timed and type(timed[field]) is int and abs(timed[field]) > 9007199254740991:
                        errors.append(ProjectValidationError(f"{timed_path}.{field}", "must be a safe integer"))
            if "disabled" in cue and type(cue["disabled"]) is not bool:
                _fail(f"{cue_path}.disabled", "must be a boolean")
            if type(cue.get("end")) is int:
                previous_end = cue["end"]
    if main_count != 1:
        _fail("$.tracks", "must contain exactly one main track")
    if sum(track["role"] == "secondary" for track in tracks) > 1:
        _fail("$.tracks", "supports at most one secondary track")
    if overlay_count > 1:
        _fail("$.tracks", "supports at most one overlay track")
    if errors:
        raise ProjectValidationFailed(tuple(errors))
    bilingual = _object(project.get("bilingual"), "$.bilingual")
    if "enabled" in bilingual:
        _fail("$.bilingual.enabled", "enabled belongs to each track")
    if bilingual.get("display_mode") not in ("main", "extension", "both"):
        _fail("$.bilingual.display_mode", "must be main, extension, or both")
    extensions = [track for track in tracks if track["role"] == "secondary"]
    active = bilingual.get("active_track_id")
    if extensions or "active_track_id" in bilingual:
        if not isinstance(active, str) or not any(track["id"] == active for track in extensions):
            _fail("$.bilingual.active_track_id", "must reference an existing extension track")
    _validate_bindings(project)
    _validate_groups(project)


def validate_tracks_project(raw: JsonValue) -> ProjectValidationResult:
    """Strict v2 validation, returning a detached project only on success."""
    try:
        project = copy.deepcopy(_object(raw, "$"))
        _validate_canonical(project)
        return ProjectValidationResult(True, (), project)
    except ProjectValidationFailed as error:
        return ProjectValidationResult(False, error.errors, None)


def _legacy_groups(project: dict[str, Any]) -> None:
    table: dict[str, Any] = {"next_id": 1, "color": [], "sticker": []}
    for ti, track in enumerate(project["tracks"]):
        segments = track["segments"]
        errors: list[ProjectValidationError] = []
        _validate_head_refs(segments, errors, path_prefix=f"$.tracks[{ti}].segments")
        if errors:
            raise ProjectValidationFailed(tuple(errors))
        for kind in ("color", "sticker"):
            heads: dict[int, str] = {}
            reserved: set[str] = {group["id"] for group in table[kind]}
            for index, cue in enumerate(segments):
                if cue.get(kind) is not None:
                    value = copy.deepcopy(cue[kind])
                    value.pop("start", None)
                    value.pop("end", None)
                    identifier = _fresh_id(f"{kind}-{track['id']}-{index + 1}", reserved)
                    table[kind].append({"id": identifier, "value": value})
                    heads[index] = identifier
            for index, cue in enumerate(segments):
                ref = cue.get(f"{kind}_ref")
                identifier = heads.get(ref["headIdx"] if ref is not None else index)
                if identifier is not None:
                    field = f"{kind}_group_id"
                    if field in cue:
                        _fail(f"$.tracks[{ti}].segments[{index}].{field}", "migration metadata conflict")
                    cue[field] = identifier
                if ref is not None:
                    extra = {key: value for key, value in ref.items() if key not in ("headIdx", "name")}
                    if extra:
                        field = f"{kind}_group_metadata"
                        if field in cue:
                            _fail(f"$.tracks[{ti}].segments[{index}].{field}", "migration metadata conflict")
                        cue[field] = extra
                cue.pop(kind, None)
                cue.pop(f"{kind}_ref", None)
    project["subtitle_groups"] = table


def _legacy_normalized_ids(values: list[dict[str, Any]], prefix: str) -> list[str]:
    """Reproduce old implicit IDs only to resolve references during import.

    These aliases never become a second persisted identity. Legacy writers
    could omit an ID while binding to the deterministic ID filled by v1.
    """
    reserved = {value["id"] for value in values if "id" in value}
    used: set[str] = set()
    identifiers = []
    for index, value in enumerate(values):
        if "id" in value:
            identifier = value["id"]
        else:
            base = f"{prefix}-{index + 1:03d}"
            identifier = base
            suffix = 2
            while identifier in used or (identifier != base and identifier in reserved):
                identifier = f"{base}-{suffix}"
                suffix += 1
            if identifier in reserved:
                identifier = f"{base}-generated"
                suffix = 2
                while identifier in used or identifier in reserved:
                    identifier = f"{base}-generated-{suffix}"
                    suffix += 1
        identifiers.append(identifier)
        used.add(identifier)
    return identifiers


def _legacy_track_ids(extensions: list[Any]) -> tuple[set[str], dict[str, str]]:
    reserved: set[str] = set()
    for index, raw in enumerate(extensions):
        track = _object(raw, f"$.multi_subtitle.tracks[{index}]")
        if "id" in track:
            identifier = _identifier(track["id"], f"$.multi_subtitle.tracks[{index}].id", trim=True)
            if identifier in reserved:
                _fail(f"$.multi_subtitle.tracks[{index}].id", "must be a unique track ID")
            reserved.add(identifier)
            track["id"] = identifier
    old_ids = _legacy_normalized_ids(extensions, "extension")
    for index, track in enumerate(extensions):
        if "id" not in track:
            track["id"] = _fresh_id(f"extension-{index + 1}", reserved)
    return reserved, {old_id: track["id"] for old_id, track in zip(old_ids, extensions)}


def _validate_legacy_content(project: dict[str, Any], multi: dict[str, Any], *, has_legacy_groups: bool) -> None:
    """Report independent field failures before any reference is migrated."""
    errors: list[ProjectValidationError] = []
    _validate_timebase(project, errors)
    _validate_media_metadata(project, errors)
    _validate_transcription_metadata(project, errors)
    errors.extend(ProjectValidationError(path, message) for path, message in validate_preview(project))
    extension_index = 0
    for index, track in enumerate(project["tracks"]):
        path = f"$.tracks[{index}]"
        source_path = "$.segments" if track["role"] == "main" else "$.overlay_track.segments"
        if track["role"] == "secondary":
            source_path = f"$.multi_subtitle.tracks[{extension_index}].segments"
            extension_index += 1
        metadata_errors: list[ProjectValidationError] = []
        _validate_transcription_metadata({field: track[field] for field in TRACK_SOURCE_FIELDS if field in track}, metadata_errors)
        errors.extend(ProjectValidationError(path + error.path[1:], error.message) for error in metadata_errors)
        if "split_mode_override" in track and track["split_mode_override"] not in ("word", "continuous"):
            errors.append(ProjectValidationError(f"{path}.split_mode_override", "must be continuous or word"))
        if "preserve_punctuation" in track and type(track["preserve_punctuation"]) is not bool:
            errors.append(ProjectValidationError(f"{path}.preserve_punctuation", "must be a boolean"))
        segments = track["segments"]
        if not isinstance(segments, list):
            errors.append(ProjectValidationError(f"{path}.segments", "must be an array"))
            continue
        previous_end = None
        for segment_index, segment in enumerate(segments):
            segment_path = f"{path}.segments[{segment_index}]"
            if not isinstance(segment, dict):
                errors.append(ProjectValidationError(segment_path, "must be an object"))
                continue
            checked_segment = copy.deepcopy(segment)
            segment_errors: list[ProjectValidationError] = []
            _validate_segment(checked_segment, segment_path, previous_end, segment_errors)
            for error in segment_errors:
                error_path = error.path
                if error_path.startswith(f"{segment_path}.assOverride"):
                    error_path = f"{source_path}[{segment_index}]" + error_path[len(segment_path):]
                errors.append(ProjectValidationError(error_path, error.message))
            if not segment_errors and isinstance(segment.get("assOverride"), dict):
                # Legacy import keeps its historical two-decimal scale/default
                # normalization, while unknown fields survive the conversion.
                original = segment["assOverride"]
                override = {key: value for key, value in original.items() if key not in ("scale", "pos")}
                override.update(checked_segment.get("assOverride", {}))
                if "pos" in override:
                    override["pos"] = {**original["pos"], **override["pos"]}
                if override:
                    segment["assOverride"] = override
                else:
                    segment.pop("assOverride", None)
            if type(segment.get("start")) is int and type(segment.get("end")) is int and segment["end"] > segment["start"]:
                previous_end = segment["end"]
        if has_legacy_groups:
            _validate_head_refs(segments, errors, path_prefix=f"{path}.segments")
    bindings = multi.get("bindings")
    if bindings is not None and not isinstance(bindings, list):
        errors.append(ProjectValidationError("$.multi_subtitle.bindings", "must be an array"))
    for index, binding in enumerate(bindings if isinstance(bindings, list) else []):
        path = f"$.multi_subtitle.bindings[{index}]"
        if not isinstance(binding, dict):
            errors.append(ProjectValidationError(path, "must be an object"))
            continue
        for field in ("main_segment_ids", "extension_segment_ids"):
            ids = binding.get(field)
            if ids is None and field[:-1] in binding:
                ids = [binding[field[:-1]]]
            if not isinstance(ids, list) or len(ids) != 1:
                errors.append(ProjectValidationError(f"{path}.{field}", "must contain exactly one stable ID"))
    if errors:
        raise ProjectValidationFailed(tuple(errors))


def _migrate_legacy(raw: dict[str, Any]) -> dict[str, Any]:
    project = copy.deepcopy(raw)
    schema = project.get("schema", LEGACY_PROJECT_SCHEMA)
    for field in ("tracks", "bindings", "bilingual"):
        if field in project:
            _fail(f"$.{field}", "canonical field conflicts with legacy project")
    if schema == LEGACY_PROJECT_SCHEMA and "subtitle_groups" in project:
        _fail("$.subtitle_groups", "group table requires project v2 or v2")
    main_segments = _array(project.pop("segments", None), "$.segments")
    multi_value = project.pop("multi_subtitle", None)
    multi = {} if multi_value is None else _object(multi_value, "$.multi_subtitle")
    if multi.get("schema") is not None and multi["schema"] != "moy.asr.multi_subtitle.v1":
        _fail("$.multi_subtitle.schema", "must be moy.asr.multi_subtitle.v1")
    extensions = _array(multi["tracks"] if multi.get("tracks") is not None else [], "$.multi_subtitle.tracks")
    if len(extensions) > 1:
        _fail("$.tracks", "supports at most one secondary track")
    reserved_tracks, track_aliases = _legacy_track_ids(extensions)
    main: dict[str, Any] = {
        "id": _fresh_id("main", reserved_tracks), "role": "main", "name": "主字幕",
        "enabled": True, "segments": main_segments,
    }
    for field in TRACK_SOURCE_FIELDS:
        if field in project:
            main[field] = project.pop(field)
    if multi.get("main_split_mode") is not None:
        main["split_mode_override"] = multi["main_split_mode"]
    tracks = [main]
    overlay = project.pop("overlay_track", None)
    if overlay is not None:
        overlay = _object(overlay, "$.overlay_track")
        for field in ("id", "role"):
            if field in overlay:
                _fail(f"$.overlay_track.{field}", "migration metadata conflict")
        overlay.update(id=_fresh_id("overlay", reserved_tracks), role="overlay")
        overlay.setdefault("name", "叠加字幕")
        if overlay.get("enabled") is None:
            overlay["enabled"] = False
        if overlay.get("segments") is None:
            overlay["segments"] = []
        tracks.append(overlay)
    enabled = multi["enabled"] if multi.get("enabled") is not None else False
    if type(enabled) is not bool:
        _fail("$.multi_subtitle.enabled", "must be a boolean")
    for index, track in enumerate(extensions):
        if track.get("role") is not None and track["role"] != "extension":
            _fail(f"$.multi_subtitle.tracks[{index}].role", "must be extension")
        if "enabled" in track and track["enabled"] != enabled:
            _fail(f"$.multi_subtitle.tracks[{index}].enabled", "migration metadata conflict")
        track.update(role="secondary", enabled=enabled)
        track.setdefault("name", "副字幕")
        if track.get("segments") is None:
            track["segments"] = []
        if track.get("split_mode") is None:
            track["split_mode"] = "word"
        tracks.append(track)
    for track in tracks:
        track.setdefault("preview_visible", True)
        track.setdefault("variant", "plain")
        export = track.setdefault("export", {})
        if isinstance(export, dict):
            export.setdefault("enabled", True)
    project.update(schema=TRACKS_PROJECT_SCHEMA, tracks=tracks)
    bilingual = {key: value for key, value in multi.items()
                 if key not in ("schema", "tracks", "bindings", "enabled", "main_split_mode")}
    if bilingual.get("display_mode") is None:
        bilingual["display_mode"] = "both"
    if extensions and "active_track_id" not in bilingual:
        bilingual["active_track_id"] = extensions[0]["id"]
    elif isinstance(bilingual.get("active_track_id"), str):
        bilingual["active_track_id"] = track_aliases.get(bilingual["active_track_id"].strip(), bilingual["active_track_id"])
    project["bilingual"] = bilingual
    _validate_legacy_content(project, multi, has_legacy_groups=schema == LEGACY_PROJECT_SCHEMA)

    # v1 IDs were track-scoped. Reserve all explicit IDs before generating any.
    reserved_cues: set[str] = set()
    for ti, track in enumerate(tracks):
        local: set[str] = set()
        for si, raw_cue in enumerate(_array(track["segments"], f"$.tracks[{ti}].segments")):
            cue = _object(raw_cue, f"$.tracks[{ti}].segments[{si}]")
            if "id" in cue:
                identifier = _identifier(cue["id"], f"$.tracks[{ti}].segments[{si}].id", trim=True)
                if identifier in local or (schema in GROUP_PROJECT_SCHEMAS and identifier in reserved_cues):
                    _fail(f"$.tracks[{ti}].segments[{si}].id", "must be a unique cue ID")
                local.add(identifier)
                reserved_cues.add(identifier)
                cue["id"] = identifier
            elif schema in GROUP_PROJECT_SCHEMAS:
                _fail(f"$.tracks[{ti}].segments[{si}].id", "group projects require stable cue IDs")
    used_cues: set[str] = set()
    mappings: dict[str, dict[str, str]] = {}
    old_track_ids = {current: old for old, current in track_aliases.items()}
    for track in tracks:
        mapping: dict[str, str] = {}
        prefix = f"{old_track_ids[track['id']]}-segment" if track["role"] == "secondary" else track["role"]
        old_ids = _legacy_normalized_ids(track["segments"], prefix)
        for index, cue in enumerate(track["segments"]):
            original = cue.get("id")
            if original is None or original in used_cues:
                cue["id"] = _fresh_id(f"{track['id']}-cue-{index + 1}", reserved_cues)
            used_cues.add(cue["id"])
            mapping[old_ids[index]] = cue["id"]
        mappings[track["id"]] = mapping

    bindings = _array(multi["bindings"] if multi.get("bindings") is not None else [], "$.multi_subtitle.bindings")
    reserved_bindings: set[str] = set()
    for index, raw_binding in enumerate(bindings):
        binding = _object(raw_binding, f"$.multi_subtitle.bindings[{index}]")
        if "id" in binding:
            identifier = _identifier(binding["id"], f"$.multi_subtitle.bindings[{index}].id", trim=True)
            if identifier in reserved_bindings:
                _fail(f"$.multi_subtitle.bindings[{index}].id", "must be unique within its collection")
            binding["id"] = identifier
            reserved_bindings.add(identifier)
    for index, binding in enumerate(bindings):
        path = f"$.multi_subtitle.bindings[{index}]"
        for field in ("source", "target", "source_track_id", "target_track_id", "source_segment_ids", "target_segment_ids"):
            if field in binding:
                _fail(f"{path}.{field}", "migration metadata conflict")
        if "id" not in binding:
            binding["id"] = _fresh_id(f"binding-{index + 1}", reserved_bindings)
        target_id = binding.pop("track_id", None)
        if target_id is None and len(extensions) == 1:
            target_id = extensions[0]["id"]
        target_id = _identifier(target_id, f"{path}.track_id", trim=True)
        target_id = track_aliases.get(target_id, target_id)
        if not any(track["id"] == target_id for track in extensions):
            _fail(f"{path}.track_id", "must reference an existing extension track")
        for old_field, side, track_id in (
            ("main_segment_ids", "source", main["id"]),
            ("extension_segment_ids", "target", target_id),
        ):
            singular = old_field[:-1]
            if binding.get(old_field) is not None and singular in binding:
                if binding[old_field] != [binding[singular]]:
                    _fail(f"{path}.{old_field}", "conflicts with singular legacy endpoint")
            ids = binding.pop(old_field, None)
            if ids is None and singular in binding:
                ids = [binding[singular]]
            binding.pop(singular, None)
            ids = _array(ids, f"{path}.{old_field}")
            if len(ids) != 1:
                _fail(f"{path}.{old_field}", "must contain exactly one stable ID")
            old_id = _identifier(ids[0], f"{path}.{old_field}[0]", trim=True)
            if old_id not in mappings[track_id]:
                _fail(f"{path}.{old_field}[0]", "must reference an existing cue")
            binding[side] = {"track_id": track_id, "segment_id": mappings[track_id][old_id]}
        source = next(cue for cue in main["segments"] if cue["id"] == binding["source"]["segment_id"])
        target_track = next(track for track in extensions if track["id"] == target_id)
        target = next(cue for cue in target_track["segments"] if cue["id"] == binding["target"]["segment_id"])
        for edge in ("start", "end"):
            if type(source.get(edge)) is int and type(target.get(edge)) is int:
                if binding.get(f"{edge}_offset_ms") is None:
                    binding[f"{edge}_offset_ms"] = target[edge] - source[edge]
    project["bindings"] = bindings
    if schema == LEGACY_PROJECT_SCHEMA:
        _legacy_groups(project)
    return project


def _changes(before: Any, after: Any, path: str = "$") -> list[dict[str, Any]]:
    if isinstance(before, dict) and isinstance(after, dict):
        result = []
        for key in sorted(before.keys() | after.keys()):
            child = f"{path}.{key}"
            if key not in before:
                result.append({"path": child, "kind": "add", "after": copy.deepcopy(after[key])})
            elif key not in after:
                result.append({"path": child, "kind": "remove", "before": copy.deepcopy(before[key])})
            else:
                result.extend(_changes(before[key], after[key], child))
        return result
    if isinstance(before, list) and isinstance(after, list) and len(before) == len(after):
        return [change for index, (left, right) in enumerate(zip(before, after))
                for change in _changes(left, right, f"{path}[{index}]")]
    if type(before) is not type(after) or before != after:
        return [{"path": path, "kind": "replace", "before": copy.deepcopy(before), "after": copy.deepcopy(after)}]
    return []


@dataclass(frozen=True)
class ProjectTracksImport:
    project: JsonDict
    changes: tuple[JsonDict, ...]


def import_project(raw: JsonValue) -> ProjectTracksImport:
    """Migrate once at an input boundary; never change the supplied object."""
    source = _object(raw, "$")
    schema = source.get("schema", LEGACY_PROJECT_SCHEMA)
    if schema not in {LEGACY_PROJECT_SCHEMA, TRACKS_PROJECT_SCHEMA, *GROUP_PROJECT_SCHEMAS}:
        _fail("$.schema", "unsupported project schema")
    candidate = copy.deepcopy(source) if schema == TRACKS_PROJECT_SCHEMA else _migrate_legacy(source)
    _validate_canonical(candidate)
    return ProjectTracksImport(candidate, tuple(_changes(source, candidate)))


def migrate_project_tracks(raw: JsonValue) -> JsonDict:
    return import_project(raw).project
