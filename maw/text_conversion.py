"""Safe Simplified-to-Traditional conversion for subtitle segments."""

from __future__ import annotations


def convert_segments_to_traditional(segments: list[dict], mode: str) -> None:
    """Convert whole segments, then preserve item timestamps with character alignment."""
    config = {"taiwan": "s2twp", "standard": "s2t"}.get(mode)
    if config is None:
        return
    from opencc import OpenCC

    converter = OpenCC(config)
    glyph_converter = OpenCC("s2t")

    def convert_glyphs(text: str) -> str:
        return "".join(glyph_converter.convert(char) for char in text)

    for index, segment in enumerate(segments, 1):
        source = str(segment.get("text") or "")
        items = segment.get("items") or []
        item_source = "".join(str(item.get("text") or "") for item in items)
        converted = converter.convert(source)
        aligned = len(converted) == len(source) and (not items or item_source == source)
        if not aligned:
            reasons = []
            if len(converted) != len(source):
                reasons.append(f"词汇转换字数由 {len(source)} 变为 {len(converted)}")
            if items and item_source != source:
                reasons.append("items 文字无法拼回 segment")
            print(f"[警告] 第 {index} 条字幕无法逐字对齐（{'；'.join(reasons)}）；已回退为单字简繁转换。")
            converted = convert_glyphs(source)

        segment["text"] = converted
        if not items:
            continue
        offset = 0
        for item in items:
            length = len(str(item.get("text") or ""))
            item["text"] = converted[offset:offset + length]
            offset += length
