import copy
import json
from pathlib import Path
import tempfile
import unittest
import wave

from maw.project import normalize_project, validate_project
from maw.project_io import write_mosp
from maw.project_tracks import get_main_track, import_project, make_project, validate_tracks_project


class SpeakerProjectBoundaryTests(unittest.TestCase):
    def test_server_takeover_compares_identity_semantics_not_just_cue_bytes(self):
        from tests.test_local_editor_server import server_editor

        project = make_project([{"start": 0, "end": 100, "text": "x", "speaker": "one"}])
        self.assertTrue(server_editor._attach_segments_match(project, copy.deepcopy(project)))
        for field, value in (("speakers", [{"id": "spk-001", "name": "Different person", "color": "#f9ca1f"}]),
                             ("annotation_mode", "speaker"), ("palette_size", 9), ("speaker_shortcuts", {})):
            with self.subTest(field=field):
                browser = {**copy.deepcopy(project), field: value}
                self.assertFalse(server_editor._attach_segments_match(project, browser))

    def test_basic_python_ass_explicitly_rejects_unsupported_identity_names(self):
        from maw.project_ass_export import ProjectSubtitleError, render_project_ass

        project = make_project([{"start": 0, "end": 100, "text": "x", "speaker": "one"}],
                               project_fields={"annotation_mode": "speaker"})
        project["preview"] = {"subtitle": {"x": 0.1, "y": 0.8, "width": 0.8, "height": 0.1,
                                             "speaker_labels": {"mapping_enabled": True, "enabled": True}}}
        with self.assertRaisesRegex(ProjectSubtitleError, "身份姓名"):
            render_project_ass(project, title="test", play_resolution=(640, 360))
        project["preview"]["subtitle"]["speaker_labels"]["enabled"] = False
        self.assertIn("Dialogue:", render_project_ass(project, title="test", play_resolution=(640, 360)))

    def test_local_asr_output_registers_identities_without_a_paid_provider(self):
        from maw.local_asr import LocalTranscription, write_local_outputs

        segments = [{"start": i * 100, "end": (i + 1) * 100, "text": "x", "speaker": str(i)} for i in range(6)]
        result = LocalTranscription("xxxxxx", "en", [], segments, "synthetic")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "source.wav"
            with wave.open(str(media), "wb") as audio:
                audio.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
                audio.writeframes(b"\0\0" * 8000)
            paths = write_local_outputs(input_path=media, output_srt=root / "result.srt", transcription=result,
                                        segments=segments, write_json=True, generate_html=False, with_waveform=False)
            project = normalize_project(json.loads(paths.json.read_text(encoding="utf-8")))
        # Automatic expansion is an upper-layer ASR feature; core creation
        # registers every identity while retaining the default five slots.
        self.assertEqual(project["palette_size"], 5)
        self.assertEqual(len(project["speakers"]), 6)
        self.assertEqual(get_main_track(project)["segments"][5]["speaker"], "spk-006")

    def test_core_registers_every_identity_without_automatically_expanding_palette(self):
        for count in (0, 1, 5, 6, 9, 10):
            with self.subTest(count=count):
                segments = [{"start": index * 100, "end": (index + 1) * 100, "text": "x",
                             "speaker": str(index), "items": [
                                 {"start": index * 100, "end": (index + 1) * 100, "text": "x", "speaker": str(index)}]}
                            for index in range(count)]
                before = copy.deepcopy(segments)
                project = make_project(segments, project_fields={"annotation_mode": "color", "vendor": {"keep": 1}})
                self.assertEqual(segments, before)
                self.assertEqual(len(project["speakers"]), count)
                self.assertEqual(project["palette_size"], 5)
                self.assertEqual(project["annotation_mode"], "color")
                self.assertEqual(len(project["speaker_shortcuts"]), min(count, 5))
                self.assertTrue(validate_project(project).ok)
                self.assertEqual(import_project(project).project, project)
                self.assertEqual(normalize_project(project), project)
                self.assertTrue(all("speaker" not in item for segment in get_main_track(project)["segments"]
                                    for item in segment["items"]))
                if count == 10:
                    self.assertEqual(project["speakers"][0]["color"], project["speakers"][5]["color"])
                    self.assertNotEqual(project["speakers"][0]["id"], project["speakers"][5]["id"])

    def test_asr_splits_word_identity_before_real_file_roundtrip(self):
        source = [{"id": "cue", "start": 0, "end": 200, "text": "甲乙", "vendor": 7,
                   "items": [{"start": 0, "end": 100, "text": "甲", "speaker": "A"},
                             {"start": 100, "end": 200, "text": "乙", "speaker": "B"}]}]
        project = make_project(source)
        with tempfile.TemporaryDirectory() as directory:
            path = write_mosp(Path(directory) / "speakers.mosp", project)
            reopened = normalize_project(json.loads(path.read_text(encoding="utf-8")))
        self.assertEqual(reopened, project)
        cues = get_main_track(reopened)["segments"]
        self.assertEqual([(cue["text"], cue["start"], cue["end"]) for cue in cues], [("甲", 0, 100), ("乙", 100, 200)])
        self.assertEqual([cue["speaker"] for cue in cues], ["spk-001", "spk-002"])
        self.assertEqual([cue["vendor"] for cue in cues], [7, 7])

    def test_strict_entrypoints_reject_invalid_identity_metadata(self):
        base = make_project([{"start": 0, "end": 100, "text": "x", "speaker": "6"}])
        mutations = [({"palette_size": True}, "$.palette_size"),
                     ({"annotation_mode": "unknown"}, "$.annotation_mode"),
                     ({"speaker_shortcuts": {"0": "spk-001"}}, "$.speaker_shortcuts.0"),
                     ({"speaker_shortcuts": {"6": "missing"}}, "$.speaker_shortcuts.6")]
        for fields, path in mutations:
            with self.subTest(path=path):
                invalid = {**copy.deepcopy(base), **fields}
                self.assertIn(path, [error.path for error in validate_tracks_project(invalid).errors])
                self.assertFalse(validate_project(invalid).ok)
        missing = copy.deepcopy(base)
        missing["speakers"] = []
        self.assertFalse(validate_tracks_project(missing).ok)
        per_word = copy.deepcopy(base)
        get_main_track(per_word)["segments"][0]["items"] = [{"start": 0, "end": 100, "text": "x", "speaker": "spk-001"}]
        self.assertFalse(validate_tracks_project(per_word).ok)

    def test_reopen_preserves_collapsed_slots_null_assignment_and_same_name_people(self):
        project = make_project([{"start": i * 100, "end": (i + 1) * 100, "text": "x", "speaker": str(i)} for i in range(6)],
                               project_fields={"palette_size": 9})
        project["palette_size"] = 5
        for speaker in project["speakers"]:
            speaker.update(name="同名", color="#969fab")
        get_main_track(project)["segments"][0]["speaker"] = None
        self.assertEqual(normalize_project(project), project)
        self.assertEqual(project["speaker_shortcuts"]["6"], "spk-006")


if __name__ == "__main__":
    unittest.main()
