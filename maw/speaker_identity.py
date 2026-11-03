"""Source speaker migration and the v2 project identity boundary."""

from __future__ import annotations

import copy
import re
import unicodedata
from collections.abc import Iterable, Mapping
from typing import Any

from maw.colors import COLOR_PALETTE

# The first five entries retain the existing shortcuts and display colours.
SPEAKER_PALETTE = (*COLOR_PALETTE, ("orange", "#f2a65a"), ("cyan", "#49c5c1"),
                   ("magenta", "#d675b9"), ("gray", "#969fab"))
SPEAKER_PROJECT_FIELDS = ("speakers", "annotation_mode", "palette_size", "speaker_shortcuts")


class SpeakerMigrationError(ValueError):
    def __init__(self, path: str, message: str):
        super().__init__(message)
        self.path = path


def is_valid_speaker_id(value: object) -> bool:
    """Use the shared Python/JavaScript definition of a nonblank opaque ID."""
    return isinstance(value, str) and bool(value) and any(not (char.isspace() or char == '\ufeff') for char in value)


def distinct_speaker_ids(segments: Iterable[Mapping[str, Any]]) -> list[str]:
    """Return distinct, nonblank source identifiers in first-seen order.

    Provider identifiers are opaque strings: their numeric value, display name,
    and color have no bearing on how many speakers were reported.
    """
    result: list[str] = []
    seen: set[str] = set()
    for segment in segments:
        speaker = segment.get("speaker")
        if not is_valid_speaker_id(speaker) or speaker in seen:
            continue
        result.append(speaker)
        seen.add(speaker)
    return result


def allocate_source_speaker_ids(
    segments: Iterable[Mapping[str, Any]], *, reserved_ids: Iterable[str],
) -> dict[str, str]:
    """Allocate distinct project identities for an already-segmented ASR result.

    Existing project IDs are reserved only; matching an opaque source ID does
    not establish that speakers from separate sources are the same person.
    Include item identities so a cue with no segment-level identity can still
    be converted when its items identify one speaker unambiguously.
    """
    used = set(reserved_ids)
    mapping: dict[str, str] = {}
    number = 1
    source_entries: list[Mapping[str, Any]] = []
    for segment in segments:
        source_entries.append(segment)
        items = segment.get("items")
        if isinstance(items, list):
            source_entries.extend(item for item in items if isinstance(item, Mapping))
    for source_id in distinct_speaker_ids(source_entries):
        candidate = f"spk-{number:03d}"
        while candidate in used:
            number += 1
            candidate = f"spk-{number:03d}"
        mapping[source_id] = candidate
        used.add(candidate)
        number += 1
    return mapping


def _allocate_split_id(base: str, reserved: set[str], *, start: int = 1) -> str:
    """Reserve the final ID, keeping the contract's Unicode-codepoint limit."""
    number = start
    while True:
        suffix = f"-speaker-{number}"
        candidate = base[:160 - len(suffix)] + suffix
        if candidate not in reserved:
            reserved.add(candidate)
            return candidate
        number += 1


