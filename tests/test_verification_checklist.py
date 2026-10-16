"""Generation contracts for the independent verification checklist tool."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from compact_assertions import CompactContainerAssertions


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("verification_builder", ROOT / "tools/verification-checklist/build.py")
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)

SECTIONS = '''<details class="section" open id="feature">
<summary><span class="sec-title">核验</span><span class="badge fixed">已修复</span></summary>
<div class="body"><div class="item"><input type="checkbox" id="check-1">
<label for="check-1">操作 → 预期 {{TITLE}}</label></div></div></details>'''
EXAMPLE = ROOT / "tools/verification-checklist/examples/checklist.json"


def example_source():
    return json.loads(EXAMPLE.read_text(encoding="utf-8"))


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
        path = ROOT / "docs/logs/1.8.0-beta.1/2026-10-09/first-verification/maw-verification-v1.8.0b1-to-main.html"
        fields = builder.extract_page(path.read_text(encoding="utf-8"))
        result = builder.extract_page(builder.render(**fields))
        self.assertTrue(fields == result, "Refresh must preserve the release checklist content")
        validator = builder.ChecklistValidator()
        validator.validate(fields["sections"])
        self.assertGreater(len(validator.checkboxes), 0)

    def test_json_example_generates_all_blocks_with_stable_unchecked_items(self):
        source = example_source()
        page = builder.render_source(source)
        validator = builder.ChecklistValidator()
        validator.validate(page)
        self.assertEqual(validator.checkboxes, ["manual-persistence", "manual-export"])
        sections = builder.extract_page(page)["sections"]
        self.assertIn('<details class="section" id="automation">', sections)
        self.assertIn('<details class="section" id="manual" open>', sections)
        self.assertIn('<ol class="plain">', sections)
        self.assertIn('<pre class="cmd">', sections)
        self.assertIn('<th scope="col">', sections)
        self.assertIn('<span class="badge todo">', sections)
        self.assertNotIn(" checked", sections)
        # Inserting a read-only section does not renumber existing checkbox IDs.
        source["sections"].insert(0, {"id": "added", "title": "补充",
                                     "blocks": [{"type": "text", "text": "新证据"}]})
        updated = builder.ChecklistValidator()
        updated.validate(builder.render_source(source))
        self.assertEqual(updated.checkboxes, validator.checkboxes)

    def test_json_text_cannot_create_markup_or_replace_template_placeholders(self):
        source = example_source()
        payload = '</label><script>alert(1)</script> & "引号" {{TITLE}}\n第二行'
        source["title"] = payload
        source["subtitle"] = payload
        source["sections"][0]["title"] = payload
        source["sections"][0]["blocks"][0]["text"] = payload
        source["sections"][0]["blocks"][2]["items"][0] = payload
        source["sections"][1]["blocks"][0]["text"] = payload
        source["sections"][1]["blocks"][1]["rows"][0][0] = payload
        source["sections"][2]["badge"]["text"] = payload
        source["sections"][2]["blocks"][0]["purpose"] = payload
        page = builder.render_source(source)
        self.assertNotIn('<script>alert(1)</script>', page)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', page)
        self.assertIn('{{TITLE}}<br>第二行', page)
        self.assertIn('{{TITLE}}\n第二行</code></pre>', page)
        self.assertEqual(page.count('<script>'), 1)

    def test_json_contract_rejects_errors_with_field_paths(self):
        cases = [
            (("schema",), "maw.verification-checklist.v1", "source.schema"),
            (("title",), " ", "source.title"),
            (("subtitle",), None, "source.subtitle"),
            (("sections",), [], "source.sections"),
            (("sections", 0, "blocks"), [], "blocks"),
            (("sections", 0, "open"), "true", "open"),
            (("sections", 0, "blocks", 0, "text"), 1, "text"),
            (("sections", 0, "blocks", 0, "type"), "html", "type"),
            (("sections", 0, "blocks", 0, "type"), [], "type"),
            (("sections", 0, "blocks", 2, "items"), [1], "items"),
            (("sections", 0, "blocks", 2, "ordered"), 1, "ordered"),
            (("sections", 1, "blocks", 1, "headers"), [], "headers"),
            (("sections", 1, "blocks", 1, "rows"), [["wrong width"]], "rows"),
            (("sections", 1, "blocks", 1, "rows"), [["a", "b", 1]], "rows"),
            (("sections", 2, "badge", "kind"), "custom", "badge.kind"),
            (("sections", 2, "blocks", 0, "expected"), "", "expected"),
            (("sections", 2, "blocks", 0, "confirmed"), True, "unknown fields"),
            (("sections", 0, "unexpected"), "typo", "unknown fields"),
        ]
        for path, value, message in cases:
            source = example_source()
            target = source
            for key in path[:-1]:
                target = target[key]
            target[path[-1]] = value
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, message):
                builder.render_source(source)
        source = example_source()
        del source["sections"][2]["blocks"][0]["operation"]
        with self.assertRaisesRegex(ValueError, "missing fields: operation"):
            builder.render_source(source)
        for source in ([], {"sections": []}):
            with self.assertRaises(ValueError):
                builder.render_source(source)

    def test_json_ids_cannot_collide_with_items_template_or_runtime_elements(self):
        for item_id in ("manual", "manual-export", "reset", "toc", "checklist-note-0",
                        "constructor", "toString", "__proto__", 'bad"id', "has space", "中文"):
            source = example_source()
            source["sections"][2]["blocks"][0]["id"] = item_id
            with self.subTest(item_id=item_id), self.assertRaisesRegex(ValueError, r"blocks\[[01]\].id"):
                builder.render_source(source)

    def test_json_allows_empty_subtitle_table_and_cells(self):
        source = example_source()
        source["subtitle"] = ""
        table = source["sections"][1]["blocks"][1]
        for rows in ([], [["", "", ""]]):
            table["rows"] = rows
            self.assertIn('<tbody>', builder.render_source(source))

    def test_json_rejects_non_renderable_unicode_before_writing(self):
        for value in ('bad\ud800', 'bad\udfff', 'bad\0value'):
            source = example_source()
            source["sections"][2]["blocks"][0]["purpose"] = value
            with self.subTest(value=repr(value)), self.assertRaisesRegex(ValueError, r"blocks\[0\].purpose"):
                builder.render_source(source)
        source = example_source()
        source["sections"][0]["blocks"][0]["text"] = '汉字 😀 𠮷'
        self.assertIn('汉字 😀 𠮷', builder.render_source(source))

    def test_json_command_keeps_leading_newline_outside_pre_parse_rule(self):
        source = example_source()
        source["sections"][1]["blocks"][0]["text"] = '\n\tpython check.py\n'
        self.assertIn('<pre class="cmd"><code>\n\tpython check.py\n</code></pre>', builder.render_source(source))

    def test_failed_page_replace_keeps_existing_output_and_cleans_temporary_file(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "checklist.html"
            output.write_bytes(b"existing page")
            with patch.object(builder.os, "replace", side_effect=OSError("replace blocked")):
                with self.assertRaisesRegex(OSError, "replace blocked"):
                    builder.write_page(output, "新的页面")
            self.assertEqual(output.read_bytes(), b"existing page")
            self.assertEqual(list(output.parent.iterdir()), [output])
            with self.assertRaises(UnicodeEncodeError):
                builder.write_page(output, 'invalid\ud800')
            self.assertEqual(output.read_bytes(), b"existing page")
            builder.write_page(output, '新的页面\n第二行')
            self.assertEqual(output.read_bytes(), '新的页面\n第二行'.encode('utf-8'))

    def test_json_cli_roundtrip_bom_and_failure_preserves_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data = root / "source.json"
            output = root / "nested/checklist.html"
            data.write_text(json.dumps(example_source(), ensure_ascii=False), encoding="utf-8-sig")
            original_data = data.read_bytes()

            def run(*args):
                return subprocess.run([sys.executable, str(builder.__file__), *map(str, args)],
                                      capture_output=True, text=True, encoding="utf-8")

            built = run("--data", data, "--output", output)
            self.assertEqual(built.returncode, 0, built.stderr)
            original_fields = builder.extract_page(output.read_text(encoding="utf-8"))
            refreshed = run("--refresh", output)
            self.assertEqual(refreshed.returncode, 0, refreshed.stderr)
            self.assertEqual(original_fields, builder.extract_page(output.read_text(encoding="utf-8")))
            for arguments in (
                ("--data", data, "--output", data),
                ("--data", data, "--output", builder.TEMPLATE),
                ("--data", data, "--refresh", output),
                ("--data", data),
                ("--data", data, "--title", "Conflict", "--output", output),
            ):
                with self.subTest(arguments=arguments):
                    self.assertNotEqual(run(*arguments).returncode, 0)
            self.assertEqual(data.read_bytes(), original_data)
            original_page = output.read_bytes()
            for bad in ('{"title": "A", "title": "B"}', '{bad',
                        json.dumps({**example_source(), "schema": "exported-results"}),
                        json.dumps({**example_source(), "title": 'invalid\ud800'})):
                data.write_text(bad, encoding="utf-8")
                failed = run("--data", data, "--output", output)
                self.assertEqual(failed.returncode, 1)
                self.assertIn("Checklist error:", failed.stderr)
                self.assertEqual(output.read_bytes(), original_page)


if __name__ == "__main__":
    unittest.main()
