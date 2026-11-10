from __future__ import annotations

import json
import argparse
import os
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

from maw.ocr_runtime import (
    OCR_MODEL_ID,
    OCR_SMALL_MODEL_ID,
    OcrRuntimeCancelled,
    OcrRuntimeError,
    _runtime_env,
    install_ocr_runtime,
    managed_ocr_runtime_status,
    recover_ocr_runtime_install,
    run_ocr_in_runtime,
    run_ocr_scan_in_runtime,
)
from maw.postprocess import OutputMode
from maw.postprocess_ocr import OcrDedupRequest, OcrRegion
from maw.runtime_manifest import STATUS_BROKEN, STATUS_INSTALLING, write_runtime_manifest
from maw.runtimes import OCR


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

    def test_aborted_install_does_not_leave_an_installing_manifest(self) -> None:
        python = OCR.python_path(self.root)
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_bytes(b"python")
        write_runtime_manifest(
            self.root,
            status=STATUS_INSTALLING,
            runtime_version=OCR.spec.runtime_version,
            python_version=OCR.spec.python_version,
            extra={"modelId": OCR_MODEL_ID},
        )

        self.assertTrue(recover_ocr_runtime_install(self.root))
        self.assertEqual(managed_ocr_runtime_status(self.root).status, STATUS_BROKEN)
        manifest = json.loads((self.root / "runtime.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["status"], STATUS_BROKEN)
        self.assertEqual(manifest["modelId"], OCR_MODEL_ID)
        self.assertFalse(recover_ocr_runtime_install(self.root))

    # 内嵌流测试固定 win32：install 分支与布局在 mac/linux CI 上一致。
    @mock.patch("maw.runtimes.base.sys.frozen", True, create=True)
    @mock.patch("maw.runtimes.base.sys.platform", "win32")
    def test_install_creates_venv_installs_exact_runtime_requirements_and_writes_manifest(self) -> None:
        calls: list[list[str]] = []

        def fake_extract(_zip_path, target_dir):
            python = target_dir / ("python.exe" if sys.platform == "win32" else "bin/python")
            python.parent.mkdir(parents=True, exist_ok=True)
            python.write_bytes(b"python")

        def fake_run(command, *, env, cancel, on_line, cwd, **_unused):
            _ = (env, cancel, cwd)
            calls.append(command)
            if "install" in command:
                site_packages = self.root / "site-packages"
                for package in ("certifi", "numpy", "onnxruntime", "PIL", "rapidocr"):
                    (site_packages / package).mkdir(parents=True, exist_ok=True)
            on_line("fake command complete")
            return 0

        requirements_txt = self.root.parent / "requirements-ocr.txt"
        requirements_txt.write_text("numpy==2.4.6\nonnxruntime==1.28.0\nrapidocr==3.9.2\n", encoding="utf-8")
        with mock.patch("maw.runtimes.base._find_bootstrap_asset", side_effect=[Path("embed.zip"), Path("get-pip.py")]):
            with mock.patch("maw.runtimes.base._extract_embed_python", side_effect=fake_extract):
                with mock.patch.object(OCR, "requirements_path", return_value=requirements_txt):
                    with mock.patch("maw.runtimes.base.pick_fastest_mirror", return_value="https://pypi.org/simple"):
                        with mock.patch("maw.runtimes.base._run_process", side_effect=fake_run):
                            status = install_ocr_runtime(runtime_root=self.root, cancel_event=Event())

        self.assertTrue(status.ready)
        self.assertEqual(json.loads((self.root / "runtime.json").read_text(encoding="utf-8"))["modelId"], OCR_MODEL_ID)
        self.assertIn("--target", calls[1])
        self.assertIn("-r", calls[1])
        self.assertTrue(any("requirements-ocr.txt" in str(arg) for arg in calls[1]))
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
            media_path=self.root.parent / "source.mp4",
            output_directory=self.root.parent / "ocr-output",
            output_mode=OutputMode.BOTH,
            region=OcrRegion(mode="custom", x1=0.05, y1=0.6, x2=0.95, y2=1.0),
            threshold=0.25,
            report=True,
        )
        command_lines: list[list[str]] = []

        def fake_run(
            command,
            *,
            env,
            cancel,
            on_line,
            cwd,
            error_class,
            cancelled_class,
            cancelled_message,
            message_prefix,
        ):
            _ = (env, cancel, cwd)
            self.assertIs(error_class, OcrRuntimeError)
            self.assertIs(cancelled_class, OcrRuntimeCancelled)
            self.assertEqual(cancelled_message, "OCR 运行环境操作已取消。")
            self.assertEqual(message_prefix, "OCR 运行环境")
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
        self.assertIn("--media-path", command)
        self.assertIn("--output-directory", command)
        self.assertIn(str(self.root.parent / "ocr-output"), command)

    def test_worker_scan_command_collects_blocks_and_summary(self) -> None:
        self._make_ready_runtime()
        ffmpeg = self.root.parent / "ffmpeg.exe"
        ffmpeg.write_bytes(b"ffmpeg")
        video = self.root.parent / "clip.mp4"
        video.write_bytes(b"video")
        command_lines: list[list[str]] = []
        cancel = Event()
        seen_cancels = []

        def fake_run(command, *, env, cancel, on_line, cwd, **_unused):
            _ = (env, cancel, cwd)
            command_lines.append(command)
            seen_cancels.append(cancel)
            on_line(
                json.dumps(
                    {
                        "type": "blocks",
                        "tMs": 618_000,
                        "frame": "frame-000000618000.jpg",
                        "blocks": [
                            {"text": "前往星核", "score": 0.9412, "box": [10, 20, 220, 44]},
                        ],
                    },
                    ensure_ascii=False,
                )
            )
            on_line(json.dumps({"type": "blocks", "tMs": 619_000, "frame": "frame-000000618000.jpg",
                                "blocks": [{"text": "前往星核", "score": 0.9412, "box": [10, 20, 220, 44]}]}))
            on_line(
                json.dumps(
                    {
                        "type": "result",
                        "framesTotal": 6,
                        "framesScanned": 6,
                        "framesSkippedDuplicate": 1,
                        "framesFailed": 0,
                        "blocksTotal": 1,
                    }
                )
            )
            return 0

        with mock.patch("maw.ocr_runtime._run_process", side_effect=fake_run):
            result = run_ocr_scan_in_runtime(
                video,
                ffmpeg_path=ffmpeg,
                duration_ms=620_000,
                fps=0.5,
                model_id=OCR_SMALL_MODEL_ID,
                runtime_root=self.root,
                max_frames=7,
                cancel_event=cancel,
            )

        command = command_lines[0]
        self.assertIn("scan", command)
        self.assertIn(OCR_SMALL_MODEL_ID, command)
        self.assertIn("--duration-ms", command)
        self.assertIn("620000", command)
        self.assertIn("--fps", command)
        self.assertIn("0.5", command)
        self.assertEqual(command[command.index("--max-frames") + 1], "7")
        self.assertIs(seen_cancels[0], cancel)
        self.assertNotIn("--frames-dir", command)
        self.assertEqual(result["framesTotal"], 6)
        self.assertEqual(len(result["blocks"]), 2)
        block = result["blocks"][0]
        self.assertEqual(block["text"], "前往星核")
        self.assertEqual(block["tMs"], 618_000)
        self.assertEqual(block["frame"], "frame-000000618000.jpg")
        self.assertEqual(block["box"], [10, 20, 220, 44])
        self.assertEqual(result["blocks"][1]["frame"], block["frame"])
        self.assertEqual(result["blocks"][1]["tMs"], 619_000)

    def test_scan_invalid_max_frames_fails_before_runtime_lookup(self) -> None:
        for limit in (0, -1, True, 1.5):
            with self.subTest(limit=limit), mock.patch("maw.ocr_runtime.managed_ocr_runtime_status") as status:
                with self.assertRaises(ValueError):
                    run_ocr_scan_in_runtime("synthetic.mp4", ffmpeg_path="ffmpeg", duration_ms=1000, max_frames=limit)
                status.assert_not_called()

    def test_worker_parser_rejects_nonpositive_frame_limit(self) -> None:
        from maw.ocr_runtime_worker import _positive_int

        self.assertEqual(_positive_int("7"), 7)
        for value in ("0", "-1"):
            with self.subTest(value=value), self.assertRaises(argparse.ArgumentTypeError):
                _positive_int(value)

    def test_worker_scan_surfaces_worker_error(self) -> None:
        self._make_ready_runtime()
        ffmpeg = self.root.parent / "ffmpeg.exe"
        ffmpeg.write_bytes(b"ffmpeg")
        video = self.root.parent / "clip.mp4"
        video.write_bytes(b"video")

        def fake_run(command, *, on_line, **_unused):
            _ = command
            on_line(json.dumps({"type": "error", "detail": "boom"}, ensure_ascii=False))
            return 1

        with mock.patch("maw.ocr_runtime._run_process", side_effect=fake_run):
            with self.assertRaises(OcrRuntimeError):
                run_ocr_scan_in_runtime(
                    video,
                    ffmpeg_path=ffmpeg,
                    duration_ms=1_000,
                    runtime_root=self.root,
                )

    def _make_ready_runtime(self) -> None:
        python = self.root / ("python/python.exe" if sys.platform == "win32" else "python/bin/python")
        python.parent.mkdir(parents=True, exist_ok=True)
        python.write_bytes(b"python")
        site_packages = self.root / "site-packages"
        for package in ("certifi", "numpy", "onnxruntime", "PIL", "rapidocr"):
            (site_packages / package).mkdir(parents=True, exist_ok=True)
        (self.root / "runtime.json").write_text(
            json.dumps({"status": "ready", "runtimeVersion": OCR.spec.runtime_version}),
            encoding="utf-8",
        )


class OcrRuntimeEnvironmentTests(unittest.TestCase):
    """回归：OCR worker 跑在托管 venv 的宿主解释器上（见 restore_host_library_path）。"""

    def test_runtime_env_drops_bundled_library_path_for_frozen_linux(self) -> None:
        parent_env = {"LD_LIBRARY_PATH": "/app/_internal", "MAW_TEST": "preserved"}
        with mock.patch.object(sys, "platform", "linux"):
            with mock.patch.object(sys, "frozen", True, create=True):
                with mock.patch.dict(os.environ, parent_env, clear=True):
                    env = _runtime_env(Path("/tmp/ocr-runtime"))
                    self.assertEqual(dict(os.environ), parent_env)

        self.assertNotIn("LD_LIBRARY_PATH", env)
        self.assertEqual(env["MAW_TEST"], "preserved")


if __name__ == "__main__":
    _ = unittest.main()
