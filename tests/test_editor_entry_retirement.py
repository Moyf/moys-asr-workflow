from __future__ import annotations

import ast
import io
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from types import SimpleNamespace
from unittest import mock

from maw import cli, editor_entry_policy as policy, gui_workflow
from scripts.prepare_editor_pages import prepare_editor_pages


ROOT = Path(__file__).resolve().parents[1]


class EditorEntryRetirementTests(unittest.TestCase):
    def test_version_boundary_includes_prereleases_and_packaged_fallback(self):
        for version, supported in [
            ("1.9.0-beta.1", True), ("1.99.0", True),
            ("2.0.0-alpha.1", False), ("2.0.0rc1", False),
            ("v2.0.0", False), ("2.1.0", False), ("3.0.0", False),
            ("unknown", False),
        ]:
            with self.subTest(version=version):
                self.assertEqual(policy.standalone_editor_supported(version), supported)
        with mock.patch("maw.diagnostics.Path.read_text", side_effect=FileNotFoundError), \
             mock.patch("maw.diagnostics.BUNDLED_APP_VERSION", "2.0.0-beta.1"):
            self.assertFalse(policy.standalone_editor_supported())

    def test_explicit_html_fails_before_transcription_even_with_missing_input(self):
        with mock.patch.object(policy, "app_version", return_value="2.0.0-beta.1"), \
             mock.patch.object(cli, "_invoke_generator") as invoke, \
             redirect_stderr(io.StringIO()) as errors:
            with self.assertRaises(SystemExit) as raised:
                cli.main(["-i", "missing.wav", "--html"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("2.0", errors.getvalue())
        self.assertIn("--server", errors.getvalue())
        invoke.assert_not_called()

    def test_retired_edit_command_never_builds_or_overwrites_historical_html(self):
        import edit
        with tempfile.TemporaryDirectory() as directory:
            old = Path(directory) / "historical.html"
            old.write_text("historical user copy", encoding="utf-8")
            with mock.patch.object(policy, "app_version", return_value="2.0.0"), \
                 mock.patch.object(sys, "argv", ["edit.py", "--blank", "-o", str(old)]), \
                 mock.patch.object(edit, "ensure_bundle") as build, \
                 redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as raised:
                    edit.main()
                with self.assertRaisesRegex(ValueError, "2.0"):
                    edit.build_blank_html()
                with self.assertRaisesRegex(ValueError, "2.0"):
                    gui_workflow.render_editor_html(Path("missing.json"), Path("missing.wav"), old)
            self.assertEqual(raised.exception.code, 2)
            self.assertEqual(old.read_text(encoding="utf-8"), "historical user copy")
            build.assert_not_called()

    def test_implicit_html_request_skips_only_retired_artifact(self):
        with mock.patch.object(policy, "app_version", return_value="2.0.0"), \
             redirect_stderr(io.StringIO()) as errors:
            self.assertFalse(policy.should_generate_standalone_editor(False))
            self.assertEqual(errors.getvalue(), "")
            self.assertFalse(policy.should_generate_standalone_editor(True))
            self.assertIn("历史 HTML", errors.getvalue())
        with mock.patch.object(policy, "app_version", return_value="1.9.0-beta.1"):
            self.assertTrue(policy.should_generate_standalone_editor(True))

    def test_local_server_dispatch_remains_available_in_two(self):
        with mock.patch.object(policy, "app_version", return_value="2.0.0"), \
             mock.patch.object(cli, "_invoke_server", return_value=0) as server:
            self.assertEqual(cli.main(["--server", "8765", "legacy.json", "--no-open"]), 0)
        self.assertEqual(server.call_args.args[0], ["legacy.json", "--port", "8765", "--no-open"])
        args = cli.build_parser().parse_args(["-i", "clip.wav", "--json", "--no-html"])
        self.assertTrue(args.json_output)
        self.assertTrue(args.no_html)

    def test_launcher_rejects_retired_blank_html_before_accessing_old_files(self):
        from maw.gui_web import LauncherApi
        with mock.patch.object(policy, "app_version", return_value="2.0.0"), \
             mock.patch("maw.gui_web._open_existing_path") as open_path:
            result = LauncherApi.open_blank_html(SimpleNamespace())
        self.assertFalse(result["ok"])
        self.assertIn("2.0", result["error"])
        open_path.assert_not_called()

    def test_pages_two_emits_no_editor_and_refuses_stale_output(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(policy, "app_version", return_value="2.0.0-beta.1"), \
             redirect_stdout(io.StringIO()):
            output = Path(directory)
            prepare_editor_pages(output)
            self.assertTrue((output / ".nojekyll").is_file())
            self.assertFalse((output / "editor").exists())
            (output / "editor").mkdir()
            old = output / "editor" / "index.html"
            old.write_text("old", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "fresh"):
                prepare_editor_pages(output)
            self.assertEqual(old.read_text(encoding="utf-8"), "old")

    def test_pages_one_retains_transition_without_touching_root_artifact(self):
        with tempfile.TemporaryDirectory() as directory, \
             mock.patch.object(policy, "app_version", return_value="1.9.0"), \
             mock.patch("edit.build_blank_html", return_value="legacy\npage"):
            prepare_editor_pages(Path(directory))
            self.assertEqual((Path(directory) / "editor/index.html").read_bytes(), b"legacy\npage")

    def test_packaging_two_excludes_legacy_html_but_keeps_server_assets(self):
        # Execute the actual shared spec with PyInstaller's builders replaced;
        # this checks the data manifest, not a native installed application.
        for version, expected in [("1.9.0", True), ("2.0.0-beta.1", False)]:
            captured = []
            def analysis(*args, **kwargs):
                captured.extend(kwargs["datas"])
                return SimpleNamespace(pure=[], scripts=[], binaries=[], datas=[])
            with self.subTest(version=version), \
                 mock.patch.object(policy, "app_version", return_value=version):
                spec_directory = ROOT / "scripts" / "packaging"
                runpy.run_path(str(spec_directory / "MAW.spec"), init_globals={
                    "SPECPATH": str(spec_directory), "Analysis": analysis,
                    "PYZ": lambda *a, **k: None, "EXE": lambda *a, **k: None,
                    "COLLECT": lambda *a, **k: None, "BUNDLE": lambda *a, **k: None,
                })
            paths = {Path(source).name for source, _ in captured}
            self.assertEqual("blank-editor.html" in paths, expected)
            self.assertTrue({"web", "server-editor", "edit.py", "editor_entry_policy.py", "diagnostics.py"} <= paths)

    def test_all_generating_consumers_gate_their_optional_artifact(self):
        # These generators invoke a separate process: catch omissions without
        # running paid ASR or installing model runtimes.
        expected = {f"{provider}.py" for provider in ("bcut", "doubao", "openai", "qwen", "soniox")}
        found = set()
        for path in (ROOT / "maw" / "asr").glob("*.py"):
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source)
            html_scripts = [node for node in ast.walk(tree)
                            if isinstance(node, ast.Constant) and node.value == "edit.py"]
            if not html_scripts:
                continue  # Tencent accepts --no-html but does not generate HTML.
            found.add(path.name)
            gates = [node for node in ast.walk(tree) if isinstance(node, ast.If)
                     and isinstance(node.test, ast.Call) and isinstance(node.test.func, ast.Name)
                     and node.test.func.id == "should_generate_standalone_editor"]
            self.assertEqual(len(gates), 1, path.name)
            self.assertTrue(all(node in list(ast.walk(gates[0])) for node in html_scripts), path.name)
        self.assertEqual(found, expected)


if __name__ == "__main__":
    unittest.main()
