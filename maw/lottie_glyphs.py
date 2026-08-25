"""Convert Lottie text layers into font-independent vector shape layers.

The editor deliberately keeps text-mode animation generation in JavaScript.
This module is only used by server-editor for the optional glyph/vector export,
where the server can inspect the installed font and package the resulting
outlines into the .lottie archive.
"""

from __future__ import annotations

import copy
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any


class LottieGlyphError(ValueError):
    """Raised when vector export cannot resolve or draw a required glyph."""


_FONT_SUFFIXES = frozenset({".otf", ".ttf", ".ttc", ".otc"})
_FALLBACK_FAMILIES = (
    "Microsoft YaHei",
    "Noto Sans CJK SC",
    "Noto Sans SC",
    "SimSun",
    "Arial",
)
_FILENAME_HINTS = {
    "microsoft yahei": ("msyh.ttc", "msyhl.ttc", "msyhbd.ttc"),
    "simhei": ("simhei.ttf", "simhei.ttc"),
    "simsun": ("simsun.ttc", "simsunb.ttf"),
    "arial": ("arial.ttf", "arialuni.ttf"),
}


@dataclass(eq=False)
class _FontFace:
    font: Any
    glyph_set: Any
    cmap: dict[int, str]
    metrics: dict[str, tuple[int, int]]
    units_per_em: float
    ascent: float
    family_names: tuple[str, ...]
    source: Path
    font_number: int | None

    def supports(self, character: str) -> bool:
        return bool(character) and ord(character) in self.cmap


@dataclass
class _Contour:
    raw_vertices: list[tuple[float, float]]
    vertices: list[list[float]]
    incoming: list[list[float]]
    outgoing: list[list[float]]
    closed: bool = False


def _font_roots() -> tuple[Path, ...]:
    roots: list[Path] = []
    if sys.platform == "win32":
        windows = os.environ.get("WINDIR")
        local_app_data = os.environ.get("LOCALAPPDATA")
        if windows:
            roots.append(Path(windows) / "Fonts")
        if local_app_data:
            roots.append(Path(local_app_data) / "Microsoft" / "Windows" / "Fonts")
    elif sys.platform == "darwin":
        roots.extend((Path("/System/Library/Fonts"), Path("/Library/Fonts"), Path.home() / "Library" / "Fonts"))
    else:
        roots.extend((Path("/usr/share/fonts"), Path("/usr/local/share/fonts"), Path.home() / ".fonts"))
    return tuple(dict.fromkeys(root for root in roots if root.exists()))


def _font_candidates(family: str) -> tuple[Path, ...]:
    """Return likely font files, with the requested family's common files first."""
    paths: list[Path] = []
    seen: set[Path] = set()
    family_key = family.strip().casefold()

    def add(path: Path) -> None:
        resolved = path.resolve()
        if resolved in seen or not resolved.is_file() or resolved.suffix.casefold() not in _FONT_SUFFIXES:
            return
        seen.add(resolved)
        paths.append(resolved)

    for filename in _FILENAME_HINTS.get(family_key, ()):
        for root in _font_roots():
            add(root / filename)
    for path in _installed_font_files():
        add(path)

    # On Linux, fontconfig knows about fonts outside the conventional roots.
    fc_match = shutil.which("fc-match")
    if fc_match:
        try:
            result = subprocess.run(
                [fc_match, "-f", "%{file}\n", family],
                check=False,
                capture_output=True,
                text=True,
                timeout=2,
            )
        except (OSError, subprocess.SubprocessError):
            result = None
        if result and result.returncode == 0:
            for value in result.stdout.splitlines():
                if value.strip():
                    add(Path(value.strip()))
    return tuple(paths)


def _font_names(font: Any) -> tuple[str, ...]:
    names: list[str] = []
    name_table = font["name"] if "name" in font else None
    if name_table is None:
        return ()
    for name_id in (16, 1):
        try:
            value = name_table.getDebugName(name_id)
        except Exception:  # pragma: no cover - malformed third-party fonts
            value = None
        if value and value not in names:
            names.append(value)
    return tuple(names)


