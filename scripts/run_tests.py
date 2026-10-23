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
import json
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import Any, cast

if __package__:
    from .test_policy import PYTHON_PACKS, allowed_platform_skip, python_pack
else:
    from test_policy import PYTHON_PACKS, allowed_platform_skip, python_pack

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


def cases(suite):
    for entry in suite:
        if isinstance(entry, unittest.TestSuite):
            yield from cases(entry)
        else:
            yield entry


def filter_pack(suite, pack):
    return unittest.TestSuite(case for case in cases(suite)
                              if python_pack(case.id()) == pack or isinstance(case, unittest.loader._FailedTest)
                              or type(case).__name__ == "ModuleSkipped")


def pack_suite(pack: str, start_dir: str, pattern: str):
    # Let unittest execute package hooks, imported cases and dynamically created
    # suites before selecting ownership. Source inspection cannot predict them.
    return filter_pack(build_suite([], start_dir, pattern), pack)


def result_report(result, selected_ids):
    return {"selected_ids": selected_ids, "run": result.testsRun,
            "failures": len(result.failures), "errors": len(result.errors),
            "skips": [{"id": test.id(), "reason": reason,
                       "platform_not_applicable": allowed_platform_skip(test.id(), reason)}
                      for test, reason in result.skipped],
            "expected_failures": len(result.expectedFailures),
            "unexpected_successes": len(result.unexpectedSuccesses)}


def report_code(report, required):
    return int(bool(report["failures"] or report["errors"] or report["unexpected_successes"]
                    or required and (report["expected_failures"]
                                     or any(not skip["platform_not_applicable"] for skip in report["skips"]))))


def write_report(args, report):
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.required and any(not skip["platform_not_applicable"] for skip in report["skips"]):
        print("[run_tests] required gate failed: unsupported skips; inspect report")
    if args.required and report["expected_failures"]:
        print("[run_tests] required gate failed: expected failures remain unverified")


def _write_full_log(full_text: str, explicit_log: str, report: Path | None = None) -> Path:
    if explicit_log:
        log_path = Path(explicit_log)
    elif report:
        log_path = report.with_suffix('.log')
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
    import importlib
    import os

    os.chdir(ROOT)
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    _config.update(max_chars=payload["max_chars"], max_line=payload["max_line"])

    loader = unittest.TestLoader()
    target_path = Path(payload["path"]).resolve()
    start_dir = str(target_path.parent)
    # 包模式：目标位于发现根的包链内（沿途都有 __init__.py）时，以发现根为
    # top_level 导入，模块名保留包前缀（feature.test_example），嵌套测试里的
    # 相对导入（from .helper import ...）才能正常工作；平铺目录维持原行为。
    discovery_root = Path(payload.get("root") or start_dir).resolve()

    def _inside_package_chain(child: Path, ancestor: Path) -> bool:
        if ancestor not in child.parents:
            return False
        node = child.parent
        while True:
            if not (node / "__init__.py").is_file():
                return False
            if node == ancestor:
                return True
            node = node.parent

    if _inside_package_chain(target_path, discovery_root):
        top_level = discovery_root
    else:
        top_level = target_path.parent
    module_name = ".".join(target_path.relative_to(top_level).with_suffix("").parts)
    loaded = sys.modules.get(module_name)
    if Path(getattr(loaded, "__file__", "")).resolve() != target_path:
        sys.modules.pop(module_name, None)
    if str(top_level) in sys.path:
        sys.path.remove(str(top_level))
    sys.path.insert(0, str(top_level))
    # Load this exact module without recursively discovering other files. Keep
    # its complete suite: imported TestCases and load_tests-created tests (e.g.
    # FunctionTestCase) need not have this module as their class's origin.
    # Pass the discovery pattern through to load_tests just as discover does.
    buffer = _CapturedStream()
    started = time.perf_counter()
    fd_output = ""
    # 测试与被测代码的 print / subprocess 直通 fd 1/2 一律重定向到临时
    # 文件（redirect_* 只拦 Python 层流，拦不住子进程继承的 fd），避免
    # 并行时多 worker 日志交叉污染主进程输出。
    with tempfile.TemporaryFile() as fd_capture:
        saved_stdout, saved_stderr = os.dup(1), os.dup(2)
        try:
            os.dup2(fd_capture.fileno(), 1)
            os.dup2(fd_capture.fileno(), 2)
            with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
                try:
                    module = importlib.import_module(module_name)
                    suite = loader.loadTestsFromModule(module, pattern=payload.get("pattern", target_path.name))
                except unittest.SkipTest as error:
                    suite = unittest.loader._make_skipped_test(module_name, error, unittest.TestSuite)
                except BaseException as error:  # import-time SystemExit(0) must not exit the parent successfully
                    suite = unittest.TestSuite([unittest.loader._FailedTest(module_name, error)])
                selected_ids = [case.id() for case in cases(suite)]
                runner = unittest.TextTestRunner(
                    stream=buffer,
                    verbosity=0,
                    resultclass=CompactTextTestResult,
                )
                result = cast(CompactTextTestResult, runner.run(suite))
        finally:
            os.dup2(saved_stdout, 1)
            os.dup2(saved_stderr, 2)
            os.close(saved_stdout)
            os.close(saved_stderr)
            fd_capture.seek(0)
            fd_output = fd_capture.read().decode("utf-8", errors="replace")
    elapsed = time.perf_counter() - started
    return {
        **result_report(result, selected_ids),
        "file": payload["file"],
        "pid": os.getpid(),
        "tests": result.testsRun,
        "errors": len(result.errors),
        "failures": len(result.failures),
        "skipped": len(result.skipped),
        "seconds": elapsed,
        "full_text": result.full_text,
        "test_output": buffer.getvalue() + fd_output,
        "success": result.wasSuccessful(),
    }


