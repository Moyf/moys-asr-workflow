from __future__ import annotations

import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

from maw import ass_fonts
from maw.ass_fonts import (
    FONT_ALIAS_SCHEMA,
    FontFileNames,
    FontNameRecord,
    _canonical_family_name,
    _extract_font_names,
    _locale_primary_key,
    _merge_font_entries,
    _primary_language_key,
    _record_language,
    _registry_font_path,
    normalize_ass_text_fontnames,
    resolve_font_name,
)


def _entries(*pairs: tuple[str, tuple[str, ...]]) -> tuple[dict, ...]:
    return tuple({"canonical": canonical, "names": list(names)} for canonical, names in pairs)


SMILEY_ENTRIES = _entries(
    ("得意黑", ("得意黑", "Smiley Sans", "Smiley Sans Oblique", "SmileySans-Oblique")),
    ("Arial", ("Arial", "Arial MT")),
)
# 带 family（nameID1 值集合）的条目：libass 可直接命中的名字无需改写。
YAHEI_ENTRIES = ({
    "canonical": "微软雅黑",
    "names": ["微软雅黑", "Microsoft YaHei", "Microsoft YaHei UI"],
    "family": ["微软雅黑", "Microsoft YaHei"],
},)


class _FakeNameRecord:
    def __init__(self, name_id: int, value: str, platform_id: int = 3, lang_id: int = 0x409) -> None:
        self.nameID = name_id
        self.platformID = platform_id
        self.langID = lang_id
        self._value = value

    def toUnicode(self) -> str:
        return self._value


class _FakeNameTable:
    def __init__(self, records: list[_FakeNameRecord]) -> None:
        self.names = records


class _FakeFont:
    def __init__(self, records: list[_FakeNameRecord]) -> None:
        self._table = _FakeNameTable(records)

    def __contains__(self, key: str) -> bool:
        return key == "name"

    def __getitem__(self, key: str) -> _FakeNameTable:
        if key != "name":
            raise KeyError(key)
        return self._table


class LanguageKeyTests(unittest.TestCase):
    def test_primary_language_key_maps_zh_en_and_others(self) -> None:
        self.assertEqual(_primary_language_key(0x04), "zh")
        self.assertEqual(_primary_language_key(0x09), "en")
        self.assertEqual(_primary_language_key(0x11), "win:11")

    def test_record_language_reads_windows_and_mac_lang_ids(self) -> None:
        windows = _FakeNameRecord(1, "x", platform_id=3, lang_id=0x0804)
        mac_zh = _FakeNameRecord(1, "x", platform_id=1, lang_id=33)
        mac_en = _FakeNameRecord(1, "x", platform_id=1, lang_id=0)
        unknown = _FakeNameRecord(1, "x", platform_id=3, lang_id=0x0411)
        self.assertEqual(_record_language(windows), "zh")
        self.assertEqual(_record_language(mac_zh), "zh")
        self.assertEqual(_record_language(mac_en), "en")
        self.assertEqual(_record_language(unknown), "win:11")

    def test_locale_primary_key_normalizes_separators(self) -> None:
        self.assertEqual(_locale_primary_key("zh-CN"), "zh")
        self.assertEqual(_locale_primary_key("en_US"), "en")
        self.assertEqual(_locale_primary_key(""), "")


class ExtractFontNamesTests(unittest.TestCase):
    def test_extracts_name_ids_with_languages_and_skips_bad_records(self) -> None:
        font = _FakeFont([
            _FakeNameRecord(1, "得意黑", lang_id=0x0804),
            _FakeNameRecord(1, "Smiley Sans", lang_id=0x0409),
            _FakeNameRecord(1, "得意黑", lang_id=0x0804),  # 重复值去重
            _FakeNameRecord(16, "Smiley Sans"),
            _FakeNameRecord(4, "Smiley Sans Regular"),
            _FakeNameRecord(6, "SmileySans-Oblique"),
            _FakeNameRecord(3, "bad record"),
        ])

        class _BrokenRecord:
            nameID = 1
            platformID = 3
            langID = 0x0409

            def toUnicode(self) -> str:
                raise ValueError("bad")

        font._table.names.insert(2, _BrokenRecord())
        names = _extract_font_names(font)
        self.assertEqual(names.family, (
            FontNameRecord("得意黑", "zh"),
            FontNameRecord("Smiley Sans", "en"),
        ))
        self.assertEqual(names.typographic, ("Smiley Sans",))
        self.assertEqual(names.full, ("Smiley Sans Regular",))
        self.assertEqual(names.postscript, ("SmileySans-Oblique",))
        self.assertEqual(names.all_names(), (
            "得意黑", "Smiley Sans", "Smiley Sans Regular", "SmileySans-Oblique",
        ))


