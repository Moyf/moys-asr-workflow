#!/usr/bin/env python3
"""运行 unittest，并把失败输出压缩到可读规模。

背景
----
unittest 的 ``assertIn`` / ``assertEqual`` 失败会把整个容器 repr 进失败信息。本仓库
多处测试对内联脚本或整页 HTML（数十万字符）做成员断言，单次失败就会把完整内容写进
终端、agent 上下文与 CI 日志，而排查只需要「哪个 needle 没找到」。unittest 把这类
失败打印成**一整行**，所以 ``grep`` / ``head`` / ``tail`` 这类下游过滤救不了它——
必须在生成端截断。

做法
----
:class:`CompactTextTestResult` 只在**打印**阶段截断失败文本：内存里仍保留未截断的
内容，并写入日志文件。截断与测试类的写法无关——``assertIn`` / ``assertNotIn`` /
``assertEqual`` 或任何自定义断言的失败都会被压到上限之内。

用法
----
    uv run --no-sync python scripts/run_tests.py                 # 全量 tests/test_*.py
    uv run --no-sync python scripts/run_tests.py tests/test_gui_web.py
    uv run --no-sync python scripts/run_tests.py tests.test_gui_web.GuiWebBridgeTests
    uv run --no-sync python scripts/run_tests.py -v --full-log out.log

退出码与 ``python -m unittest`` 一致：全部通过为 0，否则为 1。
"""

from __future__ import annotations

import argparse
import io
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MAX_CHARS = 4000
DEFAULT_MAX_LINE = 400

_config = {"max_chars": DEFAULT_MAX_CHARS, "max_line": DEFAULT_MAX_LINE}


def compact_text(
    text: str,
    *,
    max_chars: int | None = None,
    max_line: int | None = None,
) -> str:
    """折叠超长行，并把整段文本压到 ``max_chars`` 以内（保留头尾，中间省略）。"""
    if max_chars is None:
        max_chars = _config["max_chars"]
    if max_line is None:
        max_line = _config["max_line"]
    folded = []
    for line in text.splitlines():
        if max_line and len(line) > max_line:
            half = max(1, max_line // 2)
            folded.append(
                f"{line[:half]} … [本行省略 {len(line) - 2 * half:,} 字符] … {line[-half:]}"
            )
        else:
            folded.append(line)
    text = "\n".join(folded)
    if max_chars and len(text) > max_chars:
        half = max(1, max_chars // 2)
        text = (
            f"{text[:half]}\n"
            f"… [中间省略 {len(text) - 2 * half:,} 字符，完整输出见日志文件] …\n"
            f"{text[-half:]}"
        )
    return text


class _CapturedStream(io.StringIO):
    """TextTestResult 期望的流带有 ``writeln``；StringIO 补上即可当捕获缓冲。"""

    def writeln(self, arg=None):
        self.write("" if arg is None else f"{arg}\n")


class CompactTextTestResult(unittest.TextTestResult):
    """打印时截断失败文本；``full_text`` 保留未截断的原始内容。"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.full_text = ""

    def printErrors(self):
        buffer = _CapturedStream()
        stream = self.stream
        self.stream = cast(Any, buffer)
        try:
            super().printErrors()
        finally:
            self.stream = stream
        self.full_text = buffer.getvalue()
        stream.write(compact_text(self.full_text))


def _to_module_name(target: str) -> str:
    """把 ``tests/test_x.py`` 之类的路径写法转成点号模块名；其余原样返回。"""
    path = Path(target)
    if path.suffix != ".py":
        return target
    if path.is_absolute():
        try:
            path = path.relative_to(ROOT)
        except ValueError:
            pass
    return ".".join(path.with_suffix("").parts)


def build_suite(targets, start_dir: str, pattern: str):
    loader = unittest.TestLoader()
    if not targets:
        return loader.discover(str(start_dir), pattern=pattern)
    suite = unittest.TestSuite()
    for target in targets:
        suite.addTests(loader.loadTestsFromName(_to_module_name(target)))
    return suite


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(
        description="运行 unittest，并把失败输出压缩到可读规模（完整文本写入日志文件）。",
    )
    parser.add_argument("targets", nargs="*", help="测试文件路径或点号名称；留空则发现 tests/ 下全部")
    parser.add_argument("--start-dir", default=str(ROOT / "tests"), help="发现模式下的起始目录")
    parser.add_argument("--pattern", default="test_*.py", help="发现模式下的文件匹配")
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS, help="单条失败保留的总字符上限")
    parser.add_argument("--max-line", type=int, default=DEFAULT_MAX_LINE, help="单行字符上限")
    parser.add_argument("--full-log", default="", help="未截断输出的写法路径（默认写入临时目录）")
    parser.add_argument("-v", "--verbose", action="count", default=1, help="提高 unittest 详细度")
    args = parser.parse_args(argv)

    _config.update(max_chars=args.max_chars, max_line=args.max_line)
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))

    suite = build_suite(args.targets, args.start_dir, args.pattern)
    runner = unittest.TextTestRunner(
        stream=sys.stdout,
        verbosity=args.verbose,
        resultclass=CompactTextTestResult,
    )
    result = cast(CompactTextTestResult, runner.run(suite))

    if result.full_text.strip():
        if args.full_log:
            log_path = Path(args.full_log)
        else:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            log_path = Path(tempfile.gettempdir()) / f"maw-tests-{stamp}.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(result.full_text, encoding="utf-8")
        print(
            f"[run_tests] 失败输出已压缩（上限 {args.max_chars} 字符 / 单行 {args.max_line}）；"
            f"未截断文本：{log_path}"
        )

    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