@lru_cache(maxsize=256)
def _open_font_faces(path_name: str) -> tuple[_FontFace, ...]:
    path = Path(path_name)
    try:
        from fontTools.ttLib import TTCollection, TTFont
    except ImportError as error:  # pragma: no cover - exercised by packaging checks
        raise LottieGlyphError(
            "矢量模式需要 fonttools；请重新安装 MAW 或运行 uv sync"
        ) from error

    opened: list[tuple[int | None, Any, Any]] = []
    owner: Any = None
    try:
        if path.suffix.casefold() in {".ttc", ".otc"}:
            owner = TTCollection(str(path), lazy=True)
            opened = [(index, font, owner) for index, font in enumerate(owner.fonts)]
        else:
            font = TTFont(str(path), lazy=True)
            opened = [(None, font, font)]
    except Exception:
        return ()

    faces: list[_FontFace] = []
    for font_number, font, font_owner in opened:
        try:
            cmap = dict(font.getBestCmap() or {})
            if not cmap:
                continue
            head = font["head"]
            hhea = font["hhea"] if "hhea" in font else None
            os2 = font["OS/2"] if "OS/2" in font else None
            ascent = getattr(hhea, "ascent", None) or getattr(os2, "sTypoAscender", head.unitsPerEm)
            metrics = dict(font["hmtx"].metrics)
            faces.append(_FontFace(
                font=font,
                glyph_set=font.getGlyphSet(),
                cmap=cmap,
                metrics=metrics,
                units_per_em=float(head.unitsPerEm),
                ascent=float(ascent),
                family_names=_font_names(font),
                source=path,
                font_number=font_number,
            ))
        except Exception:
            continue
        # Keep the collection alive through the font object; retaining this
        # local owner is also useful for readers that lazily access tables.
        _ = font_owner
    return tuple(faces)


def _close_font_faces(faces: tuple[_FontFace, ...] | list[_FontFace]) -> None:
    for face in faces:
        close = getattr(face.font, "close", None)
        if close:
            close()


@lru_cache(maxsize=1)
def _installed_font_files() -> tuple[Path, ...]:
    paths: list[Path] = []
    seen: set[Path] = set()
    for root in _font_roots():
        try:
            candidates = root.rglob("*")
        except OSError:
            continue
        for path in candidates:
            if not path.is_file() or path.suffix.casefold() not in _FONT_SUFFIXES:
                continue
            resolved = path.resolve()
            if resolved not in seen:
                seen.add(resolved)
                paths.append(resolved)
    return tuple(paths)


@lru_cache(maxsize=32)
def _load_font_family(family: str) -> tuple[_FontFace, ...]:
    family_key = family.strip().casefold()
    faces: list[_FontFace] = []
    for path in _font_candidates(family):
        opened = _open_font_faces(str(path))
        if not opened:
            continue
        matching = tuple(
            face for face in opened
            if any(family_key == name.casefold() or family_key in name.casefold() for name in face.family_names)
        )
        if matching:
            # The first matching face is the regular family face in the
            # platform font directory; loading every installed font variant
            # only makes export slower and keeps unnecessary file handles open.
            selected = matching[:1]
            _close_font_faces([face for face in opened if face not in selected])
            return selected
        elif path.name.casefold() in {hint.casefold() for hint in _FILENAME_HINTS.get(family_key, ())}:
            selected = opened[:1]
            _close_font_faces(opened[1:])
            return selected
        _close_font_faces(opened)
    return tuple(faces)


def _resolve_faces(family: str) -> tuple[_FontFace, ...]:
    requested = str(family or "Arial").strip() or "Arial"
    faces: list[_FontFace] = []
    seen: set[tuple[Path, int | None]] = set()
    for candidate in (requested, *_FALLBACK_FAMILIES):
        for face in _load_font_family(candidate):
            key = (face.source, face.font_number)
            if key not in seen:
                seen.add(key)
                faces.append(face)
        # One Chinese-capable fallback covers the common missing-glyph case;
        # do not inspect every installed family when the requested font already
        # contains the characters in this export.
        if faces and any(face.supports("汉") for face in faces):
            break
    if not faces:
        raise LottieGlyphError(
            f"矢量模式找不到字体“{requested}”；请先在系统中安装该字体"
        )
    return tuple(faces)


def _face_for_character(faces: tuple[_FontFace, ...], character: str) -> _FontFace:
    for face in faces:
        if face.supports(character):
            return face
    codepoint = f"U+{ord(character):04X}" if character else "空字符"
    raise LottieGlyphError(f"矢量模式没有找到字符 {codepoint}（“{character}”）的字形")


def _round(value: float) -> float:
    return round(float(value), 4)


