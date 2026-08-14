from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

from maw.ocr_runtime import (
    OCR_MODEL_ID,
    OCR_SMALL_MODEL_ID,
    OCR_REQUIREMENTS,
    install_ocr_runtime,
    managed_ocr_runtime_status,
    run_ocr_in_runtime,
)
from maw.postprocess import OutputMode
from maw.postprocess_ocr import OcrDedupRequest, OcrRegion


class OcrRuntimeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name) / "ocr-runtime"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_status_reports_missing_runtime_without_importing_ocr_packages(self) -> None:
        status = managed_ocr_runtime_status(self.root)

        self.assertFalse(status.ready)
        self.assertEqual(status.status, "missing")
        self.assertEqual(status.model_id, OCR_MODEL_ID)
        self.assertEqual(status.path, str(self.root.resolve()))

    def test_install_creates_venv_installs_exact_runtime_requirements_and_writes_manifest(self) -> None:
        calls: list[list[str]] = []

        def fake_run(command, *, env, cancel, on_line, cwd):
            _ = (env, cancel, cwd)
            calls.append(command)
            if len(command) > 1 and command[1] == "venv":
                python = self.root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
                python.parent.mkdir(parents=True, exist_ok=True)
                python.write_bytes(b"python")
            elif len(command) > 1 and command[1] == "pip":
                site_packages = self.root / ("Lib/site-packages" if os.name == "nt" else "lib/python3.11/site-packages")
                for package in ("numpy", "onnxruntime", "PIL", "rapidocr"):
                    (site_packages / package).mkdir(parents=True, exist_ok=True)
            on_line("fake command complete")
            return 0

        with mock.patch("maw.ocr_runtime._find_uv", return_value=Path("uv.exe")):
            with mock.patch("maw.ocr_runtime._run_process", side_effect=fake_run):
                status = install_ocr_runtime(runtime_root=self.root, cancel_event=Event())

        self.assertTrue(status.ready)
        self.assertEqual(json.loads((self.root / "runtime.json").read_text(encoding="utf-8"))["modelId"], OCR_MODEL_ID)
        self.assertIn("uv", str(calls[0][0]).lower())
        self.assertEqual(calls[1][-len(OCR_REQUIREMENTS):], list(OCR_REQUIREMENTS))
        self.assertIn("rapidocr", calls[2][-1])

    def test_worker_command_forwards_model_paths_region_and_output_options(self) -> None:
        self._make_ready_runtime()
        ffmpeg = self.root.parent / "ffmpeg.exe"
        ffmpeg.write_bytes(b"ffmpeg")
        request = OcrDedupRequest(
            project_path=self.root.parent / "clip.mosp",
            srt_path=None,
            video_path=self.root.parent / "clip.mp4",
            fallback_video_path=self.root.parent / "fallback.mp4",
            output_mode=OutputMode.BOTH,
            region=OcrRegion(mode="custom", x1=0.05, y1=0.6, x2=0.95, y2=1.0),
            threshold=0.25,
            report=True,
        )
        command_lines: list[list[str]] = []

        def fake_run(command, *, env, cancel, on_line, cwd):
            _ = (env, cancel, cwd)
            command_lines.append(command)
            on_line(json.dumps({"type": "status", "key": "toolbox_status_writing", "details": {}}))
            on_line(json.dumps({"type": "result", "projectPath": "out.mosp", "srtPath": "out.srt", "warnings": []}))
            return 0

        with mock.patch("maw.ocr_runtime._run_process", side_effect=fake_run):
            result = run_ocr_in_runtime(
                request,
                ffmpeg_path=ffmpeg,
                runtime_root=self.root,
                model_id=OCR_SMALL_MODEL_ID,
            )

        command = command_lines[0]
        self.assertEqual(result["projectPath"], "out.mosp")
        self.assertIn("--model-id", command)
        self.assertIn(OCR_SMALL_MODEL_ID, command)
        self.assertIn("--region-mode", command)
        self.assertIn("custom", command)
        self.assertIn("--threshold", command)
        self.assertIn("0.25", command)
        self.assertIn("--report", command)
        self.assertIn("--fallback-video-path", command)

    def _make_ready_runtime(self) -> None:
        python = self.root / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_bytes(b"python")
        site_packages = self.root / ("Lib/site-packages" if os.name == "nt" else "lib/python3.11/site-packages")
        for package in ("numpy", "onnxruntime", "PIL", "rapidocr"):
            (site_packages / package).mkdir(parents=True, exist_ok=True)
        (self.root / "runtime.json").write_text(
            json.dumps({"status": "ready", "runtimeVersion": "1"}),
            encoding="utf-8",
        )


if __name__ == "__main__":
    _ = unittest.main()
