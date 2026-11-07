import copy
import unittest

from maw.ass_styles import ass_color
from maw.colors import COLOR_PALETTE_ALL
from maw.postprocess_io import render_srt
from maw.project_ass_export import escape_ass_text, render_project_ass
from maw.project_tracks import make_project


def project():
    result = make_project([
        {"id": "a", "start": 0, "end": 1000, "text": "First", "speaker": "p1", "color_group_id": "red-group"},
        {"id": "b", "start": 1000, "end": 2000, "text": "Second", "speaker": "p2"},
        {"id": "c", "start": 2000, "end": 3000, "text": "Unassigned", "speaker": None, "color_group_id": "red-group"},
    ], project_fields={
        "speakers": [{"id": "p1", "name": "Alice", "color": "#123456"},
                     {"id": "p2", "name": "Bob", "color": "#969fab"}],
        "annotation_mode": "speaker", "palette_size": 5, "speaker_shortcuts": {"1": "p1", "9": "p2"},
        "subtitle_groups": {"next_id": 1, "color": [{"id": "red-group", "value": {"name": "red"}}], "sticker": []},
        "preview": {"subtitle": {"x": 0, "y": 0, "width": 1, "height": 1,
                                   "ass_color_style": "text", "color": "#ffffff", "speaker_labels": {
            "enabled": False, "mapping_enabled": False, "export_enabled": True, "separator": ": ",
            "names": {"red": "Not Alice"},
        }}},
    })
    result["tracks"].append({"id": "overlay", "role": "overlay", "name": "Overlay", "enabled": True,
                             "segments": [{"id": "o", "start": 500, "end": 1500, "text": "Overlay", "speaker": "p2"}]})
    return result


def events(ass):
    return [line.removeprefix("Dialogue: ").split(",", 9) for line in ass.splitlines() if line.startswith("Dialogue:")]


def styles(ass):
    return {fields[0]: fields for line in ass.splitlines() if line.startswith("Style: ")
            for fields in [line.removeprefix("Style: ").split(",")]}


def render(source):
    return render_project_ass(source, title="Speaker export", play_resolution=(1920, 1080))