def _transform_point(point: tuple[float, float], scale: float, x_offset: float, baseline: float) -> list[float]:
    return [_round(x_offset + point[0] * scale), _round(baseline - point[1] * scale)]


def _vector_delta(start: list[float], end: list[float]) -> list[float]:
    return [_round(end[0] - start[0]), _round(end[1] - start[1])]


def _append_start(contour: _Contour | None, point: tuple[float, float], scale: float, x_offset: float, baseline: float) -> _Contour:
    transformed = _transform_point(point, scale, x_offset, baseline)
    return _Contour([point], [transformed], [[0, 0]], [[0, 0]])


def _append_line(contour: _Contour, point: tuple[float, float], scale: float, x_offset: float, baseline: float) -> None:
    transformed = _transform_point(point, scale, x_offset, baseline)
    contour.raw_vertices.append(point)
    contour.vertices.append(transformed)
    contour.incoming.append([0, 0])
    contour.outgoing.append([0, 0])


def _append_cubic(
    contour: _Contour,
    control_one: tuple[float, float],
    control_two: tuple[float, float],
    endpoint: tuple[float, float],
    scale: float,
    x_offset: float,
    baseline: float,
) -> None:
    start = contour.vertices[-1]
    transformed_control_one = _transform_point(control_one, scale, x_offset, baseline)
    transformed_control_two = _transform_point(control_two, scale, x_offset, baseline)
    transformed_endpoint = _transform_point(endpoint, scale, x_offset, baseline)
    contour.outgoing[-1] = _vector_delta(start, transformed_control_one)
    contour.raw_vertices.append(endpoint)
    contour.vertices.append(transformed_endpoint)
    contour.incoming.append(_vector_delta(transformed_endpoint, transformed_control_two))
    contour.outgoing.append([0, 0])


def _quadratic_to_cubics(
    contour: _Contour,
    points: tuple[tuple[float, float] | None, ...],
    scale: float,
    x_offset: float,
    baseline: float,
) -> None:
    if not points:
        return
    if points[-1] is None:
        endpoint = contour.raw_vertices[0]
        controls = [point for point in points[:-1] if point is not None]
    else:
        endpoint = points[-1]
        controls = [point for point in points[:-1] if point is not None]
    if endpoint is None:
        return
    if not controls:
        _append_line(contour, endpoint, scale, x_offset, baseline)
        return
    start = contour.raw_vertices[-1]
    for index, control in enumerate(controls):
        target = endpoint if index == len(controls) - 1 else (
            (control[0] + controls[index + 1][0]) / 2,
            (control[1] + controls[index + 1][1]) / 2,
        )
        control_one = (
            start[0] + (control[0] - start[0]) * 2 / 3,
            start[1] + (control[1] - start[1]) * 2 / 3,
        )
        control_two = (
            target[0] + (control[0] - target[0]) * 2 / 3,
            target[1] + (control[1] - target[1]) * 2 / 3,
        )
        _append_cubic(contour, control_one, control_two, target, scale, x_offset, baseline)
        start = target


def _recording_to_paths(
    recording: Any,
    scale: float,
    x_offset: float,
    baseline: float,
) -> list[dict[str, Any]]:
    contours: list[_Contour] = []
    current: _Contour | None = None
    for operation, points in recording.value:
        if operation == "moveTo":
            if current is not None:
                contours.append(current)
            current = _append_start(current, points[0], scale, x_offset, baseline)
        elif current is None:
            continue
        elif operation == "lineTo":
            _append_line(current, points[0], scale, x_offset, baseline)
        elif operation == "curveTo":
            _append_cubic(current, points[0], points[1], points[2], scale, x_offset, baseline)
        elif operation == "qCurveTo":
            _quadratic_to_cubics(current, points, scale, x_offset, baseline)
        elif operation == "closePath":
            if current.raw_vertices[-1] != current.raw_vertices[0]:
                _append_line(current, current.raw_vertices[0], scale, x_offset, baseline)
            current.closed = True
            contours.append(current)
            current = None
        elif operation == "endPath":
            contours.append(current)
            current = None
    if current is not None:
        contours.append(current)

    paths: list[dict[str, Any]] = []
    for index, contour in enumerate(contours):
        if len(contour.vertices) < 2:
            continue
        paths.append({
            "ty": "sh",
            "ind": index,
            "ks": {
                "a": 0,
                "k": {
                    "i": contour.incoming,
                    "o": contour.outgoing,
                    "v": contour.vertices,
                    "c": contour.closed,
                },
            },
            "nm": f"Glyph path {index + 1}",
        })
    return paths


