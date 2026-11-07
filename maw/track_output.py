"""Track selection for Python subtitle outputs."""
from maw.track_policy import select_tracks, unsupported_variant


def select_export_tracks(project, mode="main"):
    """Select output tracks and reject an enabled, unsupported overlay variant."""
    if mode in ("main", "overlay", "main_and_extension", "all"):
        for track in project.get("tracks", []):
            if (unsupported_variant(track) and track.get("enabled") is True
                    and (track.get("export") or {}).get("enabled", True) is not False):
                raise ValueError(f"Unsupported overlay variant: {track.get('variant')}")
    return select_tracks(project, mode, "export")
