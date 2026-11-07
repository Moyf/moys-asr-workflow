"""Resolve an ASS snapshot stored in the project, without a local library."""
from collections.abc import Mapping


def resolve_track_style(project, track):
    reference = track.get("style")
    styles = project.get("styles")
    if not isinstance(reference, Mapping) or not isinstance(styles, list):
        return None
    style_id = reference.get("style_id")
    if not isinstance(style_id, str) or not style_id:
        return None
    return next((style for style in styles if isinstance(style, Mapping) and style.get("id") == style_id), None)
