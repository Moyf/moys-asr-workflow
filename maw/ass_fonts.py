"""ASS 字体名归一化：本机字体别名表。

libass（Windows 上 directwrite + GDI 字体提供器）只按字体 nameID 1（GDI 兼容
family，任意语言变体）匹配；用户在 ASS 样式里存了 nameID 16 的排版名
（如 Smiley Sans 的 "Smiley Sans"）时 libass 不识别，会静默回退到默认字体。
本模块扫描本机字体文件，把同一 family 的全部名字（nameID 1/4/6/16）聚合成
别名条目，并改写 ASS ``Style:`` 行的 Fontname 字段为本机 canonical 名。

扫描结果进程内缓存；fontTools 缺失或扫描失败时所有入口优雅降级（归一化
原样返回、端点返回错误结构），与 serve.py 的 libass 探测降级风格一致。
"""

from __future__ import annotations

import os
import re
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any, Final, Mapping

FONT_ALIAS_SCHEMA: Final = "moy.asr.font_aliases.v1"

_FONT_SUFFIXES: Final = frozenset({".otf", ".ttf", ".ttc", ".otc"})
_TTC_SUFFIXES: Final = frozenset({".ttc", ".otc"})
# macOS 27 起系统字体可经 MobileAsset 按需投递（AssetsV2）；字体资产目录
# 前缀固定为 com_apple_MobileAsset_Font*，未来版本可能递增编号。
# 注意 maw/lottie_glyphs.py 的 _font_roots 内联了同一路径，调整时必须同步。
MACOS_ASSETS_V2_ROOT: Final = Path("/System/Library/AssetsV2")
# ASS Style 行固定 23 字段，Fontname 是第 2 个逗号分隔字段；只匹配行首的
# Style: 前缀，Format:/Dialogue: 与事件文本一概不动。
_STYLE_LINE_RE: Final = re.compile(r"^(Style:[ \t]*)(.*)$")

# Windows LANGID 主语言 ID（低 10 位）：中文 0x04、英文 0x09；其余语言以
# 十六进制主语言 ID 作为键，与字体 name 记录的语言键同空间比较。
_PRIMARY_LANGUAGE_ZH: Final = 0x04
_PRIMARY_LANGUAGE_EN: Final = 0x09
# Macintosh 平台 langID：0 = English，33/34 = 简/繁中文。
_MAC_LANGUAGE_EN: Final = 0
_MAC_LANGUAGE_ZH: Final = frozenset({33, 34})


class FontAliasTableUnavailable(RuntimeError):
    """字体别名表不可用（fontTools 缺失等）；调用方按降级路径处理。"""


@dataclass(frozen=True)
class FontNameRecord:
    """一条 name 表记录的归一化结果：值 + 语言键（"" 表示未知）。"""

    value: str
    language: str


@dataclass(frozen=True)
class FontFileNames:
    """单个字体 face 读出的各 nameID 名字集合（各自保序去重）。"""

    family: tuple[FontNameRecord, ...]  # nameID 1（全语言）
    typographic: tuple[str, ...]  # nameID 16
    full: tuple[str, ...]  # nameID 4
    postscript: tuple[str, ...]  # nameID 6

    def all_names(self) -> tuple[str, ...]:
        return tuple(dict.fromkeys((
            *(record.value for record in self.family),
            *self.typographic,
            *self.full,
            *self.postscript,
        )))


def _primary_language_key(primary_id: int) -> str:
    if primary_id == _PRIMARY_LANGUAGE_ZH:
        return "zh"
    if primary_id == _PRIMARY_LANGUAGE_EN:
        return "en"
    return f"win:{primary_id:02x}"


def _record_language(record: Any) -> str:
    """把 name 记录的 platform/langID 折算成与系统语言可比的键。"""

    platform_id = getattr(record, "platformID", None)
    lang_id = getattr(record, "langID", None)
    if not isinstance(lang_id, int):
        return ""
    if platform_id == 3:  # Windows
        return _primary_language_key(lang_id & 0x3FF)
    if platform_id == 1:  # Macintosh
        if lang_id == _MAC_LANGUAGE_EN:
            return "en"
        if lang_id in _MAC_LANGUAGE_ZH:
            return "zh"
    return ""


