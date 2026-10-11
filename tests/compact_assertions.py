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

配套：
- 硬保险是 ``scripts/run_tests.py``：它在打印阶段截断任何失败文本（含 assertEqual 的
  大字符串），与测试类怎么写无关；本混入负责把失败信息写得比截断更清楚。
- ``find_unprotected_membership_assertions`` 交给 meta 测试
  （``tests/test_compact_assertions_usage.py``）扫描漏掉混入的测试类，避免「记得加
  混入」全靠人的自觉。
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import Iterable

_SMALL_CONTAINER_LIMIT = 200
_NEEDLE_REPR_LIMIT = 200

# 命中这些调用的赋值，视为「大容器来源」（内联脚本、整页 HTML、HTTP 响应等）。
_SOURCE_CALL_MARKERS = (
    "read_text(",
    "read_bytes(",
    "getvalue(",
    "urlopen(",
    ".read(",
    "check_output(",
    "subprocess.run(",
    "Popen(",
)


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


def _big_container_vars(node: ast.AST) -> set[str]:
    """收集「由读取大文本 / 响应的调用赋值而来」的局部变量名。"""
    names: set[str] = set()
    for child in ast.walk(node):
        if not isinstance(child, ast.Assign) or not isinstance(child.value, ast.Call):
            continue
        call = ast.unparse(child.value)
        if not any(marker in call for marker in _SOURCE_CALL_MARKERS):
            continue
        for target in child.targets:
            if isinstance(target, ast.Name):
                names.add(target.id)
    return names


def _membership_assertion_methods(cls: ast.ClassDef) -> list[str]:
    """返回类中「对大容器局部变量做成员断言」的方法名。"""
    hits: list[str] = []
    for fn in cls.body:
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        big = _big_container_vars(fn)
        if not big:
            continue
        for child in ast.walk(fn):
            if not isinstance(child, ast.Call) or not isinstance(child.func, ast.Attribute):
                continue
            if child.func.attr not in ("assertIn", "assertNotIn") or len(child.args) < 2:
                continue
            container = child.args[1]
            if isinstance(container, ast.Name) and container.id in big:
                hits.append(fn.name)
                break
    return hits


def find_unprotected_membership_assertions(
    paths: Iterable[Path | str],
    *,
    mixin_name: str = "CompactContainerAssertions",
) -> list[tuple[Path, str, list[str]]]:
    """找出对大容器做成员断言、却没有继承压缩混入的测试类。

    只识别确定性模式：测试方法里先把「读取大文本 / 响应」的调用结果赋给局部变量，
    再对该变量做 ``self.assertIn`` / ``self.assertNotIn``。返回
    ``[(path, class_name, [方法名, ...]), ...]``，按路径排序；无命中则为空列表。

    其余断言（``assertEqual`` 的大字符串等）由 ``scripts/run_tests.py`` 的打印截断兜底。
    """
    offenders: list[tuple[Path, str, list[str]]] = []
    for raw in paths:
        path = Path(raw)
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.ClassDef):
                continue
            if any(mixin_name in ast.unparse(base) for base in node.bases):
                continue
            methods = _membership_assertion_methods(node)
            if methods:
                offenders.append((path, node.name, methods))
    offenders.sort(key=lambda item: (str(item[0]), item[1]))
    return offenders
