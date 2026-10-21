"""Canonical subtitle tracks and lossless v1/v2 import boundary.

The v2 group contract follows PR #239 at 740953e2093c8a54fe17cabbe1b2d07d44ccd607.
Legacy containers are read only in this module; all returned projects use v3.
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

TRACKS_PROJECT_SCHEMA = "moy.asr.project.v3"
LEGACY_PROJECT_SCHEMA = "moy.asr.project.v1"
GROUP_PROJECT_SCHEMA = "moy.asr.project.v2"
TRACK_ROLES = frozenset({"main", "extension", "overlay"})
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
    """Create a new v3 project for ASR/SRT producers, preserving cue payloads.

    Missing cue IDs are generated only here (and in legacy import), never in
    strict v3 validation. Explicit invalid or duplicate IDs remain errors.
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
                    _fail(f"{path}.{kind}", "legacy group fields are not allowed in v3")


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
        endpoints = []
        for side, role in (("source", "main"), ("target", "extension")):
            track_id = binding.get(f"{side}_track_id")
            if not isinstance(track_id, str) or track_id not in tracks or tracks[track_id]["role"] != role:
                _fail(f"{path}.{side}_track_id", f"must reference an existing {role} track")
            ids = _array(binding.get(f"{side}_segment_ids"), f"{path}.{side}_segment_ids")
            if len(ids) != 1 or not isinstance(ids[0], str):
                _fail(f"{path}.{side}_segment_ids", "must contain exactly one stable ID")
            cue = next((cue for cue in tracks[track_id]["segments"] if cue["id"] == ids[0]), None)
            if cue is None:
                _fail(f"{path}.{side}_segment_ids[0]", "must reference a cue on the specified track")
            endpoints.append(cue)
        source, target = endpoints
        pair = (binding["target_track_id"], source["id"])
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
            _fail(f"$.{field}", "legacy field is not allowed in v3")
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
            _fail(f"{path}.role", "must be main, extension, or overlay")
        main_count += role == "main"
        overlay_count += role == "overlay"
        if type(track.get("enabled")) is not bool:
            _fail(f"{path}.enabled", "must be a boolean")
        if role == "main" and track["enabled"] is not True:
            _fail(f"{path}.enabled", "main track must be enabled")
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
        _validate_transcription_metadata(track, track_errors)
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
            # v3 validation and unknown ASS metadata round trips are non-mutating.
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
    if overlay_count > 1:
        _fail("$.tracks", "supports at most one overlay track")
    if errors:
        raise ProjectValidationFailed(tuple(errors))
    bilingual = _object(project.get("bilingual"), "$.bilingual")
    if bilingual.get("display_mode") not in ("main", "extension", "both"):
        _fail("$.bilingual.display_mode", "must be main, extension, or both")
    extensions = [track for track in tracks if track["role"] == "extension"]
    active = bilingual.get("active_track_id")
    if extensions or "active_track_id" in bilingual:
        if not isinstance(active, str) or not any(track["id"] == active for track in extensions):
            _fail("$.bilingual.active_track_id", "must reference an existing extension track")
    _validate_bindings(project)
    _validate_groups(project)


def validate_tracks_project(raw: JsonValue) -> ProjectValidationResult:
    """Strict v3 validation, returning a detached project only on success."""
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


def _legacy_track_ids(extensions: list[Any]) -> set[str]:
    reserved: set[str] = set()
    for index, raw in enumerate(extensions):
        track = _object(raw, f"$.multi_subtitle.tracks[{index}]")
        if "id" in track:
            identifier = _identifier(track["id"], f"$.multi_subtitle.tracks[{index}].id", trim=True)
            if identifier in reserved:
                _fail(f"$.multi_subtitle.tracks[{index}].id", "must be a unique track ID")
            reserved.add(identifier)
            track["id"] = identifier
    for index, track in enumerate(extensions):
        if "id" not in track:
            track["id"] = _fresh_id(f"extension-{index + 1}", reserved)
    return reserved


