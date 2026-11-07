import copy
from contextlib import redirect_stderr, redirect_stdout
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
import wave

from maw.colors import COLOR_PALETTE_ALL
from maw.project_tracks import get_main_track, import_project, make_project, validate_tracks_project
from maw.speaker import apply_project_speaker_colors
from maw.speaker_identity import make_asr_project


def _segments(identities):
    return [{"start": index * 200, "end": (index + 1) * 200, "text": "字", "speaker": identity,
             "items": [{"start": index * 200, "end": (index + 1) * 200, "text": "字", "speaker": identity}]}
            for index, identity in enumerate(identities)]


def _wav(path):
    with wave.open(str(path), "wb") as audio:
        audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        audio.writeframes(b"\0\0" * 24000)


class AsrSpeakerPaletteTests(unittest.TestCase):
    def test_asr_counts_current_result_and_assigns_five_or_nine_distinct_colors(self):
        for count in (0, 1, 5, 6, 9, 10):
            with self.subTest(count=count):
                source = _segments([str(index) for index in range(count)])
                before = copy.deepcopy(source)
                project = make_asr_project(source)
                size = 9 if count > 5 else 5
                self.assertEqual(source, before)
                self.assertEqual(project["palette_size"], size)
                self.assertEqual(len(project["speakers"]), count)
                self.assertEqual(len({speaker["id"] for speaker in project["speakers"]}), count)
                self.assertEqual([speaker["color"] for speaker in project["speakers"]],
                                 [COLOR_PALETTE_ALL[index % size][1] for index in range(count)])
                self.assertEqual(len(project["speaker_shortcuts"]), min(count, size))
                self.assertTrue(validate_tracks_project(project).ok)
                if count == 10:
                    self.assertNotEqual(project["speakers"][0]["id"], project["speakers"][9]["id"])
                    self.assertEqual(project["speakers"][0]["color"], project["speakers"][9]["color"])

    def test_empty_duplicate_and_numeric_looking_labels_do_not_expand(self):
        project = make_asr_project(_segments(["6", "1", "6", "", "  ", None]))
        self.assertEqual(project["palette_size"], 5)
        self.assertEqual(len(project["speakers"]), 2)
        cues = get_main_track(project)["segments"]
        self.assertEqual(cues[0]["speaker"], cues[2]["speaker"])
        self.assertTrue(all(cue.get("speaker") is None for cue in cues[3:]))

    def test_word_only_identities_are_split_before_counting_and_empty_outer_label_is_ignored(self):
        source = [{"start": 0, "end": 1200, "text": "甲乙丙丁戊己", "speaker": "",
                   "items": [{"text": text, "start": index * 200, "end": (index + 1) * 200, "speaker": str(index)}
                             for index, text in enumerate("甲乙丙丁戊己")]}]
        project = make_asr_project(source)
        cues = get_main_track(project)["segments"]
        self.assertEqual(project["palette_size"], 9)
        self.assertEqual(len(project["speakers"]), 6)
        self.assertEqual([cue["text"] for cue in cues], list("甲乙丙丁戊己"))
        self.assertTrue(all("speaker" not in item for cue in cues for item in cue["items"]))
        source[0]["speaker"] = "unused outer source"
        self.assertEqual(len(make_asr_project(source)["speakers"]), 6)

    def test_expansion_preserves_other_switches_and_a_saved_nine_palette(self):
        fields = {"annotation_mode": "color", "preview": {"subtitle": {"x": 0.1, "y": 0.8, "width": 0.8, "height": 0.1, "speaker_labels": {
            "mapping_enabled": False, "enabled": False, "export_enabled": False}}}, "vendor": {"keep": 1}}
        before = copy.deepcopy(fields)
        project = make_asr_project(_segments([str(index) for index in range(6)]), project_fields=fields)
        self.assertEqual(fields, before)
        self.assertEqual(project["annotation_mode"], "color")
        self.assertEqual(project["preview"], fields["preview"])
        self.assertEqual(project["vendor"], fields["vendor"])
        self.assertEqual(make_asr_project(_segments(["one"]), project_fields={"palette_size": 9})["palette_size"], 9)
        project["palette_size"] = 5
        self.assertEqual(import_project(project).project, project)
        self.assertEqual(make_project(_segments([str(index) for index in range(6)]))["palette_size"], 5)

    def test_explicit_speaker_option_does_not_add_or_replace_classification_groups(self):
        project = make_asr_project(_segments([str(index) for index in range(10)]))
        project["subtitle_groups"]["color"] = [{"id": "classification", "value": {"name": "blue", "value": "#61a7fa"}}]
        get_main_track(project)["segments"][0]["color_group_id"] = "classification"
        original = copy.deepcopy(project)
        stats = apply_project_speaker_colors(project)
        self.assertTrue(stats["overflow"])
        self.assertEqual(project, {**original, "annotation_mode": "speaker"})
        apply_project_speaker_colors(project)
        self.assertEqual(project, {**original, "annotation_mode": "speaker"})

    def test_real_local_output_writes_nine_colors_and_only_explicit_flag_selects_speaker_mode(self):
        from maw.local_asr import LocalTranscription, write_local_outputs

        for enabled in (False, True):
            with self.subTest(enabled=enabled), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                media = root / "source.wav"
                _wav(media)
                segments = _segments([str(index) for index in range(6)])
                result = LocalTranscription("字" * 6, "zh", [], segments, "synthetic")
                paths = write_local_outputs(input_path=media, output_srt=root / "result.srt", transcription=result,
                                            segments=segments, write_json=True, generate_html=False,
                                            with_waveform=False, speaker_colors=enabled)
                project = json.loads(paths.json.read_text(encoding="utf-8"))
                self.assertEqual(project["palette_size"], 9)
                self.assertEqual(project["annotation_mode"], "speaker" if enabled else "color")
                self.assertEqual(len(project["speakers"]), 6)
                self.assertEqual(project["subtitle_groups"]["color"], [])
                self.assertTrue(all("speaker" not in item for cue in get_main_track(project)["segments"] for item in cue["items"]))

    def test_real_soniox_cli_output_routes_mocked_provider_result_to_identity_palette(self):
        from maw.asr.soniox import main

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "source.wav"
            _wav(media)
            items = [dict(cue["items"][0]) for cue in _segments([str(index) for index in range(6)])]
            result = {"text": "字" * 6, "language": "zh", "items": items}
            with mock.patch("sys.argv", ["maw.asr.soniox", str(media), "-o", str(root / "result.srt"),
                                         "--json", "--no-html", "--speaker-colors"]), \
                 mock.patch("maw.asr.soniox.load_config", return_value={"model": "stt-async-v5"}), \
                 mock.patch("maw.asr.soniox.transcribe", return_value=result) as provider, \
                 redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
                main()
            self.assertEqual(provider.call_count, 1)
            project = json.loads((root / "result.mosp").read_text(encoding="utf-8"))
            self.assertEqual(project["palette_size"], 9)
            self.assertEqual(project["annotation_mode"], "speaker")
            self.assertEqual(len(project["speakers"]), 6)
            self.assertEqual(project["subtitle_groups"]["color"], [])


if __name__ == "__main__":
    unittest.main()
