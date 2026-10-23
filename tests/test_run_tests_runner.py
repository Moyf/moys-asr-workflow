"""``scripts/run_tests.py`` 的输出压缩契约。

这些用例就是「测试失败不再刷屏」这条保证的守门人：不依赖任何测试类的写法，
只看 runner 打印出来的东西有没有被压到上限之内，同时确认未截断文本仍被保留。
"""

from __future__ import annotations

from tests.compact_assertions import CompactContainerAssertions

import io
import json
import pathlib
import subprocess
import sys
import tempfile
import textwrap
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.run_tests import (  # noqa: E402
    CompactTextTestResult,
    _run_one_file_worker,
    _to_module_name,
    pack_suite,
    cases,
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
    def test_pack_keeps_dynamic_cases_and_filters_only_other_packs(self):
        with tempfile.TemporaryDirectory() as temporary:
            target = pathlib.Path(temporary) / 'test_mixed.py'
            target.write_text(textwrap.dedent('''
                import unittest
                class Case(unittest.TestCase):
                    def test_fast(self): pass
                    def test_real_preflight_never_loads_model_or_writes_artifacts(self): pass
                def generated(): pass
                def load_tests(loader, tests, pattern):
                    assert pattern in (None, 'test_mixed.py'), repr(pattern)
                    tests.addTest(unittest.FunctionTestCase(generated))
                    return tests
            '''), encoding='utf-8')
            payload = {'file': target.name, 'path': str(target), 'max_chars': 4000, 'max_line': 400}
            whole = _run_one_file_worker(payload)
            common = [case.id() for case in cases(pack_suite('common', str(target.parent), target.name))]
            media = [case.id() for case in cases(pack_suite('media', str(target.parent), target.name))]
        self.assertEqual(whole['tests'], 3)
        self.assertEqual(len(common), 2)
        self.assertEqual(len(media), 1)
        self.assertEqual(sorted(common + media), sorted(whole['selected_ids']))
        self.assertTrue(whole['success'])

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


class ParallelCommandTests(CompactContainerAssertions, unittest.TestCase):
    def run_discovery(self, root, *, parallel, required=False, full_log=True):
        return subprocess.run(
            [
                sys.executable, str(ROOT / "scripts/run_tests.py"),
                "--start-dir", str(root), "--parallel", str(parallel),
                *(["--full-log", str(root / "failures.log")] if full_log else []),
                "--report", str(root / f'report-{parallel}.json'),
                *(['--required'] if required else []),
            ],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )

    def write_source(self, root, name, source):
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(textwrap.dedent(source), encoding="utf-8", newline="\n")

    def test_package_discovery_errors_are_not_skipped(self):
        # These packages have no test_*.py; enumerating files alone misses them.
        for source, message in (
            ("raise RuntimeError('package import failed')", "package import failed"),
            (
                "def load_tests(loader, tests, pattern):\n"
                "    raise RuntimeError('package hook failed')",
                "package hook failed",
            ),
        ):
            with self.subTest(message=message), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                self.write_source(root, "test_ok.py", """
                    import unittest
                    class Case(unittest.TestCase):
                        def test_ok(self): pass
                """)
                self.write_source(root, "feature/__init__.py", source)
                serial = self.run_discovery(root, parallel=0)
                parallel = self.run_discovery(root, parallel=2)
                self.assertEqual(serial.returncode, 1, serial.stdout)
                self.assertEqual(parallel.returncode, 1, parallel.stdout)
                self.assertIn(message, parallel.stdout)
                self.assertIn("回退串行", parallel.stdout)
                self.assertIn("Ran 2 tests", parallel.stdout)

    def test_file_load_tests_keeps_function_case(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.write_source(root, "test_function.py", """
                import unittest
                def fails():
                    raise AssertionError('function case failed')
                def load_tests(loader, tests, pattern):
                    assert pattern == 'test_*.py', repr(pattern)
                    return unittest.TestSuite([unittest.FunctionTestCase(fails)])
            """)
            serial = self.run_discovery(root, parallel=0)
            parallel = self.run_discovery(root, parallel=2, full_log=False)
            self.assertEqual(serial.returncode, 1, serial.stdout)
            self.assertEqual(parallel.returncode, 1, parallel.stdout)
            self.assertIn("并行完成：1 tests", parallel.stdout)
            self.assertIn("function case failed", (root / "failures.log").read_text(encoding="utf-8"))
            self.assertIn("function case failed", (root / "report-2.log").read_text(encoding="utf-8"))
            serial_report = json.loads((root / 'report-0.json').read_text(encoding='utf-8'))
            parallel_report = json.loads((root / 'report-2.json').read_text(encoding='utf-8'))
            for key in ('selected_ids', 'run', 'errors', 'failures', 'skips', 'expected_failures', 'unexpected_successes', 'exit_code'):
                self.assertEqual(serial_report[key], parallel_report[key], key)

    def test_flat_discovery_really_runs_in_worker_processes(self):
        # multiprocessing.parent_process() exists only inside pool workers. This
        # catches unconditional fallback and imported-TestCase filtering alike.
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.write_source(root, "helper.py", """
                import multiprocessing
                import unittest
                class ImportedCase(unittest.TestCase):
                    def test_imported(self):
                        self.assertIsNotNone(multiprocessing.parent_process())
            """)
            self.write_source(root, "test_imported.py", "from helper import ImportedCase\n")
            self.write_source(root, "test_local.py", """
                import multiprocessing
                import unittest
                class LocalCase(unittest.TestCase):
                    def test_local(self):
                        self.assertIsNotNone(multiprocessing.parent_process())
            """)
            parallel = self.run_discovery(root, parallel=2)
            self.assertEqual(parallel.returncode, 0, parallel.stdout)
            self.assertIn("并行完成：2 tests", parallel.stdout)
            report = json.loads((root / 'report-2.json').read_text(encoding='utf-8'))
            self.assertEqual(report['mode'], 'parallel')
            self.assertEqual(report['run'], len(report['selected_ids']))
            self.assertTrue(all(item['pid'] for item in report['files']))

    def test_class_setup_skip_matches_serial_and_parallel(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.write_source(root, 'test_class_skip.py', """
                import unittest
                class Case(unittest.TestCase):
                    @classmethod
                    def setUpClass(cls):
                        raise unittest.SkipTest('optional class capability unavailable')
                    def test_never_runs(self):
                        self.fail('class setup must skip this case')
            """)
            for required, expected_code in ((False, 0), (True, 1)):
                with self.subTest(required=required):
                    reports = []
                    for workers in (0, 2):
                        result = self.run_discovery(root, parallel=workers, required=required)
                        self.assertEqual(result.returncode, expected_code, result.stdout)
                        report = json.loads((root / f'report-{workers}.json').read_text(encoding='utf-8'))
                        self.assertEqual(len(report['selected_ids']), 1)
                        self.assertEqual(report['run'], 0)
                        self.assertEqual(len(report['skips']), 1)
                        self.assertFalse(report['skips'][0]['platform_not_applicable'])
                        reports.append(report)
                    for key in ('selected_ids', 'run', 'errors', 'failures', 'skips',
                                'expected_failures', 'unexpected_successes', 'exit_code'):
                        self.assertEqual(reports[0][key], reports[1][key], key)

    def test_module_import_skip_stays_skipped(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.write_source(root, "test_skip.py", """
                import unittest
                raise unittest.SkipTest('optional dependency unavailable')
            """)
            serial = self.run_discovery(root, parallel=0)
            parallel = self.run_discovery(root, parallel=2)
            self.assertEqual(serial.returncode, 0, serial.stdout)
            self.assertEqual(parallel.returncode, 0, parallel.stdout)
            self.assertIn("并行完成：1 tests（skipped 1）", parallel.stdout)
            for workers in (0, 2):
                required = self.run_discovery(root, parallel=workers, required=True)
                report = json.loads((root / f'report-{workers}.json').read_text(encoding='utf-8'))
                self.assertEqual(required.returncode, 1, required.stdout)
                self.assertEqual(report['exit_code'], 1)
                self.assertEqual(report['run'], len(report['selected_ids']))
                self.assertEqual(report['skips'][0]['reason'], 'optional dependency unavailable')
                self.assertFalse(report['skips'][0]['platform_not_applicable'])

    def test_required_expected_failures_and_platform_skips_match_serial(self):
        platform_method = ('test_open_existing_path_uses_external_opener_for_file_and_folder' if sys.platform == 'win32'
                           else 'test_open_output_folder_uses_startfile_on_windows')
        for source, exit_code in (
            ("@unittest.expectedFailure\ndef test_expected(self): self.fail('known failure')", 1),
            ("@unittest.expectedFailure\ndef test_unexpected(self): pass", 1),
            (f"def {platform_method}(self): self.skipTest('other platform')", 1),
        ):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                self.write_source(root, 'test_outcome.py', 'import unittest\nclass Case(unittest.TestCase):\n'
                                  + textwrap.indent(source, '    ') + '\n')
                reports = []
                for workers in (0, 2):
                    result = self.run_discovery(root, parallel=workers, required=True)
                    self.assertEqual(result.returncode, exit_code, result.stdout)
                    reports.append(json.loads((root / f'report-{workers}.json').read_text(encoding='utf-8')))
                for key in ('selected_ids', 'run', 'errors', 'failures', 'skips', 'expected_failures', 'unexpected_successes', 'exit_code'):
                    self.assertEqual(reports[0][key], reports[1][key], key)

    def test_complete_log_keeps_successful_worker_output(self):
        for workers in (0, 2):
            with self.subTest(workers=workers), tempfile.TemporaryDirectory() as temporary:
                root = pathlib.Path(temporary)
                self.write_source(root, "test_output.py", """
                    import subprocess
                    import sys
                    import unittest
                    print('import success marker')
                    class Case(unittest.TestCase):
                        def test_output(self):
                            print('python success marker')
                            subprocess.run([sys.executable, '-c', "print('child success marker')"], check=True)
                """)
                result = self.run_discovery(root, parallel=workers)
                self.assertEqual(result.returncode, 0, result.stdout)
                report = json.loads((root / f'report-{workers}.json').read_text(encoding='utf-8'))
                full = pathlib.Path(report['full_log']).read_text(encoding='utf-8')
                self.assertIn('import success marker', full)
                self.assertIn('python success marker', full)
                self.assertIn('child success marker', full)

    def test_platform_exemptions_require_exact_owner_and_reason(self):
        from scripts.test_policy import allowed_platform_skip
        import os
        identity, reason = (
            ('tests.test_gui_web.GuiWebBridgeTests.test_open_existing_path_uses_external_opener_for_file_and_folder',
             'Non-Windows paths use the external opener') if os.name == 'nt' else
            ('tests.test_gui_web.GuiWebBridgeTests.test_open_output_folder_uses_startfile_on_windows',
             'os.startfile 仅 Windows 可用；os.name 补丁会让 pathlib 选择 WindowsPath'))
        self.assertTrue(allowed_platform_skip(identity, reason))
        self.assertFalse(allowed_platform_skip(identity, 'dependency missing'))
        self.assertFalse(allowed_platform_skip(identity.replace('GuiWebBridgeTests', 'OtherTests'), reason))

    def test_pack_keeps_dynamic_imported_hooks_and_load_errors(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.write_source(root, 'helper.py', 'import unittest\nclass Imported(unittest.TestCase):\n    def test_imported(self): pass\n')
            self.write_source(root, 'test_dynamic.py', """
                import unittest
                from helper import Imported
                def hook(): pass
                def load_tests(loader, suite, pattern):
                    suite.addTest(unittest.FunctionTestCase(hook))
                    return suite
            """)
            command = [sys.executable, str(ROOT / 'scripts/run_tests.py'), '--pack', 'common', '--start-dir', str(root),
                       '--report', str(root / 'pack.json')]
            result = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            report = json.loads((root / 'pack.json').read_text(encoding='utf-8'))
            self.assertEqual(report['run'], 2)
            self.write_source(root, 'test_broken.py', "raise RuntimeError('load marker')")
            result = subprocess.run(command, capture_output=True, text=True, cwd=ROOT)
            self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
            report = json.loads((root / 'pack.json').read_text(encoding='utf-8'))
            self.assertEqual(report['errors'], 1)

    def test_module_import_system_exit_cannot_report_success(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = pathlib.Path(temporary)
            self.write_source(root, "test_exit.py", "import sys\nsys.exit(0)\n")
            serial = self.run_discovery(root, parallel=0)
            parallel = self.run_discovery(root, parallel=2)
            self.assertEqual(serial.returncode, 1, serial.stdout)
            self.assertEqual(parallel.returncode, 1, parallel.stdout)
            self.assertIn("FAIL(f=0 e=1)", parallel.stdout)
            self.assertIn("SystemExit: 0", (root / "failures.log").read_text(encoding="utf-8"))


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