class CanonicalSelectionTests(unittest.TestCase):
    def _records(self, *pairs: tuple[str, str]) -> list[FontNameRecord]:
        return [FontNameRecord(value, language) for value, language in pairs]

    def test_prefers_system_language_then_zh_then_en_then_first(self) -> None:
        records = self._records(("Smiley Sans", "en"), ("得意黑", "zh"))
        self.assertEqual(_canonical_family_name(records, ("zh",)), "得意黑")
        self.assertEqual(_canonical_family_name(records, ("en",)), "Smiley Sans")
        self.assertEqual(_canonical_family_name(records, ()), "得意黑")
        reversed_records = self._records(("得意黑", "zh"), ("Smiley Sans", "en"))
        self.assertEqual(_canonical_family_name(reversed_records, ("ja",)), "得意黑")
        self.assertEqual(
            _canonical_family_name(self._records(("Arial", "")), ("zh",)), "Arial",
        )
        self.assertIsNone(_canonical_family_name([], ("zh",)))


class MergeFontEntriesTests(unittest.TestCase):
    def test_faces_with_intersecting_names_merge_into_one_entry(self) -> None:
        ttf = FontFileNames(
            family=(FontNameRecord("得意黑", "zh"), FontNameRecord("Smiley Sans", "en")),
            typographic=("Smiley Sans",),
            full=("Smiley Sans Regular",),
            postscript=("SmileySans-Oblique",),
        )
        otf = FontFileNames(
            family=(FontNameRecord("Smiley Sans Oblique", "en"),),
            typographic=(),
            full=("Smiley Sans Oblique",),
            postscript=("SmileySans-Oblique",),  # 与 ttf 的 PS 名交集触发合并
        )
        entries = _merge_font_entries([ttf, otf], ("zh",))
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["canonical"], "得意黑")
        self.assertEqual(entries[0]["names"], [
            "得意黑", "Smiley Sans", "Smiley Sans Regular", "SmileySans-Oblique",
            "Smiley Sans Oblique",
        ])

    def test_disjoint_families_stay_separate_and_alias_case_dedupes(self) -> None:
        first = FontFileNames(
            family=(FontNameRecord("Arial", "en"),),
            typographic=(), full=(), postscript=(),
        )
        second = FontFileNames(
            family=(FontNameRecord("Microsoft YaHei", "zh"), FontNameRecord("微软雅黑", "zh")),
            typographic=(), full=(), postscript=(),
        )
        entries = _merge_font_entries([first, second], ())
        self.assertEqual([entry["canonical"] for entry in entries], ["Arial", "Microsoft YaHei"])
        self.assertEqual(entries[1]["names"], ["Microsoft YaHei", "微软雅黑"])

    def test_transitive_intersection_merges_all_three_files(self) -> None:
        files = [
            FontFileNames(family=(FontNameRecord("A", "en"),), typographic=(), full=("Shared",), postscript=()),
            FontFileNames(family=(FontNameRecord("B", "en"),), typographic=("Shared",), full=(), postscript=()),
            FontFileNames(family=(FontNameRecord("C", "en"), FontNameRecord("B", "en")), typographic=(), full=(), postscript=()),
        ]
        entries = _merge_font_entries(files, ())
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["canonical"], "A")

    def test_bridging_groups_preserves_later_group_aliases(self) -> None:
        def face(family: str, *aliases: str) -> FontFileNames:
            return FontFileNames(
                family=(FontNameRecord(family, "en"),),
                typographic=aliases, full=(), postscript=(),
            )

        files = [face("A"), face("B"), face("C"), face("A", "B"), face("C", "C alias")]
        entries = _merge_font_entries(files, ())
        self.assertEqual([entry["canonical"] for entry in entries], ["A", "C"])
        self.assertEqual(entries[0]["names"], ["A", "B"])
        self.assertEqual(entries[1]["names"], ["C", "C alias"])

    def test_shared_typographic_family_keeps_each_faces_full_and_postscript_targets(self) -> None:
        entries = _merge_font_entries([
            FontFileNames(family=(FontNameRecord("Example Sans", "en"),),
                          typographic=("Example Typographic",),
                          full=("Example Sans Regular",), postscript=("ExampleSans-Regular",)),
            FontFileNames(family=(FontNameRecord("Example Sans Semibold", "en"),),
                          typographic=("Example Typographic",),
                          full=("Example Sans Demi",), postscript=("ExampleSans-Semibold",)),
        ], ("en",))
        self.assertEqual(len(entries), 1)
        text = "\n".join(f"Style: {index},{name},86" for index, name in enumerate((
            "Example Sans Semibold", "Example Sans Demi", "examplesans-semibold", "Example Typographic",
        )))
        with mock.patch.object(ass_fonts, "font_alias_entries", return_value=tuple(entries)):
            normalized, _ = normalize_ass_text_fontnames(text)
            self.assertEqual(resolve_font_name("ExampleSans-Semibold"), "Example Sans Semibold")
            payload = ass_fonts.font_alias_payload()
        self.assertEqual(normalized, "\n".join((
            "Style: 0,Example Sans Semibold,86", "Style: 1,Example Sans Semibold,86",
            "Style: 2,Example Sans Semibold,86", "Style: 3,Example Sans,86",
        )))
        self.assertEqual(payload["fonts"][0]["canonicalByName"]["examplesans-semibold"],
                         "Example Sans Semibold")