def _locale_primary_key(locale: str) -> str:
    """把 "zh-CN" / "zh_CN" 形式的 locale 折算成主语言键。"""

    text = str(locale or "").strip().replace("_", "-")
    if not text:
        return ""
    prefix = re.split(r"[-@.]", text, maxsplit=1)[0].lower()
    if prefix == "zh":
        return "zh"
    if prefix == "en":
        return "en"
    return f"locale:{prefix}"


def _system_ui_language_keys() -> tuple[str, ...]:
    """系统 UI 语言键（Windows）；非 Windows 或取不到时为空，走 zh→en 兜底。"""

    if sys.platform != "win32":
        return ()
    keys: list[str] = []
    try:
        import ctypes

        lang_id = int(ctypes.windll.kernel32.GetUserDefaultUILanguage()) & 0xFFFF
        keys.append(_primary_language_key(lang_id & 0x3FF))
    except Exception:  # noqa: BLE001 - 缺 ctypes/调用失败都走下一个来源
        pass
    if not keys:
        try:
            import ctypes

            buffer = ctypes.create_unicode_buffer(85)
            if ctypes.windll.kernel32.GetUserDefaultLocaleName(buffer, len(buffer)):
                key = _locale_primary_key(buffer.value)
                if key:
                    keys.append(key)
        except Exception:  # noqa: BLE001
            pass
    return tuple(dict.fromkeys(key for key in keys if key))


def _windows_registry_font_files() -> tuple[Path, ...]:
    """读注册表登记的字体文件路径（HKLM + HKCU），值可为绝对或相对路径。"""

    if sys.platform != "win32":
        return ()
    try:
        import winreg
    except ImportError:  # pragma: no cover - 非 Windows 不会走到这里
        return ()
    system_fonts_dir = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    local_app_data = os.environ.get("LOCALAPPDATA")
    user_fonts_dir = (
        Path(local_app_data) / "Microsoft" / "Windows" / "Fonts" if local_app_data else None
    )
    found: list[Path] = []
    for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        try:
            with winreg.OpenKey(
                hive, r"SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
            ) as key:
                index = 0
                while True:
                    try:
                        _, data, _ = winreg.EnumValue(key, index)
                    except OSError:
                        break
                    index += 1
                    if not isinstance(data, str) or not data.strip():
                        continue
                    found.append(
                        _registry_font_path(data, system_fonts_dir, user_fonts_dir)
                    )
        except OSError:
            continue
    return tuple(path for path in found if path is not None)


def _registry_font_path(
    data: str, system_fonts_dir: Path, user_fonts_dir: Path | None,
) -> Path:
    """注册表值 → 字体文件路径：绝对路径原样；相对名按实际存在文件落位
    （系统目录优先，仅用户目录有文件时落到用户目录，都没有按系统目录兜底）。"""

    candidate = Path(data.strip().strip('"'))
    if candidate.is_absolute():
        return candidate
    resolved = system_fonts_dir / candidate
    if (user_fonts_dir is not None and user_fonts_dir != system_fonts_dir
            and not resolved.is_file() and (user_fonts_dir / candidate).is_file()):
        return user_fonts_dir / candidate
    return resolved


def _font_roots() -> tuple[Path, ...]:
    """兜底枚举的字体目录（与 lottie_glyphs 的目录约定保持一致）。"""

    roots: list[Path] = []
    if sys.platform == "win32":
        windows = os.environ.get("WINDIR")
        local_app_data = os.environ.get("LOCALAPPDATA")
        if windows:
            roots.append(Path(windows) / "Fonts")
        if local_app_data:
            roots.append(Path(local_app_data) / "Microsoft" / "Windows" / "Fonts")
    elif sys.platform == "darwin":
        roots.extend((
            Path("/System/Library/Fonts"),
            Path("/Library/Fonts"),
            Path.home() / "Library" / "Fonts",
        ))
        # macOS 27 起部分系统字体（PingFang、Kaiti 等 CJK 字体）改为 MobileAsset
        # 按需投递，存放在 AssetsV2 的字体资产目录；CoreText 与 libass 的
        # coretext provider 仍能解析它们，漏扫会把本机已有字体误报为「未找到」。
        # 只枚举字体资产目录，避免遍历整个 AssetsV2。
        roots.extend(sorted(
            path for path in MACOS_ASSETS_V2_ROOT.glob("com_apple_MobileAsset_Font*")
            if path.is_dir()
        ))
    else:
        roots.extend((
            Path("/usr/share/fonts"),
            Path("/usr/local/share/fonts"),
            Path.home() / ".fonts",
        ))
    return tuple(dict.fromkeys(root for root in roots if root.exists()))