def _run_parallel(args) -> int:
    from concurrent.futures import ProcessPoolExecutor, as_completed

    # 相对路径在 worker 里 os.chdir(ROOT) 后语义会变：主进程先解析为绝对路径
    start_dir = str(Path(args.start_dir).resolve())
    # Package __init__ and load_tests hooks control standard discovery, including
    # errors in packages without test_*.py files. File sharding cannot preserve
    # those hooks, so use the unchanged serial path whenever subpackages exist.
    if any(path.parent != Path(start_dir) for path in Path(start_dir).rglob("__init__.py")):
        print("[run_tests] 发现测试子包，为保留包初始化与 load_tests 语义，本次回退串行。")
        return _run_serial(args)
    files = sorted(
        str(path.relative_to(start_dir))
        for path in Path(start_dir).glob(args.pattern)
        if path.is_file()
    )
    if not files:
        print(f"[run_tests] 在 {start_dir} 未发现 {args.pattern}。")
        return 1

    payloads = [
        {
            # discover 的 pattern 匹配 basename；file 保留相对路径用于展示与聚合
            "file": name,
            "path": str((Path(start_dir) / name).resolve()),
            "root": start_dir,
            "pattern": args.pattern,
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
            "[run_tests] 提示：bundle 产物缺失（"
            + "、".join(missing_bundles)
            + "）。跨进程锁会保证只构建一次，但首个触发构建的 worker"
            "会被同步拖慢；建议先运行 pnpm install --frozen-lockfile"
            " && pnpm run build 让各 worker 立即命中产物。",
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
    outcomes = {}
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
                    "test_output": "", "success": False,
                    "selected_ids": [], "run": 0, "skips": [],
                    "expected_failures": 0, "unexpected_successes": 0,
                }
            outcomes[payload["file"]] = outcome
            total_tests += outcome["tests"]
            total_skipped += outcome["skipped"]
            status = "OK"
            # 与串行 TextTestResult.wasSuccessful() 保持一致；包含 unexpectedSuccesses
            if not outcome["success"] or report_code(outcome, args.required):
                if outcome["failures"] or outcome["errors"]:
                    status = f"FAIL(f={outcome['failures']} e={outcome['errors']})"
                else:
                    status = "FAIL(required or unexpected success)"
                failures.append(outcome)
            print(
                f"[{completed:>3}/{len(payloads)}] {outcome['file']:<44}"
                f" {outcome['tests']:>4} tests {outcome['seconds']:>7.2f}s  {status}",
                flush=True,
            )

    wall = time.perf_counter() - wall_start
    ordered = [outcomes[payload["file"]] for payload in payloads]
    report = {"selected_ids": [identity for item in ordered for identity in item["selected_ids"]],
              **{key: sum(item[key] for item in ordered) for key in
                 ("run", "failures", "errors", "expected_failures", "unexpected_successes")},
              "skips": [skip for item in ordered for skip in item["skips"]],
              "mode": "parallel", "workers": workers, "wall_seconds": wall,
              "files": [{key: value for key, value in item.items()
                         if key not in {"full_text", "test_output"}} for item in ordered]}
    complete_log = "\n\n".join(
        f"=== {item['file']} ===\n{item['test_output']}\n{item['full_text']}"
        for item in ordered)
    log_path = _write_full_log(complete_log, args.full_log, args.report)
    report["full_log"] = str(log_path.resolve())
    report["exit_code"] = int(bool(failures or not report["selected_ids"]))
    write_report(args, report)
    print(
        f"\n[run_tests] 并行完成：{total_tests} tests"
        f"（skipped {total_skipped}），wall {wall:.1f}s，workers {workers}"
    )

    if failures:
        combined = "\n\n".join(
            f"{'=' * 70}\nFAIL: {item['file']}\n{'-' * 70}\n{item['full_text']}"
            + (
                f"\n{'-' * 70}\n[测试自身输出]\n{item['test_output']}"
                if item.get("test_output", "").strip()
                else ""
            )
            for item in failures
        )
        print(compact_text(combined))
        print(
            f"[run_tests] {len(failures)} 个文件失败；失败输出已压缩，"
            f"未截断文本：{log_path}"
        )
        return 1
    return report["exit_code"]


def _run_serial(args) -> int:
    started = time.perf_counter()
    import contextlib
    import os

    buffer = _CapturedStream()
    runner = unittest.TextTestRunner(stream=buffer, verbosity=args.verbose,
                                    resultclass=CompactTextTestResult)
    with tempfile.TemporaryFile() as capture:
        saved_stdout, saved_stderr = os.dup(1), os.dup(2)
        try:
            sys.stdout.flush()
            sys.stderr.flush()
            os.dup2(capture.fileno(), 1)
            os.dup2(capture.fileno(), 2)
            with contextlib.redirect_stdout(buffer), contextlib.redirect_stderr(buffer):
                suite = pack_suite(args.pack, args.start_dir, args.pattern) if args.pack else build_suite(args.targets, args.start_dir, args.pattern)
                selected_ids = [case.id() for case in cases(suite)]
                result = cast(CompactTextTestResult, runner.run(suite))
        finally:
            os.dup2(saved_stdout, 1)
            os.dup2(saved_stderr, 2)
            os.close(saved_stdout)
            os.close(saved_stderr)
        capture.seek(0)
        complete_log = buffer.getvalue() + capture.read().decode("utf-8", errors="replace")
    print(compact_text(buffer.getvalue()))
    log_path = _write_full_log(complete_log + result.full_text, args.full_log, args.report)
    print(f"[run_tests] 完整输出：{log_path}")

    report = result_report(result, selected_ids)
    code = report_code(report, args.required) or int(not selected_ids)
    report.update(exit_code=code, mode="serial", workers=1, wall_seconds=time.perf_counter() - started,
                  full_log=str(log_path.resolve()))
    write_report(args, report)
    return code


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
    parser.add_argument("--pack", choices=PYTHON_PACKS, help="按成本/边界分组；不改变无参数的历史全量入口")
    parser.add_argument("--required", action="store_true", help="依赖、编码器和夹具缺失导致的 skip 视为失败")
    parser.add_argument("--report", type=Path, help="机器可读结果，包含每个 skip 的原因")
    parser.add_argument("-v", "--verbose", action="count", default=1, help="提高 unittest 详细度")
    parser.add_argument(
        "--parallel",
        type=int,
        default=0,
        metavar="N",
        help=(
            "按文件并行跑（N 个 worker 进程），不拆分显式 targets；"
            "required/报告保留；分组及含测试子包时回退串行以保留包初始化与 load_tests。"
            "bundle 产物缺失时跨进程锁保证只自动构建一次，但首个触发构建的 worker"
            "会被同步拖慢；新建 worktree/clone 建议先 pnpm install --frozen-lockfile"
            " && pnpm run build"
        ),
    )
    args = parser.parse_args(argv)

    _config.update(max_chars=args.max_chars, max_line=args.max_line)
    if str(ROOT) not in sys.path:
        sys.path.insert(0, str(ROOT))
    sys.path.insert(0, str(ROOT / "tests"))
    if args.pack and args.targets:
        parser.error("--pack 与显式 targets 不能混用")

    if args.parallel > 1:
        if not args.targets and not args.pack:
            return _run_parallel(args)

    if args.parallel > 1 and args.pack:
        print("[run_tests] 分组发现保留 unittest hooks，本次串行执行。")

    if args.parallel > 1 and args.targets:
        print("[run_tests] --parallel 不拆分显式 targets，本次回退串行。")

    return _run_serial(args)


if __name__ == "__main__":
    raise SystemExit(main())
