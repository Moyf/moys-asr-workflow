"""verification-checklist build.py：Markdown 源格式解析、转义与往返契约。"""
from __future__ import annotations

from io import StringIO
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD_PATH = ROOT / "tools" / "verification-checklist" / "build.py"
SPEC = importlib.util.spec_from_file_location("verification_checklist_build", BUILD_PATH)
assert SPEC and SPEC.loader
build = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = build
SPEC.loader.exec_module(build)


def minimal_source(**overrides):
    source = {
        "schema": "maw.verification-checklist.source.v1",
        "title": "功能核对",
        "subtitle": "范围与边界",
        "sections": [{
            "id": "feature-export",
            "title": "导出功能",
            "badge": {"kind": "todo", "text": "待核查"},
            "blocks": [
                {"type": "note", "text": "自动化结果与未验证边界。"},
                {"type": "check", "id": "export-01", "entry": "编辑器 → 导出",
                 "action": "选择 SRT 并保存", "expected": "文件内容与字幕一致"},
            ],
        }],
    }
    source.update(overrides)
    return source


class MarkdownRoundTripTests(unittest.TestCase):
    def test_json_md_html_roundtrip_is_byte_identical(self) -> None:
        source = minimal_source(sections=[{
            "id": "mixed",
            "title": "混合块型",
            "badge": {"kind": "pass", "text": "已通过"},
            "blocks": [
                {"type": "note", "text": "1. 这是以数字开头的说明；2. 第二点。"},
                {"type": "note", "text": "- 破折号开头的说明"},
                {"type": "note", "text": "> 引用开头的说明"},
                {"type": "note", "text": "普通说明。"},
                {"type": "list", "items": ["第一项", "第二项"]},
                {"type": "list", "ordered": True, "items": ["甲", "乙"]},
                {"type": "command", "text": "uv run python tools/build.py --flag"},
                {"type": "table", "headers": ["命令", "结果"],
                 "rows": [["a|b", "12 passed"], ["", ""]]},
                {"type": "check", "id": "mixed-01", "entry": "入口",
                 "action": "操作步骤", "expected": "预期结果"},
            ],
        }])
        markdown = build.source_to_markdown(source, {"task": "demo", "pr": "1",
                                                     "date": "2026-10-15", "status": "pending"})
        meta, parsed = build.parse_markdown_source(markdown)
        self.assertEqual(meta, {"task": "demo", "pr": "1", "date": "2026-10-15", "status": "pending"})
        self.assertEqual(parsed, source)

    def test_rendered_html_is_identical_through_markdown(self) -> None:
        source = minimal_source()
        html_from_json = build.render_source(json.loads(json.dumps(source),
                                                        object_pairs_hook=build.unique_json_object))
        markdown = build.source_to_markdown(source)
        _, parsed = build.parse_markdown_source(markdown)
        self.assertEqual(build.render_source(parsed), html_from_json)

    def test_rendered_html_is_identical_with_front_matter_and_progress(self) -> None:
        source = minimal_source()
        markdown = build.source_to_markdown(
            source, {"task": "demo", "status": "partial"})
        markdown = markdown.replace("- [ ] **编辑器 → 导出**", "- [x] **编辑器 → 导出**")
        html_from_json = build.render_source(source)
        _, parsed = build.parse_markdown_source(markdown)
        self.assertEqual(parsed["sections"][0]["blocks"][1]["id"], "export-01")
        self.assertEqual(build.render_source(parsed), html_from_json)


