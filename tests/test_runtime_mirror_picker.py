"""Unit tests for scripts/runtime_mirror_picker.py (no real network).

测速选择逻辑用 mock 数据驱动; 单源测量用假 response 对象驱动。
"""

from __future__ import annotations

import io
import json
import ssl
import unittest
import urllib.error
from unittest import mock

from maw.runtime_mirror_picker import (
    DEFAULT_SOURCES,
    FALLBACK_SOURCE,
    _main,
    _parse_simple_links,
    _pick_fastest,
    candidate_sources,
    measure_sources,
    pick_fastest_mirror,
)


class _FakeResponse:
    """Minimal urllib response stand-in: serves fixed bytes, tracks close()."""

    status = 200

    def __init__(self, body: bytes = b"x" * 4096) -> None:
        self._body = body
        self.closed = False

    def read(self, size: int = -1) -> bytes:
        if self._body == b"":
            return b""
        if size is None or size < 0:
            chunk, self._body = self._body, b""
            return chunk
        chunk, self._body = self._body[:size], self._body[size:]
        return chunk

    def __enter__(self) -> "_FakeResponse":
        return self

    def __exit__(self, *exc: object) -> bool:
        self.close()
        return False

    def close(self) -> None:
        self.closed = True


class CandidateSourcesTests(unittest.TestCase):
    def test_defaults_when_env_unset(self) -> None:
        with mock.patch.dict("os.environ", {}, clear=True):
            self.assertIn("https://pypi.org/simple", candidate_sources())
            self.assertGreaterEqual(len(candidate_sources()), 4)

    def test_env_override_replaces_defaults(self) -> None:
        with mock.patch.dict(
            "os.environ", {"MAW_PIP_INDEX": "https://a.example/simple, https://b.example/simple "}
        ):
            self.assertEqual(
                candidate_sources(),
                ["https://a.example/simple", "https://b.example/simple"],
            )

    def test_blank_env_falls_back_to_defaults(self) -> None:
        with mock.patch.dict("os.environ", {"MAW_PIP_INDEX": " , "}):
            self.assertEqual(candidate_sources(), DEFAULT_SOURCES)


class ParseSimpleLinksTests(unittest.TestCase):
    def test_extracts_hrefs(self) -> None:
        html = '<a href="https://x/setuptools-1.0-py3-none-any.whl#sha256=abc">a</a>\n"' \
               "<a href='/pypi/setuptools/setuptools-1.0.tar.gz'>b</a>"
        links = _parse_simple_links(html)
        self.assertIn("https://x/setuptools-1.0-py3-none-any.whl#sha256=abc", links)
        self.assertIn("/pypi/setuptools/setuptools-1.0.tar.gz", links)

    def test_empty_html(self) -> None:
        self.assertEqual(_parse_simple_links(""), [])
        self.assertEqual(_parse_simple_links("<html><body></body></html>"), [])


class MeasureOneTests(unittest.TestCase):
    def test_ok_records_latency_and_speed(self) -> None:
        with mock.patch("maw.runtime_mirror_picker._open_probe") as open_mock:
            open_mock.return_value = _FakeResponse(body=b"z" * 100_000)
            result = measure_sources(timeout=5.0, sources=["https://example.org/simple"])

        item = result[0]
        self.assertTrue(item["ok"])
        self.assertIsNone(item["error"])
        self.assertGreaterEqual(item["latency_ms"], 0.0)
        self.assertGreater(item["bytes_per_sec"], 0.0)
        self.assertEqual(item["url"], "https://example.org/simple")

    def test_certificate_error_retries_with_unverified_context(self) -> None:
        cert_error = ssl.SSLCertVerificationError("unable to get local issuer certificate")
        with mock.patch("maw.runtime_mirror_picker._open_probe") as open_mock:
            open_mock.side_effect = [cert_error, _FakeResponse(body=b"a" * 8192)]
            result = measure_sources(timeout=5.0, sources=["https://badcert.example/simple"])

        self.assertTrue(result[0]["ok"])
        self.assertEqual(open_mock.call_count, 2)
        first_call = open_mock.mock_calls[0]
        second_call = open_mock.mock_calls[1]
        self.assertTrue(first_call.kwargs["use_verified_context"])
        self.assertFalse(second_call.kwargs["use_verified_context"])

    def test_urlerror_wrapped_cert_failure_also_retries(self) -> None:
        wrapped = urllib.error.URLError(
            ssl.SSLCertVerificationError("self-signed certificate")
        )
        with mock.patch("maw.runtime_mirror_picker._open_probe") as open_mock:
            open_mock.side_effect = [wrapped, _FakeResponse()]
            result = measure_sources(timeout=5.0, sources=["https://badcert.example/simple"])

        self.assertTrue(result[0]["ok"])
        self.assertEqual(open_mock.call_count, 2)

    def test_timeout_is_isolated_not_retried(self) -> None:
        timeout_error = urllib.error.URLError(TimeoutError("timed out"))
        with mock.patch("maw.runtime_mirror_picker._open_probe") as open_mock:
            open_mock.side_effect = timeout_error
            result = measure_sources(timeout=0.1, sources=["https://slow.example/simple"])

        item = result[0]
        self.assertFalse(item["ok"])
        self.assertIsNotNone(item["error"])
        self.assertEqual(open_mock.call_count, 1)  # 非证书错误不做 unverified 重试

    def test_http_error_is_reported_and_skipped(self) -> None:
        http_error = urllib.error.HTTPError("https://x/setuptools/", 404, "Not Found", None, None)
        with mock.patch("maw.runtime_mirror_picker._open_probe") as open_mock:
            open_mock.side_effect = http_error
            result = measure_sources(timeout=5.0, sources=["https://gone.example/simple"])

        item = result[0]
        self.assertFalse(item["ok"])
        self.assertIn("HTTP 404", item["error"])
        self.assertEqual(open_mock.call_count, 1)


