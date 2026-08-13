from __future__ import annotations

import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import edit  # noqa: E402


class EditorAssetContractTests(unittest.TestCase):
    def test_editor_script_manifest_is_ordered_and_complete(self) -> None:
        self.assertEqual(
            edit.read_editor_script_manifest(),
            (
                "editor-runtime.js",
                "editor-utils.js",
                "editor-i18n.js",
                "waveform.js",
                "editor.js",
                "editor-onboarding.js",
            ),
        )

    def test_editor_script_payload_follows_manifest_order(self) -> None:
        payload = edit.build_editor_scripts()
        previous_index = -1
        markers = (
            "// Shared frontend runtime registry.",
            "// Pure editor helpers kept separate",
            "(function initMaweI18n(global) {",
            "// Framework-neutral waveform runtime.",
            "const EDITOR_SETTINGS_KEY = 'moy.asr.editor.settings.v1';",
            "const helpOnboardingButton = document.getElementById('help-onboarding');",
        )
        for asset_name, marker in zip(edit.read_editor_script_manifest(), markers):
            current_index = payload.index(marker)
            self.assertGreater(current_index, previous_index, asset_name)
            previous_index = current_index

    def test_template_uses_one_script_token(self) -> None:
        template = edit.read_web_asset("editor-template.html")
        self.assertEqual(template.count("__EDITOR_SCRIPTS_JS__"), 1)
        for legacy_token in (
            "__EDITOR_UTILS_JS__",
            "__EDITOR_I18N_JS__",
            "__WAVEFORM_JS__",
            "__EDITOR_JS__",
            "__EDITOR_ONBOARDING_JS__",
        ):
            self.assertNotIn(legacy_token, template)

    def test_generated_page_contains_registered_modules_in_order(self) -> None:
        page = edit.build_blank_html()
        self.assertNotRegex(page, r"__[A-Z][A-Z0-9_]+__")
        self.assertIn(
            f'<span class="app-version" id="app-version" data-label="版本号">版本号 v{edit.get_app_version()}</span>',
            page,
        )
        self.assertNotIn("生成时间", page)
        markers = (
            "// Shared frontend runtime registry.",
            "window.AsrEditorUtils = {",
            "global.MAWE_I18N = {",
            "window.AsrWaveform = {",
            "window.MAWE_EDITOR_BRIDGE = Object.freeze({",
            "window.MAWE_ONBOARDING = Object.freeze({",
        )
        indices = [page.index(marker) for marker in markers]
        self.assertEqual(indices, sorted(indices))

    def test_tauri_builder_consumes_the_shared_script_manifest(self) -> None:
        build_script = (ROOT / "desktop" / "src-tauri" / "build.rs").read_text(encoding="utf-8")
        self.assertIn('web_dir.join("editor-scripts.txt")', build_script)
        self.assertIn('("__EDITOR_SCRIPTS_JS__", editor_scripts.as_str())', build_script)
        for legacy_token in (
            "__EDITOR_UTILS_JS__",
            "__EDITOR_I18N_JS__",
            "__WAVEFORM_JS__",
            "__EDITOR_JS__",
        ):
            self.assertNotIn(legacy_token, build_script)


if __name__ == "__main__":
    unittest.main()
