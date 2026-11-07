from __future__ import annotations

from maw.colors import COLOR_PALETTE
from maw.speaker_identity import distinct_speaker_ids, is_valid_speaker_id


def speaker_color_summary(segments: list[dict]) -> dict:
    """Describe speaker coloring without writing any legacy cue fields."""
    speakers = distinct_speaker_ids(segments)
    identities = set(speakers)
    return {"speakers": speakers, "colored_segments": sum(
                isinstance(segment.get("speaker"), str) and segment["speaker"] in identities for segment in segments),
            "overflow": len(speakers) > len(COLOR_PALETTE)}


def apply_project_speaker_colors(project: dict) -> dict:
    """Assign speaker colors directly to the canonical project group table."""
    from maw.project_tracks import get_main_track
    segments = get_main_track(project)["segments"]
    stats = speaker_color_summary(segments)
    palette = {speaker: COLOR_PALETTE[index % len(COLOR_PALETTE)] for index, speaker in enumerate(stats["speakers"])}
    table = project["subtitle_groups"]
    groups = table["color"]
    reserved = {group["id"] for group in groups}
    previous_speaker = None
    identifier = None
    for segment in segments:
        speaker = segment.get("speaker")
        if not is_valid_speaker_id(speaker):
            previous_speaker = None
            continue
        if speaker != previous_speaker:
            next_id = table.get("next_id", 1)
            identifier = f"speaker-color-{next_id}"
            while identifier in reserved:
                next_id += 1
                identifier = f"speaker-color-{next_id}"
            table["next_id"] = next_id + 1
            reserved.add(identifier)
            name, value = palette[speaker]
            groups.append({"id": identifier, "value": {"name": name, "value": value}})
        segment["color_group_id"] = identifier
        previous_speaker = speaker
    return stats


# speaker 只是调色板的取色者之一：色值权威定义见 maw/colors.py。
def split_items_by_speaker(items: list[dict]) -> list[list[dict]]:
    """按 speaker 变化硬切分，避免两个说话人进入同一字幕段。

    缺少 speaker 的 item 跟随前一个已知 speaker，不主动制造切分。
    """
    runs: list[list[dict]] = []
    current: list[dict] = []
    current_speaker: str | None = None
    for item in items:
        speaker = item.get("speaker")
        if (
            current
            and speaker is not None
            and current_speaker is not None
            and speaker != current_speaker
        ):
            runs.append(current)
            current = []
            current_speaker = None
        current.append(item)
        if speaker is not None:
            current_speaker = speaker
    if current:
        runs.append(current)
    return runs


def apply_speaker_colors(segments: list[dict]) -> dict:
    """按 speaker 首次出现顺序写入 5 色 color/color_ref 快照。"""
    speaker_order: list[str] = []
    for seg in segments:
        speaker = seg.get("speaker")
        if speaker and speaker not in speaker_order:
            speaker_order.append(speaker)
    if not speaker_order:
        return {"speakers": [], "colored_segments": 0, "overflow": False}

    overflow = len(speaker_order) > len(COLOR_PALETTE)
    palette_of = {
        speaker: COLOR_PALETTE[index % len(COLOR_PALETTE)]
        for index, speaker in enumerate(speaker_order)
    }

    colored = 0
    index = 0
    while index < len(segments):
        speaker = segments[index].get("speaker")
        if not speaker:
            index += 1
            continue
        end_index = index
        while (
            end_index + 1 < len(segments)
            and segments[end_index + 1].get("speaker") == speaker
        ):
            end_index += 1
        name, value = palette_of[speaker]
        segments[index]["color"] = {
            "name": name,
            "value": value,
            "start": segments[index]["start"],
            "end": segments[end_index]["end"],
        }
        for ref_index in range(index + 1, end_index + 1):
            segments[ref_index]["color_ref"] = {
                "name": name,
                "headIdx": index,
            }
        colored += end_index - index + 1
        index = end_index + 1

    return {
        "speakers": speaker_order,
        "colored_segments": colored,
        "overflow": overflow,
    }