class AliasLookupTests(unittest.TestCase):
    def _patched_entries(self) -> object:
        return mock.patch.object(ass_fonts, "font_alias_entries", return_value=SMILEY_ENTRIES)

    def test_resolve_is_case_insensitive_and_hits_every_alias(self) -> None:
        with self._patched_entries():
            self.assertEqual(resolve_font_name("smiley sans"), "得意黑")
            self.assertEqual(resolve_font_name("  SMILEYSANS-OBLIQUE "), "得意黑")
            self.assertEqual(resolve_font_name("得意黑"), "得意黑")
            self.assertIsNone(resolve_font_name("Not Installed"))
            self.assertIsNone(resolve_font_name(""))

    def test_resolve_degrades_when_table_unavailable(self) -> None:
        with mock.patch.object(ass_fonts, "font_alias_entries", return_value=None):
            self.assertIsNone(resolve_font_name("Arial"))

    def test_normalize_rewrites_style_lines_and_keeps_dialogue(self) -> None:
        text = "\n".join([
            "[Script Info]",
            "Title: t",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour",
            "Style: Default,Smiley Sans,86,&H00FFFFFF",
            "Style: Second,smiley sans,64,&H00FFFFFF",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
            "Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Smiley Sans 保持原样",
        ])
        with self._patched_entries():
            normalized, notices = normalize_ass_text_fontnames(text)
        self.assertIn("Style: Default,得意黑,86,&H00FFFFFF", normalized)
        self.assertIn("Style: Second,得意黑,64,&H00FFFFFF", normalized)
        self.assertIn("Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,Smiley Sans 保持原样", normalized)
        self.assertEqual(notices, [
            "字体「Smiley Sans」已按本机字体匹配为「得意黑」",
            "字体「smiley sans」已按本机字体匹配为「得意黑」",
        ])

    def test_normalize_reports_missing_font_once_per_name(self) -> None:
        text = "\n".join([
            "Style: Default,Not Installed,86,&H00FFFFFF",
            "Style: Again,Not Installed,64,&H00FFFFFF",
        ])
        with self._patched_entries():
            normalized, notices = normalize_ass_text_fontnames(text)
        self.assertEqual(normalized, text)
        self.assertEqual(notices, ["字体「Not Installed」未在本机找到，实际画面将回退为其他字体"])

    def test_normalize_passes_through_known_canonical_and_empty_names(self) -> None:
        text = "\n".join([
            "Style: Default,得意黑,86,&H00FFFFFF",
            "Style: Empty,,64,&H00FFFFFF",
        ])
        with self._patched_entries():
            normalized, notices = normalize_ass_text_fontnames(text)
        self.assertEqual(normalized, text)
        self.assertEqual(notices, [])

    def test_normalize_is_noop_without_style_lines_or_table(self) -> None:
        with self._patched_entries():
            self.assertEqual(normalize_ass_text_fontnames("[Script Info]\n"), ("[Script Info]\n", []))
        with mock.patch.object(ass_fonts, "font_alias_entries", return_value=None):
            self.assertEqual(
                normalize_ass_text_fontnames("Style: Default,Smiley Sans,86,&H00FFFFFF\n"),
                ("Style: Default,Smiley Sans,86,&H00FFFFFF\n", []),
            )
        with mock.patch.object(ass_fonts, "font_alias_entries", return_value=()):
            self.assertEqual(
                normalize_ass_text_fontnames("Style: Default,Smiley Sans,86,&H00FFFFFF\n"),
                ("Style: Default,Smiley Sans,86,&H00FFFFFF\n", []),
            )

    def test_normalize_preserves_crlf_line_endings_and_style_indent(self) -> None:
        text = "Style:  Default,Smiley Sans,86,&H00FFFFFF\r\n"
        with self._patched_entries():
            normalized, notices = normalize_ass_text_fontnames(text)
        self.assertEqual(normalized, "Style:  Default,得意黑,86,&H00FFFFFF\r\n")
        self.assertEqual(notices, ["字体「Smiley Sans」已按本机字体匹配为「得意黑」"])

    def test_normalize_keeps_names_libass_already_matches_via_nameid1(self) -> None:
        # Microsoft YaHei 是 msyh.ttc 的 nameID1（en 变体）：即使 canonical 是
        # 中文名也不改写、不告警，避免 SRT/工程烧录的常规样式产生无谓副本。
        text = "Style: Default,Microsoft YaHei,80,&H00FFFFFF\n"
        with mock.patch.object(ass_fonts, "font_alias_entries", return_value=YAHEI_ENTRIES):
            normalized, notices = normalize_ass_text_fontnames(text)
        self.assertEqual(normalized, text)
        self.assertEqual(notices, [])
        # 排版别名（非 nameID1）仍然改写为 canonical。
        text = "Style: Default,Microsoft YaHei UI,80,&H00FFFFFF\n"
        with mock.patch.object(ass_fonts, "font_alias_entries", return_value=YAHEI_ENTRIES):
            normalized, notices = normalize_ass_text_fontnames(text)
        self.assertIn("Style: Default,微软雅黑,", normalized)
        self.assertEqual(notices, ["字体「Microsoft YaHei UI」已按本机字体匹配为「微软雅黑」"])