@lru_cache(maxsize=1)
def _installed_font_files() -> tuple[Path, ...]:
    """本机字体文件清单：注册表登记优先，目录枚举兜底，去重。"""

    paths: list[Path] = []
    seen: set[Path] = set()

    def add(path: Path) -> None:
        try:
            resolved = path.resolve()
            if resolved in seen or not resolved.is_file():
                return
        except OSError:
            return
        if resolved.suffix.casefold() not in _FONT_SUFFIXES:
            return
        seen.add(resolved)
        paths.append(resolved)

    for path in _windows_registry_font_files():
        add(path)
    for root in _font_roots():
        try:
            candidates = root.rglob("*")
        except OSError:
            continue
        for path in candidates:
            if path.is_file():
                add(path)
    return tuple(paths)


def _extract_font_names(font: Any) -> FontFileNames:
    """读单个 face 的 nameID 1/4/6/16；坏记录静默跳过。"""

    name_table = font["name"] if "name" in font else None
    family: list[FontNameRecord] = []
    typographic: list[str] = []
    full: list[str] = []
    postscript: list[str] = []
    if name_table is not None:
        for record in name_table.names:
            try:
                value = str(record.toUnicode()).strip()
            except Exception:  # noqa: BLE001 - 第三方字体坏记录
                continue
            if not value:
                continue
            name_id = getattr(record, "nameID", None)
            if name_id == 1:
                family.append(FontNameRecord(value, _record_language(record)))
            elif name_id == 16:
                typographic.append(value)
            elif name_id == 4:
                full.append(value)
            elif name_id == 6:
                postscript.append(value)
    return FontFileNames(
        family=tuple(dict.fromkeys(family)),
        typographic=tuple(dict.fromkeys(typographic)),
        full=tuple(dict.fromkeys(full)),
        postscript=tuple(dict.fromkeys(postscript)),
    )


def _read_font_file_names(path: Path) -> list[FontFileNames]:
    """读一个字体文件（TTC 展开为多个 face）；读不了返回空列表。

    fontTools 缺失抛 :class:`FontAliasTableUnavailable`，由扫描入口统一降级。
    """

    try:
        from fontTools.ttLib import TTCollection, TTFont
    except ImportError as error:
        raise FontAliasTableUnavailable(
            "fonttools 不可用，无法扫描本机字体；请重新安装 MAW 或运行 uv sync"
        ) from error
    faces: list[Any] = []
    try:
        if path.suffix.casefold() in _TTC_SUFFIXES:
            collection = TTCollection(str(path), lazy=True)
            faces = list(collection.fonts)
        else:
            faces = [TTFont(str(path), lazy=True)]
    except Exception:  # noqa: BLE001 - 单个坏文件静默跳过
        return []
    results: list[FontFileNames] = []
    for font in faces:
        try:
            names = _extract_font_names(font)
        except Exception:  # noqa: BLE001 - 坏 name 表静默跳过
            continue
        results.append(names)
    # TTC 的多个 face 懒加载共享同一个文件流：必须全部读完再统一关闭。
    # 在循环里逐 face close 会让后续 face 读 name 表失败，整个集合只剩
    # 第一个 face（如 PingFang.ttc 只剩 HK，丢掉 SC/TC/MO）。
    for font in faces:
        close = getattr(font, "close", None)
        if close:
            close()
    return results


