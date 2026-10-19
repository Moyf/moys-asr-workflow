"""``scripts/run_tests.py`` 的输出压缩契约。

这些用例就是「测试失败不再刷屏」这条保证的守门人：不依赖任何测试类的写法，
只看 runner 打印出来的东西有没有被压到上限之内，同时确认未截断文本仍被保留。
"""

from __future__ import annotations

from tests.compact_assertions import CompactContainerAssertions

import io
import pathlib
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.run_tests import (  # noqa: E402
    CompactTextTestResult,
    _run_one_file_worker,
    _to_module_name,
    compact_text,
)


class CompactTextTests(unittest.TestCase):
    def test_long_single_line_is_folded(self):
        # unittest 的 assertIn 失败就是这样一整行：容器 repr 全在行内。
        line = "AssertionError: 'needle' not found in '" + "A" * 200_000 + "'"
        compacted = compact_text(line, max_chars=4000, max_line=400)
        self.assertLess(len(compacted), 5000, "超长单行必须被折叠到上限以内")
        self.assertIn("not found in", compacted, "失败信息首部应保留可读上下文")
        self.assertIn("[本行省略", compacted, "折叠处应标注省略字符数")

    def test_short_text_is_untouched(self):
        text = "FAIL: test_small (tests.test_x.Case.test_small)\nAssertionError: 1 != 2"
        self.assertEqual(compact_text(text, max_chars=4000, max_line=400), text)

    def test_many_lines_are_capped_by_total_budget(self):
        text = "\n".join(f"AssertionError: line {index}" for index in range(5000))
        compacted = compact_text(text, max_chars=4000, max_line=400)
        self.assertLess(len(compacted), 5000, "多行失败文本也受总字符上限约束")
        self.assertIn("中间省略", compacted)

    def test_module_name_conversion(self):
        self.assertEqual(_to_module_name("tests/test_gui_web.py"), "tests.test_gui_web")
        self.assertEqual(
            _to_module_name("tests.test_gui_web.GuiWebBridgeTests"),
            "tests.test_gui_web.GuiWebBridgeTests",
        )


class ParallelWorkerTests(unittest.TestCase):
    def test_worker_runs_only_the_requested_nested_file(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "__init__.py").write_text("", encoding="utf-8")
            nested = root / "nested"
            nested.mkdir()
            (nested / "__init__.py").write_text("", encoding="utf-8")
            (root / "test_same.py").write_text(
                "\n".join([
                    "import unittest",
                    "class RootCase(unittest.TestCase):",
                    "    def test_root(self): self.fail('wrong file ran')",
                ]),
                encoding="utf-8",
            )
            target = nested / "test_same.py"
            target.write_text(
                "\n".join([
                    "import unittest",
                    "class NestedCase(unittest.TestCase):",
                    "    def test_nested(self): pass",
                    "    @unittest.expectedFailure",
                    "    def test_unexpected_success_is_failure(self): pass",
                ]),
                encoding="utf-8",
            )
            outcome = _run_one_file_worker(
                {
                    "file": "nested/test_same.py",
                    "path": str(target),
                    "max_chars": 4000,
                    "max_line": 400,
                }
            )
        self.assertEqual(outcome["tests"], 2)
        self.assertFalse(outcome["success"], "unexpectedSuccess 必须使 worker 失败")
        self.assertEqual(outcome["failures"], 0)
        self.assertIn("unexpected success", outcome["full_text"].lower())

    def test_worker_reports_broken_file_as_error(self):
        """语法损坏的文件必须报 error，而不是被文件过滤静默吞成 0 用例假绿。"""
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            broken = root / "test_broken.py"
            broken.write_text("import unittest\nclass Broken(:\n", encoding="utf-8")
            outcome = _run_one_file_worker(
                {
                    "file": "test_broken.py",
                    "path": str(broken),
                    "max_chars": 4000,
                    "max_line": 400,
                }
            )
        self.assertEqual(outcome["tests"], 1, "_FailedTest 占位用例应保留并执行")
        self.assertFalse(outcome["success"], "损坏文件必须使 worker 失败")
        self.assertEqual(outcome["errors"], 1)

    def test_worker_preserves_package_relative_imports(self):
        """嵌套包内测试的相对导入必须可用：worker 以发现根为 top_level 导入。"""
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            (root / "__init__.py").write_text("", encoding="utf-8")
            feature = root / "feature"
            feature.mkdir()
            (feature / "__init__.py").write_text("", encoding="utf-8")
            (feature / "helper.py").write_text("VALUE = 41\n", encoding="utf-8")
            (feature / "test_relative.py").write_text(
                "\n".join([
                    "import unittest",
                    "from .helper import VALUE",
                    "class RelativeCase(unittest.TestCase):",
                    "    def test_value(self): self.assertEqual(VALUE + 1, 42)",
                ]),
                encoding="utf-8",
            )
            outcome = _run_one_file_worker(
                {
                    "file": "feature/test_relative.py",
                    "path": str(feature / "test_relative.py"),
                    "root": str(root),
                    "max_chars": 4000,
                    "max_line": 400,
                }
            )
        self.assertTrue(outcome["success"], outcome["full_text"])
        self.assertEqual(outcome["tests"], 1)
        self.assertEqual(outcome["errors"], 0)
        self.assertEqual(outcome["failures"], 0)


class CompactResultTests(CompactContainerAssertions, unittest.TestCase):
    def test_result_prints_compact_but_keeps_full_text(self):
        class HugeContainerFailure(unittest.TestCase):
            def test_dumps_container(self):
                self.assertIn("needle-that-is-missing", "x" * 300_000)

        stream = io.StringIO()
        suite = unittest.TestLoader().loadTestsFromTestCase(HugeContainerFailure)
        result = unittest.TextTestRunner(
            stream=stream,
            verbosity=0,
            resultclass=CompactTextTestResult,
        ).run(suite)

        printed = stream.getvalue()
        self.assertEqual(len(result.failures), 1, "失败必须被记录（不是为了静音而吞掉）")
        self.assertLess(len(printed), 6000, "打印输出应被压缩")
        self.assertIn("needle-that-is-missing", printed, "压缩后仍要能看出缺的是哪个 needle")
        self.assertGreater(len(result.full_text), 200_000, "未截断文本应保留在内存中供写日志")


if __name__ == "__main__":
    unittest.main()