class FontAliasPayloadTests(unittest.TestCase):
    def test_payload_schema_and_entries(self) -> None:
        with mock.patch.object(ass_fonts, "font_alias_entries", return_value=SMILEY_ENTRIES):
            payload = ass_fonts.font_alias_payload()
        self.assertEqual(payload["schema"], FONT_ALIAS_SCHEMA)
        self.assertEqual(payload["fonts"], [
            {"canonical": "得意黑",
             "names": ["得意黑", "Smiley Sans", "Smiley Sans Oblique", "SmileySans-Oblique"]},
            {"canonical": "Arial", "names": ["Arial", "Arial MT"]},
        ])

    def test_payload_preserves_renderable_family_names_for_browser_export(self) -> None:
        with mock.patch.object(ass_fonts, "font_alias_entries", return_value=YAHEI_ENTRIES):
            payload = ass_fonts.font_alias_payload()
        self.assertEqual(payload["fonts"], [{
            "canonical": "微软雅黑",
            "names": ["微软雅黑", "Microsoft YaHei", "Microsoft YaHei UI"],
            "family": ["微软雅黑", "Microsoft YaHei"],
        }])

    def test_merge_collects_nameid1_family_values(self) -> None:
        ttf = FontFileNames(
            family=(FontNameRecord("微软雅黑", "zh"), FontNameRecord("Microsoft YaHei", "en")),
            typographic=(), full=("Microsoft YaHei",), postscript=("MicrosoftYaHei",),
        )
        entries = _merge_font_entries([ttf], ("zh",))
        self.assertEqual(entries[0]["family"], ["微软雅黑", "Microsoft YaHei"])

    def test_payload_returns_error_structure_when_unavailable(self) -> None:
        with mock.patch.object(ass_fonts, "font_alias_entries", return_value=None):
            payload = ass_fonts.font_alias_payload()
        self.assertEqual(payload["schema"], FONT_ALIAS_SCHEMA)
        self.assertEqual(payload["fonts"], [])
        self.assertTrue(payload.get("error"))


