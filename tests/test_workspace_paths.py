from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from maw.workspace_paths import (
    cache_directory,
    ensure_workspace_layout,
    find_workspace_root,
    finished_directory,
    original_artifacts_directory,
    reapeaks_cache_path,
    sanitize_component,
    waveform_cache_path,
    workspace_root,
)


class WorkspacePathTests(unittest.TestCase):
    def test_media_gets_one_chinese_workspace_layout(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            media = Path(temp_name) / "视频1.mp4"
            expected = Path(temp_name).resolve() / "视频1 - MAW工作文件"

            self.assertEqual(workspace_root(media), expected)
            self.assertEqual(original_artifacts_directory(media), expected / "原始工程与字幕")
            self.assertEqual(finished_directory(media), expected / "成片")
            self.assertEqual(cache_directory(media), expected / "缓存与备份")
            self.assertEqual(
                waveform_cache_path(media),
                expected / "缓存与备份" / "视频1.mp4.waveform.json",
            )
            self.assertEqual(
                reapeaks_cache_path(media),
                expected / "缓存与备份" / "视频1.mp4.ReaPeaks",
            )

    def test_ensure_workspace_layout_creates_all_categories(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            media = Path(temp_name) / "视频1.mp4"
            root = ensure_workspace_layout(media)

            self.assertTrue((root / "原始工程与字幕").is_dir())
            self.assertTrue((root / "成片").is_dir())
            self.assertTrue((root / "缓存与备份").is_dir())

    def test_artifacts_inside_workspace_reuse_the_same_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name).resolve() / "视频1 - MAW工作文件"
            result = root / "成片" / "处理后.mp4"

            self.assertEqual(find_workspace_root(result), root)
            self.assertEqual(workspace_root(result), root)

    def test_component_name_is_cross_platform_safe(self) -> None:
        self.assertEqual(sanitize_component('CON:片段?'), "CON_片段_")
        self.assertEqual(sanitize_component("...", "视频"), "视频")


if __name__ == "__main__":
    unittest.main()
