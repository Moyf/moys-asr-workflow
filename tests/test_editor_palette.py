from __future__ import annotations

import json
import unittest
from pathlib import Path

import edit
from maw.colors import COLOR_PALETTE

REPO_ROOT = Path(__file__).resolve().parents[1]


class EditorPaletteInjectionTests(unittest.TestCase):
    """调色板单一来源：maw/colors.py → 注入编辑器页面。"""

    def test_build_palette_json_matches_color_palette(self) -> None:
        injected = json.loads(edit.build_palette_json())

        self.assertEqual(
            injected,
            [{"name": name, "value": value} for name, value in COLOR_PALETTE],
        )

    def test_rendered_page_contains_injected_palette_script(self) -> None:
        page = edit.render_editor_page(**self._minimal_context())

        self.assertIn("window.ASR_EDITOR_PALETTE = ", page)
        self.assertNotIn("__PALETTE_JSON__", page)
        for name, value in COLOR_PALETTE:
            self.assertIn(json.dumps({"name": name, "value": value}, ensure_ascii=False), page)

    def test_committed_blank_editor_stays_in_sync(self) -> None:
        blank = (REPO_ROOT / "blank-editor.html").read_text(encoding="utf-8")

        self.assertIn("window.ASR_EDITOR_PALETTE = ", blank)
        self.assertIn(edit.build_palette_json(), blank)
        self.assertNotIn("__PALETTE_JSON__", blank)

    @staticmethod
    def _minimal_context() -> dict[str, str]:
        return {
            "title": "MAWE",
            "media_html": "",
            "data_json": "{}",
            "filename_base_json": '"project"',
            "stickers_json": "[]",
            "sticker_root_json": '""',
            "app_version": "test",
            "json_display": "project",
            "json_name_class": "",
            "media_name_display": "",
            "media_name_title": "",
            "media_name_class": "",
        }


if __name__ == "__main__":
    unittest.main()