def migrate_speaker_segments(
    segments: Iterable[Mapping[str, Any]], source_to_project: Mapping[str, str],
    *, reserved_segment_ids: Iterable[str] = (),
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Split legacy word identities, returning segments and per-input ID mapping.

    Callers must use the mapping to update bindings and groups when a cue splits.
    The first run keeps its original ID; generated IDs avoid all input and
    caller-reserved IDs. Blank item identities follow the previous known one;
    leading blanks join the first known run. For an unsplit cue an existing
    segment identity wins over an item identity.

    Split only when text and boundary timestamps are available without guessing.
    Segment frame boundaries require corresponding item frames at internal edges.
    """
    source = copy.deepcopy(list(segments))
    ids = [s.get("id") for s in source if is_valid_speaker_id(s.get("id"))]
    if len(ids) != len(set(ids)):
        raise ValueError("duplicate segment id")
    used = set(ids) | set(reserved_segment_ids)
    result: list[dict[str, Any]] = []
    mappings: list[dict[str, Any]] = []

    def identity(value: object) -> str | None:
        if value is None or (isinstance(value, str) and not is_valid_speaker_id(value)):
            return None
        if not isinstance(value, str):
            raise ValueError("invalid source speaker")
        return value

    def new_id(base: str) -> str:
        return _allocate_split_id(base, used)

    for index, segment in enumerate(source):
        items = segment.get("items")
        if items is None:
            items = []
        if not isinstance(items, list) or any(not isinstance(item, dict) for item in items):
            raise ValueError("items must be an array of objects")
        segment_speaker = identity(segment.get("speaker"))
        item_speakers = [identity(item.get("speaker")) for item in items]
        runs: list[tuple[list[dict[str, Any]], str | None]] = []
        current: list[dict[str, Any]] = []
        current_speaker = None
        for item, speaker in zip(items, item_speakers):
            if current and speaker is not None and current_speaker is not None and speaker != current_speaker:
                runs.append((current, current_speaker))
                current, current_speaker = [], None
            current.append(item)
            if speaker is not None:
                current_speaker = speaker
        if current:
            runs.append((current, current_speaker))
        if not runs:
            runs = [([], None)]
        split = len(runs) > 1
        if split:
            if (not isinstance(segment.get("text"), str)
                    or any(not isinstance(item.get("text"), str) for item in items)):
                raise ValueError("cannot split segment without matching item text")
            # Providers may omit spaces and punctuation from word tokens. Keep
            # the original segment text and partition it at matched word edges.
            def significant(char: str) -> bool:
                return not (char.isspace() or char == "\ufeff" or unicodedata.category(char).startswith("P"))

            text = segment["text"]
            if ([c for c in text if significant(c)]
                    != [c for item in items for c in item["text"] if significant(c)]):
                raise ValueError("cannot split segment without matching item text")
            cuts = []
            cursor = count = 0
            for run, _ in runs[:-1]:
                count += sum(significant(c) for item in run for c in item["text"])
                while cursor < len(text) and count:
                    if significant(text[cursor]):
                        count -= 1
                    cursor += 1
                while cursor < len(text) and not significant(text[cursor]):
                    cursor += 1
                cuts.append(cursor)
            text_pieces = [text[start:end] for start, end in zip([0, *cuts], [*cuts, len(text)])]
            edges = [(run[0], "start") for run, _ in runs[1:]] + [
                (run[-1], "end") for run, _ in runs[:-1]
            ]
            if any(type(item.get(key)) is not int for item, key in edges):
                raise ValueError("cannot split segment without integer item timestamps")
            if ("start_frame" in segment) != ("end_frame" in segment):
                raise ValueError("segment frame boundaries must be paired")
            if "start_frame" in segment and any(
                type(item.get(f"{key}_frame")) is not int for item, key in edges
            ):
                raise ValueError("cannot split framed segment without item frame boundaries")
        old_id = segment.get("id")
        output_ids: list[str | None] = []
        for run_index, (run, run_speaker) in enumerate(runs):
            out = copy.deepcopy(segment)
            if split:
                if run_index or not is_valid_speaker_id(old_id):
                    out["id"] = new_id(old_id if is_valid_speaker_id(old_id) else f"segment-{index + 1}")
                out["items"] = run
                out["text"] = text_pieces[run_index]
                out["start"] = segment["start"] if run_index == 0 else run[0]["start"]
                out["end"] = segment["end"] if run_index == len(runs) - 1 else run[-1]["end"]
                if "start_frame" in segment:
                    out["start_frame"] = segment["start_frame"] if run_index == 0 else run[0]["start_frame"]
                    out["end_frame"] = segment["end_frame"] if run_index == len(runs) - 1 else run[-1]["end_frame"]
            speaker = run_speaker if split else (segment_speaker or run_speaker)
            if speaker is not None:
                project_id = source_to_project.get(speaker)
                if not is_valid_speaker_id(project_id):
                    raise ValueError("unmapped source speaker")
                out["speaker"] = project_id
            else:
                out.pop("speaker", None)
            for item in out.get("items") or []:
                item.pop("speaker", None)
            result.append(out)
            output_ids.append(out.get("id"))
        mappings.append({"input_index": index, "old_id": old_id, "new_ids": output_ids})
    return result, mappings


def prepare_asr_speaker_segments(
    segments: Iterable[Mapping[str, Any]], source_to_project: Mapping[str, str],
) -> list[dict[str, Any]]:
    """Prepare an unbound ASR result; use migrate_speaker_segments for bindings."""
    return migrate_speaker_segments(segments, source_to_project)[0]


def validate_project_speakers(project: Mapping[str, Any]) -> list[dict[str, str]]:
    """Validate segment-level references and project-owned palette settings."""
    errors: list[dict[str, str]] = []

    def error(path: str, message: str) -> None:
        errors.append({"path": path, "message": message})

    if not isinstance(project, Mapping):
        error("$", "must be an object")
        return errors
    speakers = project.get("speakers")
    if not isinstance(speakers, list):
        error("$.speakers", "must be an array")
        speakers = []
    if "annotation_mode" in project and project["annotation_mode"] not in ("speaker", "color"):
        error("$.annotation_mode", "must be speaker or color")
    if "palette_size" in project and (type(project["palette_size"]) is not int or project["palette_size"] not in (5, 9)):
        error("$.palette_size", "must be 5 or 9")
    ids: set[str] = set()
    for index, speaker in enumerate(speakers):
        path = f"$.speakers[{index}]"
        if not isinstance(speaker, Mapping):
            error(path, "must be an object")
            continue
        identifier = speaker.get("id")
        if (not is_valid_speaker_id(identifier) or len(identifier) > 160
                or identifier != identifier.strip() or identifier.startswith('\ufeff') or identifier.endswith('\ufeff')
                or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in identifier)
                or identifier in ids):
            error(f"{path}.id", "must be a unique nonempty string")
        else:
            ids.add(identifier)
        name = speaker.get("name")
        if (not isinstance(name, str) or len(name) > 64
                or any(ord(char) < 32 or 127 <= ord(char) <= 159 for char in name)):
            error(f"{path}.name", "must be a name of at most 64 characters without control characters")
        color = speaker.get("color")
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            error(f"{path}.color", "must be a six-digit hex color")

    shortcuts = project.get("speaker_shortcuts", {})
    if not isinstance(shortcuts, dict):
        error("$.speaker_shortcuts", "must be an object")
    else:
        for slot, identity in shortcuts.items():
            if slot not in tuple(str(index) for index in range(1, 10)):
                error(f"$.speaker_shortcuts.{slot}", "must be a slot from 1 to 9")
            elif not isinstance(identity, str) or identity not in ids:
                error(f"$.speaker_shortcuts.{slot}", "must reference a project speaker")

    tracks = project.get("tracks")
    if not isinstance(tracks, list):
        error("$.tracks", "must be an array")
        return errors
    for track_index, track in enumerate(tracks):
        path = f"$.tracks[{track_index}].segments"
        if not isinstance(track, Mapping) or not isinstance(track.get("segments"), list):
            error(path, "must be an array")
            continue
        for segment_index, segment in enumerate(track["segments"]):
            segment_path = f"{path}[{segment_index}]"
            if not isinstance(segment, Mapping):
                error(segment_path, "must be an object")
                continue
            speaker = segment.get("speaker")
            if speaker is not None and (not isinstance(speaker, str) or speaker not in ids):
                error(f"{segment_path}.speaker", "must reference a project speaker")
            items = segment.get("items", [])
            if items is None:
                continue
            if not isinstance(items, list):
                error(f"{segment_path}.items", "must be an array")
                continue
            for item_index, item in enumerate(items):
                if isinstance(item, Mapping) and "speaker" in item:
                    error(f"{segment_path}.items[{item_index}].speaker", "speaker belongs to the segment")
    return errors


def resolve_project_speaker(project: Mapping[str, Any], segment: Mapping[str, Any]) -> Mapping[str, Any] | None:
    """Resolve only the current segment reference; colour and words are not fallbacks."""
    identifier = segment.get("speaker")
    if identifier is None:
        return None
    return next((speaker for speaker in project.get("speakers", []) if speaker.get("id") == identifier), None)


def can_merge_speaker_segments(segments: Iterable[Mapping[str, Any]]) -> bool:
    """Assigned/unassigned mixtures and distinct identities require explicit reassignment."""
    source = list(segments)
    return bool(source) and all(segment.get("speaker") == source[0].get("speaker") for segment in source)


def upgrade_project_speakers(project: Mapping[str, Any]) -> dict[str, Any]:
    """Upgrade a structurally validated tracks project, without modifying its source.

    A present identity table is authoritative, even when empty: never revive a
    cleared identity from legacy words or colours. Without a table, provider IDs
    are interpreted within this one input project and allocated independently.
    Independent cue splits release a one-to-one binding, just like the editor;
    paired splits at matching absolute boundaries retain the paired relation.
    The import boundary exposes all changes, including removed bindings.
    """
    result = copy.deepcopy(dict(project))
    if "speakers" in result:
        return result
    tracks = result["tracks"]
    old_segments = [segment for track in tracks for segment in track["segments"]]
    identities = allocate_source_speaker_ids(old_segments, reserved_ids=())
    reserved = {segment["id"] for segment in old_segments}
    replacements: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for ti, track in enumerate(tracks):
        try:
            migrated, mappings = migrate_speaker_segments(track["segments"], identities, reserved_segment_ids=reserved)
        except ValueError as error:
            raise SpeakerMigrationError(f"$.tracks[{ti}].segments", str(error)) from error
        by_id = {segment["id"]: segment for segment in migrated}
        reserved.update(by_id)
        for mapping in mappings:
            replacements[track["id"], mapping["old_id"]] = [by_id[identifier] for identifier in mapping["new_ids"]]
        track["segments"] = migrated

    palette_size = result.setdefault("palette_size", 5)
    if type(palette_size) is not int or palette_size not in (5, 9):
        raise SpeakerMigrationError("$.palette_size", "must be 5 or 9")
    result.setdefault("annotation_mode", "color")
    used = distinct_speaker_ids(segment for track in tracks for segment in track["segments"])
    result["speakers"] = [{"id": identifier, "name": f"说话人 {index + 1}",
                           "color": SPEAKER_PALETTE[index % palette_size][1]}
                          for index, identifier in enumerate(used)]
    if "speaker_shortcuts" not in result:
        result["speaker_shortcuts"] = {str(index + 1): identifier for index, identifier in enumerate(used[:palette_size])}
    else:
        shortcuts = result["speaker_shortcuts"]
        if not isinstance(shortcuts, dict):
            raise SpeakerMigrationError("$.speaker_shortcuts", "must be an object")
        for slot, source_id in shortcuts.items():
            if not isinstance(source_id, str) or identities.get(source_id) not in used:
                raise SpeakerMigrationError(f"$.speaker_shortcuts.{slot}", "must reference an existing source speaker")
            shortcuts[slot] = identities[source_id]

    bindings = result["bindings"]
    reserved_bindings = {binding["id"] for binding in bindings}
    migrated_bindings = []
    for binding in bindings:
        sides = [replacements[ref["track_id"], ref["segment_id"]] for ref in (binding["source"], binding["target"])]
        source, target = sides
        if len(source) == len(target) == 1:
            migrated_bindings.append(binding)
            continue
        # Both sides must preserve the same absolute cuts, including any gap.
        paired = len(source) == len(target) and all(
            source[index - 1]["end"] == target[index - 1]["end"] and source[index]["start"] == target[index]["start"]
            for index in range(1, len(source))
        )
        if not paired:
            continue
        for index, (source_cue, target_cue) in enumerate(zip(source, target)):
            replacement = copy.deepcopy(binding)
            if index:
                replacement["id"] = _allocate_split_id(binding["id"], reserved_bindings, start=index)
            replacement["source"]["segment_id"] = source_cue["id"]
            replacement["target"]["segment_id"] = target_cue["id"]
            for edge in ("start", "end"):
                replacement[f"{edge}_offset_ms"] = target_cue[edge] - source_cue[edge]
            migrated_bindings.append(replacement)
    result["bindings"] = migrated_bindings
    return result
