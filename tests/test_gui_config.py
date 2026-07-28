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
                "DASHSCOPE_API_KEY=file-key\nDASHSCOPE_REGION=singapore\nDASHSCOPE_WORKSPACE_ID=file-ws\nDASHSCOPE_DEFAULT_LANGUAGE=zh\nMAW_GUI_LANG=en\nSTICKER_DIR=file-stickers\nMAW_GUI_LAST_MODEL=file-model\nMAW_GUI_LAST_LANGUAGE=\n",
                encoding="utf-8",
            )

            with mock.patch.dict(os.environ, {"DASHSCOPE_API_KEY": "system-key", "DASHSCOPE_REGION": "beijing", "STICKER_DIR": "system-stickers", "MAW_GUI_LAST_MODEL": "system-model", "MAW_GUI_LAST_LANGUAGE": "en"}, clear=True):
                resolved = gui_config.effective_config(env_path)

            self.assertEqual(resolved.api_key, "system-key")
            self.assertEqual(resolved.region, "beijing")
            self.assertEqual(resolved.workspace_id, "file-ws")
        self.assertEqual(resolved.language, "zh")
        self.assertEqual(resolved.gui_lang, "en")
        self.assertEqual(resolved.sticker_dir, "system-stickers")
        self.assertEqual(resolved.last_model, "system-model")
        self.assertEqual(resolved.last_language, "en")

    def test_effective_config_preserves_empty_last_language_from_env_file(self) -> None:
        """Given GUI language memory is empty, When resolved, Then empty means auto not absent."""
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            _ = env_path.write_text("DASHSCOPE_DEFAULT_LANGUAGE=zh\nMAW_GUI_LAST_LANGUAGE=\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {}, clear=True):
                resolved = gui_config.effective_config(env_path)

        self.assertEqual(resolved.language, "zh")
        self.assertEqual(resolved.last_language, "")

    def test_effective_config_last_language_absent_is_none(self) -> None:
        """Given no GUI language memory, When resolved, Then absence is distinct from auto."""
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            _ = env_path.write_text("DASHSCOPE_DEFAULT_LANGUAGE=zh\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {}, clear=True):
                resolved = gui_config.effective_config(env_path)

        self.assertIsNone(resolved.last_language)

    def test_effective_config_reads_sticker_dir_from_env_file(self) -> None:
        """Given only .env defines stickers, When resolved, Then sticker_dir is populated."""
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            stickers = Path(temp_dir) / "stickers"
            _ = env_path.write_text(f"STICKER_DIR={stickers}\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {}, clear=True):
                resolved = gui_config.effective_config(env_path)

        self.assertEqual(resolved.sticker_dir, str(stickers))

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

    def test_provider_registry_contains_qwen_defaults_and_key_url(self) -> None:
        """Given the provider registry, When inspected, Then Qwen owns model settings."""
        provider = gui_config.PROVIDERS[0]

        self.assertEqual(provider.id, "qwen")
        self.assertIn("aliyun", provider.key_url)
        self.assertEqual(provider.models[0].id, "qwen3-asr-flash-filetrans")
        self.assertEqual(provider.regions[0][0], "beijing")
        self.assertEqual(provider.languages[0][0], "")
        self.assertFalse(provider.supports_speaker)

    def test_provider_registry_contains_soniox_with_speaker_support(self) -> None:
        """Given the provider registry, When inspected, Then Soniox is registered with speaker support and no regions."""
        provider = gui_config.provider_by_id("soniox")

        self.assertEqual(provider.label, "Soniox STT")
        self.assertIn("console.soniox.com", provider.key_url)
        self.assertEqual(provider.models[0].id, "stt-async-v5")
        self.assertEqual(provider.models[0].env_key, "SONIOX_API_KEY")
        self.assertEqual(provider.regions, ())
        self.assertTrue(provider.supports_speaker)
        self.assertTrue(provider.multi_language)

    def test_qwen_languages_single_select_with_auto_and_documented_28(self) -> None:
        """Given Qwen docs allow exactly one language, When registry read, Then auto + 27 codes are offered."""
        qwen = gui_config.provider_by_id("qwen")

        self.assertFalse(qwen.multi_language)
        self.assertEqual(qwen.languages[0], ("", "自动识别"))
        self.assertEqual(len(qwen.languages), 28)
        codes = {code for code, _label in qwen.languages}
        for expected in ("zh", "yue", "en", "fil", "is", "sv"):
            self.assertIn(expected, codes)

    def test_soniox_languages_multi_select_60_without_auto_entry(self) -> None:
        """Given Soniox language_hints is a list, When registry read, Then 60 codes and no auto placeholder."""
        soniox = gui_config.provider_by_id("soniox")

        self.assertEqual(len(soniox.languages), 60)
        codes = [code for code, _label in soniox.languages]
        self.assertTrue(all(codes))
        self.assertEqual(codes[0], "zh")
        self.assertNotIn("yue", codes)  # Soniox 文档的 60 语言表不含粤语独立代码
        for expected in ("en", "ja", "ko", "cy", "ur", "sw"):
            self.assertIn(expected, codes)

    def test_provider_common_languages_are_sensible_subsets_under_ten(self) -> None:
        """Given less common languages are hidden, When common sets read, Then both providers expose 8 languages."""
        qwen = gui_config.provider_by_id("qwen")
        soniox = gui_config.provider_by_id("soniox")

        for provider in (qwen, soniox):
            codes = {code for code, _label in provider.languages}
            common_codes = set(provider.common_languages) - {""}
            self.assertEqual(len(common_codes), 8)
            self.assertTrue(set(provider.common_languages).issubset(codes))
            self.assertLess(len(provider.common_languages), len(provider.languages))
            for expected in ("zh", "en", "ja", "ko"):
                self.assertIn(expected, provider.common_languages)

        self.assertIn("", qwen.common_languages)
        for less_common in ("da", "fil", "is", "sv"):
            self.assertNotIn(less_common, qwen.common_languages)
        for less_common in ("da", "cy", "ur", "sw"):
            self.assertNotIn(less_common, soniox.common_languages)

    def test_effective_config_parses_show_rare_langs_toggle(self) -> None:
        """Given the rare-language toggle in .env, When resolved, Then it becomes a boolean flag."""
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            _ = env_path.write_text("MAW_GUI_SHOW_RARE_LANGS=true\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertTrue(gui_config.effective_config(env_path).show_rare_langs)

            _ = env_path.write_text("MAW_GUI_SHOW_RARE_LANGS=false\n", encoding="utf-8")
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertFalse(gui_config.effective_config(env_path).show_rare_langs)

            _ = env_path.write_text("", encoding="utf-8")
            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertFalse(gui_config.effective_config(env_path).show_rare_langs)

    def test_model_by_label_searches_all_providers(self) -> None:
        """Given a Soniox model id, When resolved, Then its env key comes from the Soniox entry."""
        model = gui_config.model_by_label("stt-async-v5")

        self.assertEqual(model.env_key, "SONIOX_API_KEY")
        self.assertEqual(gui_config.model_by_label("no-such-model").id, "qwen3-asr-flash-filetrans")

    def test_provider_for_model_maps_soniox_model(self) -> None:
        """Given a Soniox model id, When provider resolved, Then it maps to the soniox provider."""
        self.assertEqual(gui_config.provider_for_model("stt-async-v5").id, "soniox")
        self.assertEqual(gui_config.provider_for_model("qwen3-asr-flash-filetrans").id, "qwen")

    def test_api_key_for_provider_reads_each_provider_env_key(self) -> None:
        """Given both keys in .env, When resolved per provider, Then each gets its own key and system env wins."""
        with tempfile.TemporaryDirectory() as temp_dir:
            env_path = Path(temp_dir) / ".env"
            _ = env_path.write_text("DASHSCOPE_API_KEY=file-qwen\nSONIOX_API_KEY=file-soniox\n", encoding="utf-8")

            with mock.patch.dict(os.environ, {"SONIOX_API_KEY": "system-soniox"}, clear=True):
                self.assertEqual(gui_config.api_key_for_provider("soniox", env_path), "system-soniox")
                self.assertEqual(gui_config.api_key_for_provider("qwen", env_path), "file-qwen")

            with mock.patch.dict(os.environ, {}, clear=True):
                self.assertEqual(gui_config.api_key_for_provider("soniox", env_path), "file-soniox")

    def test_i18n_string_tables_have_identical_keys(self) -> None:
        """Given bilingual UI strings, When keys are compared, Then no translation is missing."""
        from maw.gui_i18n import STRINGS

        self.assertEqual(set(STRINGS["zh"]), set(STRINGS["en"]))


if __name__ == "__main__":
    _ = unittest.main()
