"""CLI/cache 回归：仅合成源文件与假 OCR/LLM，不读取凭据或调用网络。"""

from __future__ import annotations

import contextlib
import io
import json
import math
import os
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tools" / "term-extract"))

from tests.compact_assertions import CompactContainerAssertions  # noqa: E402
from term_extract import __main__ as cli, provider  # noqa: E402
from maw.postprocess_llm import LlmSettings  # noqa: E402
from maw.postprocess_ocr import OcrRegion  # noqa: E402
from maw.ocr_runtime import OcrRuntimeCancelled  # noqa: E402


def blocks() -> list[dict[str, object]]:
    return [{"text": "前往星核", "score": 0.95, "box": [0, 0, 100, 30], "tMs": t, "frame": None}
            for t in (0, 5000, 10000, 15000)]


class FakeProvider:
    def __init__(self, rows: list[dict[str, object]] | None = None, **summary: object):
        self.rows = blocks() if rows is None else rows
        self.calls: list[dict[str, object]] = []
        self.summary = summary

    def scan(self, video: Path, **kwargs: object) -> dict[str, object]:
        self.calls.append(kwargs)
        planned = math.ceil(kwargs["duration_ms"] * kwargs["fps"] / 1000)
        total = min(planned, kwargs["max_frames"])
        return {"framesTotal": total, "framesScanned": total, "framesSkippedDuplicate": 0,
                "framesFailed": 0, "blocksTotal": len(self.rows), "blocksRecognized": len(self.rows),
                "framesPlanned": planned, "truncated": planned > total,
                "sampledThroughMs": round((total - 1) * 1000 / kwargs["fps"]),
                "fps": kwargs["fps"], "durationMs": kwargs["duration_ms"], **self.summary, "blocks": self.rows}


class CliCacheTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.video = Path(self.temp.name) / "synthetic.mp4"
        self.video.write_bytes(b"not real media")
        self.out = Path(self.temp.name) / "out"
        self.out.mkdir()

    def args(self, *options: str):
        return cli.build_parser().parse_args([str(self.video), "--out", str(self.out), *options])

    def run_cli(self, *options: str, scan: object = None, **kwargs: object) -> tuple[int, str]:
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            code = cli.run_pipeline(self.args(*options), scan_provider=scan or FakeProvider(),
                                    duration_prober=lambda _v: 20_000, **kwargs)
        return code, output.getvalue()

    def payload(self, name: str = "candidates.json") -> dict:
        return json.loads((self.out / name).read_text(encoding="utf-8"))

    def fresh(self, *options: str) -> None:
        code, diagnostic = self.run_cli("--no-ai", "--fps", "0.2", "--model", "small", "--region", "bottom30", *options)
        self.assertEqual(code, 0, diagnostic)

    def test_max_frames_and_cancellation_reach_provider(self) -> None:
        rows = [{"text": "前往星核", "score": .95, "box": [0, 0, 100, 30], "tMs": t, "frame": None} for t in (0, 1000, 2000)]
        fake = FakeProvider(rows, framesScanned=6, framesFailed=1)
        cancel = Event()
        code, output = self.run_cli("--no-ai", "--max-frames", "7", scan=fake, cancel_event=cancel)
        self.assertEqual(code, 0, output)
        self.assertEqual(fake.calls[0]["max_frames"], 7)
        self.assertIs(fake.calls[0]["cancel_event"], cancel)
        self.assertTrue(self.payload()["scan"]["truncated"])
        self.assertIn("截断", output)
        self.assertIn("失败", output)

    def test_resume_uses_stored_fps_model_region_and_continuous_events(self) -> None:
        self.fresh()
        before = self.payload()
        fake = FakeProvider()
        code, output = self.run_cli("--no-ai", "--resume", scan=fake)
        self.assertEqual(code, 0, output)
        self.assertEqual(fake.calls, [])
        after = self.payload()
        self.assertEqual(after["fps"], 0.2)
        self.assertEqual(after["model"], "small")
        self.assertEqual(after["region"], {"mode": "bottom30", "x1": 0., "y1": .7, "x2": 1., "y2": 1.})
        self.assertEqual([(c["word"], c["eventCount"]) for c in after["candidates"]],
                         [(c["word"], c["eventCount"]) for c in before["candidates"]])
        self.assertEqual(next(c["eventCount"] for c in after["candidates"] if c["word"] == "星核"), 1)

    def test_resume_rejects_explicit_scan_parameter_conflicts(self) -> None:
        self.fresh()
        for option in (("--fps", "1"), ("--model", "tiny"), ("--region", "full"), ("--max-frames", "3")):
            with self.subTest(option=option):
                code, output = self.run_cli("--no-ai", "--resume", *option)
                self.assertEqual(code, 1)
                self.assertIn("冲突", output)

    def test_resume_rejects_changed_or_different_video(self) -> None:
        self.fresh()
        original = self.video
        other = original.with_name("other.mp4")
        other.write_bytes(b"not real media")
        self.video = other
        code, output = self.run_cli("--no-ai", "--resume")
        self.assertEqual(code, 1)
        self.assertIn("身份不匹配", output)
        self.video = original
        original.write_bytes(b"changed synthetic contents")
        code, output = self.run_cli("--no-ai", "--resume")
        self.assertEqual(code, 1)
        self.assertIn("身份不匹配", output)

    def test_resume_rejects_mtime_change_without_size_change(self) -> None:
        self.fresh()
        stat = self.video.stat()
        os.utime(self.video, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
        code, output = self.run_cli("--no-ai", "--resume")
        self.assertEqual(code, 1)
        self.assertIn("身份不匹配", output)

    def test_matching_explicit_scan_parameters_are_accepted_on_resume(self) -> None:
        self.fresh()
        code, output = self.run_cli("--no-ai", "--resume", "--fps", "0.2", "--model", "small", "--region", "bottom30")
        self.assertEqual(code, 0, output)

    def test_legacy_cache_is_rejected_not_silently_migrated(self) -> None:
        self.fresh()
        payload = self.payload("ocr.json")
        del payload["source"]
        (self.out / "ocr.json").write_text(json.dumps(payload), encoding="utf-8")
        code, output = self.run_cli("--no-ai", "--resume")
        self.assertEqual(code, 1)
        self.assertIn("重新扫描", output)

    def test_resume_rejects_invalid_source_or_scan_metadata(self) -> None:
        self.fresh()
        valid = self.payload("ocr.json")
        mutations = [
            {"source": {**valid["source"], "size": str(valid["source"]["size"])}},
            {"scan": {**valid["scan"], "fps": 1.}},
            {"scan": {**valid["scan"], "sampledThroughMs": 20000}},
            {"region": {"mode": "bottom30", "x1": 0., "y1": 0., "x2": 1., "y2": 1.}},
        ]
        for fields in mutations:
            with self.subTest(fields=fields):
                (self.out / "ocr.json").write_text(json.dumps({**valid, **fields}), encoding="utf-8")
                code, output = self.run_cli("--no-ai", "--resume")
                self.assertEqual(code, 1)
                self.assertIn("[错误]", output)

    def test_malformed_cache_has_friendly_nonzero_exit(self) -> None:
        self.fresh()
        valid = self.payload("ocr.json")
        bad_payloads = ["{", "[]"]
        for field, value in (("blocks", {}), ("durationMs", "20000"), ("region", {}), ("fps", float("nan"))):
            bad_payloads.append(json.dumps({**valid, field: value}))
        for timestamp in (-1, 20000, 1.5, True):
            bad_payloads.append(json.dumps({**valid, "blocks": [{**valid["blocks"][0], "tMs": timestamp}]}))
        for content in bad_payloads:
            with self.subTest(content=content[:70]):
                (self.out / "ocr.json").write_text(content, encoding="utf-8")
                code, output = self.run_cli("--no-ai", "--resume")
                self.assertEqual(code, 1)
                self.assertIn("[错误]", output)
                self.assertNotIn("Traceback", output)

    def test_nonpositive_max_frames_fails_before_provider(self) -> None:
        for value in ("0", "-2"):
            fake = FakeProvider()
            code, output = self.run_cli("--no-ai", "--max-frames", value, scan=fake)
            self.assertEqual(code, 1)
            self.assertEqual(fake.calls, [])

    def test_missing_resume_cache_falls_back_to_fresh_defaults(self) -> None:
        fake = FakeProvider()
        code, output = self.run_cli("--no-ai", "--resume", scan=fake)
        self.assertEqual(code, 0, output)
        self.assertEqual(fake.calls[0]["fps"], 1.)
        self.assertEqual(fake.calls[0]["model"], "tiny")
        cache = self.payload("ocr.json")
        self.assertEqual(cache["source"]["name"], self.video.name)
        self.assertEqual(cache["source"]["size"], self.video.stat().st_size)
        self.assertEqual(cache["source"]["mtimeNs"], self.video.stat().st_mtime_ns)
        self.assertEqual(cache["maxFrames"], 20000)

    def test_empty_recommendations_clear_stale_hotwords(self) -> None:
        (self.out / "hotwords.txt").write_text("stale\n", encoding="utf-8")
        code, output = self.run_cli("--no-ai", scan=FakeProvider([]))
        self.assertEqual(code, 0, output)
        self.assertEqual((self.out / "hotwords.txt").read_text(encoding="utf-8"), "")

    def test_scan_failure_is_nonzero_and_clears_previous_hotwords(self) -> None:
        (self.out / "hotwords.txt").write_text("stale\n", encoding="utf-8")
        fake = mock.Mock()
        fake.scan.side_effect = ValueError("all frames failed")
        code, output = self.run_cli("--no-ai", scan=fake)
        self.assertEqual(code, 1)
        self.assertIn("[错误]", output)
        self.assertEqual((self.out / "hotwords.txt").read_text(encoding="utf-8"), "")
        code, _ = self.run_cli("--no-ai", scan=FakeProvider([], framesScanned=0, framesFailed=20))
        self.assertEqual(code, 1)

    def test_scan_runtime_cancellation_is_reported_as_cancelled(self) -> None:
        fake = mock.Mock()
        fake.scan.side_effect = OcrRuntimeCancelled("cancelled")
        code, output = self.run_cli("--no-ai", scan=fake)
        self.assertEqual(code, 130)
        self.assertIn("[中断]", output)
        self.assertEqual((self.out / "hotwords.txt").read_text(encoding="utf-8"), "")

    def test_ai_reject_removes_rule_recommendation_and_keeps_manual_candidate(self) -> None:
        scored = [{"word": "星核", "score": 90, "recommended": True}, {"word": "真希", "score": 80, "recommended": True}]
        settings = LlmSettings(provider_id="custom", api_key="fake-key", base_url="http://127.0.0.1:9", model="fake")
        verdicts = {"星核": {"verdict": "reject", "type": "非术语", "reason": "not a name"},
                    "真希": {"verdict": "keep", "type": "人物", "reason": "name"}}
        with mock.patch.object(cli.score, "apply_scoring", return_value=scored), \
             mock.patch.object(cli.ai_filter, "build_settings", return_value=settings), \
             mock.patch.object(cli.ai_filter, "filter_candidates", return_value=verdicts):
            code, output = self.run_cli("--weight-by-score")
        self.assertEqual(code, 0, output)
        payload = self.payload()
        self.assertFalse(payload["candidates"][0]["recommended"])
        self.assertEqual((self.out / "hotwords.txt").read_text(encoding="utf-8"), "真希: 5\n")
        self.assertEqual(payload["aiStatus"], "complete")
        self.assertTrue(payload["weightByScore"])
        self.assertTrue(payload["candidates"][0]["ruleRecommended"])

    def test_ai_failure_persists_current_candidates_before_call_and_sanitizes_error(self) -> None:
        (self.out / "hotwords.txt").write_text("stale\n", encoding="utf-8")
        (self.out / "candidates.json").write_text('{"stale":true}', encoding="utf-8")
        settings = LlmSettings(provider_id="custom", api_key="fake-secret", base_url="http://127.0.0.1:9", model="fake")

        def fail(_candidates, _settings):
            pending = self.payload()
            self.assertNotIn("stale", pending)
            self.assertEqual(pending["aiStatus"], "pending")
            self.assertFalse(pending["aiEnabled"])
            self.assertEqual((self.out / "hotwords.txt").read_text(encoding="utf-8"), "")
            raise RuntimeError(r"fake-secret failed in C:\Users\test\private.txt at http://127.0.0.1:9")

        with mock.patch.object(cli.ai_filter, "build_settings", return_value=settings), \
             mock.patch.object(cli.ai_filter, "filter_candidates", side_effect=fail):
            code, output = self.run_cli()
        self.assertEqual(code, 2, output)
        self.assertEqual((self.out / "hotwords.txt").read_text(encoding="utf-8"), "")
        self.assertNotIn("stale", self.payload())
        self.assertEqual(self.payload()["aiStatus"], "failed")
        failure = (self.out / "ai-failure-record.md").read_text(encoding="utf-8")
        self.assertNotIn("fake-secret", failure)
        self.assertNotIn("C:\\Users", failure)
        self.assertNotIn("127.0.0.1:9", failure)
        self.assertIn("仅含规则评分", failure)

    def test_ai_settings_error_also_records_rule_only_failure(self) -> None:
        with mock.patch.object(cli.ai_filter, "build_settings", side_effect=ValueError("missing key")):
            code, output = self.run_cli()
        self.assertEqual(code, 2, output)
        self.assertEqual(self.payload()["aiStatus"], "failed")
        self.assertFalse(self.payload()["aiEnabled"])
        self.assertTrue((self.out / "ai-failure-record.md").is_file())

    def test_missing_ai_verdict_is_failure_not_silent_recommendation(self) -> None:
        settings = LlmSettings(provider_id="custom", api_key="fake-key", base_url="http://127.0.0.1:9", model="fake")
        with mock.patch.object(cli.score, "apply_scoring", return_value=[{"word": "term", "score": 90, "recommended": True}]), \
             mock.patch.object(cli.ai_filter, "build_settings", return_value=settings), \
             mock.patch.object(cli.ai_filter, "filter_candidates", return_value={}):
            code, output = self.run_cli()
        self.assertEqual(code, 2, output)
        self.assertEqual(self.payload()["aiStatus"], "failed")
        self.assertEqual((self.out / "hotwords.txt").read_text(encoding="utf-8"), "")


class ProviderProtocolTests(unittest.TestCase):
    def test_runtime_provider_forwards_frame_limit_and_cancel_event(self) -> None:
        cancel = Event()
        with mock.patch.object(provider, "resolve_ffmpeg_tool", return_value="ffmpeg"), \
             mock.patch.object(provider, "run_ocr_scan_in_runtime", return_value={}) as run:
            provider.RuntimeScanProvider().scan(Path("synthetic.mp4"), duration_ms=1000, fps=1,
                                               region=OcrRegion(), model="small", frames_dir=Path("frames"),
                                               max_frames=7, cancel_event=cancel)
        self.assertEqual(run.call_args.kwargs["max_frames"], 7)
        self.assertIs(run.call_args.kwargs["cancel_event"], cancel)

    def test_local_provider_forwards_frame_limit_and_cancel_event(self) -> None:
        cancel = Event()
        with mock.patch.object(provider, "resolve_ffmpeg_tool", return_value="ffmpeg"), \
             mock.patch("maw.postprocess_ocr._RapidOcrRecognizer") as recognizer, \
             mock.patch("maw.ocr_scan.run_ocr_scan", return_value={}) as run:
            provider.LocalScanProvider().scan(Path("synthetic.mp4"), duration_ms=1000, fps=1,
                                             region=OcrRegion(), model="small", frames_dir=Path("frames"),
                                             max_frames=7, cancel_event=cancel)
        self.assertEqual(run.call_args.args[0].max_frames, 7)
        cancel.set()
        with self.assertRaises(KeyboardInterrupt):
            run.call_args.kwargs["on_status"]("ocr_scan_frame", {"current": 1, "total": 7})


if __name__ == "__main__":
    unittest.main()