def _glyph_paths(
    face: _FontFace,
    character: str,
    scale: float,
    x_offset: float,
    baseline: float,
) -> tuple[list[dict[str, Any]], float]:
    glyph_name = face.cmap.get(ord(character))
    if not glyph_name:
        return [], face.units_per_em * 0.25 * scale
    try:
        from fontTools.pens.recordingPen import RecordingPen

        recording = RecordingPen()
        face.glyph_set[glyph_name].draw(recording)
        paths = _recording_to_paths(recording, scale, x_offset, baseline)
    except Exception as error:  # pragma: no cover - malformed installed font
        raise LottieGlyphError(f"无法解析字符“{character}”的字体轮廓") from error
    advance = face.metrics.get(glyph_name, (face.units_per_em * 0.25, 0))[0] * scale
    return paths, float(advance)


def _static_value(value: Any, fallback: Any) -> Any:
    if isinstance(value, dict) and value.get("a") == 0:
        return value.get("k", fallback)
    return fallback


def _selector_keyframes(value: Any) -> list[tuple[int, int]]:
    if not isinstance(value, dict):
        return []
    keyframes = value.get("k")
    if isinstance(keyframes, (int, float)):
        return [(0, int(round(keyframes)))]
    result: list[tuple[int, int]] = []
    if isinstance(keyframes, list):
        for keyframe in keyframes:
            if not isinstance(keyframe, dict):
                continue
            frame = keyframe.get("t")
            start = keyframe.get("s")
            if isinstance(frame, (int, float)) and isinstance(start, list) and start:
                result.append((int(round(frame)), int(round(float(start[0])))))
    return result


def _highlight_states(layer: dict[str, Any], character_index: int) -> list[tuple[int, bool]]:
    animator_list = layer.get("t", {}).get("a", [])
    animator = animator_list[0] if isinstance(animator_list, list) and animator_list else {}
    selector = animator.get("s", {}) if isinstance(animator, dict) else {}
    starts = _selector_keyframes(selector.get("s"))
    ends = _selector_keyframes(selector.get("e"))
    frames = sorted({frame for frame, _ in starts} | {frame for frame, _ in ends})
    layer_end = layer.get("op")
    if isinstance(layer_end, (int, float)):
        frames.append(int(round(layer_end)))
    frames = sorted(set(frames))
    if not frames:
        return []

    def value_at(keyframes: list[tuple[int, int]], frame: int) -> int:
        current = keyframes[0][1] if keyframes else 0
        for keyframe_frame, value in keyframes:
            if keyframe_frame > frame:
                break
            current = value
        return current

    return [
        (frame, value_at(starts, frame) <= character_index < value_at(ends, frame))
        for frame in frames
    ]


def _highlight_color(
    layer: dict[str, Any],
    character_index: int,
    base_color: Any,
    highlight_color: Any,
) -> dict[str, Any]:
    states = _highlight_states(layer, character_index)
    if not states:
        return {"a": 0, "k": base_color}
    return {
        "a": 1,
        "k": [
            {"t": frame, "s": highlight_color if active else base_color, "h": 1}
            for frame, active in states
        ],
    }


def _shape_group(paths: list[dict[str, Any]], color: Any, opacity: dict[str, Any], name: str) -> dict[str, Any]:
    color_property = color if isinstance(color, dict) and "a" in color else {"a": 0, "k": color}
    return {
        "ty": "gr",
        "nm": name,
        "it": [
            *copy.deepcopy(paths),
            {"ty": "fl", "c": color_property, "o": opacity, "r": 1, "bm": 0, "nm": "Fill"},
            {
                "ty": "tr",
                "p": {"a": 0, "k": [0, 0]},
                "a": {"a": 0, "k": [0, 0]},
                "s": {"a": 0, "k": [100, 100]},
                "r": {"a": 0, "k": 0},
                "o": {"a": 0, "k": 100},
                "sk": {"a": 0, "k": 0},
                "sa": {"a": 0, "k": 0},
                "nm": "Transform",
            },
        ],
    }


