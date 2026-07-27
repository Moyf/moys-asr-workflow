from __future__ import annotations

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from maw import gui_config  # noqa: E402


class GuiConfigTests(unittest.TestCase):
    def test_save_env_preserves_comments_order_and_other_values(self) -> None:
        """Given an existing env file, When keys are saved, Then only those keys change."""
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            _ = env_path.write_text("# heading\nDASHSCOPE_API_KEY=old\nKEEP_ME=yes\n\n# tail\n", encoding="utf-8", newline="\n")

            gui_config.save_env(env_path, {"DASHSCOPE_API_KEY": "new", "MAW_GUI_LANG": "en"})

            self.assertEqual(
                env_path.read_text(encoding="utf-8"),
                "# heading\nDASHSCOPE_API_KEY=new\nKEEP_ME=yes\n\n# tail\nMAW_GUI_LANG=en\n",
            )

    def test_save_env_creates_from_example_when_absent(self) -> None:
        """Given no env file, When saving, Then the local example is copied first."""
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _ = (root / ".env.example").write_text("# sample\nDASHSCOPE_REGION=beijing\n", encoding="utf-8")

            gui_config.save_env(root / ".env", {"DASHSCOPE_REGION": "singapore"})

            self.assertEqual((root / ".env").read_text(encoding="utf-8"), "# sample\nDASHSCOPE_REGION=singapore\n")

    def test_effective_config_prefers_system_environment_over_env_file(self) -> None:
        """Given env file and process env differ, When resolved, Then process env wins."""
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            _ = env_path.write_text(
                "DASHSCOPE_API_KEY=file-key\nDASHSCOPE_REGION=singapore\nDASHSCOPE_WORKSPACE_ID=file-ws\nDASHSCOPE_DEFAULT_LANGUAGE=zh\nMAW_GUI_LANG=en\n",
                encoding="utf-8",
            )

            with mock.patch.dict(os.environ, {"DASHSCOPE_API_KEY": "system-key", "DASHSCOPE_REGION": "beijing"}, clear=True):
                resolved = gui_config.effective_config(env_path)

            self.assertEqual(resolved.api_key, "system-key")
            self.assertEqual(resolved.region, "beijing")
            self.assertEqual(resolved.workspace_id, "file-ws")
        self.assertEqual(resolved.language, "zh")
        self.assertEqual(resolved.gui_lang, "en")

    def test_masked_secret_never_returns_full_key(self) -> None:
        """Given a saved key, When status text is built, Then only a prefix and suffix remain."""
        masked = gui_config.masked_secret("sk-very-secret-abcd")

        self.assertEqual(masked, "sk-…abcd")
        self.assertNotIn("very-secret", masked)

    def test_model_registry_resolves_env_key_and_shape(self) -> None:
        """Given the v1 registry, When inspected, Then model metadata is complete."""
        self.assertEqual(len(gui_config.MODELS), 1)
        model = gui_config.MODELS[0]

        self.assertEqual(model.id, "qwen3-asr-flash-filetrans")
        self.assertEqual(model.env_key, "DASHSCOPE_API_KEY")
        self.assertTrue(model.label)

    def test_i18n_string_tables_have_identical_keys(self) -> None:
        """Given bilingual UI strings, When keys are compared, Then no translation is missing."""
        from maw.gui import STRINGS

        self.assertEqual(set(STRINGS["zh"]), set(STRINGS["en"]))


if __name__ == "__main__":
    _ = unittest.main()
