import io
import json
import tempfile
import subprocess
import sys
import unittest
from pathlib import Path

from scripts.ci_summary import browser_issues, description, render, safe
from scripts.run_tests import result_report


class SummaryTests(unittest.TestCase):
    def report(self, kind, data, outcome='failure'):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'report.json'
            path.write_text(json.dumps(data), encoding='utf-8')
            return render(kind, 'windows', outcome, [path])

    def browser(self, status='failed'):
        return {'stats': {'expected': 0, 'unexpected': 1}, 'suites': [
            {'title': 'file', 'specs': [{'title': 'a case', 'file': 'test.mjs', 'line': 12,
             'tests': [{'projectName': 'chromium', 'status': 'unexpected',
                        'results': [{'status': status, 'errors': [{'message': 'expected A, got B'}]}]}]}]}]}

    def test_serial_and_parallel_failure_reports_keep_exit_code(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / 'test_sample.py').write_text(
                'import unittest\nclass Case(unittest.TestCase):\n'
                '    def test_failure(self): self.fail("diagnostic sentinel")\n', encoding='utf-8')
            for parallel in (1, 2):
                report = folder / f'result-{parallel}.json'
                run = subprocess.run([sys.executable, str(root / 'scripts/run_tests.py'),
                    '--start-dir', str(folder), '--parallel', str(parallel), '--report', str(report)],
                    cwd=root, capture_output=True, text=True, timeout=30)
                self.assertEqual(run.returncode, 1)
                data = json.loads(report.read_text(encoding='utf-8'))
                self.assertEqual(data['exit_code'], 1)
                self.assertIn('diagnostic sentinel', data['failure_details'][0]['message'])
                self.assertTrue(Path(data['full_log']).exists())

    def test_expected_failure_states_keep_ids_counts_and_gate(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / 'test_expected.py').write_text(
                'import unittest\nclass Case(unittest.TestCase):\n'
                '    @unittest.expectedFailure\n'
                '    def test_unexpected(self): pass\n'
                '    @unittest.expectedFailure\n'
                '    def test_expected(self): self.fail("known failure")\n', encoding='utf-8')
            for parallel in (1, 2):
                report = folder / f'expected-{parallel}.json'
                run = subprocess.run([sys.executable, str(root / 'scripts/run_tests.py'),
                    '--start-dir', str(folder), '--parallel', str(parallel), '--report', str(report)],
                    cwd=root, capture_output=True, text=True, timeout=30)
                self.assertEqual(run.returncode, 1)
                data = json.loads(report.read_text(encoding='utf-8'))
                self.assertEqual(data['unexpected_successes'], 1)
                self.assertEqual(data['expected_failures'], 1)
                self.assertEqual(data['failures'], 0)
                self.assertEqual(data['errors'], 0)
                summary = self.report('python', data)
                for text in ('意外通过 1', '预期失败 1', 'test_unexpected',
                             'test_expected', '会导致门禁失败', 'required 门禁不允许'):
                    self.assertIn(text, summary)

    def test_parallel_worker_crash_is_not_zero_failures(self):
        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / 'test_crash.py').write_text(
                'import os, unittest\nclass Case(unittest.TestCase):\n'
                '    def test_crash(self): os._exit(7)\n', encoding='utf-8')
            report = folder / 'crash.json'
            run = subprocess.run([sys.executable, str(root / 'scripts/run_tests.py'),
                '--start-dir', str(folder), '--parallel', '2', '--report', str(report)],
                cwd=root, capture_output=True, text=True, timeout=30)
            self.assertEqual(run.returncode, 1)
            data = json.loads(report.read_text(encoding='utf-8'))
            self.assertEqual(data['errors'], 1)
            summary = self.report('python', data)
            self.assertIn('测试工作进程异常', summary)
            self.assertIn('test_crash.py', summary)
            self.assertIn('无法确认该文件的测试完成情况', summary)

    def test_browser_failure(self):
        result = self.report('browser', self.browser())
        self.assertIn('a case', result)
        self.assertIn('expected A, got B', result)
        self.assertIn('尚未定位', result)
        self.assertIn('尚未提供中文说明', result)

    def test_global_error(self):
        report = {'suites': [], 'stats': {}, 'errors': [{'message': 'browser not installed'}]}
        self.assertIn('测试运行器错误', self.report('browser', report))

    def test_missing_results_not_passed(self):
        report = self.browser()
        report['suites'][0]['specs'][0]['tests'][0]['results'] = []
        self.assertIn('没有完整结果', self.report('browser', report))

    def test_missing_and_cancelled(self):
        text = render('browser', 'x', 'cancelled', [])
        self.assertIn('被取消', text)
        self.assertIn('不能当作', text)

    def test_malformed(self):
        self.assertIn('无法解析', self.report('browser', {}))
        self.assertIn('无法解析', self.report('python', {'failures': 1}))

    def test_python_serializer_preserves_failure(self):
        class Failing(unittest.TestCase):
            def runTest(self):
                self.fail('expected rejection')
        result = unittest.TextTestRunner(stream=io.StringIO()).run(Failing())
        report = result_report(result, ['sample'])
        self.assertEqual(report['failures'], 1)
        self.assertEqual(len(report['failure_details']), 1)
        self.assertIn('expected rejection', self.report('python', report))

    def test_python_zero_details_is_not_gate_success(self):
        result = self.report('python', {'failure_details': [], 'run': 2, 'failures': 0, 'errors': 0})
        self.assertIn('仍以执行步骤', result)

    def test_gate_is_not_another_test(self):
        result = render('gate', 'matrix', 'failure', [], {'browser': {'result': 'failure'}})
        self.assertIn('不是另一组测试', result)
        self.assertIn('browser', result)
        self.assertIn('failure', result)

    def test_escaping_and_bounded_output(self):
        self.assertNotIn('<script>', safe('<script>alert(1)</script>'))
        self.assertNotIn('\x1b', safe('\x1b[31mred\x1b[0m'))
        self.assertIn('已截断', safe('a' * 2000))
        self.assertNotIn('someone', safe('/home/someone/project'))
        report = self.browser()
        report['suites'][0]['specs'][0]['title'] = '</code><script>alert(1)</script>'
        self.assertNotIn('<script>', self.report('browser', report))

    def test_descriptions_exact_not_guess(self):
        self.assertIsNotNone(description('tests.Foo.test_prproj_generation_route_refuses_without_writing'))
        self.assertIsNone(description('test_prproj_generation_route_refuses_without_writing_extra'))

    def test_attempts_and_skips_retained(self):
        report = self.browser('timedOut')
        test = report['suites'][0]['specs'][0]['tests'][0]
        test['results'].append({'status': 'passed'})
        test['status'] = 'flaky'
        self.assertEqual(len(browser_issues(report)), 1)
        self.assertIn('expected A', self.report('browser', report))


if __name__ == '__main__':
    unittest.main()