class RegistryFontPathTests(unittest.TestCase):
    def test_absolute_paths_pass_through_and_relative_names_resolve(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            system = Path(tmp) / "system"
            user = Path(tmp) / "user"
            system.mkdir()
            user.mkdir()
            (system / "smiley.ttf").write_bytes(b"x")
            (user / "other.ttf").write_bytes(b"x")
            absolute = Path(tmp) / "custom.ttf"
            self.assertEqual(_registry_font_path(str(absolute), system, user), absolute)
            self.assertEqual(
                _registry_font_path("smiley.ttf", system, user), system / "smiley.ttf",
            )
            self.assertEqual(
                _registry_font_path("other.ttf", system, user), user / "other.ttf",
            )
            # 两个目录都不存在时按系统字体目录兜底（后续文件检查会丢弃）。
            self.assertEqual(
                _registry_font_path("missing.ttf", system, user), system / "missing.ttf",
            )


class _SharedStream:
    """模拟 TTC 多 face 共享的懒加载文件流；关闭后读取报错。"""

    def __init__(self) -> None:
        self.closed = False

    def require_open(self) -> None:
        if self.closed:
            raise RuntimeError("shared font stream closed")


class _LazyTtcFace:
    """懒加载 face：name 表访问要求共享流处于打开状态。"""

    def __init__(self, stream: _SharedStream, family: str) -> None:
        self._stream = stream
        self._family = family

    def __contains__(self, key: str) -> bool:
        self._stream.require_open()
        return key == "name"

    def __getitem__(self, key: str) -> _FakeNameTable:
        self._stream.require_open()
        if key != "name":
            raise KeyError(key)
        return _FakeNameTable([_FakeNameRecord(1, self._family)])

    def close(self) -> None:
        self._stream.closed = True


class ReadFontFileNamesTests(unittest.TestCase):
    def test_reads_every_ttc_face_before_closing_shared_stream(self) -> None:
        # TTC 的多个 face 懒加载共享同一文件流；逐 face 提前 close 会让
        # 后续 face 全部读取失败（PingFang.ttc 只剩第一个 face）。
        stream = _SharedStream()
        faces = [_LazyTtcFace(stream, "PingFang SC"), _LazyTtcFace(stream, "苹方-简")]
        tt_lib = mock.MagicMock()
        tt_lib.TTCollection.side_effect = lambda path, lazy=True: mock.MagicMock(fonts=faces)
        fake_font_tools = types.ModuleType("fontTools")
        fake_tt_lib = types.ModuleType("fontTools.ttLib")
        fake_tt_lib.TTCollection = tt_lib.TTCollection
        fake_tt_lib.TTFont = mock.MagicMock()
        fake_font_tools.ttLib = fake_tt_lib
        with mock.patch.dict(sys.modules, {"fontTools": fake_font_tools, "fontTools.ttLib": fake_tt_lib}):
            names = ass_fonts._read_font_file_names(Path("fonts.ttc"))
        self.assertEqual([record.value for record in names[0].family], ["PingFang SC"])
        self.assertEqual([record.value for record in names[1].family], ["苹方-简"])
        self.assertTrue(stream.closed)


class FontRootsTests(unittest.TestCase):
    def test_darwin_roots_include_mobile_asset_font_directories(self) -> None:
        # macOS 27 起部分系统字体（PingFang 等）经 AssetsV2 的 MobileAsset
        # 目录投递；漏扫会把本机已有字体误报为「未在本机找到」。
        # 注意：仓库 CI 只有 Windows Python runner，本用例仅会在 macOS
        # 本机真实执行，其余机器稳定 skip，不能指望 CI 守住这条回归。
        assets = sorted(
            path for path in Path("/System/Library/AssetsV2").glob("com_apple_MobileAsset_Font*")
            if path.is_dir()
        )
        if not assets:
            self.skipTest("本机没有 MobileAsset 字体资产目录")
        with mock.patch.object(sys, "platform", "darwin"):
            roots = ass_fonts._font_roots()
        for path in assets:
            self.assertIn(path, roots)

    def test_darwin_roots_enumerate_mobile_asset_directories_from_module_constant(self) -> None:
        # 仓库 CI 只有 Windows Python runner，跑不到真实 AssetsV2；这里用
        # 临时目录合成资产结构并 patch 模块常量，让「按 com_apple_MobileAsset_Font*
        # 前缀枚举目录、过滤非目录项」的逻辑在任何平台都有自动化覆盖。
        with tempfile.TemporaryDirectory() as tmp, \
                mock.patch.object(ass_fonts, "MACOS_ASSETS_V2_ROOT", Path(tmp)), \
                mock.patch.object(sys, "platform", "darwin"):
            asset_dir = Path(tmp) / "com_apple_MobileAsset_Font8"
            asset_dir.mkdir()
            (asset_dir / "AssetData").mkdir()
            (asset_dir / "AssetData" / "PingFang.ttc").write_bytes(b"")
            stray_file = Path(tmp) / "com_apple_MobileAsset_Font9"
            stray_file.write_bytes(b"")
            roots = ass_fonts._font_roots()
        self.assertIn(asset_dir, roots)
        self.assertNotIn(stray_file, roots)


if __name__ == "__main__":
    unittest.main()
