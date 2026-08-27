from __future__ import annotations

import importlib.util
import json
import sys
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
SERVER_PATH = ROOT / "server-align" / "serve.py"
SPEC = importlib.util.spec_from_file_location("maw_server_align_serve", SERVER_PATH)
assert SPEC and SPEC.loader
SERVER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = SERVER
SPEC.loader.exec_module(SERVER)


class ServerAlignTests(unittest.TestCase):
    def test_rendered_page_inlines_gap_core_and_playback_contract(self) -> None:
        page = SERVER.render_page().decode("utf-8")
        self.assertNotIn("/* __GAP_REMOVE_CORE_JS__ */", page)
        self.assertIn("global.AsrGapRemoveCore = Object.freeze({", page)
        self.assertIn("function visibleGapEntries()", page)
        self.assertIn("const source = Array.isArray(gapRemoveConfig?.gaps)", page)
        self.assertIn("const GAP_DISPLAY_LABELS = Object.freeze({", page)
        self.assertIn("静音空隙（自动生成+手动调整）", page)
        self.assertIn("classes.push('protected')", page)
        self.assertIn("if (gap.removed === false) classes.push('restored');", page)
        self.assertIn("const stateText = gap.removed === false ? '空隙（未激活）' : '空隙';", page)
        self.assertIn("function commitGapProvenance(nextProvenance, message = '')", page)
        self.assertIn("const moveGapRemoveProvenance = GAP_REMOVE_CORE.moveGapRemoveProvenance;", page)
        self.assertIn("moveGapRemoveProvenance(\n", page)
        self.assertIn("resizeGapRemoveProvenanceBoundary(\n", page)
        self.assertIn("removeGapRemoveProvenanceRange(", page)
        self.assertIn("appendGapEntries(root, visibleGapEntries());", page)
        self.assertIn("const gap = Number.isInteger(index) ? visibleGapEntries()[index] : null;", page)
        self.assertIn("isPlaying: !player.paused", page)
        self.assertNotIn("isPreviewingGap(gap, now)", page)

    def test_preview_and_export_return_mawe_project(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            project_path = root / "source.mosp"
            script_path = root / "script.txt"
            project_path.write_text(json.dumps({
                "media": "",
                "segments": [
                    {"id": "s1", "start": 0, "end": 500, "text": "hello", "items": []},
                    {"id": "s2", "start": 500, "end": 1000, "text": "world", "items": []},
                    {"id": "s3", "start": 1200, "end": 1700, "text": "hello", "items": []},
                    {"id": "s4", "start": 1700, "end": 2200, "text": "world", "items": []},
                ],
            }), encoding="utf-8")
            script_path.write_text("hello world\n", encoding="utf-8")
            state = SERVER.load_state(project_path, script_path, None)

            with SERVER.AlignmentServer(("127.0.0.1", 0), state) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{server.server_address[1]}"
                with urlopen(f"{base}/api/state") as response:
                    state_payload = json.loads(response.read())
                self.assertIn("alignment", state_payload)

                selected = state.alignment["defaultSelection"]
                body = json.dumps({
                    "selectedByLine": selected,
                    "candidateActions": {},
                    "extraActions": {},
                }).encode("utf-8")
                request = Request(
                    f"{base}/api/export",
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request) as response:
                    exported = json.loads(response.read())
                server.shutdown()

            self.assertTrue(exported["ok"])
            output = json.loads(Path(exported["path"]).read_text(encoding="utf-8"))
            self.assertEqual(output["gap_remove"]["schema"], "moy.asr.gap_remove.v1")
            self.assertTrue(output["gap_remove"]["skip_playback"])
            self.assertEqual(output["gap_remove"]["operation_mode"], "boundary_drag")
            self.assertIn("script_alignment", output)
            self.assertTrue(any(segment.get("disabled") is True for segment in output["segments"]))
            reloaded = SERVER.read_project(Path(exported["path"]))
            self.assertEqual(reloaded["script_alignment"]["schema"], "moy.asr.script_alignment.v1")

    def test_preview_accepts_manual_incomplete_candidate_enable(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            project_path = root / "source.mosp"
            script_path = root / "script.txt"
            project_path.write_text(json.dumps({
                "media": "",
                "segments": [
                    {"id": "s1", "start": 0, "end": 500, "text": "hello", "items": []},
                ],
            }), encoding="utf-8")
            script_path.write_text("hello world\n", encoding="utf-8")
            state = SERVER.load_state(project_path, script_path, None)
            candidate = state.alignment["candidatesByLine"][0][0]

            with SERVER.AlignmentServer(("127.0.0.1", 0), state) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{server.server_address[1]}"
                body = json.dumps({
                    "selectedByLine": state.alignment["defaultSelection"],
                    "candidateActions": {candidate["id"]: "keep"},
                    "extraActions": {},
                }).encode("utf-8")
                request = Request(
                    f"{base}/api/preview",
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request) as response:
                    preview = json.loads(response.read())
                server.shutdown()

            self.assertTrue(preview["ok"])
            self.assertTrue(preview["selection"]["readyForMediaTrim"])
            self.assertEqual(
                preview["selection"]["manuallyEnabledCandidateIds"],
                [candidate["id"]],
            )

    def test_preview_accepts_manual_complete_candidate_disable(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            project_path = root / "source.mosp"
            script_path = root / "script.txt"
            project_path.write_text(json.dumps({
                "media": "",
                "segments": [
                    {"id": "s1", "start": 0, "end": 500, "text": "hello", "items": []},
                ],
            }), encoding="utf-8")
            script_path.write_text("hello\n", encoding="utf-8")
            state = SERVER.load_state(project_path, script_path, None)
            candidate = state.alignment["candidatesByLine"][0][0]

            with SERVER.AlignmentServer(("127.0.0.1", 0), state) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{server.server_address[1]}"
                body = json.dumps({
                    "selectedByLine": state.alignment["defaultSelection"],
                    "candidateActions": {candidate["id"]: "discard"},
                    "extraActions": {},
                }).encode("utf-8")
                request = Request(
                    f"{base}/api/preview",
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(request) as response:
                    preview = json.loads(response.read())
                server.shutdown()

            self.assertTrue(preview["ok"])
            self.assertTrue(preview["selection"]["readyForMediaTrim"])
            self.assertEqual(
                preview["selection"]["manuallyDisabledCandidateIds"],
                [candidate["id"]],
            )
            self.assertEqual(
                preview["selection"]["candidateActions"],
                {candidate["id"]: "discard"},
            )

    def test_preview_and_export_preserve_manual_gap_state(self) -> None:
        with TemporaryDirectory() as temporary:
            root = Path(temporary)
            project_path = root / "source.mosp"
            script_path = root / "script.txt"
            project_path.write_text(json.dumps({
                "media": "",
                "segments": [
                    {"id": "s1", "start": 0, "end": 500, "text": "hello", "items": []},
                    {"id": "s2", "start": 500, "end": 1000, "text": "world", "items": []},
                ],
            }), encoding="utf-8")
            script_path.write_text("hello world\n", encoding="utf-8")
            state = SERVER.load_state(project_path, script_path, None)
            gap_remove = {
                "skip_playback": False,
                "operation_mode": "boundary_and_middle",
                "gaps": [
                    {"start": 100, "end": 250, "removed": False},
                    {"start": 200, "end": 300, "removed": False},
                    {"start": 500, "end": 700, "removed": True},
                    {"start": 650, "end": 800, "removed": True},
                ],
            }

            with SERVER.AlignmentServer(("127.0.0.1", 0), state) as server:
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                base = f"http://127.0.0.1:{server.server_address[1]}"
                body = json.dumps({
                    "selectedByLine": state.alignment["defaultSelection"],
                    "candidateActions": {},
                    "extraActions": {},
                    "gapRemove": gap_remove,
                }).encode("utf-8")
                preview_request = Request(
                    f"{base}/api/preview",
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(preview_request) as response:
                    preview = json.loads(response.read())
                export_request = Request(
                    f"{base}/api/export",
                    data=body,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                with urlopen(export_request) as response:
                    exported = json.loads(response.read())
                server.shutdown()

            expected_gaps = [
                {"start": 100, "end": 300, "removed": False, "source": "manual", "origins": ["manual"]},
                {"start": 500, "end": 800, "removed": True, "source": "audio_gate", "origins": ["audio_gate"]},
            ]
            self.assertTrue(preview["ok"])
            self.assertEqual(preview["gapRemove"]["skip_playback"], False)
            self.assertEqual(preview["gapRemove"]["operation_mode"], "boundary_and_middle")
            self.assertEqual(preview["gapRanges"], expected_gaps)
            self.assertTrue(exported["ok"])
            output = json.loads(Path(exported["path"]).read_text(encoding="utf-8"))
            self.assertEqual(output["gap_remove"]["skip_playback"], False)
            self.assertEqual(output["gap_remove"]["operation_mode"], "boundary_and_middle")
            self.assertEqual(output["gap_remove"]["gaps"], expected_gaps)
            provenance = output["gap_remove"]["provenance"]
            self.assertEqual(provenance["legacy"], [])
            self.assertEqual(
                [(item["start"], item["end"], item["removed"])
                for item in provenance["sources"]["audio_gate"]],
                [(500, 800, True)],
            )
            self.assertEqual(
                [(item["start"], item["end"], item["removed"])
                for item in provenance["manual_overrides"]],
                [(100, 300, False)],
            )


if __name__ == "__main__":
    unittest.main()