def _migrate_legacy(raw: dict[str, Any]) -> dict[str, Any]:
    project = copy.deepcopy(raw)
    schema = project.get("schema", LEGACY_PROJECT_SCHEMA)
    for field in ("tracks", "bindings", "bilingual"):
        if field in project:
            _fail(f"$.{field}", "canonical field conflicts with legacy project")
    if schema == LEGACY_PROJECT_SCHEMA and "subtitle_groups" in project:
        _fail("$.subtitle_groups", "group table requires project v2 or v3")
    main_segments = _array(project.pop("segments", None), "$.segments")
    multi_value = project.pop("multi_subtitle", None)
    multi = {} if multi_value is None else _object(multi_value, "$.multi_subtitle")
    if "schema" in multi and multi["schema"] != "moy.asr.multi_subtitle.v1":
        _fail("$.multi_subtitle.schema", "must be moy.asr.multi_subtitle.v1")
    extensions = _array(multi.get("tracks", []), "$.multi_subtitle.tracks")
    reserved_tracks = _legacy_track_ids(extensions)
    main: dict[str, Any] = {
        "id": _fresh_id("main", reserved_tracks), "role": "main", "name": "主字幕",
        "enabled": True, "segments": main_segments,
    }
    for field in TRACK_SOURCE_FIELDS:
        if field in project:
            main[field] = project.pop(field)
    if "main_split_mode" in multi:
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
        overlay.setdefault("enabled", False)
        overlay.setdefault("segments", [])
        tracks.append(overlay)
    enabled = multi.get("enabled", False)
    if type(enabled) is not bool:
        _fail("$.multi_subtitle.enabled", "must be a boolean")
    for index, track in enumerate(extensions):
        if "role" in track and track["role"] != "extension":
            _fail(f"$.multi_subtitle.tracks[{index}].role", "must be extension")
        if "enabled" in track and track["enabled"] != enabled:
            _fail(f"$.multi_subtitle.tracks[{index}].enabled", "migration metadata conflict")
        track.update(role="extension", enabled=enabled)
        track.setdefault("name", "副字幕")
        track.setdefault("segments", [])
        tracks.append(track)
    project.update(schema=TRACKS_PROJECT_SCHEMA, tracks=tracks)
    bilingual = {key: value for key, value in multi.items()
                 if key not in ("schema", "tracks", "bindings", "enabled", "main_split_mode")}
    bilingual.setdefault("display_mode", "both")
    if extensions and "active_track_id" not in bilingual:
        bilingual["active_track_id"] = extensions[0]["id"]
    project["bilingual"] = bilingual

    # v1 IDs were track-scoped. Reserve all explicit IDs before generating any.
    reserved_cues: set[str] = set()
    for ti, track in enumerate(tracks):
        local: set[str] = set()
        for si, raw_cue in enumerate(_array(track["segments"], f"$.tracks[{ti}].segments")):
            cue = _object(raw_cue, f"$.tracks[{ti}].segments[{si}]")
            if "id" in cue:
                identifier = _identifier(cue["id"], f"$.tracks[{ti}].segments[{si}].id", trim=True)
                if identifier in local or (schema == GROUP_PROJECT_SCHEMA and identifier in reserved_cues):
                    _fail(f"$.tracks[{ti}].segments[{si}].id", "must be a unique cue ID")
                local.add(identifier)
                reserved_cues.add(identifier)
                cue["id"] = identifier
            elif schema == GROUP_PROJECT_SCHEMA:
                _fail(f"$.tracks[{ti}].segments[{si}].id", "v2 requires stable cue IDs")
    used_cues: set[str] = set()
    mappings: dict[str, dict[str, str]] = {}
    for track in tracks:
        mapping: dict[str, str] = {}
        for index, cue in enumerate(track["segments"]):
            original = cue.get("id")
            if original is None or original in used_cues:
                cue["id"] = _fresh_id(f"{track['id']}-cue-{index + 1}", reserved_cues)
            used_cues.add(cue["id"])
            if original is not None:
                mapping[original] = cue["id"]
        mappings[track["id"]] = mapping

    bindings = _array(multi.get("bindings", []), "$.multi_subtitle.bindings")
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
        for field in ("source_track_id", "target_track_id", "source_segment_ids", "target_segment_ids"):
            if field in binding:
                _fail(f"{path}.{field}", "migration metadata conflict")
        if "id" not in binding:
            binding["id"] = _fresh_id(f"binding-{index + 1}", reserved_bindings)
        target_id = binding.pop("track_id", extensions[0]["id"] if len(extensions) == 1 else None)
        target_id = _identifier(target_id, f"{path}.track_id", trim=True)
        if not any(track["id"] == target_id for track in extensions):
            _fail(f"{path}.track_id", "must reference an existing extension track")
        binding["source_track_id"] = main["id"]
        binding["target_track_id"] = target_id
        for old_field, side, track_id in (
            ("main_segment_ids", "source", main["id"]),
            ("extension_segment_ids", "target", target_id),
        ):
            singular = old_field[:-1]
            if old_field in binding and singular in binding:
                if binding[old_field] != [binding[singular]]:
                    _fail(f"{path}.{old_field}", "conflicts with singular legacy endpoint")
            ids = binding.pop(old_field, [binding[singular]] if singular in binding else None)
            binding.pop(singular, None)
            ids = _array(ids, f"{path}.{old_field}")
            if len(ids) != 1:
                _fail(f"{path}.{old_field}", "must contain exactly one stable ID")
            old_id = _identifier(ids[0], f"{path}.{old_field}[0]", trim=True)
            if old_id not in mappings[track_id]:
                _fail(f"{path}.{old_field}[0]", "must reference an existing cue")
            binding[f"{side}_segment_ids"] = [mappings[track_id][old_id]]
        source = next(cue for cue in main["segments"] if cue["id"] == binding["source_segment_ids"][0])
        target_track = next(track for track in extensions if track["id"] == target_id)
        target = next(cue for cue in target_track["segments"] if cue["id"] == binding["target_segment_ids"][0])
        for edge in ("start", "end"):
            if type(source.get(edge)) is int and type(target.get(edge)) is int:
                binding.setdefault(f"{edge}_offset_ms", target[edge] - source[edge])
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
    if schema not in (LEGACY_PROJECT_SCHEMA, GROUP_PROJECT_SCHEMA, TRACKS_PROJECT_SCHEMA):
        _fail("$.schema", "unsupported project schema")
    candidate = copy.deepcopy(source) if schema == TRACKS_PROJECT_SCHEMA else _migrate_legacy(source)
    _validate_canonical(candidate)
    return ProjectTracksImport(candidate, tuple(_changes(source, candidate)))


def migrate_project_tracks(raw: JsonValue) -> JsonDict:
    return import_project(raw).project
