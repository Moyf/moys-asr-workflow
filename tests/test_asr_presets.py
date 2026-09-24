from html.parser import HTMLParser
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from maw.asr_presets import BOOL_FIELDS, SCHEMA, TEXT_FIELDS, create_preset, list_presets, read_preset, read_preset_document, write_preset
from maw.gui_config import load_env, save_env
from maw.gui_web import ASR_PRESET_ROOT_ENV, LauncherApi, LauncherPaths


class RecognitionPresetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = self.root / ".env"
        self.library = self.root / "library"
        self.library.mkdir()
        self.api = LauncherApi(paths=LauncherPaths(self.root, self.env, self.root / "index.html"))
        self.options = dict.fromkeys(TEXT_FIELDS, "") | dict.fromkeys(BOOL_FIELDS, False)
        self.options.update(
            localDevice="auto", fireRedPunc="ct-punc", qwenAudioHotwordsMode="text",
            qwenAudioHotwordWeight="50", promptContext="领域背景\n保留第二行",
            qwenAudioHotwords="术语: 50\n产品", debugRaw=True, testRun=True,
            qwenAudioKeepDialect=True, language="zh,en",
        )
        self.assertTrue(self.api.set_asr_preset_root({"path": str(self.library)})["ok"])

    def test_every_advanced_input_is_in_the_preset(self):
        class Inputs(HTMLParser):
            def __init__(self):
                super().__init__()
                self.ids = set()

            def handle_starttag(self, tag, attrs):
                if tag in ("input", "select", "textarea"):
                    self.ids.add(dict(attrs).get("id"))

        html = (Path(__file__).resolve().parents[1] / "web/launcher/index.html").read_text(encoding="utf-8")
        advanced = html.split('id="advancedCard"', 1)[1].split("</section>", 1)[0]
        parser = Inputs()
        parser.feed(advanced)
        self.assertFalse(parser.ids - set(TEXT_FIELDS + BOOL_FIELDS + ("openaiPrompt", "qwenAudioContext", "sonioxContextText")))
        self.assertIn("promptContext", TEXT_FIELDS)

    def test_legacy_preset_without_description_loads_with_empty_description(self):
        path = self.library / "legacy.json"
        legacy_options = dict(self.options)
        legacy_options.pop("promptContext")
        legacy_options["openaiPrompt"] = "共享提示"
        legacy_options["qwenAudioContext"] = "共享提示"
        legacy_options["sonioxContextText"] = "共享提示"
        path.write_text(json.dumps({"schema": SCHEMA, "options": legacy_options}), encoding="utf-8")
        self.assertEqual(read_preset_document(path)["description"], "")
        restored = read_preset(path)
        self.assertEqual(restored["promptContext"], "共享提示")
        self.assertNotIn("openaiPrompt", restored)
        self.assertNotIn("qwenAudioContext", restored)
        self.assertNotIn("sonioxContextText", restored)
        self.assertEqual({key: value for key, value in restored.items() if key != "promptContext"},
                         {key: value for key, value in self.options.items() if key != "promptContext"})

    def test_legacy_per_provider_contexts_merge_into_shared_prompt_context(self):
        path = self.library / "merged.json"
        legacy_options = dict(self.options)
        legacy_options["promptContext"] = "领域背景"
        legacy_options["openaiPrompt"] = "领域背景"
        legacy_options["sonioxContextText"] = "Soniox 补充说明"
        path.write_text(json.dumps({"schema": SCHEMA, "options": legacy_options}), encoding="utf-8")
        restored = read_preset(path)
        self.assertEqual(restored["promptContext"], "领域背景\nSoniox 补充说明")
        self.assertNotIn("sonioxContextText", restored)

    def test_crud_keeps_metadata_separate_from_options_and_copy_uses_saved_data(self):
        created = self.api.recognition_presets({
            "action": "create", "name": "访谈", "description": "安静环境", "options": self.options,
        })
        self.assertEqual(created, {"ok": True, "name": "访谈"})
        path = self.library / "访谈.json"
        self.assertNotIn(b"\r\n", path.read_bytes())
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["description"], "安静环境")

        loaded = self.api.recognition_presets({"action": "load", "name": "访谈"})
        self.assertEqual(loaded["options"], self.options)
        self.assertEqual(loaded["description"], "安静环境")
        preview = self.api.recognition_presets({"action": "preview", "name": "访谈"})
        self.assertEqual(preview["options"], self.options)

        renamed = self.api.recognition_presets({
            "action": "save_info", "name": "访谈", "newName": "采访", "description": "",
        })
        self.assertEqual(renamed, {"ok": True, "name": "采访"})
        self.assertFalse(path.exists())
        renamed_document = json.loads((self.library / "采访.json").read_text(encoding="utf-8"))
        self.assertEqual(renamed_document["description"], "")
        self.assertEqual(renamed_document["options"], self.options)

        updated_options = self.options | {"promptContext": "updated"}
        updated = self.api.recognition_presets({"action": "update", "name": "采访", "options": updated_options})
        self.assertTrue(updated["ok"], updated)
        copied = self.api.recognition_presets({"action": "copy", "name": "采访", "newName": "采访副本"})
        self.assertTrue(copied["ok"], copied)
        copy_document = read_preset_document(self.library / "采访副本.json")
        self.assertEqual(copy_document["options"], updated_options)
        self.assertEqual(copy_document["description"], "")
        self.assertEqual(read_preset(self.library / "采访.json"), updated_options)

        with patch("maw.gui_web.send2trash", side_effect=lambda value: Path(value).unlink()):
            deleted = self.api.recognition_presets({"action": "delete", "name": "采访副本"})
        self.assertTrue(deleted["ok"], deleted)
        self.assertFalse((self.library / "采访副本.json").exists())

    def test_copy_generates_a_unique_default_name_and_open_file_accepts_only_library_names(self):
        self.assertTrue(self.api.recognition_presets({"action": "create", "name": "共享", "options": self.options})["ok"])
        first = self.api.recognition_presets({"action": "copy", "name": "共享", "suffix": "副本"})
        second = self.api.recognition_presets({"action": "copy", "name": "共享", "suffix": "副本"})
        self.assertEqual(first["name"], "共享 副本")
        self.assertEqual(second["name"], "共享 副本 (2)")
        self.assertEqual(read_preset(self.library / "共享 副本.json"), self.options)

        with patch("maw.gui_web._open_existing_path", return_value={"ok": True}) as open_path:
            self.assertEqual(self.api.open_asr_preset_file({"name": "共享"}), {"ok": True})
            open_path.assert_called_once_with(self.library / "共享.json")
        rejected = self.api.open_asr_preset_file({"name": "../outside"})
        self.assertFalse(rejected["ok"])

    def test_create_rejects_traversal_invalid_names_and_case_insensitive_collisions(self):
        for name in ("../escape", "sub\\escape", "bad/name", "CON", "name.json", ""):
            result = self.api.recognition_presets({"action": "create", "name": name, "options": self.options})
            self.assertFalse(result["ok"], name)
        self.assertFalse((self.root / "escape.json").exists())
        self.assertTrue(self.api.recognition_presets({"action": "create", "name": "Preset", "options": self.options})["ok"])
        duplicate = self.api.recognition_presets({"action": "create", "name": "preset", "options": self.options})
        self.assertFalse(duplicate["ok"])
        self.assertEqual(len(list(self.library.glob("*.json"))), 1)

    def test_broken_and_unsupported_json_are_listed_unavailable_with_reason(self):
        (self.library / "broken.json").write_text("not json", encoding="utf-8")
        (self.library / "unsupported.json").write_text('{"schema":"other","options":{}}', encoding="utf-8")
        result = self.api.asr_preset_library()
        self.assertTrue(result["ok"], result)
        items = {item["name"]: item for item in result["items"]}
        self.assertFalse(items["broken"]["valid"])
        self.assertTrue(items["broken"]["detail"])
        self.assertFalse(items["unsupported"]["valid"])
        self.assertIn("Unsupported", items["unsupported"]["detail"])

    def test_failed_atomic_update_preserves_previous_preset(self):
        create_preset(self.library, "stable", self.options, "description")
        path = self.library / "stable.json"
        original = path.read_bytes()
        with patch("maw.asr_presets.os.replace", side_effect=PermissionError("locked")):
            result = self.api.recognition_presets({
                "action": "update", "name": "stable", "options": self.options | {"promptContext": "new"},
            })
        self.assertFalse(result["ok"])
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(read_preset(path), self.options)

    def test_custom_root_must_exist_and_be_writable(self):
        missing = self.root / "missing"
        self.assertFalse(self.api.set_asr_preset_root({"path": str(missing)})["ok"])
        file_path = self.root / "file"
        file_path.write_text("x", encoding="utf-8")
        self.assertFalse(self.api.set_asr_preset_root({"path": str(file_path)})["ok"])

    def test_migration_uses_legacy_folder_once_and_can_be_declined(self):
        legacy = self.root / "old-library"
        legacy.mkdir()
        write_preset(legacy / "old.json", self.options, "legacy")
        (legacy / "broken.json").write_text("still migrate this file", encoding="utf-8")
        migration_env = self.root / "migration.env"
        save_env(migration_env, {"MAW_ASR_PRESET_DIRECTORY": str(legacy)})
        migration_api = LauncherApi(paths=LauncherPaths(self.root, migration_env, self.root / "index.html"))
        target = self.root / "new-library"
        target.mkdir()
        preview = migration_api.asr_preset_migration_preview({"path": str(target)})
        self.assertEqual(preview["files"], ["broken.json", "old.json"])
        with patch("maw.gui_web.send2trash", side_effect=lambda value: Path(value).unlink()):
            result = migration_api.set_asr_preset_root({"path": str(target), "migrate": True})
        self.assertTrue(result["ok"], result)
        self.assertEqual(read_preset(target / "old.json"), self.options)
        self.assertEqual((target / "broken.json").read_text(encoding="utf-8"), "still migrate this file")
        self.assertFalse((legacy / "old.json").exists())
        self.assertEqual(load_env(migration_env)[ASR_PRESET_ROOT_ENV], str(target.resolve()))
        self.assertEqual(load_env(migration_env)["MAW_ASR_PRESET_DIRECTORY"], str(legacy))

    def test_symbolic_links_are_unavailable_and_cannot_be_loaded(self):
        target = self.library / "valid.json"
        write_preset(target, self.options)
        link = self.library / "linked.json"
        try:
            link.symlink_to(target)
        except (OSError, NotImplementedError) as error:
            self.skipTest(f"symbolic links unavailable: {error}")
        items = {item["name"]: item for item in list_presets(self.library)}
        self.assertFalse(items["linked"]["valid"])
        self.assertIn("symbolic link", items["linked"]["detail"])
        self.assertFalse(self.api.recognition_presets({"action": "load", "name": "linked"})["ok"])

    def test_migration_collision_is_reported_without_overwriting_or_switching_root(self):
        legacy = self.root / "old-library"
        legacy.mkdir()
        write_preset(legacy / "same.json", self.options)
        migration_env = self.root / "collision.env"
        save_env(migration_env, {"MAW_ASR_PRESET_DIRECTORY": str(legacy)})
        migration_api = LauncherApi(paths=LauncherPaths(self.root, migration_env, self.root / "index.html"))
        target = self.root / "target"
        target.mkdir()
        write_preset(target / "same.json", self.options | {"promptContext": "existing"})
        preview = migration_api.asr_preset_migration_preview({"path": str(target)})
        self.assertEqual(preview["conflicts"], ["same.json"])
        result = migration_api.set_asr_preset_root({"path": str(target), "migrate": True})
        self.assertFalse(result["ok"])
        self.assertEqual(read_preset(target / "same.json")["promptContext"], "existing")
        self.assertTrue((legacy / "same.json").exists())
        self.assertNotIn(ASR_PRESET_ROOT_ENV, load_env(migration_env))

    def test_switch_without_migration_keeps_old_library_intact(self):
        create_preset(self.library, "keep", self.options)
        target = self.root / "other-library"
        target.mkdir()
        result = self.api.set_asr_preset_root({"path": str(target), "migrate": False})
        self.assertTrue(result["ok"], result)
        self.assertEqual(load_env(self.env)[ASR_PRESET_ROOT_ENV], str(target.resolve()))
        self.assertTrue((self.library / "keep.json").exists())

    def test_default_root_is_under_global_app_data_and_old_last_folder_is_not_active_root(self):
        env = self.root / "empty.env"
        legacy = self.root / "last-used"
        legacy.mkdir()
        save_env(env, {"MAW_ASR_PRESET_DIRECTORY": str(legacy)})
        api = LauncherApi(paths=LauncherPaths(self.root, env, self.root / "index.html"))
        with patch("maw.gui_web.default_app_data_root", return_value=self.root / "global-data"):
            config = api.get_config()
            result = api.asr_preset_library()
        self.assertEqual(config["asrPresetRoot"], str((self.root / "global-data" / "asr-presets").resolve()))
        self.assertFalse(config["asrPresetRootConfigured"])
        self.assertEqual(result["root"], config["asrPresetRoot"])

    def test_older_preset_defaults_to_standard_dialect_behavior(self):
        from maw.asr_presets import validate_options

        legacy = dict(self.options)
        del legacy["qwenAudioKeepDialect"]
        restored = validate_options(legacy)
        self.assertFalse(restored["qwenAudioKeepDialect"])
        self.assertEqual(restored, legacy | {"qwenAudioKeepDialect": False})


if __name__ == "__main__":
    unittest.main()