class MarkdownValidationTests(unittest.TestCase):
    def parse(self, markdown: str):
        return build.parse_markdown_source(markdown)

    def md(self, body: str, meta: str = "status: pending") -> str:
        return f"---\n{meta}\n---\n\n# 标题\n\n> 副标题\n\n{body}"

    def test_front_matter_rejects_unknown_missing_and_bad_fields(self) -> None:
        cases = (
            "task: demo",
            "status: done",
            "status: pending\npr: x1",
            "status: pending\ndate: 2026/10/15",
            "status: pending\nunknown: 1",
            "status: pending\nstatus: passed",
        )
        for front in cases:
            with self.subTest(front=front), self.assertRaises(ValueError):
                self.parse(f"---\n{front}\n---\n\n# 标题\n\n> 副标题\n")

    def test_front_matter_status_only_is_valid(self) -> None:
        meta, source = self.parse("---\nstatus: passed\n---\n\n# 标题\n\n> 副标题\n\n"
                                  "## 分区\n<!-- id: s1 -->\n\n说明。\n")
        self.assertEqual(meta, {"status": "passed"})
        self.assertEqual(source["sections"][0]["blocks"], [{"type": "note", "text": "说明。"}])

    def test_check_line_requires_trailing_id_and_separator(self) -> None:
        body = "## 分区\n<!-- id: s1 -->\n\n- [ ] **入口**：操作；预期：结果 <!-- id: c1 -->\n"
        meta, source = self.parse(self.md(body))
        self.assertEqual(source["sections"][0]["blocks"][0]["id"], "c1")
        for broken in (
            "## 分区\n<!-- id: s1 -->\n\n- [ ] **入口**：操作；预期：结果\n",
            "## 分区\n<!-- id: s1 -->\n\n- [ ] **入口**：操作 <!-- id: c1 -->\n",
            "## 分区\n<!-- id: s1 -->\n\n- [ ] **入口**：操作；预期：结果 <!-- id: c1 --> 额外\n",
        ):
            with self.subTest(broken=broken), self.assertRaises(ValueError):
                self.parse(self.md(broken))

    def test_check_fields_reject_markup_and_separator(self) -> None:
        for body in (
            "## 分区\n<!-- id: s1 -->\n\n- [ ] **入**口**：操作；预期：结果 <!-- id: c1 -->\n",
            "## 分区\n<!-- id: s1 -->\n\n- [ ] **入口**：操作 <!-- 注释 -->；预期：结果 <!-- id: c1 -->\n",
        ):
            with self.subTest(body=body), self.assertRaises(ValueError):
                self.parse(self.md(body))

    def test_section_requires_id_comment(self) -> None:
        with self.assertRaises(ValueError):
            self.parse(self.md("## 分区\n\n- [ ] **入口**：操作；预期：结果 <!-- id: c1 -->\n"))

    def test_note_starting_with_list_marker_round_trips(self) -> None:
        _, source = self.parse(self.md("## 分区\n<!-- id: s1 -->\n\n1\\. 数字开头的说明。\n"))
        self.assertEqual(source["sections"][0]["blocks"], [{"type": "note", "text": "1. 数字开头的说明。"}])

    def test_command_and_table_blocks_round_trip(self) -> None:
        body = (
            "## 分区\n<!-- id: s1 -->\n\n```build.py --flag```\n\n"
            "| A | B |\n| --- | --- |\n| a\\|b |  |\n"
        )
        _, source = self.parse(self.md(body))
        self.assertEqual(source["sections"][0]["blocks"][0],
                         {"type": "command", "text": "build.py --flag"})
        self.assertEqual(source["sections"][0]["blocks"][1],
                         {"type": "table", "headers": ["A", "B"], "rows": [["a|b", ""]]})

    def test_emit_rejects_unsupported_shapes(self) -> None:
        with self.assertRaises(ValueError):
            build.source_to_markdown(minimal_source(sections=[{
                "id": "s", "title": "折叠", "open": False, "blocks": []}]))
        with self.assertRaises(ValueError):
            build.source_to_markdown(minimal_source(sections=[{
                "id": "s", "title": "多行", "blocks": [{"type": "note", "text": "一\n二"}]}]))
        with self.assertRaises(ValueError):
            build.source_to_markdown(minimal_source(sections=[{
                "id": "s", "title": "纯文本", "blocks": [{"type": "text", "text": "x"}]}]))
        with self.assertRaises(ValueError):
            build.source_to_markdown(minimal_source(), {"status": "pending", "wat": 1})


class MetaAndScanTests(unittest.TestCase):
    def test_meta_args_parse_and_reject_duplicates(self) -> None:
        self.assertEqual(build.parse_meta_args(["task=demo", "pr=7"]),
                         {"task": "demo", "pr": "7"})
        for pairs in (["task"], ["task="], ["task=a", "task=b"], ["=v"]):
            with self.subTest(pairs=pairs), self.assertRaises(ValueError):
                build.parse_meta_args(pairs)

    def test_scan_reports_status_progress_and_invalid_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "demo.checklist.md").write_text(
                "---\ntask: demo\npr: 9\nstatus: partial\n---\n\n# 标题\n\n> 副标题\n\n"
                "## 分区\n<!-- id: s1 -->\n\n- [x] **入口**：操作；预期：结果 <!-- id: c1 -->\n"
                "- [ ] **入口**：操作；预期：结果 <!-- id: c2 -->\n",
                encoding="utf-8")
            (root / "broken.checklist.md").write_text("---\nstatus: nope\n---\n", encoding="utf-8")
            rows = build.scan_checklists(root)
        self.assertEqual(len(rows), 2)
        self.assertIn("invalid", rows[0])
        self.assertIn("partial", rows[1])
        self.assertIn("1/2", rows[1])
        self.assertIn("demo", rows[1])

    def test_scan_reports_missing_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            rows = build.scan_checklists(Path(temp))
        self.assertEqual(len(rows), 1)
        self.assertIn("未找到", rows[0])


class CommandLineTests(unittest.TestCase):
    def run_cli(self, *argv: str) -> tuple[int, str]:
        out_buffer, err_buffer = StringIO(), StringIO()
        with redirect_stdout(out_buffer), redirect_stderr(err_buffer):
            try:
                build.main(list(argv))
            except SystemExit as error:
                return int(error.code or 0), out_buffer.getvalue() + err_buffer.getvalue()
        return 0, out_buffer.getvalue() + err_buffer.getvalue()

    def test_check_and_data_and_to_md_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            json_path = root / "data.json"
            json_path.write_text(json.dumps(minimal_source(), ensure_ascii=False), encoding="utf-8")
            md_path = root / "data.checklist.md"
            html_from_json = root / "from-json.html"
            html_from_md = root / "from-md.html"
            code, out = self.run_cli("--to-md", str(json_path), "--meta", "task=demo",
                                     "--meta", "status=pending", "--output", str(md_path))
            self.assertEqual(code, 0, out)
            self.assertEqual(self.run_cli("--check", str(md_path))[0], 0)
            self.assertEqual(self.run_cli("--data", str(json_path), "--output", str(html_from_json))[0], 0)
            self.assertEqual(self.run_cli("--data", str(md_path), "--output", str(html_from_md))[0], 0)
            self.assertEqual(html_from_json.read_text(encoding="utf-8"),
                             html_from_md.read_text(encoding="utf-8"))
            self.assertIn("status: pending", md_path.read_text(encoding="utf-8"))

    def test_check_failure_exits_nonzero(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            bad = Path(temp) / "bad.checklist.md"
            bad.write_text("---\nstatus: wat\n---\n", encoding="utf-8")
            code, out = self.run_cli("--check", str(bad))
        self.assertEqual(code, 1)
        self.assertIn("status", out)


if __name__ == "__main__":
    unittest.main()
