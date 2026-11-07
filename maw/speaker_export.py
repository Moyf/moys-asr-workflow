"""Read project identities at subtitle export boundaries without mutating them."""

from __future__ import annotations

from collections.abc import Mapping

from maw.colors import COLOR_PALETTE_ALL
from maw.speaker_identity import resolve_project_speaker


def speaker_label_settings(project: Mapping[str, object]) -> Mapping[str, object]:
    preview = project.get("preview")
    subtitle = preview.get("subtitle") if isinstance(preview, Mapping) else None
    labels = subtitle.get("speaker_labels") if isinstance(subtitle, Mapping) else None
    return labels if isinstance(labels, Mapping) else {}


def export_speaker_name(project: Mapping[str, object], segment: Mapping[str, object]) -> str:
    # Preview visibility and annotation purpose never enable an export prefix.
    if speaker_label_settings(project).get("export_enabled") is not True:
        return ""
    speaker = resolve_project_speaker(project, segment)
    return str(speaker.get("name") or "") if speaker else ""


def speaker_label_separator(project: Mapping[str, object]) -> str:
    return str(speaker_label_settings(project).get("separator", "："))


def labelled_export_text(project: Mapping[str, object], segment: Mapping[str, object], text: str) -> str:
    name = export_speaker_name(project, segment)
    return f"{name}{speaker_label_separator(project)}{text}" if name else text


def speaker_display_color(project: Mapping[str, object], segment: Mapping[str, object],
                          groups: Mapping[str, object]) -> str | None:
    """Resolve purpose-specific colour; unassigned identities never fall back."""
    if project.get("annotation_mode") == "speaker":
        speaker = resolve_project_speaker(project, segment)
        return str(speaker["color"]) if speaker else None
    value = groups.get(str(segment.get("color_group_id") or ""))
    if not isinstance(value, Mapping):
        return None
    return dict(COLOR_PALETTE_ALL).get(str(value.get("name") or ""))