class MeasureSourcesTests(unittest.TestCase):
    def test_concurrent_preserves_input_order(self) -> None:
        sources = ["https://a.example/simple", "https://b.example/simple"]
        with mock.patch("maw.runtime_mirror_picker._measure_one") as measure_mock:
            measure_mock.side_effect = [
                {"url": "https://a.example/simple", "ok": True,
                 "latency_ms": 10.0, "bytes_per_sec": 1.0, "error": None},
                {"url": "https://b.example/simple", "ok": False,
                 "latency_ms": None, "bytes_per_sec": None, "error": "boom"},
            ]
            results = measure_sources(timeout=5.0, sources=sources)

        self.assertEqual([item["url"] for item in results], sources)
        self.assertTrue(results[0]["ok"])
        self.assertFalse(results[1]["ok"])

    def test_unexpected_exception_from_worker_is_captured(self) -> None:
        with mock.patch("maw.runtime_mirror_picker._measure_one") as measure_mock:
            measure_mock.side_effect = RuntimeError("unexpected")
            results = measure_sources(timeout=5.0, sources=["https://a.example/simple"])

        self.assertFalse(results[0]["ok"])
        self.assertIsNotNone(results[0]["error"])


class PickFastestTests(unittest.TestCase):
    def _ok(self, url: str, latency: float, speed: float = 1000.0) -> dict:
        return {
            "url": url, "ok": True,
            "latency_ms": latency, "bytes_per_sec": speed, "error": None,
        }

    def _fail(self, url: str) -> dict:
        return {
            "url": url, "ok": False,
            "latency_ms": None, "bytes_per_sec": None, "error": "timeout",
        }

    def test_pick_fastest_prefers_lowest_latency(self) -> None:
        results = [
            self._ok("https://slow.example/simple", latency=300.0),
            self._ok("https://fast.example/simple", latency=40.0),
            self._ok("https://mid.example/simple", latency=120.0),
        ]
        self.assertEqual(_pick_fastest(results), "https://fast.example/simple")

    def test_pick_fastest_ignores_failed_sources(self) -> None:
        results = [
            self._fail("https://dead.example/simple"),
            self._ok("https://alive.example/simple", latency=200.0),
            self._fail("https://dead2.example/simple"),
        ]
        self.assertEqual(_pick_fastest(results), "https://alive.example/simple")

    def test_tie_break_by_speed(self) -> None:
        results = [
            self._ok("https://a.example/simple", latency=50.0, speed=2048.0),
            self._ok("https://b.example/simple", latency=50.0, speed=4096.0),
        ]
        self.assertEqual(_pick_fastest(results), "https://b.example/simple")

    def test_all_failed_falls_back_to_official_pypi(self) -> None:
        results = [
            self._fail("https://dead.example/simple"),
            self._fail("https://dead2.example/simple"),
        ]
        self.assertEqual(_pick_fastest(results), FALLBACK_SOURCE)

    def test_pick_fastest_mirror_delegates_to_measure_sources(self) -> None:
        with mock.patch("maw.runtime_mirror_picker.measure_sources") as measure_mock:
            measure_mock.return_value = [
                self._ok("https://pypi.org/simple", latency=500.0),
                self._ok("https://cn.example/simple", latency=30.0),
            ]
            fastest = pick_fastest_mirror(timeout=2.0)

        self.assertEqual(fastest, "https://cn.example/simple")
        measure_mock.assert_called_once_with(timeout=2.0)


class CliTests(unittest.TestCase):
    def test_json_output_shape(self) -> None:
        ok_items = [
            {"url": "https://a.example/simple", "ok": True,
             "latency_ms": 10.0, "bytes_per_sec": 2048.0, "error": None},
            {"url": "https://b.example/simple", "ok": False,
             "latency_ms": None, "bytes_per_sec": None, "error": "timeout"},
        ]
        captured = io.StringIO()
        with mock.patch("maw.runtime_mirror_picker.measure_sources",
                        return_value=ok_items):
            with mock.patch("sys.stdout", captured):
                exit_code = _main(["--json", "--timeout", "2.0"])

        self.assertEqual(exit_code, 0)
        payload = json.loads(captured.getvalue())
        self.assertEqual(payload["fastest"], "https://a.example/simple")
        self.assertEqual(len(payload["results"]), 2)
        self.assertFalse(payload["results"][1]["ok"])


if __name__ == "__main__":
    unittest.main()