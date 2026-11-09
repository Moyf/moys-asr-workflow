import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier
from unittest.mock import patch

from maw.text_processing_presets import LEGACY_SCHEMA, ProcessingConflict, load_library, save_library, validate_library
from maw.project import ProjectValidationFailed, normalize_project


class EditorProcessingTests(unittest.TestCase):
    def test_default_library_path_migrates_existing_presets_on_first_write(self):
        with tempfile.TemporaryDirectory() as directory, patch(
            "maw.text_processing_presets.default_app_data_root", return_value=Path(directory),
        ):
            root = Path(directory)
            legacy = root / "text-processing-presets.json"
            original = json.dumps({"schema": LEGACY_SCHEMA, "presets": [{
                "id": "old", "name": "旧配方", "scope": "all", "rules": [], "operations": {"trim": True},
            }]})
            legacy.write_text(original, encoding="utf-8")
            before = load_library()
            self.assertEqual(before["presets"][0]["steps"], [{"type": "trim", "enabled": True}])
            saved = save_library({**before, "defaultPresetId": "old"})
            self.assertTrue((root / "editor-processing.json").is_file())
            self.assertEqual(legacy.read_text(encoding="utf-8"), original)
            self.assertEqual(load_library(), saved)
            with self.assertRaises(ProcessingConflict):
                save_library(before)

    def test_library_round_trip_and_conflict(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "editor-processing.json"
            initial = load_library(path)
            steps = [
                {"type": "trim"},
                {"type": "replace", "find": "(猫)", "replacement": "$01", "regex": True, "caseSensitive": False},
                {"type": "wrap", "wraps": [{"id": "fade"}, {"id": "custom", "left": "【", "right": ""}]},
            ]
            saved = save_library({
                **initial, "defaultPresetId": "example", "presets": [{"id": "example", "name": "示例", "scope": "all", "steps": steps}],
            }, path)
            self.assertEqual(saved["revision"], 1)
            self.assertEqual(load_library(path), saved)
            with self.assertRaises(ProcessingConflict) as conflict:
                save_library(initial, path)
            self.assertEqual(conflict.exception.current, saved)
            self.assertEqual(load_library(path)["presets"][0]["steps"], [{**step, "enabled": True} for step in steps])

    def test_large_legacy_library_can_be_saved_after_conversion(self):
        rule = {"find": "嗯", "replace": "", "enabled": True, "regex": False, "caseSensitive": False}
        legacy = {"schema": LEGACY_SCHEMA, "presets": [
            {"id": str(index), "name": str(index), "scope": "all", "rules": [rule] * 100, "operations": {}}
            for index in range(30)
        ]}
        raw = json.dumps(legacy, ensure_ascii=False, indent=2).encode()
        self.assertLess(len(raw), 512 * 1024)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "presets.json"
            path.write_bytes(raw)
            saved = save_library(load_library(path), path)
            self.assertGreater(path.stat().st_size, 512 * 1024)
            self.assertEqual(load_library(path), saved)

    def test_concurrent_writes_allow_one_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "editor-processing.json"
            base = load_library(path)
            barrier = Barrier(2)

            def write(name):
                barrier.wait(timeout=3)
                try:
                    save_library({**base, "presets": [{"id": name, "name": name, "scope": "all", "steps": [{"type": "trim"}]}]}, path)
                    return "saved"
                except ProcessingConflict:
                    return "conflict"

            with ThreadPoolExecutor(max_workers=2) as pool:
                self.assertCountEqual(pool.map(write, ["first", "second"]), ["saved", "conflict"])
            self.assertEqual(load_library(path)["revision"], 1)

    def test_project_keeps_empty_text_override_and_validates_join(self):
        original = {"segments": [{"start": 0, "end": 1000, "text": ""}]}
        self.assertNotIn("processing_overrides", normalize_project(original))
        join = {"gapMs": 0, "shortCount": 20, "snapDirection": "forward",
                "absorbDirection": "previous", "absorbShort": False}
        original["processing_overrides"] = {"text": [], "join": join}
        self.assertEqual(normalize_project(original)["processing_overrides"], {"text": [], "join": join})
        join["gapMs"] = -1
        with self.assertRaisesRegex(ProjectValidationFailed, "processing_overrides"):
            normalize_project(original)

    def test_legacy_preset_preserves_scope_rule_state_and_fixed_order(self):
        legacy = {"schema": LEGACY_SCHEMA, "presets": [{
            "id": "old", "name": "旧配方", "scope": "selected",
            "rules": [{"find": "嗯", "replace": "", "enabled": False, "regex": False, "caseSensitive": True}],
            "operations": {"trim": True, "stripMarkdown": True, "convertChineseNumbers": True,
                           "wraps": [{"id": "custom", "left": "", "right": ""}], "left": "【", "right": "】"},
        }]}
        preset = validate_library(legacy)["presets"][0]
        self.assertEqual(preset["scope"], "selected")
        self.assertEqual([step["type"] for step in preset["steps"]],
                         ["replace", "stripMarkdown", "trim", "convertChineseNumbers", "wrap"])
        self.assertFalse(preset["steps"][0]["enabled"])
        self.assertEqual(preset["steps"][-1]["wraps"], [{"id": "custom", "left": "【", "right": "】"}])
        legacy["presets"][0]["operations"].update(left="", right="")
        steps = validate_library(legacy)["presets"][0]["steps"]
        self.assertEqual(steps[-1]["type"], "convertChineseNumbers")
        legacy["presets"][0]["operations"]["wraps"] = [{"id": "imported", "left": "「", "right": "」"}]
        wraps = validate_library(legacy)["presets"][0]["steps"][-1]["wraps"]
        self.assertEqual(wraps, [{"id": "custom", "left": "「", "right": "」"}])
        legacy["presets"][0]["operations"]["wraps"] = [None]
        with self.assertRaises(ValueError):
            validate_library(legacy)

    def test_corrupt_file_is_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / 'presets.json'
            path.write_text('{broken', encoding='utf-8')
            with self.assertRaises(json.JSONDecodeError):
                load_library(path)
