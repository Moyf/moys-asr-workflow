from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import edit


class EditorManifestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.web = self.root / "web"
        self.web.mkdir()
        for entry in ("editor.js", "editor/boot/start.js", "shared/core.js"):
            path = self.web / entry
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(f"// {entry}\n", encoding="utf-8")
        self.patch = patch.object(edit, "WEB_DIR", self.web)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def manifest(self, text: str) -> tuple[str, ...]:
        (self.web / "editor-scripts.txt").write_text(text, encoding="utf-8")
        return edit.read_editor_script_manifest()

    def test_shared_path_cases(self) -> None:
        cases = Path(__file__).parent / "fixtures" / "editor_manifest_cases.txt"
        for line in cases.read_text(encoding="utf-8").splitlines():
            expected, entry = line.split(" ", 1)
            with self.subTest(entry=entry):
                if expected == "ok":
                    self.assertEqual(self.manifest(entry), (entry,))
                else:
                    with self.assertRaisesRegex(ValueError, "Invalid editor script manifest entry"):
                        self.manifest(entry)

    def test_nested_sources_preserve_order_and_comments(self) -> None:
        self.assertEqual(
            self.manifest("# order\neditor/boot/start.js # boot\n\neditor.js\n"),
            ("editor/boot/start.js", "editor.js"),
        )
        self.assertEqual(edit.build_editor_scripts(), "// editor/boot/start.js\n\n// editor.js")

    def test_rejects_empty_duplicate_missing_and_directory_entries(self) -> None:
        (self.web / "directory.js").mkdir()
        for manifest in ("# empty\n", "editor.js\neditor.js # duplicate\n", "missing.js\n", "directory.js\n"):
            with self.subTest(manifest=manifest), self.assertRaises(ValueError):
                self.manifest(manifest)

    def test_rejects_symlink_escape(self) -> None:
        outside = self.root / "outside.js"
        outside.write_text("// outside\n", encoding="utf-8")
        link = self.web / "escape.js"
        try:
            link.symlink_to(outside)
        except OSError as error:
            self.skipTest(f"Symlink creation is unavailable: {error}")
        with self.assertRaisesRegex(ValueError, "escapes web directory"):
            self.manifest("escape.js\n")

    def test_accepts_symlink_within_web_directory(self) -> None:
        link = self.web / "alias.js"
        try:
            link.symlink_to(self.web / "shared/core.js")
        except OSError as error:
            self.skipTest(f"Symlink creation is unavailable: {error}")
        self.assertEqual(self.manifest("alias.js\n"), ("alias.js",))


if __name__ == "__main__":
    unittest.main()
