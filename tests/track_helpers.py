"""Read cue expectations from explicit legacy fixtures or canonical results."""

from maw.project_tracks import get_main_track, get_tracks_by_role


def main_track(project):
    return get_main_track(project) if project.get("schema") == "moy.asr.project.v3" else project


def main_segments(project):
    return main_track(project)["segments"]


def extension_tracks(project):
    return get_tracks_by_role(project, "extension")


def overlay_track(project):
    return get_tracks_by_role(project, "overlay")[0]