class SpeakerPythonExportTests(unittest.TestCase):
    def test_export_prefix_is_independent_of_preview_purpose_and_palette(self):
        for preview_enabled in (False, True):
            for export_enabled in (False, True):
                for mode in ("speaker", "color"):
                    for palette in (5, 9):
                        with self.subTest(preview=preview_enabled, export=export_enabled, mode=mode, palette=palette):
                            source = project()
                            source.update(annotation_mode=mode, palette_size=palette)
                            source["preview"]["subtitle"]["speaker_labels"].update(enabled=preview_enabled, export_enabled=export_enabled)
                            before = copy.deepcopy(source)
                            ass = render(source)
                            srt = render_srt(source)
                            self.assertEqual("Alice: First" in ass, export_enabled)
                            self.assertEqual("Alice: First" in srt, export_enabled)
                            self.assertNotIn("Not Alice", ass)
                            self.assertNotIn("Not Alice", srt)
                            self.assertEqual(source, before)

    def test_identity_color_is_project_owned_and_unassigned_never_uses_category_color(self):
        source = project()
        output = render(source)
        rows, sheet = events(output), styles(output)
        self.assertEqual([row[3] for row in rows], ["Speaker 1", "Speaker 2", "Default", "Overlay Speaker 2"])
        self.assertEqual(sheet["Speaker 1"][3], ass_color("#123456"))
        self.assertEqual(sheet["Speaker 2"][3], ass_color("#969fab"))
        self.assertEqual(sheet["Overlay Speaker 2"][3], ass_color("#969fab"))
        self.assertEqual(rows[2][4], "")
        self.assertEqual(rows[2][9], "Unassigned")
        self.assertIn("Bob: Overlay", render_srt(source))

    def test_secondary_export_combines_track_policy_and_speaker_style(self):
        for mode in ("text", "stroke"):
            with self.subTest(color_style=mode):
                source = project()
                source["preview"]["subtitle"]["ass_color_style"] = mode
                secondary = {"id": "secondary", "role": "secondary", "name": "Secondary", "enabled": True,
                             "segments": [{"id": "s", "start": 0, "end": 1000, "text": "Translation", "speaker": "p1"}]}
                source["tracks"].append(secondary)
                source["bilingual"] = {"display_mode": "both", "active_track_id": "secondary"}
                ass = render_project_ass(source, title="Speaker export", play_resolution=(1920, 1080), mode="all")
                row = next(row for row in events(ass) if "Translation" in row[9])
                self.assertEqual(row[0], "1")
                self.assertEqual(row[3:5], ["Secondary Speaker 1", "Alice"])
                self.assertEqual(row[9], "Alice: Translation")
                self.assertEqual(styles(ass)[row[3]][3 if mode == "text" else 5], ass_color("#123456"))
                secondary["export"] = {"enabled": False}
                self.assertNotIn("Translation", render_project_ass(source, title="Speaker export", play_resolution=(1920, 1080), mode="all"))

    def test_same_name_same_color_people_keep_distinct_events_and_styles(self):
        source = project()
        for speaker in source["speakers"]:
            speaker.update(name="同名", color="#969fab")
        before = copy.deepcopy(source)
        rows = events(render(source))
        self.assertEqual(rows[0][4], rows[1][4])
        self.assertNotEqual(rows[0][3], rows[1][3])
        self.assertEqual(rows[0][9], "同名: First")
        self.assertEqual(rows[1][9], "同名: Second")
        self.assertEqual(source, before)

    def test_extended_category_colors_export_when_palette_is_collapsed(self):
        for name, color in COLOR_PALETTE_ALL[5:]:
            for mode in ("text", "stroke"):
                with self.subTest(color=name, mode=mode):
                    source = project()
                    source["annotation_mode"] = "color"
                    source["preview"]["subtitle"]["ass_color_style"] = mode
                    source["subtitle_groups"]["color"][0]["value"]["name"] = name
                    source["tracks"][1]["segments"][0]["color_group_id"] = "red-group"
                    ass = render(source)
                    sheet = styles(ass)
                    self.assertEqual(events(ass)[0][3], name.upper())
                    self.assertEqual(sheet[name.upper()][3 if mode == "text" else 5], ass_color(color))
                    self.assertEqual(events(ass)[2][3], name.upper())
                    self.assertEqual(events(ass)[3][3], f"Overlay {name.upper()}")
                    self.assertEqual(sheet[f"Overlay {name.upper()}"][3 if mode == "text" else 5], ass_color(color))
                    for unused, _ in COLOR_PALETTE_ALL[5:]:
                        if unused != name:
                            self.assertNotIn(unused.upper(), sheet)
                            self.assertNotIn(f"Overlay {unused.upper()}", sheet)
                    self.assertNotIn("#", render_srt(source))

    def test_category_style_table_stays_five_until_extended_colors_are_enabled_or_used(self):
        source = project()
        source["annotation_mode"] = "color"
        source["subtitle_groups"]["color"].append({"id": "unused", "value": {"name": "gray"}})
        for mode in ("text", "stroke"):
            for size in (5, 9):
                with self.subTest(mode=mode, palette=size):
                    source["preview"]["subtitle"]["ass_color_style"] = mode
                    source["palette_size"] = size
                    names = [name.upper() for name, _ in COLOR_PALETTE_ALL[:size]]
                    self.assertEqual(list(styles(render(source))),
                                     ["Default", *names, "Overlay", *(f"Overlay {name}" for name in names)])

    def test_speaker_color_style_colors_only_the_escaped_prefix(self):
        source = project()
        source["preview"]["subtitle"]["ass_color_style"] = "speaker"
        source["speakers"][0]["name"] = r"A,{\b1}"
        source["tracks"][0]["segments"][0]["text"] = "line\\value {x}\nsecond"
        before = copy.deepcopy(source)
        first = events(render(source))[0]
        self.assertEqual(len(first), 10)
        self.assertEqual(first[4], r"A {\b1}")
        self.assertEqual(first[9], r"{\c&H563412&}" + escape_ass_text(r"A,{\b1}: ")
                         + r"{\c&HFFFFFF&}" + escape_ass_text(source["tracks"][0]["segments"][0]["text"]))
        self.assertIn(r"A,{\b1}: line\value {x}" + "\nsecond", render_srt(source))
        self.assertEqual(source, before)

    def test_stroke_and_none_styles_preserve_identity_without_mutating_content(self):
        source = project()
        source["preview"]["subtitle"]["ass_color_style"] = "stroke"
        self.assertEqual(styles(render(source))["Speaker 1"][5], ass_color("#123456"))
        source["preview"]["subtitle"]["ass_color_style"] = "none"
        self.assertEqual(events(render(source))[0][3], "Default")
        self.assertEqual(events(render(source))[0][9], "Alice: First")

    def test_export_flag_absent_keeps_old_plain_output(self):
        source = project()
        del source["preview"]["subtitle"]["speaker_labels"]["export_enabled"]
        source["preview"]["subtitle"]["speaker_labels"].update(enabled=True, mapping_enabled=True)
        self.assertNotIn("Alice:", render(source))
        self.assertNotIn("Alice:", render_srt(source))


if __name__ == "__main__":
    unittest.main()
