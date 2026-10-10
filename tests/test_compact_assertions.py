import unittest

from tests.compact_assertions import CompactContainerAssertions


class CompactContainerAssertionTests(CompactContainerAssertions, unittest.TestCase):
    def test_failure_message_for_big_container_stays_compact(self):
        haystack = "x" * 100_000
        with self.assertRaises(AssertionError) as caught:
            self.assertIn("needle-123", haystack)
        message = str(caught.exception)
        self.assertIn("needle-123", message)
        self.assertIn("100,000", message)
        # 容器本体不得泄漏进失败信息
        self.assertNotIn("xxxxx", message)

    def test_failure_message_for_small_container_keeps_default_detail(self):
        with self.assertRaises(AssertionError) as caught:
            self.assertIn("needle", "short body")
        message = str(caught.exception)
        self.assertIn("'short body'", message)

    def test_not_in_failure_for_big_container_stays_compact(self):
        haystack = "y" * 50_000
        with self.assertRaises(AssertionError) as caught:
            self.assertNotIn("yyy", haystack)
        message = str(caught.exception)
        self.assertIn("unexpectedly found", message)
        self.assertIn("50,000", message)
        # 容器本体（50000 个 y）不得泄漏；needle 'yyy' 会合法出现
        self.assertNotIn("yyyyy", message)

    def test_passing_assertions_do_not_raise(self):
        self.assertIn("a", "abc")
        self.assertNotIn("z", "abc")

    def test_custom_message_is_preserved(self):
        with self.assertRaises(AssertionError) as caught:
            self.assertIn("needle", "x" * 1_000, "补充说明")
        self.assertIn("补充说明", str(caught.exception))
