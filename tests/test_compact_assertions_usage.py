"""meta 测试：对大容器做成员断言的测试类必须继承压缩混入。

失败时不会再 dump 整个容器 —— 这条规则以前只写在 AGENTS.md 里，靠人记得；
漏掉混入的类在失败时会刷出数十万字符，所以这里把它变成红灯。

真跑测试时的硬保险仍是 ``scripts/run_tests.py`` 的打印截断（见
``tests/test_run_tests_runner.py``）；本测试管的是失败信息可读性。
"""

from __future__ import annotations

import pathlib
import sys
import tempfile
import textwrap
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from tests.compact_assertions import find_unprotected_membership_assertions  # noqa: E402


class CompactAssertionUsageTests(unittest.TestCase):
    def test_big_container_assertions_use_compact_mixin(self):
        offenders = find_unprotected_membership_assertions(sorted((ROOT / "tests").glob("test_*.py")))
        detail = "\n".join(
            f"  {path.relative_to(ROOT)} :: {name} ({len(methods)} 处，如 {methods[0]}())"
            for path, name, methods in offenders
        )
        self.assertEqual(
            offenders,
            [],
            "以下测试类对大容器做成员断言但未继承 CompactContainerAssertions，"
            "失败时会把完整容器 dump 进输出；改成 "
            "`class X(CompactContainerAssertions, unittest.TestCase)` 即可：\n" + detail,
        )


class CompactAssertionScannerTests(unittest.TestCase):
    """扫描器自身的行为：报确定的模式，不误报已继承混入的类。"""

    def _scan(self, source: str):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / "test_sample.py"
            path.write_text(textwrap.dedent(source), encoding="utf-8")
            return find_unprotected_membership_assertions([path])

    def test_reports_class_without_mixin(self):
        offenders = self._scan(
            """
            import unittest

            class BadTests(unittest.TestCase):
                def test_needle(self):
                    script = (ROOT / "web/launcher/launcher.js").read_text(encoding="utf-8")
                    self.assertIn("needle", script)
            """
        )
        self.assertEqual([(name, methods) for _, name, methods in offenders], [("BadTests", ["test_needle"])])

    def test_ignores_class_with_mixin(self):
        offenders = self._scan(
            """
            import unittest
            from tests.compact_assertions import CompactContainerAssertions

            class GoodTests(CompactContainerAssertions, unittest.TestCase):
                def test_needle(self):
                    script = (ROOT / "web/launcher/launcher.js").read_text(encoding="utf-8")
                    self.assertIn("needle", script)
            """
        )
        self.assertEqual(offenders, [])

    def test_ignores_small_container_assertions(self):
        offenders = self._scan(
            """
            import unittest

            class SmallTests(unittest.TestCase):
                def test_labels(self):
                    labels = some_source().read_text(encoding="utf-8")
                    self.assertIn("needle", "abcd")
                    self.assertEqual(labels, "abcd")
            """
        )
        self.assertEqual(offenders, [], "断言目标不是大容器局部变量时不应报错")


if __name__ == "__main__":
    unittest.main()
