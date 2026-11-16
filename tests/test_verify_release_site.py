from __future__ import annotations

from contextlib import redirect_stdout, redirect_stderr
from http.client import HTTPResponse
from io import BytesIO, StringIO
import json
import math
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlsplit

from scripts import verify_release_site as verifier
from tests.compact_assertions import CompactContainerAssertions


class Clock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class Response(BytesIO):
    def __init__(self, value=None, status=200):
        super().__init__(json.dumps(value).encode() if value is not None else b'page')
        self.status = status


def index(version='2.0.1'):
    return dict(schema_version=1, latest_stable=version,
                generated_at='2026-11-11T00:00:00+00:00',
                releases=[dict(version=version)])


def ready_responses(version='2.0.1'):
    notes = dict(schema_version=1, version=version, body_markdown='A useful update.')
    return [Response(index(version)), Response(index(version)),
            Response(notes), Response(notes), Response(), Response()]


class Socket:
    """Feed real HTTPResponse parsing/reads without opening a network socket."""
    def __init__(self, raw):
        self.raw = raw

    def makefile(self, mode):
        return BytesIO(self.raw)


def truncated_response():
    response = HTTPResponse(Socket(b'HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n{}'))
    response.begin()
    return response


class VerifyReleaseSiteTests(CompactContainerAssertions, unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.output = StringIO()
        self.enterContext(patch.object(verifier.time, 'monotonic', self.clock.monotonic))
        self.enterContext(patch.object(verifier.time, 'sleep', self.clock.sleep))
        self.enterContext(redirect_stdout(self.output))

    def wait(self, **kwargs):
        return verifier.wait_for_site('https://example.test/project/', 'v2.0.1', **kwargs)

    def test_temporary_old_index_then_new_succeeds(self):
        with patch.object(verifier, 'urlopen', side_effect=[Response(index('2.0.0')), *ready_responses()]) as http:
            self.wait(timeout=30, retry_interval=10)
        self.assertEqual(http.call_count, 7)
        self.assertEqual(self.clock.sleeps, [10])
        self.assertIn('attempt=2', self.output.getvalue())
        self.assertIn('elapsed=10.0s', self.output.getvalue())
        self.assertIn('expected=v2.0.1', self.output.getvalue())
        self.assertIn('latest_stable=2.0.0', self.output.getvalue())
        self.assertIn('generated_at=2026-11-11', self.output.getvalue())

    def test_permanently_old_index_stops_at_deadline(self):
        with patch.object(verifier, 'urlopen', side_effect=lambda *a, **k: Response(index('2.0.0'))) as http:
            with self.assertRaisesRegex(TimeoutError, 'caught up'):
                self.wait(timeout=25, retry_interval=10)
        self.assertEqual(http.call_count, 3)
        self.assertEqual(self.clock.sleeps, [10, 10, 5])
        self.assertEqual(self.clock.now, 25)
        self.assertIn('attempt=3', self.output.getvalue())
        self.assertIn('last_error=', self.output.getvalue())
        self.assertNotIn('verified', self.output.getvalue().lower())

    def test_network_and_http_404_then_success(self):
        errors = [URLError('offline'), HTTPError('https://example.test', 404, 'not ready', {}, None)]
        with patch.object(verifier, 'urlopen', side_effect=[*errors, *ready_responses()]) as http:
            self.wait(timeout=30, retry_interval=10)
        self.assertEqual(http.call_count, 8)
        self.assertEqual(self.clock.sleeps, [10, 10])

    def test_real_content_length_truncation_then_success(self):
        with patch.object(verifier, 'urlopen', side_effect=[truncated_response(), *ready_responses()]) as http:
            self.wait(timeout=20, retry_interval=1)
        self.assertEqual(http.call_count, 7)
        self.assertEqual(self.clock.sleeps, [1])
        self.assertIn('IncompleteRead', self.output.getvalue())
        self.assertIn('attempt=2', self.output.getvalue())
        self.assertIn('verified', self.output.getvalue())

    def test_bad_http_status_line_then_success(self):
        responses = iter(ready_responses())
        attempts = 0

        def fetch(request, timeout):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                with HTTPResponse(Socket(b'temporary malformed status\r\n')) as response:
                    response.begin()
            return next(responses)

        with patch.object(verifier, 'urlopen', side_effect=fetch) as http:
            self.wait(timeout=20, retry_interval=1)
        self.assertEqual(http.call_count, 7)
        self.assertEqual(self.clock.sleeps, [1])
        self.assertIn('BadStatusLine', self.output.getvalue())
        self.assertIn('verified', self.output.getvalue())

    def test_persistent_real_truncation_cli_times_out_with_last_error(self):
        errors = StringIO()
        with patch.object(verifier, 'urlopen', side_effect=lambda *a, **k: truncated_response()) as http:
            with redirect_stderr(errors):
                code = verifier.main(['--base-url', 'https://example.test/project', '--expected-tag', 'v2.0.1',
                                      '--timeout', '3', '--retry-interval', '1'])
        self.assertEqual(code, 1)
        self.assertEqual(http.call_count, 3)
        self.assertEqual(self.clock.sleeps, [1, 1, 1])
        self.assertEqual(self.clock.now, 3)
        self.assertIn('attempt=3', self.output.getvalue())
        self.assertIn('last_error=IncompleteRead', self.output.getvalue())
        self.assertIn('IncompleteRead', errors.getvalue())
        self.assertNotIn('verified', self.output.getvalue())

    def test_request_timeout_is_capped_by_remaining_budget(self):
        timeouts = []

        def slow_error(request, timeout):
            timeouts.append(timeout)
            self.clock.now += 4
            raise URLError('slow')

        with patch.object(verifier, 'urlopen', side_effect=slow_error):
            with self.assertRaises(TimeoutError):
                self.wait(timeout=9, retry_interval=1)
        self.assertEqual(timeouts, [9, 4])
        self.assertEqual(self.clock.sleeps, [1])
        self.assertEqual(self.clock.now, 9)

    def test_each_request_rechecks_deadline_even_inside_successful_round(self):
        def slow_index(request, timeout):
            self.clock.now += timeout
            return Response(index())

        with patch.object(verifier, 'urlopen', side_effect=slow_index) as http:
            with self.assertRaises(TimeoutError):
                self.wait(timeout=2, retry_interval=1)
        self.assertEqual(http.call_count, 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_final_detail_read_crossing_deadline_is_not_success(self):
        responses = iter(ready_responses())

        def fetch(request, timeout):
            response = next(responses)
            if not urlsplit(request.full_url).query and request.full_url.endswith('/2.0.1/'):
                self.clock.now = 5
            return response

        with patch.object(verifier, 'urlopen', side_effect=fetch):
            with self.assertRaises(TimeoutError):
                self.wait(timeout=5, retry_interval=1)
        self.assertNotIn('verified', self.output.getvalue().lower())

    def test_final_success_decision_rechecks_deadline_after_last_response_check(self):
        real_remaining = verifier._remaining
        checks = 0

        def advancing_remaining(deadline):
            nonlocal checks
            result = real_remaining(deadline)
            checks += 1
            if checks == 12:  # Sixth request's post-response check passes, then time advances.
                self.clock.now = deadline + 0.01
            return result

        with patch.object(verifier, '_remaining', side_effect=advancing_remaining):
            with patch.object(verifier, 'urlopen', side_effect=ready_responses()) as http:
                with redirect_stderr(StringIO()):
                    code = verifier.main(['--base-url', 'https://example.test/project', '--expected-tag', 'v2.0.1',
                                          '--timeout', '5', '--retry-interval', '1'])
        self.assertEqual(code, 1)
        self.assertEqual(http.call_count, 6)
        self.assertEqual(self.clock.now, 5.01)
        self.assertEqual(self.clock.sleeps, [])
        self.assertNotIn('verified', self.output.getvalue())
        self.assertIn('deadline', self.output.getvalue())

    def test_reporting_that_reaches_deadline_does_not_start_sleep(self):
        def report_delay(*args, **kwargs):
            self.clock.now = 2

        with patch.object(verifier, 'urlopen', return_value=Response(index('2.0.0'))) as http:
            with patch('builtins.print', side_effect=report_delay):
                with self.assertRaises(TimeoutError):
                    self.wait(timeout=2, retry_interval=1)
        self.assertEqual(http.call_count, 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_cache_defenses_preserve_project_prefix_and_canonical_entry(self):
        with patch.object(verifier, 'urlopen', side_effect=ready_responses()) as http:
            verifier.verify('https://example.test/project/', 'v2.0.1')
        requests = [call.args[0] for call in http.call_args_list]
        paths = [urlsplit(request.full_url).path for request in requests]
        self.assertEqual(paths, ['/project/releases/index.json'] * 2
                         + ['/project/releases/2.0.1/notes.json'] * 2
                         + ['/project/releases/2.0.1/'] * 2)
        for position, request in enumerate(requests):
            self.assertEqual(request.get_header('Cache-control'), 'no-cache')
            self.assertEqual(request.get_header('Pragma'), 'no-cache')
            query = parse_qs(urlsplit(request.full_url).query)
            self.assertEqual(bool(query.get('_maw_verify')), position % 2 == 0)
        self.assertTrue(all(0 < call.kwargs['timeout'] <= 15 for call in http.call_args_list))

    def test_cache_probe_query_changes_each_round(self):
        with patch.object(verifier, 'urlopen', side_effect=[Response(index('2.0.0')), *ready_responses()]) as http:
            self.wait(timeout=20, retry_interval=1)
        queries = [urlsplit(call.args[0].full_url).query for call in http.call_args_list[:2]]
        self.assertTrue(all(queries))
        self.assertNotEqual(*queries)

    def test_new_probe_but_old_canonical_does_not_pass(self):
        def fetch(request, timeout):
            query = urlsplit(request.full_url).query
            return Response(index('2.0.1' if query else '2.0.0'))

        with patch.object(verifier, 'urlopen', side_effect=fetch) as http:
            with self.assertRaisesRegex(TimeoutError, 'caught up'):
                self.wait(timeout=2, retry_interval=1)
        self.assertEqual(http.call_count, 4)
        self.assertIn('source=canonical', self.output.getvalue())
        self.assertIn('latest_stable=2.0.0', self.output.getvalue())

    def test_bad_notes_fail_immediately_in_probe_and_canonical(self):
        bad_notes = [dict(schema_version=1, version='2.0.0', body_markdown='Update'),
                     dict(schema_version=1, version='2.0.1', body_markdown=' \n\t'),
                     dict(schema_version=1, version='2.0.1', body_markdown=['not text']),
                     dict(schema_version=2, version='2.0.1', body_markdown='Update')]
        for notes in bad_notes:
            for canonical in (False, True):
                with self.subTest(notes=notes, canonical=canonical):
                    responses = ready_responses()
                    responses[3 if canonical else 2] = Response(notes)
                    with patch.object(verifier, 'urlopen', side_effect=responses):
                        with self.assertRaisesRegex(ValueError, 'notes'):
                            self.wait(timeout=20, retry_interval=1)
        self.assertEqual(self.clock.sleeps, [])

    def test_single_round_rejects_whitespace_notes(self):
        def fetch(request, timeout):
            url = request if isinstance(request, str) else request.full_url
            if urlsplit(url).path.endswith('/index.json'):
                return Response(index())
            if urlsplit(url).path.endswith('/notes.json'):
                return Response(dict(schema_version=1, version='2.0.1', body_markdown=' \n\t'))
            return Response()

        with patch.object(verifier, 'urlopen', side_effect=fetch):
            with self.assertRaisesRegex(ValueError, 'notes'):
                verifier.verify('https://example.test/project', 'v2.0.1')

    def test_duplicate_versions_and_bad_contract_fail_without_sleep(self):
        duplicate = index()
        duplicate['releases'].append(dict(version='2.0.1'))
        bad_order = index('2.9.0')
        bad_order['releases'].append(dict(version='2.10.0'))
        bad_indices = [duplicate, bad_order, dict(index(), schema_version=2),
                       dict(index(), schema_version=True), dict(index(), latest_stable='2.0.0'),
                       dict(index(), releases=[dict(version='2.0.1-beta.1')]),
                       dict(index(), releases='bad'), dict(index(), releases=[{}]), []]
        for feed in bad_indices:
            with self.subTest(feed=feed), patch.object(verifier, 'urlopen', return_value=Response(feed)) as http:
                with self.assertRaises(ValueError):
                    self.wait(timeout=20, retry_interval=1)
                self.assertEqual(http.call_count, 1)
        self.assertEqual(self.clock.sleeps, [])

    def test_invalid_json_is_a_contract_error(self):
        with patch.object(verifier, 'urlopen', return_value=BytesIO(b'{broken')):
            with self.assertRaises(ValueError):
                self.wait(timeout=20, retry_interval=1)
        self.assertEqual(self.clock.sleeps, [])

    def test_detail_http_200_is_required(self):
        responses = ready_responses()
        responses[-1] = Response(status=503)
        with patch.object(verifier, 'urlopen', side_effect=[*responses, *ready_responses()]) as http:
            self.wait(timeout=20, retry_interval=1)
        self.assertEqual(http.call_count, 12)
        self.assertEqual(self.clock.sleeps, [1])

    def test_empty_catalog_without_expected_tag_is_valid(self):
        empty = dict(index(), latest_stable=None, releases=[])
        with patch.object(verifier, 'urlopen', side_effect=[Response(empty), Response(empty)]) as http:
            verifier.verify('https://example.test/project')
        self.assertEqual(http.call_count, 2)

    def test_unspecified_expected_tag_confirms_canonical_latest(self):
        with patch.object(verifier, 'urlopen', side_effect=ready_responses('2.0.0')):
            verifier.wait_for_site('https://example.test/project', timeout=20, retry_interval=1)
        self.assertIn('expected=latest', self.output.getvalue())
        self.assertIn('latest_stable=2.0.0', self.output.getvalue())

    def test_positive_finite_api_parameters(self):
        for name in ('timeout', 'retry_interval'):
            for value in (0, -1, math.nan, math.inf, -math.inf):
                with self.subTest(name=name, value=value), patch.object(verifier, 'urlopen') as http:
                    with self.assertRaisesRegex(ValueError, 'finite positive'):
                        self.wait(**{name: value})
                    http.assert_not_called()

    def test_invalid_expected_tag_fails_before_single_round_or_wait_requests(self):
        tags = ('v2.0.1-beta.1', 'v2.0.1-rc.1', '2.0.1', 'garbage', 'v02.0.1', 'v2.0',
                ' v2.0.1', 'v2.0.1\n', 'v2.0.1+build')
        for tag in tags:
            for operation in (verifier.verify, verifier.wait_for_site):
                with self.subTest(tag=tag, operation=operation.__name__):
                    with patch.object(verifier, 'urlopen', side_effect=lambda *a, **k: Response(index())) as http:
                        with self.assertRaisesRegex(ValueError, 'expected_tag'):
                            operation('https://example.test/project', tag)
                        http.assert_not_called()
        self.assertEqual(self.clock.sleeps, [])

    def test_cli_invalid_expected_tag_is_nonzero_without_network_or_wait(self):
        for tag in ('v2.0.1-beta.1', 'v2.0.1-rc.1', '2.0.1', 'garbage'):
            with self.subTest(tag=tag), redirect_stderr(StringIO()) as errors:
                with patch.object(verifier, 'urlopen', side_effect=lambda *a, **k: Response(index())) as http:
                    code = verifier.main(['--base-url', 'https://example.test/project', '--expected-tag', tag,
                                          '--timeout', '2', '--retry-interval', '1'])
                self.assertNotEqual(code, 0)
                http.assert_not_called()
                self.assertIn('expected_tag', errors.getvalue())
        self.assertEqual(self.clock.sleeps, [])

    def test_cli_rejects_invalid_numbers_without_network(self):
        for option in ('--timeout', '--retry-interval'):
            for value in ('0', '-1', 'nan', 'inf', '-inf', 'not-a-number'):
                with self.subTest(option=option, value=value), redirect_stderr(StringIO()):
                    with patch.object(verifier, 'urlopen') as http:
                        with self.assertRaises(SystemExit) as error:
                            verifier.main(['--base-url', 'https://example.test', f'{option}={value}'])
                        self.assertEqual(error.exception.code, 2)
                        http.assert_not_called()

    def test_cli_defaults_and_failure_exit(self):
        with patch.object(verifier, 'wait_for_site') as wait:
            self.assertEqual(verifier.main(['--base-url', 'https://example.test/project']), 0)
        wait.assert_called_once_with('https://example.test/project', '', timeout=300, retry_interval=10)
        with patch.object(verifier, 'urlopen', side_effect=lambda *a, **k: Response(index('2.0.0'))):
            with redirect_stderr(StringIO()):
                code = verifier.main(['--base-url', 'https://example.test/project', '--expected-tag', 'v2.0.1',
                                      '--timeout', '2', '--retry-interval', '1'])
        self.assertEqual(code, 1)

    def test_output_bounds_long_errors_and_frequent_retries(self):
        with patch.object(verifier, 'urlopen', side_effect=URLError('x' * 10000)):
            with self.assertRaises(TimeoutError):
                self.wait(timeout=1, retry_interval=0.001)
        lines = self.output.getvalue().splitlines()
        self.assertLessEqual(len(lines), 3)
        self.assertTrue(all(len(line) <= 800 for line in lines))


if __name__ == '__main__':
    unittest.main()
