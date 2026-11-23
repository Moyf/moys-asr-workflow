from __future__ import annotations

import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from maw.gui_web import LauncherApi
from maw.project_tracks import get_main_track
from maw.tool_windows import ComparisonPreloadApi, open_comparison_window, timestamp_compare_payload, transcript_compare_payload


def _write_project(path: Path, name: str = "工程") -> Path:
    target = path / name
    target.write_text(json.dumps({"segments": [
        {"id": "main-001", "start": 0, "end": 900, "text": "第一句"},
        {"id": "main-002", "start": 1200, "end": 2100, "text": "第二句"},
    ]}, ensure_ascii=False), encoding="utf-8")
    return target


class ToolWindowTests(unittest.TestCase):
    def setUp(self) -> None:
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.directory = Path(temp.name)

    def test_transcript_payload_passes_raw_bytes_and_skips_missing(self) -> None:
        project = _write_project(self.directory, "a.mosp")
        srt = self.directory / "b.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:01,000\n第一句\n", encoding="utf-8")
        payload = transcript_compare_payload([project, srt, self.directory / "missing.srt"], lang="zh")
        self.assertEqual([item["name"] for item in payload["files"]], ["a.mosp", "b.srt"])
        self.assertEqual(base64.b64decode(payload["files"][0]["bytes"]).decode("utf-8"), project.read_text(encoding="utf-8"))
        self.assertIn("missing.srt", payload["warning"])

    def test_timestamp_payload_embeds_projects_and_skips_srt(self) -> None:
        project = _write_project(self.directory, "a.mosp")
        invalid = self.directory / "bad.mosp"
        invalid.write_text("not-json", encoding="utf-8")
        srt = self.directory / "b.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:01,000\n第一句\n", encoding="utf-8")
        payload = timestamp_compare_payload([project, invalid, srt], lang="zh")
        self.assertEqual([item["name"] for item in payload["files"]], ["a.mosp"])
        self.assertEqual(get_main_track(payload["files"][0]["project"])["segments"][0]["text"], "第一句")
        self.assertIn("bad.mosp", payload["warning"])
        self.assertIn("b.srt", payload["warning"])

    def test_preload_api_returns_payload_only(self) -> None:
        api = ComparisonPreloadApi({"files": [], "warning": ""})
        self.assertEqual(api.compare_preload(), {"files": [], "warning": ""})

    def test_open_compare_tool_dispatches_tool_windows_without_writing(self) -> None:
        project = _write_project(self.directory, "a.mosp")
        api = LauncherApi()
        opened = {}
        with patch("maw.gui_web.open_comparison_window", side_effect=lambda root, *, page, title, payload: opened.update(page=page, title=title, payload=payload)):
            result = api.open_compare_tool({"tool": "transcript", "paths": [str(project)], "lang": "zh"})
        self.assertTrue(result, result)
        self.assertEqual(opened["page"].name, "compare.html")
        self.assertEqual(opened["title"], "MAW 转写对比")
        self.assertEqual([item["name"] for item in opened["payload"]["files"]], ["a.mosp"])
        with patch("maw.gui_web.open_comparison_window", side_effect=lambda root, *, page, title, payload: opened.update(page=page, title=title, payload=payload)):
            result = api.open_compare_tool({"tool": "timestamp", "paths": [str(project)], "lang": "en"})
        self.assertTrue(result)
        self.assertEqual(opened["page"].name, "timestamp-compare.html")
        self.assertEqual(opened["title"], "MAW Timestamp Compare")
        self.assertEqual(get_main_track(opened["payload"]["files"][0]["project"])["segments"][0]["text"], "第一句")
        self.assertEqual(sorted(path.name for path in self.directory.iterdir()), ["a.mosp"])

    def test_open_compare_tool_rejects_empty_or_unusable_inputs(self) -> None:
        api = LauncherApi()
        self.assertFalse(api.open_compare_tool({"tool": "transcript", "paths": []})["ok"])
        self.assertFalse(api.open_compare_tool({"tool": "unknown", "paths": ["x.mosp"]})["ok"])
        srt = self.directory / "only.srt"
        srt.write_text("1\n00:00:00,000 --> 00:00:01,000\n第一句\n", encoding="utf-8")
        result = api.open_compare_tool({"tool": "timestamp", "paths": [str(srt)]})
        self.assertFalse(result["ok"])
        self.assertIn("SRT", result["detail"])

    def test_open_comparison_window_requires_existing_page(self) -> None:
        with self.assertRaises(OSError):
            open_comparison_window(self.directory, page=self.directory / "nope.html", title="t", payload={"files": []})


if __name__ == "__main__":
    unittest.main()
