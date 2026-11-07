"""Shared track visibility and export selection policy."""


def unsupported_variant(track):
    return bool(track and track.get("role") == "overlay" and (track.get("variant") if track.get("variant") is not None else "plain") != "plain")


def is_track_enabled(track, surface):
    if surface not in ("preview", "export"):
        raise ValueError("Unknown track surface")
    if not track or track.get("enabled") is not True or unsupported_variant(track):
        return False
    if surface == "preview":
        return track.get("preview_visible", True) is not False
    return (track.get("export") or {}).get("enabled", True) is not False


def select_tracks(project, mode="main", surface="export", *, include_overlay=True):
    tracks = project.get("tracks", []) if project else []
    main = next((t for t in tracks if t.get("role") == "main"), None)
    overlay = next((t for t in tracks if t.get("role") == "overlay"), None)
    active_id = (project.get("bilingual") or {}).get("active_track_id")
    secondary = next((t for t in tracks if t.get("role") == "secondary" and (not active_id or t.get("id") == active_id)), None)
    selections = {
        "main": [main] + ([overlay] if include_overlay else []), "overlay": [overlay], "extension": [secondary],
        "main_and_extension": [main] + ([overlay] if include_overlay else []) + [secondary],
        "all": [main, overlay, secondary],
    }
    if mode not in selections:
        raise ValueError("Unknown subtitle track selection")
    return [track for track in selections[mode] if is_track_enabled(track, surface)]