def _vector_layer(
    layer: dict[str, Any],
    faces: tuple[_FontFace, ...],
    highlight_color: Any,
) -> dict[str, Any]:
    document = layer.get("t", {}).get("d", {}).get("k", [{}])[0].get("s", {})
    text = str(document.get("t", "")).replace("\r", "\n")
    units = list(text)
    font_size = max(1.0, float(document.get("s", 18) or 18))
    primary_face = faces[0]
    scale = font_size / primary_face.units_per_em
    line_height = max(font_size, float(document.get("lh", font_size * 1.25) or font_size * 1.25))

    glyph_faces: list[_FontFace | None] = []
    advances: list[float] = []
    for character in units:
        if character in {"\n", "\r"}:
            glyph_faces.append(None)
            advances.append(0.0)
            continue
        face = _face_for_character(faces, character)
        glyph_faces.append(face)
        glyph_name = face.cmap.get(ord(character))
        advances.append(float(face.metrics.get(glyph_name, (face.units_per_em * 0.25, 0))[0]) * scale)

    lines: list[list[int]] = [[]]
    for index, character in enumerate(units):
        if character in {"\n", "\r"}:
            lines.append([])
        else:
            lines[-1].append(index)
    line_widths = [sum(advances[index] for index in line) for line in lines]
    ascent = primary_face.ascent * scale
    block_top = -len(lines) * line_height / 2
    base_color = document.get("fc", [1, 1, 1])
    if not isinstance(highlight_color, list) or len(highlight_color) != 3:
        highlight_color = [1, 0.827, 0.302]
    shapes: list[dict[str, Any]] = []
    char_positions: dict[int, tuple[float, float]] = {}
    for line_index, line in enumerate(lines):
        x = -line_widths[line_index] / 2
        baseline = block_top + ascent + line_index * line_height
        for index in line:
            char_positions[index] = (x, baseline)
            x += advances[index]

    for index, character in enumerate(units):
        face = glyph_faces[index]
        if face is None or index not in char_positions:
            continue
        x, baseline = char_positions[index]
        paths, _ = _glyph_paths(face, character, scale, x, baseline)
        if not paths:
            continue
        shapes.append(_shape_group(
            paths,
            _highlight_color(layer, index, base_color, highlight_color),
            {"a": 0, "k": 100},
            character,
        ))

    position = copy.deepcopy(layer.get("ks", {}).get("p", {"a": 0, "k": [0, 0, 0]}))
    return {
        "ddd": 0,
        "ind": layer.get("ind", 1),
        "ty": 4,
        "nm": f"{layer.get('nm', 'MAW 字幕')}（矢量）",
        "sr": layer.get("sr", 1),
        "ks": {
            "o": {"a": 0, "k": 100},
            "r": {"a": 0, "k": 0},
            "p": position,
            "a": {"a": 0, "k": [0, 0, 0]},
            "s": {"a": 0, "k": [100, 100, 100]},
        },
        "ao": 0,
        "ip": layer.get("ip", 0),
        "op": layer.get("op", 1),
        "st": layer.get("st", 0),
        "bm": layer.get("bm", 0),
        "shapes": shapes,
    }


def vectorize_lottie_animation(animation: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of *animation* with text layers replaced by vector glyphs."""
    meta = animation.get("meta") if isinstance(animation.get("meta"), dict) else {}
    font_family = str(meta.get("fontFamily", ""))
    if not font_family:
        for layer in animation.get("layers", []):
            document = layer.get("t", {}).get("d", {}).get("k", [{}])[0].get("s", {})
            if isinstance(document, dict) and document.get("f"):
                font_family = str(document["f"])
                break
    faces = _resolve_faces(font_family or "Arial")
    highlight_color: Any = meta.get("highlightColor")
    if not isinstance(highlight_color, list):
        for layer in animation.get("layers", []):
            animator_list = layer.get("t", {}).get("a", []) if isinstance(layer, dict) else []
            if animator_list and isinstance(animator_list[0], dict):
                color = animator_list[0].get("a", {}).get("fc", {}).get("k")
                if isinstance(color, list):
                    highlight_color = color
                    break
    result = copy.deepcopy(animation)
    result["layers"] = [
        _vector_layer(layer, faces, highlight_color)
        if isinstance(layer, dict) and layer.get("ty") == 5 else layer
        for layer in result.get("layers", [])
    ]
    result["fonts"] = {"list": []}
    meta = dict(result.get("meta") or {})
    meta["renderMode"] = "glyph"
    result["meta"] = meta
    return result
