"""真实 scanner + 合成 PIL 帧：扫描发布隔离、失败回滚与严格汇总契约。"""

from __future__ import annotations

import contextlib
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "term-extract"))

from PIL import Image  # noqa: E402
from maw.ocr_scan import OcrScanRequest, run_ocr_scan  # noqa: E402
from tests.compact_assertions import CompactContainerAssertions  # noqa: E402
from tests.test_term_extract_cli_cache import FakeProvider  # noqa: E402
from term_extract import __main__ as cli  # noqa: E402
from maw.postprocess_llm import LlmSettings  # noqa: E402


class SyntheticScanner:
    def __init__(self, color: str, *, interrupt: bool = False, failure: bool = False, mutate_source: bool = False):
        self.color = color
        self.interrupt = interrupt
        self.failure = failure
        self.mutate_source = mutate_source
        self.frames_dir: Path | None = None

    def scan(self, video: Path, **kwargs) -> dict:
        rows = []
        self.frames_dir = kwargs["frames_dir"]

        def extract(_ffmpeg, _video, _seconds, path):
            Image.new("RGB", (20, 20), self.color).save(path)
            return True

        def status(_key, details):
            if self.interrupt and details["current"] == 2:
                raise KeyboardInterrupt

        def collect(t_ms, frame, hits):
            rows.extend({"text": text, "score": score, "box": list(box), "tMs": t_ms, "frame": frame}
                        for text, score, box in hits)

        summary = run_ocr_scan(
            OcrScanRequest(video_path=video, ffmpeg_path=Path("fake"), duration_ms=kwargs["duration_ms"],
                           fps=kwargs["fps"], region=kwargs["region"], max_frames=kwargs["max_frames"],
                           frames_dir=self.frames_dir),
            frame_extractor=extract, image_loader=Image.open,
            recognizer=lambda _image: [("前往星核", .95, (0, 0, 20, 20))],
            on_status=status, on_blocks=collect,
        )
        if self.failure:
            raise ValueError("synthetic provider failure after writing evidence")
        if self.mutate_source:
            video.write_bytes(b"changed synthetic source")
        return {**summary, "blocks": rows}


class ScanPublicationTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.video = Path(self.temp.name) / "synthetic.mp4"
        self.video.write_bytes(b"synthetic source, not media")
        # Hosted Windows TEMP can be a junction; the CLI resolves --out before
        # publishing, so failure injection must compare the physical path.
        self.out = (Path(self.temp.name) / "out").resolve()
        self.out.mkdir()

    def run_cli(self, provider, *options: str) -> tuple[int, str]:
        args = cli.build_parser().parse_args([str(self.video), "--out", str(self.out), *options])
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = cli.run_pipeline(args, scan_provider=provider, duration_prober=lambda _v: 3000)
        return code, output.getvalue()

    def seed_complete(self) -> None:
        settings = LlmSettings(provider_id="custom", api_key="fake", base_url="http://127.0.0.1:9", model="fake")
        with mock.patch.object(cli.ai_filter, "build_settings", return_value=settings), \
             mock.patch.object(cli.ai_filter, "filter_candidates", side_effect=lambda candidates, _settings: {
                 c["word"]: {"verdict": "keep", "type": "地名", "reason": "synthetic"} for c in candidates}):
            code, output = self.run_cli(SyntheticScanner("red"))
        self.assertEqual(code, 0, output)
        self.old = {name: (self.out / name).read_bytes() for name in ("ocr.json", "candidates.json", "report.html", "report.csv")}
        self.cache = json.loads(self.old["ocr.json"])
        self.old_frames = self.out / self.cache.get("framesDirectory", "frames")
        self.old_frame = self.old_frames / self.cache["blocks"][0]["frame"]
        self.old_frame_bytes = self.old_frame.read_bytes()

    def assert_old_intact(self) -> None:
        self.assertEqual(self.old_frame.read_bytes(), self.old_frame_bytes)
        for name, content in self.old.items():
            self.assertEqual((self.out / name).read_bytes(), content, name)
        self.assertEqual(list(self.out.glob(".term-staging-*")), [])

    def test_interrupted_rescan_does_not_replace_old_complete_evidence_or_artifacts(self) -> None:
        self.seed_complete()
        scan = SyntheticScanner("blue", interrupt=True)
        code, output = self.run_cli(scan, "--no-ai")
        self.assertEqual(code, 130, output)
        self.assert_old_intact()
        code, output = self.run_cli(mock.Mock(), "--no-ai", "--resume")
        self.assertEqual(code, 0, output)
        self.assertEqual(self.old_frame.read_bytes(), self.old_frame_bytes)

    def test_provider_failure_after_staged_evidence_preserves_old_artifacts(self) -> None:
        self.seed_complete()
        code, output = self.run_cli(SyntheticScanner("blue", failure=True), "--no-ai")
        self.assertEqual(code, 1, output)
        self.assert_old_intact()

    def test_source_mutation_during_scan_preserves_old_artifacts_and_resume_rejects(self) -> None:
        self.seed_complete()
        code, output = self.run_cli(SyntheticScanner("blue", mutate_source=True), "--no-ai")
        self.assertEqual(code, 1, output)
        self.assert_old_intact()
        code, _ = self.run_cli(mock.Mock(), "--no-ai", "--resume")
        self.assertEqual(code, 1)

    def test_source_mutation_during_aggregation_never_publishes_staged_generation(self) -> None:
        self.seed_complete()
        extract = cli.aggregate.extract_candidates

        def mutate(*args, **kwargs):
            result = extract(*args, **kwargs)
            self.video.write_bytes(b"changed while aggregating")
            return result

        with mock.patch.object(cli.aggregate, "extract_candidates", side_effect=mutate):
            code, output = self.run_cli(SyntheticScanner("blue"), "--no-ai")
        self.assertEqual(code, 1, output)
        self.assert_old_intact()

    def test_successful_scan_publishes_separate_frame_generation_and_matching_report(self) -> None:
        self.seed_complete()
        code, output = self.run_cli(SyntheticScanner("blue"), "--no-ai")
        self.assertEqual(code, 0, output)
        current = json.loads((self.out / "ocr.json").read_text(encoding="utf-8"))
        payload = json.loads((self.out / "candidates.json").read_text(encoding="utf-8"))
        self.assertNotEqual(current["framesDirectory"], self.cache["framesDirectory"])
        self.assertEqual(payload["framesBaseDir"], current["framesDirectory"])
        new_frame = self.out / current["framesDirectory"] / current["blocks"][0]["frame"]
        self.assertNotEqual(new_frame.read_bytes(), self.old_frame_bytes)
        self.assertEqual(self.old_frame.read_bytes(), self.old_frame_bytes)
        with Image.open(new_frame) as image:
            self.assertGreater(image.getpixel((0, 0))[2], image.getpixel((0, 0))[0])
        self.assertIn(current["framesDirectory"], (self.out / "report.html").read_text(encoding="utf-8"))

    def test_publication_failure_rolls_back_all_existing_artifacts(self) -> None:
        self.seed_complete()
        replace = cli.os.replace
        failed = False

        def fail_once(source, target):
            nonlocal failed
            if Path(target) == self.out / "report.html" and not failed:
                failed = True
                raise OSError("synthetic publication failure")
            return replace(source, target)

        with mock.patch.object(cli.os, "replace", side_effect=fail_once):
            code, output = self.run_cli(SyntheticScanner("blue"), "--no-ai")
        self.assertTrue(failed, "publication failure injection was not reached")
        self.assertEqual(code, 1, output)
        self.assert_old_intact()
        self.assertFalse((self.out / cli.PUBLICATION_MARKER).exists())

    def test_publication_keyboard_interrupt_rolls_back_partial_files(self) -> None:
        self.seed_complete()
        replace = cli.os.replace
        interrupted = False

        def interrupt_once(source, target):
            nonlocal interrupted
            if Path(target) == self.out / "report.html" and not interrupted:
                interrupted = True
                raise KeyboardInterrupt
            return replace(source, target)

        with mock.patch.object(cli.os, "replace", side_effect=interrupt_once):
            code, output = self.run_cli(SyntheticScanner("blue"), "--no-ai")
        self.assertTrue(interrupted, "publication interrupt injection was not reached")
        self.assertEqual(code, 130, output)
        self.assert_old_intact()

    def test_failed_recovery_keeps_backups_and_next_invocation_recovers(self) -> None:
        self.seed_complete()
        replace = cli.os.replace
        failure_calls = 0

        def fail_publication_and_recovery(source, target):
            nonlocal failure_calls
            if Path(target) == self.out / "report.html":
                failure_calls += 1
                raise OSError("synthetic report file temporarily unavailable")
            return replace(source, target)

        with mock.patch.object(cli.os, "replace", side_effect=fail_publication_and_recovery):
            code, output = self.run_cli(SyntheticScanner("blue"), "--no-ai")
        self.assertGreaterEqual(failure_calls, 2, "publication and recovery must both reach the failure injection")
        self.assertEqual(code, 1, output)
        self.assertTrue((self.out / cli.PUBLICATION_MARKER).is_file())
        journal = cli._load_json(self.out / cli.PUBLICATION_MARKER)
        self.assertTrue((self.out / journal["stage"] / "backups" / "report.html").is_file())
        code, output = self.run_cli(mock.Mock(), "--no-ai", "--resume")
        self.assertEqual(code, 0, output)
        self.assertFalse((self.out / cli.PUBLICATION_MARKER).exists())
        self.assertEqual((self.out / "ocr.json").read_bytes(), self.old["ocr.json"])
        self.assertEqual(self.old_frame.read_bytes(), self.old_frame_bytes)

    def test_recovery_marker_restores_interrupted_publication_before_resume(self) -> None:
        self.seed_complete()
        stage = self.out / ".term-staging-test"
        backups = stage / "backups"
        backups.mkdir(parents=True)
        names = ("ocr.json", "candidates.json", "report.csv", "report.html")
        for name in names:
            shutil.copyfile(self.out / name, backups / name)
        (self.out / "ocr.json").write_text("{broken", encoding="utf-8")
        cli._write_json(self.out / cli.PUBLICATION_MARKER, {"stage": stage.name, "files": {n: True for n in names}, "committed": False})
        code, output = self.run_cli(mock.Mock(), "--no-ai", "--resume")
        self.assertEqual(code, 0, output)
        self.assertEqual((self.out / "ocr.json").read_bytes(), self.old["ocr.json"])
        self.assertEqual(self.old_frame.read_bytes(), self.old_frame_bytes)
        self.assertFalse((self.out / cli.PUBLICATION_MARKER).exists())


class ScanSummaryTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.video = Path(self.temp.name) / "synthetic.mp4"
        self.video.write_bytes(b"synthetic")
        self.out = self.video.parent / "synthetic.termextract"

    def run_cli(self, provider, *, resume: bool = False) -> tuple[int, str]:
        args = cli.build_parser().parse_args([str(self.video), "--no-ai", *( ["--resume"] if resume else [])])
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = cli.run_pipeline(args, scan_provider=provider, duration_prober=lambda _v: 20000)
        return code, output.getvalue()

    def test_nonfinite_blocks_recognized_or_unknown_nested_summary_is_not_published(self) -> None:
        for summary in ({"blocksRecognized": float("nan")}, {"blocksRecognized": float("inf")},
                        {"unknown": {"nested": [float("-inf")]}}):
            with self.subTest(summary=summary):
                code, output = self.run_cli(FakeProvider(**summary))
                self.assertEqual(code, 1, output)
                self.assertFalse((self.out / "ocr.json").exists())
                self.assertFalse((self.out / "report.html").exists())

    def test_unsafe_or_missing_generation_metadata_cannot_resume(self) -> None:
        code, output = self.run_cli(FakeProvider())
        self.assertEqual(code, 0, output)
        valid = json.loads((self.out / "ocr.json").read_text(encoding="utf-8"))
        for value in (None, "frames", "../frames", "frames/run-../../unsafe"):
            with self.subTest(value=value):
                (self.out / "ocr.json").write_text(json.dumps({**valid, "framesDirectory": value}), encoding="utf-8")
                self.assertEqual(self.run_cli(mock.Mock(), resume=True)[0], 1)
        (self.out / "ocr.json").write_text(json.dumps({**valid, "cacheVersion": 2}), encoding="utf-8")
        self.assertEqual(self.run_cli(mock.Mock(), resume=True)[0], 1)

    def test_summary_count_and_timing_relations_are_required(self) -> None:
        invalid = [
            {"framesTotal": 19}, {"framesScanned": 21}, {"framesSkippedDuplicate": 1},
            {"framesFailed": 1}, {"framesPlanned": 19}, {"framesPlanned": 21},
            {"truncated": True}, {"sampledThroughMs": 20000}, {"sampledThroughMs": 10000},
            {"blocksTotal": 5}, {"blocksRecognized": 5}, {"blocksRecognized": 3},
            {"blocksRecognized": True}, {"blocksRecognized": 4.0}, {"fps": .2}, {"durationMs": 19000},
        ]
        for summary in invalid:
            with self.subTest(summary=summary):
                code, output = self.run_cli(FakeProvider(**summary))
                self.assertEqual(code, 1, output)
                self.assertIn("[错误]", output)

    def test_nan_in_cache_is_rejected_before_replacing_valid_report(self) -> None:
        code, output = self.run_cli(FakeProvider())
        self.assertEqual(code, 0, output)
        html = (self.out / "report.html").read_bytes()
        valid = json.loads((self.out / "ocr.json").read_text(encoding="utf-8"))
        for value in (float("nan"), float("inf"), float("-inf")):
            corrupted = {**valid, "scan": {**valid["scan"], "blocksRecognized": value}}
            (self.out / "ocr.json").write_text(json.dumps(corrupted), encoding="utf-8")
            code, output = self.run_cli(mock.Mock(), resume=True)
            self.assertEqual(code, 1, output)
            self.assertEqual((self.out / "report.html").read_bytes(), html)
        content = json.dumps(valid).replace('"blocksRecognized": 4', '"blocksRecognized": 1e999')
        (self.out / "ocr.json").write_text(content, encoding="utf-8")
        self.assertEqual(self.run_cli(mock.Mock(), resume=True)[0], 1)


if __name__ == "__main__":
    unittest.main()
