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


def _write_full_log(full_text: str, explicit_log: str) -> Path:
    if explicit_log:
        log_path = Path(explicit_log)
    else:
        stamp = time.strftime("%Y%m%d-%H%M%S")
        log_path = Path(tempfile.gettempdir()) / f"maw-tests-{stamp}.log"
    log_path.parent.mkdir(parents=True, exist_ok=True)
    log_path.write_text(full_text, encoding="utf-8")
    return log_path


def _run_one_file_worker(payload: dict) -> dict:
    """子进程入口：跑单个测试文件，静默捕获输出，返回结构化结果。

    在 spawn（Windows/macOS 默认）模式下按文件名重新 discover，
    避免跨进程传递 suite 对象。
    """
    import contextlib
    import os

    os.chdir(ROOT)
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    _config.update(max_chars=payload["max_chars"], max_line=payload["max_line"])

    loader = unittest.TestLoader()
    suite = loader.discover(payload["start_dir"], pattern=payload["pattern"])
    buffer = _CapturedStream()
    runner = unittest.TextTestRunner(
        stream=buffer,
        verbosity=0,
        resultclass=CompactTextTestResult,
    )
    started = time.perf_counter()
    # 测试与被测代码的 print / subprocess 直通 stderr 一律收进缓冲，
    # 避免并行时 10 个 worker 的日志交叉污染主进程输出。
    with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
        result = cast(CompactTextTestResult, runner.run(suite))
    elapsed = time.perf_counter() - started
    return {
        "file": payload["file"],
        "tests": result.testsRun,
        "errors": len(result.errors),
        "failures": len(result.failures),
        "skipped": len(result.skipped),
        "seconds": elapsed,
        "full_text": result.full_text,
    }


def _run_parallel(args) -> int:
    from concurrent.futures import ProcessPoolExecutor, as_completed

    start_dir = str(Path(args.start_dir))
    files = sorted(path.name for path in Path(start_dir).glob(args.pattern))
    if not files:
        print(f"[run_tests] 在 {start_dir} 未发现 {args.pattern}。")
        return 1

    payloads = [
        {
            "file": name,
            "start_dir": start_dir,
            "pattern": name,
            "max_chars": args.max_chars,
            "max_line": args.max_line,
        }
        for name in files
    ]
    workers = min(args.parallel, len(payloads))
    missing_bundles = [
        name
        for name in ("web/editor/boot/editor-bundle.js", "web/launcher/boot/launcher-bundle.js")
        if not (ROOT / name).is_file()
    ]
    if missing_bundles:
        print(
            "[run_tests] 警告：bundle 产物缺失（"
            + "、".join(missing_bundles)
            + "）。多个 worker 会并发触发自动重建并相互冲突；"
            "建议先运行 pnpm install --frozen-lockfile && pnpm run build 再并行。",
            flush=True,
        )
    print(
        f"[run_tests] 并行模式：{len(payloads)} 个文件 × {workers} workers"
        f"（上限 {args.max_chars} 字符 / 单行 {args.max_line}）",
        flush=True,
    )

    wall_start = time.perf_counter()
    total_tests = total_skipped = 0
    failures: list[dict] = []
    completed = 0
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_run_one_file_worker, payload): payload for payload in payloads}
        for future in as_completed(futures):
            payload = futures[future]
            completed += 1
            try:
                outcome = future.result()
            except Exception as error:  # noqa: BLE001 - worker 崩溃不应中断整体
                outcome = {
                    "file": payload["file"], "tests": 0, "errors": 1, "failures": 0,
                    "skipped": 0, "seconds": 0.0,
                    "full_text": f"worker crashed: {error!r}",
                }
            total_tests += outcome["tests"]
            total_skipped += outcome["skipped"]
            status = "OK"
            if outcome["failures"] or outcome["errors"]:
                status = f"FAIL(f={outcome['failures']} e={outcome['errors']})"
                failures.append(outcome)
            print(
                f"[{completed:>3}/{len(payloads)}] {outcome['file']:<44}"
                f" {outcome['tests']:>4} tests {outcome['seconds']:>7.2f}s  {status}",
                flush=True,
            )

    wall = time.perf_counter() - wall_start
    print(
        f"\n[run_tests] 并行完成：{total_tests} tests"
        f"（skipped {total_skipped}），wall {wall:.1f}s，workers {workers}"
    )

    if failures:
        combined = "\n\n".join(
            f"{'=' * 70}\nFAIL: {item['file']}\n{'-' * 70}\n{item['full_text']}"
            for item in failures
        )
        log_path = _write_full_log(combined, args.full_log)
        print(
            f"[run_tests] {len(failures)} 个文件失败；失败输出已压缩，"
            f"未截断文本：{log_path}"
        )
        return 1
    return 0


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
    parser.add_argument(
        "--parallel",
        type=int,
        default=0,
        metavar="N",
        help=(
            "按文件并行跑（N 个 worker 进程）；仅在无 targets 的全量发现模式下生效。"
            "新建 worktree/clone 请先完成一次 bundle 构建（pnpm install && pnpm run build），"
            "否则多个 worker 会并发触发自动重建而相互冲突"
        ),
    )
    args = parser.parse_args(argv)

    _config.update(max_chars=args.max_chars, max_line=args.max_line)
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))

    if args.parallel > 1 and not args.targets:
        return _run_parallel(args)

    if args.parallel > 1 and args.targets:
        print("[run_tests] --parallel 仅支持无 targets 的全量发现模式，本次回退串行。")

    suite = build_suite(args.targets, args.start_dir, args.pattern)
    runner = unittest.TextTestRunner(
        stream=sys.stdout,
        verbosity=args.verbose,
        resultclass=CompactTextTestResult,
    )
    result = cast(CompactTextTestResult, runner.run(suite))

    if result.full_text.strip():
        log_path = _write_full_log(result.full_text, args.full_log)
        print(
            f"[run_tests] 失败输出已压缩（上限 {args.max_chars} 字符 / 单行 {args.max_line}）；"
            f"未截断文本：{log_path}"
        )

    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
