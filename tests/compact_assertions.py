"""压缩大容器断言的失败信息。

unittest 的 assertIn / assertNotIn 失败时会把整个容器 repr 进失败信息。
本仓库多处测试对内联脚本或整页 HTML（数十万字符）做成员断言，单次失败
就会把完整脚本 dump 进测试输出；而排查只需要「哪个 needle 没找到」。

用法：让测试类同时继承本混入（放在 unittest.TestCase 之前）：

    class MyTests(CompactContainerAssertions, unittest.TestCase):
        ...

行为：
- 容器 <= 200 字符：保留 unittest 默认失败信息（小容器直接打印更直观）；
- 容器更大：失败信息只含 needle 摘要与容器规模，不再输出容器本身；
- 其余断言不受影响。
"""

_SMALL_CONTAINER_LIMIT = 200
_NEEDLE_REPR_LIMIT = 200


def _compact_message(member: object, container: object, *, found: bool) -> str:
    try:
        size = len(container)
    except TypeError:
        size = None
    needle = repr(member)
    if len(needle) > _NEEDLE_REPR_LIMIT:
        needle = needle[:_NEEDLE_REPR_LIMIT] + "…"
    if size is None or size <= _SMALL_CONTAINER_LIMIT:
        return (
            f"{member!r} unexpectedly found in {container!r}"
            if found
            else f"{member!r} not found in {container!r}"
        )
    where = "unexpectedly found in" if found else "not found in"
    return f"{needle} {where} container ({size:,} chars)"


class CompactContainerAssertions:
    """见模块 docstring。只覆盖成员断言；其他断言行为不变。

    仅可与 unittest.TestCase 组合使用（依赖其 _formatMessage / fail）。
    """

    def assertIn(self, member, container, msg=None):
        if member not in container:
            self.fail(self._formatMessage(msg, _compact_message(member, container, found=False)))

    def assertNotIn(self, member, container, msg=None):
        if member not in container:
            return
        self.fail(self._formatMessage(msg, _compact_message(member, container, found=True)))
