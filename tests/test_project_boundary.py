from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from maw.project import ProjectValidationFailed, validate_project
from maw.project_boundary import prepare_project, project_changes
from maw.postprocess_io import read_project
from tests.compact_assertions import CompactContainerAssertions

ROOT = Path(__file__).resolve().parents[1]
CASES = json.loads((ROOT / "tests/fixtures/project-boundary.json").read_text(encoding="utf-8"))


class ProjectBoundaryTests(CompactContainerAssertions, unittest.TestCase):
    def test_shared_acceptance_errors_defaults_and_actual_changes(self):
        for case in CASES:
            with self.subTest(case=case["name"]):
                original = copy.deepcopy(case["input"])
                strict = validate_project(original)
                imported = prepare_project(original)
                self.assertEqual(strict.ok, case["strict_ok"])
                self.assertEqual(sorted({e.path for e in strict.errors}), sorted(case["error_paths"]))
                self.assertEqual(imported.validation.ok, case["import_ok"])
                self.assertEqual(original, case["input"])
                if imported.validation.ok:
                    # These legacy corpus inputs have no speaker identities;
                    # adding the core fields must not enable speaker mode or nine slots.
                    defaults = {"speakers": [], "annotation_mode": "color", "palette_size": 5, "speaker_shortcuts": {}}
                    self.assertEqual({field: imported.validation.project[field] for field in defaults}, defaults)
                    expected = project_changes(original, imported.validation.project)
                    self.assertEqual(list(imported.changes), expected)
                    if case["change_paths"] is not None:
                        self.assertEqual([c["path"] for c in imported.changes], case["change_paths"])
                    again = prepare_project(imported.validation.project)
                    self.assertEqual(again.changes, ())
                else:
                    self.assertIsNone(imported.validation.project)
                    self.assertEqual(imported.changes, ())

    def test_cli_and_postprocess_reader_use_same_boundary_without_writing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.json"
            for case in CASES:
                with self.subTest(case=case["name"]):
                    raw = json.dumps(case["input"], ensure_ascii=False)
                    path.write_text(raw, encoding="utf-8")
                    if case["name"] in {"missing-schema-id", "future-schema", "overlap-items"}:
                        process = subprocess.run(
                            [sys.executable, "-m", "maw.project_boundary", str(path)],
                            cwd=ROOT, capture_output=True, text=True, encoding="utf-8", timeout=15,
                        )
                        self.assertEqual(process.returncode, 0 if case["import_ok"] else 2, process.stderr)
                        self.assertEqual(json.loads(process.stdout), prepare_project(case["input"]).to_json())
                    if case["import_ok"]:
                        self.assertEqual(read_project(path), prepare_project(case["input"]).validation.project)
                    else:
                        with self.assertRaises(ProjectValidationFailed):
                            read_project(path)
                    self.assertEqual(path.read_text(encoding="utf-8"), raw)

    def test_server_import_and_save_future_schema_preserve_disk(self):
        from tests.test_local_editor_server import server_editor
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            path = root / "project.mosp"
            for case in CASES:
                with self.subTest(case=case["name"]):
                    raw = json.dumps(case["input"], ensure_ascii=False)
                    path.write_text(raw, encoding="utf-8")
                    if case["import_ok"]:
                        project = server_editor.load_project(path, None, str(root), no_waveform=True, peaks_per_second=100)
                        # Server media enrichment is separate from subtitle acceptance.
                        self.assertEqual(project.data["tracks"], prepare_project(case["input"]).validation.project["tracks"])
                    else:
                        with self.assertRaises(ProjectValidationFailed):
                            server_editor.load_project(path, None, str(root), no_waveform=True, peaks_per_second=100)
                    self.assertEqual(path.read_text(encoding="utf-8"), raw)
            path.write_text('{"segments": []}', encoding="utf-8")
            project = server_editor.load_project(path, None, str(root), no_waveform=True, peaks_per_second=100)
            with server_editor.EditorServer(("127.0.0.1", 0), project) as server:
                with self.assertRaises(server_editor.SaveProjectError):
                    server.save_project({"schema": "moy.asr.project.v99", "segments": []})
            self.assertEqual(path.read_text(encoding="utf-8"), '{"segments": []}')


if __name__ == "__main__":
    unittest.main()
