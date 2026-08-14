from __future__ import annotations

import unittest

from scripts.prepare_release_notes import build_release_notes, extract_release_section


class ReleaseNotesTests(unittest.TestCase):
    def test_extracts_only_the_requested_release_section(self) -> None:
        changelog = """## [1.0.0] - today

### 🐛 问题修复

- current

## [0.9.0] - yesterday

- older
"""

        section = extract_release_section(changelog, "v1.0.0")

        self.assertIn("- current", section)
        self.assertNotIn("- older", section)

    def test_builds_shared_platform_guide(self) -> None:
        notes = build_release_notes("## [1.0.0] - today\n\n### ✨ 新增\n\n- feature\n", "v1.0.0")

        self.assertIn("## 下载哪个版本？", notes)
        self.assertIn("如果你不知道 `FFMpeg` 是什么", notes)
        self.assertIn("MAWxFF-Windows-x64-v1.0.0.zip", notes)
        self.assertIn("MAW-x86_64-v1.0.0.AppImage", notes)
        self.assertIn("### ✨ 新增", notes)

    def test_rejects_non_tag_input(self) -> None:
        with self.assertRaisesRegex(ValueError, "must start with v"):
            extract_release_section("## [1.0.0]\n", "1.0.0")


if __name__ == "__main__":
    unittest.main()
