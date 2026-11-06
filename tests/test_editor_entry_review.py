from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest

from tests.helpers.versioned_source import create_versioned_source


class ActualVersionRetirementTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.temp.cleanup)
        cls.root = create_versioned_source(Path(cls.temp.name) / "source")

    def run_source(self, *args):
        env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        env.pop("PYTHONPATH", None)
        return subprocess.run([sys.executable, *args], cwd=self.root, env=env,
                              capture_output=True, text=True, timeout=45)

    def test_actual_two_metadata_rejects_both_production_cli_entries(self):
        for command in (["edit.py", "--blank"], ["maw_gui.py", "-i", "missing.wav", "--html"]):
            with self.subTest(command=command):
                result = self.run_source(*command)
                self.assertEqual(result.returncode, 2, result.stderr[-1500:])
                self.assertIn("2.0", result.stderr)
                self.assertIn("--server", result.stderr)
        self.assertFalse((self.root / "blank-editor.html").exists())

    def test_synchronized_frozen_fallback_remains_retired_without_metadata(self):
        result = self.run_source("-c", '''
from pathlib import Path
from maw.diagnostics import app_version
from maw.editor_entry_policy import standalone_editor_supported
metadata = Path("pyproject.toml")
saved = Path("pyproject.saved")
metadata.rename(saved)
try:
    assert app_version() == "2.0.0-beta.1"
    assert standalone_editor_supported() is False
finally:
    saved.rename(metadata)
''')
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])

    def test_two_launcher_cannot_open_a_stale_transcription_html_result(self):
        result = self.run_source("-c", '''
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from maw.diagnostics import app_version
from maw.gui_web import LauncherApi
assert app_version() == "2.0.0-beta.1"
old = Path("historical-user-copy.html")
old.write_text("historical", encoding="utf-8")
api = SimpleNamespace(result=SimpleNamespace(html_path=old))
with patch("maw.gui_web._open_existing_path", side_effect=AssertionError("retired Launcher entry opened")):
    result = LauncherApi.open_html(api)
assert result["ok"] is False and "2.0" in result["error"], result
assert old.read_text(encoding="utf-8") == "historical"
''')
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])

    def test_two_gui_pipeline_preserves_srt_project_without_calling_html_renderer(self):
        result = self.run_source("-c", '''
from pathlib import Path
from unittest.mock import patch
from maw.diagnostics import app_version
from maw.gui_workflow import TranscriptionRequest, run_transcription
assert app_version() == "2.0.0-beta.1"
media = Path("clip.wav").resolve()
media.write_bytes(b"fixture")
srt = Path("pipeline.srt").resolve()
srt.write_text("1\\n", encoding="utf-8")
project = srt.with_suffix(".mosp")
content = '{"segments":[{"start":0,"end":1000,"text":"fixture"}]}'
project.write_text(content, encoding="utf-8")
class Process:
    stdout = ["done\\n"]
    returncode = 0
    def poll(self): return 0
    def wait(self, timeout=None): return 0
with patch("maw.gui_workflow.subprocess.Popen", return_value=Process()), \\
     patch("maw.gui_workflow.render_editor_html", side_effect=AssertionError("HTML renderer invoked")):
    result = run_transcription(TranscriptionRequest(media_path=media, srt_path=srt, generate_html=True))
assert result.html_path is None
assert result.srt_path == srt and result.json_path == project
assert srt.read_text(encoding="utf-8") == "1\\n"
assert project.read_text(encoding="utf-8") == content
''')
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])

    def test_packaging_refuses_unsynchronized_metadata_before_analysis(self):
        with tempfile.TemporaryDirectory() as directory:
            root = create_versioned_source(Path(directory) / "stale", synchronize=False)
            code = '''
import runpy
from types import SimpleNamespace
def analysis(*a, **k):
    print("ANALYSIS_STARTED")
    return SimpleNamespace(pure=[],scripts=[],binaries=[],datas=[])
runpy.run_path("scripts/packaging/MAW.spec", init_globals={"SPECPATH":"scripts/packaging","Analysis":analysis,
    "PYZ":lambda *a,**k:None,"EXE":lambda *a,**k:None,"COLLECT":lambda *a,**k:None,"BUNDLE":lambda *a,**k:None})
'''
            result = subprocess.run([sys.executable, "-c", code], cwd=root,
                                    capture_output=True, text=True, timeout=45)
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("ANALYSIS_STARTED", result.stdout)
        self.assertIn("sync_launcher_version.py", result.stderr)

    def test_two_local_writer_keeps_outputs_when_legacy_html_is_requested(self):
        result = self.run_source("-c", '''
from pathlib import Path
import json, wave
from maw.local_asr import LocalTranscription, write_local_outputs
from maw.project_tracks import get_main_track
media = Path("local.wav").resolve()
with wave.open(str(media), "wb") as stream:
    stream.setnchannels(1); stream.setsampwidth(2); stream.setframerate(8000)
    stream.writeframes(b"\\0\\0" * 8000)
segments = [{"id":"local","start":0,"end":1000,"text":"Local output"}]
transcription = LocalTranscription(text="Local output", language="en", items=[], segments=segments, model="fixture")
result = write_local_outputs(input_path=media, output_srt=Path("local.srt").resolve(),
    transcription=transcription, segments=segments, write_json=True,
    generate_html=True, with_waveform=False)
assert result.html is None
assert "Local output" in result.srt.read_text(encoding="utf-8")
assert get_main_track(json.loads(result.json.read_text(encoding="utf-8")))["segments"][0]["text"] == "Local output"
assert not Path("local.edit.html").exists()
''')
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])


if __name__ == "__main__":
    unittest.main()
