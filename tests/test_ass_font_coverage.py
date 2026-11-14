from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.ttLib import TTCollection

from maw import ass_font_coverage as coverage
from maw import ass_fonts


def fixture(family="Example", weight=400, italic=False, cps=(65, 66, 768, 128512)):
    builder = FontBuilder(1000, isTTF=True)
    glyphs = [".notdef"] + [f"uni{cp:X}" for cp in cps]
    builder.setupGlyphOrder(glyphs)
    builder.setupCharacterMap({cp: f"uni{cp:X}" for cp in cps})
    builder.setupGlyf({name: TTGlyphPen(None).glyph() for name in glyphs})
    builder.setupHorizontalMetrics({name: (500, 0) for name in glyphs})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": family, "styleName": "Regular",
                           "fullName": family + " Regular", "psName": family + "-Regular"})
    builder.setupOS2(usWinAscent=900, usWinDescent=300, usWeightClass=weight,
                     fsSelection=1 if italic else 0)
    builder.setupPost()
    return builder.font


class FontCoverageTests(unittest.TestCase):
    def setUp(self):
        coverage._cached_payload_json.cache_clear()
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(coverage._cached_payload_json.cache_clear)

    def test_face_metadata_and_compacted_unicode_ranges(self):
        item = coverage._face_payload(fixture(weight=700, italic=True))
        self.assertEqual(item["family"], "Example")
        self.assertEqual(item["weight"], 700)
        self.assertTrue(item["italic"])
        self.assertEqual(item["ranges"], [[65, 66], [768, 768], [128512, 128512]])
        self.assertAlmostEqual(item["emRatio"], 1000 / 1200)
        self.assertIn("Example-Regular", item["names"])

    def test_collection_reads_all_faces_before_close(self):
        path = Path(self.temp.name) / "example.ttc"
        collection = TTCollection()
        collection.fonts = [fixture("First"), fixture("Second", 700)]
        collection.save(path)
        items, complete = coverage._read_faces(path)
        self.assertTrue(complete)
        self.assertEqual([item["family"] for item in items], ["First", "Second"])

    def test_no_bitmap_only_or_variable_font_guarantee(self):
        font = fixture()
        del font["glyf"]
        self.assertIsNone(coverage._face_payload(font))
        font = fixture()
        font["fvar"] = object()
        self.assertIsNone(coverage._face_payload(font))

    def test_optional_payload_no_paths_mutation_or_normalization_changes(self):
        path = Path(self.temp.name) / "private-font.ttf"
        fixture().save(path)
        with mock.patch.object(ass_fonts, "_installed_font_files", return_value=(path,)), \
             mock.patch.object(ass_fonts, "font_alias_entries", return_value=()):
            payload = coverage.font_coverage_payload()
            self.assertEqual(payload["faces"][0]["family"], "Example")
            self.assertNotIn(str(path), json.dumps(payload))
            payload["faces"].clear()
            self.assertEqual(len(coverage.font_coverage_payload()["faces"]), 1)
            original = "Style: Default,Unknown,30\nDialogue: 0,0,1,Default,,0,0,0,,原文"
            self.assertEqual(ass_fonts.normalize_ass_text_fontnames(original)[0], original)

    def test_unavailable_coverage_keeps_alias_payload(self):
        with mock.patch.object(coverage, "font_coverage_payload", side_effect=AssertionError("eager cmap scan")), \
             mock.patch.object(ass_fonts, "font_alias_entries", return_value=()):
            self.assertEqual(ass_fonts.font_alias_payload(), {"schema": ass_fonts.FONT_ALIAS_SCHEMA, "fonts": []})

    def test_limits_are_explicit_and_bad_files_do_not_abort_inventory(self):
        path = Path(self.temp.name) / "example.ttf"
        fixture().save(path)
        bad = Path(self.temp.name) / "broken.ttf"
        bad.write_bytes(b"not a font")
        with mock.patch.object(ass_fonts, "_installed_font_files", return_value=(bad, path)):
            payload = coverage.font_coverage_payload()
            self.assertFalse(payload["complete"])
            self.assertEqual(len(payload["faces"]), 1)
            coverage._cached_payload_json.cache_clear()
            with mock.patch.object(coverage, "_MAX_FACES", 0):
                payload = coverage.font_coverage_payload()
                self.assertFalse(payload["complete"])
                self.assertEqual(payload["faces"], [])

    def test_cmaps_are_shared_and_budget_does_not_leave_orphans(self):
        first = coverage._face_payload(fixture("First"))
        second = coverage._face_payload(fixture("Second", 700))
        paths = (Path("example.ttf"),)
        # _read_faces returns fresh objects, as the real reader does.
        def read(_path):
            import copy
            return copy.deepcopy([first, second]), True
        with mock.patch.object(ass_fonts, "_installed_font_files", return_value=paths), \
             mock.patch.object(coverage, "_read_faces", side_effect=read):
            payload = coverage.font_coverage_payload()
            self.assertEqual(len(payload["faces"]), 2)
            self.assertEqual(len(payload["cmaps"]), 1)
            self.assertEqual([f["cmap"] for f in payload["faces"]], [0, 0])
            self.assertNotIn("ranges", payload["faces"][0])
            self.assertEqual(payload["cmaps"][0], first["ranges"])
            coverage._cached_payload_json.cache_clear()
            with mock.patch.object(coverage, "_MAX_PAYLOAD_BYTES", 1024):
                bounded = coverage.font_coverage_payload()
                self.assertFalse(bounded["complete"])
                self.assertEqual(bounded["faces"], [])
                self.assertEqual(bounded["cmaps"], [])
                self.assertLessEqual(len(json.dumps(bounded).encode()), 1024)

    def test_refresh_updates_coverage_after_font_install(self):
        first = Path(self.temp.name) / "first.ttf"
        second = Path(self.temp.name) / "second.ttf"
        fixture("First").save(first)
        fixture("Second").save(second)
        self.addCleanup(ass_fonts._cached_font_entries.cache_clear)
        with mock.patch.object(ass_fonts, "_installed_font_files", return_value=(first,)) as files:
            before = coverage.font_coverage_payload()
            self.assertEqual([face["family"] for face in before["faces"]], ["First"])
            files.return_value = (first, second)
            coverage.refresh_font_inventory()
            after = coverage.font_coverage_payload()
            self.assertEqual({face["family"] for face in after["faces"]}, {"First", "Second"})
            files.cache_clear.assert_called_once()

    def test_platform_candidate_order(self):
        self.assertEqual(coverage.fallback_families("Windows"), ["Arial", "SimHei", "Segoe UI Symbol"])
        self.assertEqual(coverage.fallback_families("Darwin"), ["Arial", "PingFang SC", "Arial Unicode MS", "Apple Symbols"])
        self.assertEqual(coverage.fallback_families("Linux"), ["Arial", "Noto Sans CJK SC", "Noto Sans", "DejaVu Sans"])