def _canonical_family_name(
    records: Sequence[FontNameRecord], system_langs: Sequence[str],
) -> str | None:
    """canonical：nameID1 值按「系统 UI 语言 → zh → en → 第一个」选取。"""

    if not records:
        return None
    for lang in system_langs:
        for record in records:
            if record.language and record.language == lang:
                return record.value
    for fallback in ("zh", "en"):
        for record in records:
            if record.language == fallback:
                return record.value
    return records[0].value


@dataclass
class _AliasGroup:
    names: list[str]
    folds: set[str]
    records: list[FontNameRecord]
    family: list[str]
    canonical_by_name: dict[str, str]


def _merge_font_entries(
    files: Iterable[FontFileNames], system_langs: Sequence[str] = (),
) -> list[dict[str, Any]]:
    """同一 family 的多个 face（名字集合有交集）合并为一个别名条目。

    条目额外携带 ``family``（该 family 全部 nameID1 值）：libass 的 GDI 兼容
    匹配对任意语言变体的 nameID1 都能命中，归一化时存储名已是 nameID1 之一
    就无需改写。
    """

    groups: list[_AliasGroup] = []
    fold_to_group: dict[str, int] = {}
    for data in files:
        names = list(data.all_names())
        if not names:
            continue
        folds = {name.casefold() for name in names}
        face_canonical = _canonical_family_name(data.family, system_langs) or names[0]
        face_targets = {name.casefold(): face_canonical for name in names}
        hit_indices = {fold_to_group[fold] for fold in folds if fold in fold_to_group}
        if not hit_indices:
            groups.append(_AliasGroup(
                names=list(names), folds=set(folds), records=list(data.family),
                family=[record.value for record in dict.fromkeys(data.family)],
                canonical_by_name=face_targets,
            ))
            target = len(groups) - 1
        else:
            target = min(hit_indices)
            merged = groups[target]
            for index in sorted(hit_indices - {target}, reverse=True):
                other = groups.pop(index)
                merged.names.extend(other.names)
                merged.folds |= other.folds
                merged.records.extend(other.records)
                merged.family.extend(other.family)
                for name, canonical in other.canonical_by_name.items():
                    merged.canonical_by_name.setdefault(name, canonical)
            if len(hit_indices) > 1:
                # pop 会移动未参与合并的后续分组；所有别名索引都要随之重建。
                fold_to_group = {
                    fold: index
                    for index, existing in enumerate(groups)
                    for fold in existing.folds
                }
            merged.names.extend(names)
            merged.folds |= folds
            merged.records.extend(data.family)
            merged.family.extend(record.value for record in data.family)
            for name, canonical in face_targets.items():
                # 共有排版名保持首次选择；full/PS 别名仍指向其所属 face，
                # 避免 Semibold 与 Regular 共享 nameID16 后丢失字重。
                merged.canonical_by_name.setdefault(name, canonical)
        group = groups[target]
        for fold in folds:
            fold_to_group[fold] = target
    entries: list[dict[str, Any]] = []
    for group in groups:
        names = list(dict.fromkeys(group.names))
        family = list(dict.fromkeys(group.family))
        if family:
            canonical = _canonical_family_name(group.records, system_langs) or family[0]
        else:
            canonical = names[0]
        entries.append({"canonical": canonical, "names": names, "family": family,
                        "canonicalByName": group.canonical_by_name})
    return entries


def _scan_font_entries() -> list[dict[str, Any]]:
    """扫描本机字体并聚合别名表（不做缓存，供缓存层与测试使用）。"""

    file_data: list[FontFileNames] = []
    for path in _installed_font_files():
        file_data.extend(_read_font_file_names(path))
    return _merge_font_entries(file_data, _system_ui_language_keys())


@lru_cache(maxsize=1)
def _cached_font_entries() -> tuple[dict[str, Any], ...] | None:
    try:
        return tuple(_scan_font_entries())
    except Exception:  # noqa: BLE001 - 任何扫描失败都按不可用降级
        return None


def font_alias_entries() -> tuple[dict[str, Any], ...] | None:
    """进程内缓存的别名条目；``None`` 表示表不可用（扫描失败/缺 fontTools）。"""

    return _cached_font_entries()


