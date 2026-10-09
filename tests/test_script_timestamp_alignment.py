import io
import json
import math
import shutil
import tempfile
import unittest
import wave
from array import array
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from maw.script_timestamp_alignment import (
    ScriptAlignmentRequest, ScriptAnchor, plan_script_anchors, read_anchors,
    check_script_alignment, read_script_lines, run_script_alignment, speech_ranges, tokens_to_script_segments,
)
from maw.timestamp_alignment import TimedToken, TimestampAlignmentError


class ScriptTimestampTests(unittest.TestCase):
    def test_script_bom_blank_lines_and_punctuation(self):
        with tempfile.TemporaryDirectory() as directory:
            script = Path(directory) / "script.txt"
            script.write_text("\ufeff你好，世界！\n\n Hello world. \n", encoding="utf-8")
            self.assertEqual(read_script_lines(script), ["你好，世界！", "Hello world."])
            script.write_text("！\n", encoding="utf-8")
            with self.assertRaisesRegex(TimestampAlignmentError, "没有可对齐"):
                read_script_lines(script)

    def test_exact_text_restoration_and_absolute_offset(self):
        segments = tokens_to_script_segments(
            ["你好，世界！", "Hello world."],
            [TimedToken("你", 80, 160), TimedToken("好", 160, 240),
             TimedToken("世", 400, 480), TimedToken("界", 480, 560),
             TimedToken("Hello", 800, 1200), TimedToken("world", 1280, 1680)],
            600_000, 602_000,
        )
        self.assertEqual([cue["text"] for cue in segments], ["你好，世界！", "Hello world."])
        self.assertEqual(["".join(item["text"] for item in cue["items"]) for cue in segments], [cue["text"] for cue in segments])
        self.assertEqual(segments[1]["items"][0], {"text": "Hello", "start": 600800, "end": 601200})
        self.assertEqual(segments[1]["items"][1]["text"], " world.")

    def test_token_crossing_line_is_split_within_its_actual_range(self):
        result = tokens_to_script_segments(["你", "好"], [TimedToken("你好", 80, 240)], 0, 500)
        self.assertEqual([(cue["start"], cue["end"]) for cue in result], [(80, 160), (160, 240)])

    def test_composed_tokens_restore_original_combining_characters(self):
        for original, token in (("cafe\u0301!", "café"), ("か\u3099。", "が"), ("\u1100\u1161!", "가")):
            with self.subTest(original=original):
                cue = tokens_to_script_segments([original], [TimedToken(token, 50, 500)], 1000, 2000)[0]
                self.assertEqual(cue["text"], original)
                self.assertEqual(cue["items"], [{"text": original, "start": 1050, "end": 1500}])
        cue = tokens_to_script_segments(["cafe\u0301 bon."], [TimedToken("café", 0, 300), TimedToken("bon", 400, 800)], 0, 1000)[0]
        self.assertEqual([item["text"] for item in cue["items"]], ["cafe\u0301", " bon."])

    def test_invalid_timings_and_incomplete_text_are_rejected(self):
        for tokens in (
            [TimedToken("你", 0, 80)], [TimedToken("你好", 0, 0)],
            [TimedToken("你", 80, 160), TimedToken("好", 100, 200)],
            [TimedToken("你好", 0, 2001)], [TimedToken("好你", 0, 100)],
        ):
            with self.subTest(tokens=tokens), self.assertRaises(TimestampAlignmentError):
                tokens_to_script_segments(["你好"], tokens, 0, 2000)

    def test_silence_parsing_keeps_real_offsets(self):
        log = "silence_start: 0\nsilence_end: 1.5\nsilence_start: 3\nsilence_end: 4\nsilence_start: 5"
        self.assertEqual(speech_ranges(log, 6000), [(1500, 3000), (4000, 5000)])
        self.assertEqual(speech_ranges("", 6000), [(0, 6000)])
        self.assertEqual(speech_ranges("silence_start: 0", 6000), [])

    def test_five_minutes_uses_single_whole_audio_call(self):
        strategy, anchors = plan_script_anchors(["你好", "世界"], 300000, [(0, 1000), (2000, 300000)])
        self.assertEqual(strategy, "single")
        self.assertEqual(anchors, [ScriptAnchor(0, 2, 0, 300000)])

    def test_long_audio_chunks_use_absolute_acoustic_anchors(self):
        spans = [(i * 20000 + 1000, i * 20000 + 10000) for i in range(33)]
        strategy, anchors = plan_script_anchors(["你好"] * 33, 660000, spans)
        self.assertEqual(strategy, "silence_anchors")
        self.assertEqual(len(anchors), 3)
        self.assertEqual(anchors[-1].end, spans[-1][1])
        self.assertTrue(all(anchor.end - anchor.start <= 300000 for anchor in anchors))
        self.assertTrue(all(anchor.start == spans[anchor.first_line][0] for anchor in anchors))

    def test_count_mismatch_long_unbroken_audio_and_silence_fail(self):
        for lines, duration, spans in (
            (["你好"] * 2, 660000, [(0, 10000)]),
            (["你好"], 660000, [(0, 660000)]),
            (["你好"], 660000, []),
        ):
            with self.subTest(duration=duration), self.assertRaises(TimestampAlignmentError):
                plan_script_anchors(lines, duration, spans)

    def test_short_and_manual_modes_do_not_require_silence_spans(self):
        self.assertEqual(plan_script_anchors(["你好"], 1000, [])[0], "single")
        anchors = [ScriptAnchor(0, 1, 1000, 2000)]
        self.assertEqual(plan_script_anchors(["你好"], 660000, [], anchors), ("manual_anchors", anchors))

    def test_manual_anchors_require_full_ordered_nonoverlapping_coverage(self):
        anchors = [ScriptAnchor(0, 2, 1000, 200000), ScriptAnchor(2, 3, 500000, 600000)]
        self.assertEqual(plan_script_anchors(["a", "b", "c"], 660000, [(0, 660000)], anchors), ("manual_anchors", anchors))
        for bad in (
            anchors[:1], [ScriptAnchor(0, 3, 0, 660000)],
            [ScriptAnchor(0, 1, 0, 1000), ScriptAnchor(1, 3, 500, 2000)],
            [ScriptAnchor(1, 3, 0, 1000)], [ScriptAnchor(0, 3, False, 1000)],
        ):
            with self.subTest(bad=bad), self.assertRaises(TimestampAlignmentError):
                plan_script_anchors(["a", "b", "c"], 660000, [(0, 660000)], bad)

    def test_manual_anchor_file_uses_one_based_nonempty_line_numbers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "anchors.json"
            path.write_text('[{"first_line":1,"last_line":2,"start":800,"end":1500}]', encoding="utf-8")
            self.assertEqual(read_anchors(path), [ScriptAnchor(0, 2, 800, 1500)])
            path.write_text('[{"first_line":true,"last_line":2,"start":800,"end":1500}]', encoding="utf-8")
            with self.assertRaises(TimestampAlignmentError):
                read_anchors(path)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg unavailable")
    def test_real_audio_pipeline_writes_loadable_artifacts_without_asr(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "tone.wav"
            script = root / "script.txt"
            script.write_text("你好！\n世界。\n", encoding="utf-8")
            samples = array("h", (round(6000 * math.sin(i * 0.1)) for i in range(32000)))
            with wave.open(str(media), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(samples.tobytes())
            backend = mock.Mock()
            backend.align.return_value = [TimedToken("你", 0, 400), TimedToken("好", 400, 800), TimedToken("世", 1000, 1400), TimedToken("界", 1400, 1800)]
            with mock.patch("maw.local_asr.create_local_engine", side_effect=AssertionError("ASR must not run")):
                artifact, report = run_script_alignment(ScriptAlignmentRequest(script, media), backend=backend)
                second, _ = run_script_alignment(ScriptAlignmentRequest(script, media), backend=backend)
            self.assertEqual(report.strategy, "single")
            self.assertEqual(backend.align.call_count, 2)
            self.assertNotEqual(second.project_path, artifact.project_path)
            from maw.postprocess_io import read_project, read_srt

            project = read_project(artifact.project_path)
            srt = read_srt(artifact.srt_path)
            self.assertEqual([cue["text"] for cue in srt["segments"]], ["你好！", "世界。"])
            self.assertEqual(project["segments"][1]["items"][0]["start"], 1000)
            self.assertEqual(project["media"], str(media.resolve()))
            self.assertEqual(project["media_metadata"]["selected_audio_track"], 0)
            self.assertTrue(project["preserve_punctuation"])
            self.assertTrue(report.warnings)
            self.assertIsNone(artifact.source_srt_path)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg unavailable")
    def test_low_volume_and_nfd_input_align_without_silence_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media, script, anchors = root / "quiet.wav", root / "script.txt", root / "anchors.json"
            script.write_text("cafe\u0301!", encoding="utf-8")
            anchors.write_text('[{"first_line":1,"last_line":1,"start":0,"end":1000}]', encoding="utf-8")
            with wave.open(str(media), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(array("h", (round(8 * math.sin(i * 0.1)) for i in range(16000))).tobytes())
            backend = mock.Mock()
            backend.align.return_value = [TimedToken("café", 50, 900)]
            for manual in (None, anchors):
                with self.subTest(manual=manual):
                    artifact, _ = run_script_alignment(ScriptAlignmentRequest(script, media, language="fr", anchors_path=manual), backend=backend)
                    self.assertEqual(backend.align.call_args.args[1], "café!")
                    self.assertEqual(json.loads(artifact.project_path.read_text())["segments"][0]["text"], "cafe\u0301!")
            with wave.open(str(media), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(bytes(32000))
            with self.assertRaisesRegex(TimestampAlignmentError, "全零"):
                run_script_alignment(ScriptAlignmentRequest(script, media), backend=backend)
            self.assertEqual(backend.align.call_count, 2)

    def test_cli_dispatch_never_calls_transcription(self):
        from maw import cli
        from maw.script_timestamp_alignment import ScriptAlignmentReport

        artifact = SimpleNamespace(project_path=Path("out.mosp"), srt_path=Path("out.srt"))
        with mock.patch("maw.local_runtime.managed_runtime_status", return_value=SimpleNamespace(ready=False)), mock.patch("maw.script_timestamp_alignment.run_script_alignment", return_value=(artifact, ScriptAlignmentReport("single", 1000, 1, 1, ()))) as align, mock.patch("maw.cli._run_transcription", side_effect=AssertionError("ASR")):
            self.assertEqual(cli.main(["--align-script", "script.txt", "-i", "audio.wav"]), 0)
        self.assertEqual(align.call_args.args[0].script_path, Path("script.txt"))
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli.main(["--align-script", "script.txt", "-i", "audio.wav", "--server"])

    def test_cli_check_bypasses_model_runtime_and_outputs_plan_json(self):
        from maw import cli
        from maw.script_timestamp_alignment import ScriptAlignmentReport

        report = ScriptAlignmentReport("single", 1000, 1, 1, ())
        output = io.StringIO()
        with mock.patch("maw.script_timestamp_alignment.check_script_alignment", return_value=report), mock.patch("maw.local_runtime.managed_runtime_status", side_effect=AssertionError("model runtime must not be checked")), redirect_stdout(output):
            self.assertEqual(cli.main(["--align-script", "script.txt", "-i", "audio.wav", "--alignment-check"]), 0)
        self.assertEqual(json.loads(output.getvalue())["scriptLines"], 1)
        with redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
            cli.main(["--alignment-check", "-i", "audio.wav"])

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg unavailable")
    def test_real_preflight_never_loads_model_or_writes_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script, media = root / "script.txt", root / "audio.wav"
            script.write_text("你好。", encoding="utf-8")
            with wave.open(str(media), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                wav.writeframes(array("h", (round(6000 * math.sin(i * 0.1)) for i in range(16000))).tobytes())
            with mock.patch("maw.script_timestamp_alignment.QwenForcedAlignerBackend", side_effect=AssertionError("must not load model")):
                report = check_script_alignment(ScriptAlignmentRequest(script, media))
            self.assertEqual(report.to_payload()["anchors"], [{"first_line": 1, "last_line": 1, "start": 0, "end": 1000}])
            self.assertEqual(sorted(path.name for path in root.iterdir()), ["audio.wav", "script.txt"])

    def test_gui_check_works_without_model_configuration(self):
        from maw.gui_web import LauncherApi, LauncherPaths
        from maw.script_timestamp_alignment import ScriptAlignmentReport

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            api = LauncherApi(paths=LauncherPaths(root=root, env_path=root / "unused-config", launcher_html=root / "launcher.html"), window_getter=lambda: None)
            with mock.patch("maw.script_timestamp_alignment.check_script_alignment", return_value=ScriptAlignmentReport("manual_anchors", 1000, 1, 2, ())) as check, mock.patch.object(api, "_local_runtime_status", side_effect=AssertionError("no model runtime")):
                result = api.check_script_alignment({"scriptPath": "script.txt", "mediaPath": "audio.wav", "audioTrack": "1"})
            self.assertTrue(result["ok"])
            self.assertEqual(check.call_args.args[0].audio_track, 1)

    def test_runtime_worker_script_command_is_independent_of_project(self):
        from maw.local_runtime_worker import build_parser

        args = build_parser().parse_args(["script-align", "--model-id", "qwen", "--script-path", "script.txt", "--media-path", "audio.wav"])
        self.assertEqual(args.command, "script-align")
        self.assertEqual(args.project_path, "")

    def test_gui_script_branch_runs_without_existing_subtitle(self):
        from maw.gui_web import LauncherApi, LauncherPaths

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            api = LauncherApi(paths=LauncherPaths(root=root, env_path=root / "unused-config", launcher_html=root / "launcher.html"), window_getter=lambda: None)
            with mock.patch.object(api, "_local_runtime_status", return_value=SimpleNamespace(ready=True, python_path="python")), mock.patch("maw.gui_web.effective_config", return_value=SimpleNamespace(model_cache_root="")), mock.patch("maw.gui_web.inspect_alignment_model", return_value=SimpleNamespace(status="ready", installed=True)), mock.patch("maw.gui_web.run_timestamp_alignment_in_runtime", return_value={"artifact": {"projectPath": "out.mosp", "srtPath": "out.srt"}, "report": {"strategy": "single"}}) as worker:
                result = api.run_timestamp_alignment({"alignmentMode": "script", "modelId": "qwen", "scriptPath": "script.txt", "mediaPath": "audio.wav", "audioTrack": "1", "outputDirectory": "output"})
            self.assertTrue(result["ok"])
            self.assertIsNone(worker.call_args.kwargs["project_path"])
            self.assertEqual(worker.call_args.kwargs["script_path"], Path("script.txt"))
            self.assertEqual(worker.call_args.kwargs["audio_track"], 1)
            self.assertEqual(worker.call_args.kwargs["output_directory"], Path("output"))

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg unavailable")
    def test_eleven_minute_real_audio_preserves_acoustic_offsets(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "long.wav"
            script = root / "long.txt"
            script.write_text("你好。\n" * 33, encoding="utf-8")
            tone = array("h", (round(6000 * math.sin(i * 0.1)) for i in range(32000))).tobytes()
            silence = bytes(18 * 16000 * 2)
            with wave.open(str(media), "wb") as wav:
                wav.setparams((1, 2, 16000, 0, "NONE", "not compressed"))
                for _ in range(33):
                    wav.writeframes(tone + silence)

            class Backend:
                calls = 0

                def align(self, audio_path, text, *, language=None):
                    self.calls += 1
                    with wave.open(str(audio_path), "rb") as wav:
                        self.assert_duration = wav.getnframes() / wav.getframerate()
                    if self.assert_duration > 300:
                        raise AssertionError("model input exceeds 300 seconds")
                    return [token for index, _ in enumerate(text.splitlines()) for token in (
                        TimedToken("你", index * 20000 + 100, index * 20000 + 800),
                        TimedToken("好", index * 20000 + 800, index * 20000 + 1600),
                    )]

            backend = Backend()
            with mock.patch("maw.script_timestamp_alignment.QwenForcedAlignerBackend", side_effect=AssertionError("no model in check")):
                plan = check_script_alignment(ScriptAlignmentRequest(script, media))
            self.assertEqual(plan.to_payload()["anchors"][-1]["last_line"], 33)
            artifact, report = run_script_alignment(ScriptAlignmentRequest(script, media), backend=backend)
            project = json.loads(artifact.project_path.read_text(encoding="utf-8"))
            self.assertEqual(report.duration_ms, 660000)
            self.assertEqual(report.strategy, "silence_anchors")
            self.assertEqual(plan.to_payload(), report.to_payload())
            self.assertEqual(backend.calls, 3)
            self.assertEqual([cue["start"] for cue in project["segments"]], [index * 20000 + 100 for index in range(33)])

    def test_failure_does_not_write_partial_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / "script.txt"
            media = root / "audio.wav"
            script.write_text("你好", encoding="utf-8")
            media.touch()
            with mock.patch("maw.script_timestamp_alignment._run_ffmpeg") as process, mock.patch("maw.script_timestamp_alignment.wave.open") as wav:
                wav.return_value.__enter__.return_value.getnframes.return_value = 16000
                wav.return_value.__enter__.return_value.getframerate.return_value = 16000
                wav.return_value.__enter__.return_value.readframes.side_effect = [b"\x01\x00", b""]
                process.return_value.stderr = ""
                backend = mock.Mock()
                backend.align.return_value = [TimedToken("你", 0, 500)]
                with self.assertRaises(TimestampAlignmentError):
                    run_script_alignment(ScriptAlignmentRequest(script, media, audio_track=0), backend=backend)
            self.assertEqual(sorted(path.name for path in root.iterdir()), ["audio.wav", "script.txt"])


if __name__ == "__main__":
    unittest.main()
