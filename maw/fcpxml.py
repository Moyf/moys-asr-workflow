"""Internal FCPXML 1.13 titles-only serializer and fixed-layout ZIP transport."""

from io import BytesIO
import re
from xml.etree import ElementTree as ET
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


_FPS = {
    "24": (24, 1), "25": (25, 1), "30": (30, 1), "30000/1001": (30000, 1001),
    "50": (50, 1), "60": (60, 1), "60000/1001": (60000, 1001),
}
# Publicly documented Basic Title reference (SpliceKit FCPXML format reference).
# The target FCP 1.13 import/readback is still a release gate.
_BASIC_TITLE = ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti"
_MAX_SECONDS = 7 * 24 * 60 * 60
_MAX_TITLES = 20_000
_MAX_LANE = 128
_MAX_TITLE_BYTES = 16 * 1024
_MAX_TOTAL_TEXT_BYTES = 4 * 1024 * 1024
_BAD_XML = re.compile(r"[^\x09\x0a\x0d\x20-\ud7ff\ue000-\ufffd\U00010000-\U0010ffff]")
_BAD_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f\x7f]')
_DOS_NAME = re.compile(r"(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])", re.IGNORECASE)


def _fields(value, keys):
    if not isinstance(value, dict) or value.keys() != keys:
        raise ValueError("invalid FCPXML fields")


def _integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise ValueError("FCPXML integer out of range")


def _text(value, max_chars, max_bytes):
    if not isinstance(value, str) or len(value) > max_chars or not value.strip() or _BAD_XML.search(value):
        raise ValueError("invalid FCPXML text")
    size = len(value.encode("utf-8"))
    if size > max_bytes:
        raise ValueError("FCPXML text exceeds size limit")
    return size


def _validate(plan):
    _fields(plan, {"version", "name", "fps", "width", "height", "durationFrames", "titles"})
    if plan["version"] != "1.13":
        raise ValueError("unsupported FCPXML version")
    fps = plan["fps"]
    if not isinstance(fps, str) or fps not in _FPS:
        raise ValueError("unsupported FCPXML FPS")
    numerator, denominator = _FPS[fps]
    _text(plan["name"], 120, 480)
    _integer(plan["width"], 1, 8192)
    _integer(plan["height"], 1, 8192)
    duration = plan["durationFrames"]
    _integer(duration, 1, (_MAX_SECONDS * numerator + denominator - 1) // denominator)
    titles = plan["titles"]
    if not isinstance(titles, list) or not 1 <= len(titles) <= _MAX_TITLES:
        raise ValueError("invalid FCPXML title count")
    lane_ends = {}
    previous = (-1, 0)
    text_bytes = 0
    for title in titles:
        _fields(title, {"startFrame", "endFrame", "lane", "text"})
        start, end, lane = title["startFrame"], title["endFrame"], title["lane"]
        _integer(start, 0, duration - 1)
        _integer(end, start + 1, duration)
        _integer(lane, 1, _MAX_LANE)
        if (start, lane) <= previous or start < lane_ends.get(lane, 0):
            raise ValueError("unordered or overlapping FCPXML titles in the same lane")
        previous = (start, lane)
        lane_ends[lane] = end
        text_bytes += _text(title["text"], _MAX_TITLE_BYTES, _MAX_TITLE_BYTES)
        if text_bytes > _MAX_TOTAL_TEXT_BYTES:
            raise ValueError("FCPXML total text exceeds size limit")
    return numerator, denominator


def serialize_fcpxml_titles(plan: dict) -> bytes:
    """Serialize validated frame intervals into UTF-8/LF XML. No I/O or media references."""
    numerator, denominator = _validate(plan)

    def frame_time(count):
        ticks = count * denominator
        return f"{ticks // numerator}s" if ticks % numerator == 0 else f"{ticks}/{numerator}s"

    root = ET.Element("fcpxml", version="1.13")
    resources = ET.SubElement(root, "resources")
    ET.SubElement(resources, "format", id="r1", frameDuration=frame_time(1),
                  width=str(plan["width"]), height=str(plan["height"]))
    ET.SubElement(resources, "effect", id="r2", name="Basic Title", uid=_BASIC_TITLE)
    event = ET.SubElement(ET.SubElement(root, "library"), "event", name="MAW Titles")
    project = ET.SubElement(event, "project", name=plan["name"])
    duration = frame_time(plan["durationFrames"])
    sequence = ET.SubElement(project, "sequence", format="r1", duration=duration,
                             tcStart="0s", tcFormat="NDF")
    spine = ET.SubElement(sequence, "spine")
    gap = ET.SubElement(spine, "gap", name="Titles", offset="0s", start="0s", duration=duration)
    for index, title in enumerate(plan["titles"], 1):
        start, end = title["startFrame"], title["endFrame"]
        node = ET.SubElement(gap, "title", ref="r2", name="Basic Title", lane=str(title["lane"]),
                             offset=frame_time(start), duration=frame_time(end - start))
        style_id = f"ts{index}"
        ET.SubElement(ET.SubElement(node, "text"), "text-style", ref=style_id).text = title["text"]
        style = ET.SubElement(node, "text-style-def", id=style_id)
        ET.SubElement(style, "text-style", alignment="center")
    # Preserve literal CRs through XML's line-ending normalization without emitting CRLF.
    body = ET.tostring(root, encoding="utf-8").replace(b"\r", b"&#13;")
    return b'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n' + body + b"\n"


def _bundle_stem(name):
    stem = _BAD_FILENAME.sub("_", name).strip().strip(".").strip()
    stem = stem.encode("utf-8")[:180].decode("utf-8", errors="ignore").rstrip(". ") or "MAW Titles"
    if _DOS_NAME.fullmatch(stem.split(".", 1)[0].rstrip()):
        stem = "_" + stem
    return stem


def build_fcpxml_titles_bundle(plan: dict) -> tuple[str, bytes]:
    """Return a download name and ZIP bytes; callers cannot supply paths or entries."""
    xml = serialize_fcpxml_titles(plan)
    stem = _bundle_stem(plan["name"])
    output = BytesIO()
    entry = ZipInfo(f"{stem}.fcpxmld/Info.fcpxml")
    with ZipFile(output, "w") as archive:
        archive.writestr(entry, xml, compress_type=ZIP_DEFLATED)
    return f"{stem}-final-cut.fcpxmld.zip", output.getvalue()
