from __future__ import annotations


# 与 JSON_SCHEMA.md 第四节的 5 色一致。
SPEAKER_COLOR_PALETTE: tuple[tuple[str, str], ...] = (
    ("yellow", "#f1c40f"),
    ("green", "#2ecc71"),
    ("red", "#e74c3c"),
    ("purple", "#9b59b6"),
    ("blue", "#3498db"),
)


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

    overflow = len(speaker_order) > len(SPEAKER_COLOR_PALETTE)
    palette_of = {
        speaker: SPEAKER_COLOR_PALETTE[index % len(SPEAKER_COLOR_PALETTE)]
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
