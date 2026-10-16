from __future__ import annotations

from tests.compact_assertions import CompactContainerAssertions

import json
import unittest

import edit
from maw.colors import COLOR_PALETTE


class EditorPaletteInjectionTests(CompactContainerAssertions, unittest.TestCase):
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

    def test_blank_editor_renderer_injects_current_palette(self) -> None:
        # The committed portable copy is regenerated before releases, not on
        # every source edit. Exercise the real blank renderer without writing it.
        blank = edit.build_blank_html()

        assignment = "window.ASR_EDITOR_PALETTE = "
        self.assertIn(assignment, blank)
        injected, _ = json.JSONDecoder().raw_decode(blank.split(assignment, 1)[1])
        self.assertEqual(
            injected,
            [{"name": name, "value": value} for name, value in COLOR_PALETTE],
        )
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
