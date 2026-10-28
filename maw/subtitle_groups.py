"""Validate the independent cue groups used by v1.5 projects without rewriting data."""

GROUP_PROJECT_SCHEMA = "moy.asr.project.v1.5"


def validate_subtitle_groups(project):
    errors = []
    table = project.get("subtitle_groups")
    if not isinstance(table, dict):
        return [("$.subtitle_groups", "must be an object")]
    if "next_id" in table and (type(table["next_id"]) is not int or not 1 <= table["next_id"] <= 9007199254740991):
        errors.append(("$.subtitle_groups.next_id", "must be a positive safe integer"))
    overlay = project.get("overlay_track")
    multi = project.get("multi_subtitle")
    tracks = [("$.segments", project.get("segments", []))]
    if isinstance(overlay, dict):
        tracks.append(("$.overlay_track.segments", overlay.get("segments", [])))
    if isinstance(multi, dict) and isinstance(multi.get("tracks"), list):
        tracks.extend((f"$.multi_subtitle.tracks[{i}].segments", track.get("segments", []))
                      for i, track in enumerate(multi["tracks"]) if isinstance(track, dict))
    tracks = [(path, segments) for path, segments in tracks if isinstance(segments, list)]
    ids = set()
    for path, segments in tracks:
        for i, segment in enumerate(segments):
            if not isinstance(segment, dict):
                continue
            identifier = segment.get("id")
            # Cue normalizers trim IDs per track. Check their eventual identity
            # here so acceptance cannot produce cross-track duplicates.
            canonical = identifier.strip() if isinstance(identifier, str) else None
            if not canonical or len(identifier) > 160 or canonical in ids:
                errors.append((f"{path}[{i}].id", "must be a unique project-wide cue ID"))
            else:
                ids.add(canonical)
    for kind in ("color", "sticker"):
        groups = table.get(kind)
        if not isinstance(groups, list):
            errors.append((f"$.subtitle_groups.{kind}", "must be an array"))
            continue
        group_ids = set()
        for i, group in enumerate(groups):
            path = f"$.subtitle_groups.{kind}[{i}]"
            if not isinstance(group, dict):
                errors.append((path, "must be an object"))
                continue
            identifier = group.get("id")
            if not isinstance(identifier, str) or not identifier.strip() or len(identifier) > 160 or identifier in group_ids:
                errors.append((f"{path}.id", "must be a unique non-empty group ID"))
            else:
                group_ids.add(identifier)
            value = group.get("value")
            if not isinstance(value, dict) or not isinstance(value.get("name"), str):
                errors.append((f"{path}.value", "must contain a name"))
            elif "start" in value or "end" in value:
                errors.append((f"{path}.value", "group range is derived from members"))
        for path, segments in tracks:
            for i, segment in enumerate(segments):
                if not isinstance(segment, dict):
                    continue
                field = f"{kind}_group_id"
                if field in segment and (not isinstance(segment[field], str) or segment[field] not in group_ids):
                    errors.append((f"{path}[{i}].{field}", "must reference an existing group"))
                if kind in segment or f"{kind}_ref" in segment:
                    errors.append((f"{path}[{i}].{kind}", "legacy group fields are not allowed in v1.5"))
    return errors
