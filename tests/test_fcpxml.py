from fractions import Fraction
from io import BytesIO
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile

from maw.fcpxml import build_fcpxml_titles_bundle, serialize_fcpxml_titles


def title(start, end, lane, text="Hello"):
    return {"startFrame": start, "endFrame": end, "lane": lane, "text": text}


def sample():
    return {
        "version": "1.13", "name": '双语 "Quotes" & <test>', "fps": "30000/1001",
        "width": 1080, "height": 1920, "durationFrames": 360,
        "titles": [title(30, 62, 1, '你好 & <世界>\nHi\rthere! 🐈'), title(61, 65, 2), title(62, 63, 1)],
    }


class FcpxmlTests(unittest.TestCase):
    def test_exact_times_references_and_text_round_trip(self):
        plan = sample()
        xml = serialize_fcpxml_titles(plan)
        self.assertTrue(xml.startswith(b'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE fcpxml>\n'))
        self.assertNotIn(b'\r', xml)
        root = ET.fromstring(xml)
        self.assertEqual(root.attrib, {"version": "1.13"})
        self.assertEqual([node.tag for node in root], ["resources", "library"])
        self.assertEqual(root.find("./resources/format").attrib, {
            "id": "r1", "frameDuration": "1001/30000s", "width": "1080", "height": "1920",
        })
        self.assertEqual(root.find("./resources/effect").attrib, {
            "id": "r2", "name": "Basic Title",
            "uid": ".../Titles.localized/Bumper:Opener.localized/Basic Title.localized/Basic Title.moti",
        })
        project = root.find("./library/event/project")
        self.assertEqual(project.get("name"), plan["name"])
        seq = project.find("sequence")
        gap = seq.find("./spine/gap")
        self.assertEqual(Fraction(seq.get("duration").rstrip("s")), Fraction(3003, 250))
        self.assertEqual(gap.get("duration"), seq.get("duration"))
        self.assertEqual(gap.get("start"), "0s")
        self.assertEqual([node.tag for node in gap], ["title"] * 3)
        self.assertEqual([(node.get("offset"), node.get("duration"), node.get("lane")) for node in gap],
                         [("30030/30000s", "32032/30000s", "1"),
                          ("61061/30000s", "4004/30000s", "2"),
                          ("62062/30000s", "1001/30000s", "1")])
        text_node = gap.find("./title/text")
        self.assertIsNone(text_node.text)
        self.assertEqual(text_node[0].text, plan["titles"][0]["text"])
        self.assertIsNone(text_node[0].tail)
        ids = [node.get("id") for node in root.iter() if "id" in node.attrib]
        self.assertEqual(ids, ["r1", "r2", "ts1", "ts2", "ts3"])
        self.assertEqual(seq.get("format"), "r1")
        for index, node in enumerate(gap, 1):
            self.assertEqual(node.get("ref"), "r2")
            self.assertEqual([child.tag for child in node], ["text", "text-style-def"])
            self.assertEqual(node.find("./text/text-style").get("ref"), f"ts{index}")
            self.assertEqual(node.find("text-style-def").get("id"), f"ts{index}")
        self.assertIsNone(root.find(".//asset"))
        self.assertIsNone(root.find(".//param"))

    def test_zip_is_deterministic_and_contains_only_controlled_entry(self):
        for name, stem in [("双语 Sample", "双语 Sample"), ("CON.bad", "_CON.bad"), ("CONOUT$", "_CONOUT$"),
                           ("C:\\..\\test/../../outside", "C__.._test_.._.._outside"),
                           (".", "MAW Titles"), ("猫" * 120, "猫" * 60)]:
            with self.subTest(name=name):
                plan = dict(sample(), name=name)
                download, zipped = build_fcpxml_titles_bundle(plan)
                self.assertEqual(download, f"{stem}-final-cut.fcpxmld.zip")
                self.assertEqual(build_fcpxml_titles_bundle(plan), (download, zipped))
                with ZipFile(BytesIO(zipped)) as archive:
                    entry = f"{stem}.fcpxmld/Info.fcpxml"
                    self.assertEqual(archive.namelist(), [entry])
                    self.assertEqual(archive.read(entry), serialize_fcpxml_titles(plan))

    def test_rejects_foreign_fields_invalid_xml_and_out_of_range_timing(self):
        for edits in (
            {"version": "1.14"}, {"fps": "24000/1001"}, {"width": True}, {"height": 8193},
            {"durationFrames": 0}, {"durationFrames": 999_999_999}, {"name": "\x00"}, {"titles": []},
            {"mediaPath": "C:/forbidden.mp4"}, {"entries": ["../../Info.fcpxml"]}, {"xml": "<xml />"},
            {"titles": [dict(title(0, 1, 1), src="file:///forbidden")]},
            {"titles": [title(0, 1, 1, "\ud800")]}, {"titles": [title(0, 1, 1, "\uffff")]},
            {"titles": [title(0, 1, 1, "x\x01y")]}, {"titles": [title(0, 1, 1, "\n  ")]},
            {"titles": [title(360, 361, 1)]}, {"titles": [title(1, 1, 1)]},
            {"titles": [title(0, 1, 0)]}, {"titles": [title(0, 1, 129)]},
            {"titles": [title(0, 2, 1), title(1, 3, 1)]},
            {"titles": [title(2, 3, 2), title(1, 3, 1)]},
        ):
            with self.subTest(edits=edits), self.assertRaises(ValueError):
                build_fcpxml_titles_bundle(dict(sample(), **edits))

    def test_caps_count_and_utf8_payload(self):
        with self.assertRaisesRegex(ValueError, "title count"):
            serialize_fcpxml_titles(dict(sample(), titles=[None] * 20_001))
        with self.assertRaisesRegex(ValueError, "size limit"):
            serialize_fcpxml_titles(dict(sample(), titles=[title(0, 1, 1, "猫" * 5500)]))
        too_much = [title(i, i + 1, 1, "a" * 16_384) for i in range(257)]
        with self.assertRaisesRegex(ValueError, "total text"):
            serialize_fcpxml_titles(dict(sample(), titles=too_much))
