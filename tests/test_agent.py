import contextlib
import copy
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import wave
from unittest.mock import Mock, patch

from maw import agent


def project():
    return {"schema": "moy.asr.project.v1", "custom": {"keep": True}, "segments": [
        {"id": "a", "start": 100, "end": 900, "text": "hello", "speaker": "Alice",
         "items": [{"start": 100, "end": 900, "text": "hello"}]},
        {"id": "b", "start": 1000, "end": 1800, "text": "world", "speaker": "Alice"},
        {"id": "c", "start": 2000, "end": 2600, "text": "outside", "speaker": "Bob"}]}


class AgentTests(unittest.TestCase):
    def test_half_open_query_and_context(self):
        rows = agent.query(project(), 900, 2000, 100)
        self.assertEqual([r["index"] for r in rows], [0, 1, 2])
        self.assertEqual([r["in_range"] for r in rows], [False, True, False])
        self.assertEqual(agent.query(project(), 900, 1000), [])
        for start, end in [(True, 500), (-1, 500), (0, 0), (1.5, 500)]:
            with self.assertRaises(agent.AgentError):
                agent.query(project(), start, end)

    def test_text_preserves_source_and_requires_stable_ids(self):
        source = project()
        before = copy.deepcopy(source)
        result = agent.text_proposal(source, [{"id": "a", "text": "Hello!"}], "punctuation")
        self.assertEqual(source, before)
        self.assertEqual(result["base"], source)
        for edits in [[{"id": "missing", "text": "x"}], [{"id": "a", "text": ""}],
                      [{"id": "a", "text": "x"}] * 2, [{"id": "a", "text": "x", "start": 2}]]:
            with self.assertRaises(agent.AgentError):
                agent.text_proposal(source, edits, "invalid")

    def test_range_boundary_outside_metadata_and_ids(self):
        source = project()
        before = copy.deepcopy(source)
        with self.assertRaisesRegex(agent.AgentError, "cuts segment"):
            agent.range_proposal(source, 1100, 1800, [], "bad boundary")
        proposal = agent.range_proposal(source, 1000, 1800,
                                       [{"start": 1000, "end": 1800, "text": "World", "speaker": "Alice"}], "correct")
        self.assertEqual(source, before)
        self.assertEqual(proposal["base"]["custom"], {"keep": True})
        self.assertTrue(proposal["operation"]["segments"][0]["id"].startswith("agent-"))
        with self.assertRaises(agent.AgentError):
            agent.range_proposal(source, 1000, 1800, [{"start": 999, "end": 1800, "text": "x"}], "bad")
        self.assertEqual(agent.range_proposal(source, 900, 1000, [], "gap")["operation"]["segments"], [])

    def test_reject_unsafe_structural_metadata(self):
        for field, value in [("disabled", True), ("color", {"name": "red"}), ("custom", "keep")]:
            source = project()
            source["segments"][1][field] = value
            with self.assertRaises(agent.AgentError):
                agent.structural_indices(source, 1000, 1800)
        source = project()
        source["timebase"] = {"unit": "frames", "fps": 30}
        with self.assertRaises(agent.AgentError):
            agent.structural_indices(source, 1000, 1800)
        source = project()
        source["multi_subtitle"] = {"tracks": [{"id": "translation"}]}
        with self.assertRaises(agent.AgentError):
            agent.structural_indices(source, 1000, 1800)

    def test_offset_clipping_and_invalid_words(self):
        original = [{"start": 0, "end": 600, "text": "word", "items": [{"start": 10, "end": 590, "text": "word"}]}]
        result = agent.offset_result(original, 1000, 1800)
        self.assertEqual((result[0]["start"], result[0]["items"][0]["end"]), (1000, 1590))
        self.assertEqual(original[0]["start"], 0)
        self.assertEqual(agent.offset_result([{"start": -5, "end": 900, "text": "coarse"}], 1000, 1800)[0]["end"], 1800)
        with self.assertRaises(agent.AgentError):
            agent.offset_result(original, 1000, 1400)
        with self.assertRaises(agent.AgentError):
            agent.offset_result([], 1000, 1800)

    @patch("maw.ffmpeg.resolve_ffmpeg_tool", return_value=Path("ffmpeg"))
    def test_retranscribe_contract_uses_clip_and_existing_pipeline(self, _resolve):
        adapter = Mock()
        adapter._get_config.return_value = {"api_key": "fixture-not-a-key"}
        adapter.transcribe.return_value = {"sentences": [{"text": "fixture"}], "split_mode": "word"}
        adapter.build_segments_from_api_sentences.return_value = [{"start": 0, "end": 800, "text": "World"}]
        source = project()
        source["media_metadata"] = {"selected_audio_track": 2}
        result = agent.transcribe_range(source, Path("explicit.wav"), 1000, 1800,
                                        model="fixture-model", context_text="explicit context", adapter=adapter)
        command = adapter._run_media_tool.call_args.args[0]
        self.assertEqual(command[command.index("-ss") + 1], "1.000")
        self.assertEqual(command[command.index("-t") + 1], "0.800")
        self.assertEqual(command[command.index("-map") + 1], "0:a:2")
        self.assertEqual(adapter.transcribe.call_args.kwargs["context_text"], "explicit context")
        self.assertNotEqual(adapter.transcribe.call_args.args[0], "explicit.wav")
        new = result["operation"]["segments"][0]
        self.assertEqual((new["start"], new["end"], new["speaker"]), (1000, 1800, "Alice"))
        with self.assertRaises(agent.AgentError):
            agent.transcribe_range(source, "explicit.wav", 1000, 2600, model="fixture", adapter=adapter)

    def invoke(self, args):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = agent.main(args)
        return code, json.loads(output.getvalue())

    def test_cli_no_cloud_without_flag_and_exclusive_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "source.mosp"
            agent.write_new(source, project())
            original = source.read_bytes()
            edits = root / "edits.json"
            agent.write_new(edits, [{"id": "b", "text": "World!"}])
            code, _ = self.invoke(["propose-text", str(source), "--edits", str(edits), "--reason", "fix", "--output", str(source)])
            self.assertEqual(code, 1)
            self.assertEqual(source.read_bytes(), original)
            args = ["retranscribe", str(source), "--media", str(source), "--start", "1000", "--end", "1800",
                    "--job", str(root / "job.json"), "--output", str(root / "proposal.json")]
            code, result = self.invoke(args)
            self.assertEqual(code, 1)
            self.assertEqual(result["error"]["code"], "cloud_not_authorized")
            self.assertFalse((root / "job.json").exists())

    def test_job_success_failure_and_existing_file_preservation(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, job, output = (root / name for name in ("source.mosp", "job.json", "proposal.json"))
            agent.write_new(source, project())
            args = ["retranscribe", str(source), "--media", str(source), "--start", "1000", "--end", "1800",
                    "--job", str(job), "--output", str(output), "--allow-cloud"]
            with patch.object(agent, "transcribe_range", side_effect=RuntimeError("SECRET signed-url")):
                code, result = self.invoke(args)
            self.assertEqual(code, 1)
            self.assertNotIn("SECRET", json.dumps(result))
            failed = job.read_bytes()
            self.assertEqual(json.loads(failed)["state"], "failed")
            with patch.object(agent, "transcribe_range") as call:
                self.assertEqual(self.invoke(args)[0], 1)
                call.assert_not_called()
            self.assertEqual(job.read_bytes(), failed)
            args[args.index("--job") + 1] = str(root / "job2.json")
            fixture = agent.range_proposal(project(), 1000, 1800, [], "fixture")
            with patch.object(agent, "transcribe_range", return_value=fixture):
                self.assertEqual(self.invoke(args)[0], 0)
            self.assertEqual(agent.read_json(root / "job2.json")["state"], "succeeded")
            self.assertEqual(agent.read_json(output), fixture)

    def test_real_ffmpeg_clip_with_fixture_provider_no_network(self):
        from maw.ffmpeg import resolve_ffmpeg_tool
        if resolve_ffmpeg_tool("ffmpeg") is None:
            self.skipTest("FFmpeg not installed")
        import generate_subtitle_qwen_api as qwen
        with tempfile.TemporaryDirectory() as tmp:
            media = Path(tmp) / "synthetic.wav"
            with wave.open(str(media), "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\x00\x00" * 48000)

            def fixture_transcribe(audio, *args, **kwargs):
                with wave.open(audio, "rb") as wav:
                    self.assertEqual(wav.getnframes(), 12800)  # exactly 800 ms
                    self.assertEqual(wav.getframerate(), 16000)
                return {"items": [{"start": 0, "end": 800, "text": "World"}], "split_mode": "word"}

            with patch.object(qwen, "_get_config", return_value={"api_key": "fixture-not-a-key"}), \
                    patch.object(qwen, "transcribe", side_effect=fixture_transcribe):
                result = agent.transcribe_range(project(), media, 1000, 1800, model="fixture", adapter=qwen)
            cue = result["operation"]["segments"][0]
            self.assertEqual((cue["start"], cue["end"], cue["speaker"]), (1000, 1800, "Alice"))

    def test_cli_unicode_output_and_invalid_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "source.mosp"
            source = project()
            source["segments"][1]["text"] = "中文测试"
            agent.write_new(path, source)
            result = subprocess.run([sys.executable, "-m", "maw.agent", "read", str(path)],
                                    capture_output=True, check=True,
                                    env={**os.environ, "PYTHONUTF8": "0", "PYTHONIOENCODING": "ascii"})
            self.assertEqual(json.loads(result.stdout.decode("utf-8"))["result"]["project"]["segments"][1]["text"], "中文测试")
            path.write_text('{"segments":[],"invalid":NaN}', encoding="utf-8")
            with self.assertRaises(agent.AgentError):
                agent.read_json(path)


if __name__ == "__main__":
    unittest.main()