def _resolve_entry(
    entries: Sequence[Mapping[str, Any]], name: str,
) -> Mapping[str, Any] | None:
    """别名（大小写不敏感）→ 所属条目；重名时保留先出现条目。"""

    key = str(name).strip().casefold()
    if not key:
        return None
    for entry in entries:
        canonical = str(entry.get("canonical") or "").strip()
        if not canonical:
            continue
        for candidate in [canonical, *(str(alias) for alias in entry.get("names") or ())]:
            if candidate.strip().casefold() == key:
                return entry
    return None


def _entry_family_folds(entry: Mapping[str, Any]) -> set[str]:
    return {
        str(value).strip().casefold()
        for value in entry.get("family") or ()
        if str(value).strip()
    }


def resolve_font_name(name: str) -> str | None:
    """别名 → 本机 canonical 名（大小写不敏感）；未命中或表不可用返回 None。"""

    entries = font_alias_entries()
    if not entries:
        return None
    entry = _resolve_entry(entries, name)
    if entry is None:
        return None
    canonical = str((entry.get("canonicalByName") or {}).get(str(name).strip().casefold())
                    or entry.get("canonical") or "").strip()
    return canonical or None


def normalize_ass_text_fontnames(text: str) -> tuple[str, list[str]]:
    """把 ASS 文本所有 Style 行的 Fontname 字段改写为本机 canonical 名。

    返回 ``(新文本, 人读变更说明列表)``：替换发生给出「已按本机字体匹配」，
    名字查不到给出「未在本机找到」；说明按首次出现去重。存储名已是该字体
    nameID1 之一（libass 可直接命中）或等于 canonical 时不改写、不告警。
    表不可用或为空、文本没有 Style 行时原样返回，不产生任何告警。
    """

    entries = font_alias_entries()
    if not entries:
        return text, []
    lines = text.split("\n")
    output: list[str] = []
    notices: list[str] = []
    seen_notices: set[str] = set()
    changed = False
    for line in lines:
        new_line, line_notices = _normalize_style_line_fontname(line, entries)
        if new_line != line:
            changed = True
            line = new_line
        for notice in line_notices:
            if notice not in seen_notices:
                seen_notices.add(notice)
                notices.append(notice)
        output.append(line)
    if not changed:
        return text, notices
    return "\n".join(output), notices


def _normalize_style_line_fontname(
    line: str, entries: Sequence[Mapping[str, Any]],
) -> tuple[str, list[str]]:
    match = _STYLE_LINE_RE.match(line)
    if not match:
        return line, []
    fields = match.group(2).split(",")
    if len(fields) < 2:
        return line, []
    name = fields[1].strip()
    if not name:
        return line, []
    entry = _resolve_entry(entries, name)
    if entry is None:
        return line, [f"字体「{name}」未在本机找到，实际画面将回退为其他字体"]
    canonical = str((entry.get("canonicalByName") or {}).get(name.casefold())
                    or entry.get("canonical") or "").strip()
    # 存储名已是 nameID1 之一（libass 的 GDI 兼容匹配可命中，任意语言变体）
    # 或等于 canonical 时保持原样：改写只服务于排版名/PS 名这类匹配不了的名字。
    if not canonical or canonical == name or name.casefold() in _entry_family_folds(entry):
        return line, []
    fields[1] = canonical
    return f"{match.group(1)}{','.join(fields)}", [
        f"字体「{name}」已按本机字体匹配为「{canonical}」",
    ]


def font_alias_payload() -> dict[str, Any]:
    """给 ``GET /api/ass-font-aliases`` 的 JSON 结构；不可用时返回错误结构。"""

    entries = font_alias_entries()
    if entries is None:
        return {
            "schema": FONT_ALIAS_SCHEMA,
            "fonts": [],
            "error": "本机字体扫描不可用（fontTools 缺失或扫描失败）；字体名归一化已停用",
        }
    # 前端与服务端都须保留 libass 已能匹配的 nameID1；不同字重 face
    # 可能共享排版名，不能把它们全部改写成同一个 canonical。
    fonts = [dict(entry) for entry in entries]
    return {"schema": FONT_ALIAS_SCHEMA, "fonts": fonts}
