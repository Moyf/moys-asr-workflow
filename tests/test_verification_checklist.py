"""Generation contracts for the independent verification checklist tool."""

import importlib.util
from pathlib import Path
import unittest

from compact_assertions import CompactContainerAssertions


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("verification_builder", ROOT / "tools/verification-checklist/build.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

SECTIONS = '''<details class="section" open id="feature">
<summary><span class="sec-title">核验</span><span class="badge fixed">已修复</span></summary>
<div class="body"><div class="item"><input type="checkbox" id="check-1">
<label for="check-1">操作 → 预期 {{TITLE}}</label></div></div></details>'''


class VerificationChecklistTests(CompactContainerAssertions, unittest.TestCase):
    def test_escape_metadata_without_replacing_inserted_placeholders(self):
        result = builder.render('A < B & "C"', "范围 <测试>", SECTIONS)
        self.assertIn('<title>A &lt; B &amp; &quot;C&quot;</title>', result)
        self.assertIn('操作 → 预期 {{TITLE}}', result)

    def test_refresh_preserves_identity_heading_and_sections(self):
        original = builder.render("Identity & date", "Scope & baseline", SECTIONS, heading="可见标题")
        fields = builder.extract_page(original)
        refreshed = builder.extract_page(builder.render(**fields))
        self.assertTrue(fields == refreshed, "Refresh must preserve all extracted fields")
        self.assertEqual(refreshed["title"], "Identity & date")

    def test_invalid_checklist_ids_fail_before_write(self):
        for bad, message in (
            (SECTIONS + SECTIONS, "Duplicate HTML id"),
            (SECTIONS.replace('id="check-1"', ''), "stable, unique id"),
            (SECTIONS.replace('for="check-1"', 'for="other"'), "missing labels"),
        ):
            with self.subTest(message=message), self.assertRaisesRegex(ValueError, message):
                builder.render("Title", "Subtitle", bad)

    def test_refresh_rejects_non_checklist_html(self):
        with self.assertRaisesRegex(ValueError, "missing template field"):
            builder.extract_page("<title>Other page</title>")

    def test_existing_release_page_retains_item_content_and_ids(self):
        path = ROOT / "docs/verifications/261009_first-verification/maw-verification-v1.8.0b1-to-main.html"
        fields = builder.extract_page(path.read_text(encoding="utf-8"))
        result = builder.extract_page(builder.render(**fields))
        self.assertTrue(fields == result, "Refresh must preserve the release checklist content")
        validator = builder.ChecklistValidator()
        validator.validate(fields["sections"])
        self.assertGreater(len(validator.checkboxes), 0)


if __name__ == "__main__":
    unittest.main()
