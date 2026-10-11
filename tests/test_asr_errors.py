from __future__ import annotations

import unittest

from maw.asr_errors import api_key_error_code, asr_error_code, redact_asr_text
from maw.gui_workflow import TranscriptionProcessError


class ApiKeyInputTests(unittest.TestCase):
    def test_obvious_paste_mistakes_are_rejected_without_echoing_input(self):
        for key in (
            "Bearer test-only-private-key", '"test-only-private-key"',
            "'test-only-private-key'", "a b", "a\nb", "a\x00b", "a\x7fb",
            "https://example.test/keys", "DASHSCOPE_API_KEY=test-only-private-key",
            "apiKey=test-only-private-key", "KEY=test-only-private-key",
            "Authorization:Bearer-test-only-private-key", "中文说明",
        ):
            with self.subTest(key=key):
                self.assertEqual(api_key_error_code(key), "api_key_invalid_format")

    def test_empty_and_whitespace_keys_are_missing(self):
        for key in ("", " \t\r\n"):
            self.assertEqual(api_key_error_code(key), "api_key_missing")

    def test_prefix_length_and_validity_are_not_probed_or_imposed(self):
        for key in ("abc", "different-prefix-test-token", "abc+/==", "  test-token  "):
            with self.subTest(key=key):
                self.assertEqual(api_key_error_code(key), "")


class AsrRedactionTests(unittest.TestCase):
    def test_active_key_without_a_vendor_prefix_is_removed_and_diagnostics_remain(self):
        key = "test-only-opaque-credential"
        detail = f"HTTP 401: Incorrect API key provided: {key} | request_id=test-request"
        redacted = redact_asr_text(detail, key)
        self.assertNotIn(key, redacted)
        self.assertIn("[REDACTED]", redacted)
        self.assertIn("HTTP 401", redacted)
        self.assertIn("test-request", redacted)
        self.assertEqual(redact_asr_text(detail, ""), detail)


class AsrErrorClassificationTests(unittest.TestCase):
    def test_audio_evidence_is_used_for_cloud_and_local_without_parsing_detail(self):
        from maw.audio_diagnostics import AudioInputError
        for provider in ('qwen', 'openai', 'local'):
            for code in ('audio_tracks_missing', 'audio_track_invalid', 'asr_audio_quiet',
                         'asr_audio_all_quiet', 'asr_audio_sample_quiet', 'asr_audio_track_mismatch', 'asr_empty_result'):
                self.assertEqual(asr_error_code(AudioInputError(code, 'HTTP 401 is an old log line'), provider=provider), code)

    def test_explicit_http_responses_are_classified(self):
        for status, expected in (
            (401, "asr_auth_failed"), (403, "asr_permission_denied"),
            (404, "asr_endpoint_invalid"), (429, "asr_rate_limited"),
            (500, "asr_service_unavailable"), (503, "asr_service_unavailable"),
            (400, "asr_request_invalid"), (415, "asr_request_invalid"),
            (422, "asr_request_invalid"), (408, "asr_timeout"),
        ):
            for provider in ("qwen", "openai", "soniox", "doubao", "tencent", "bcut"):
                with self.subTest(status=status, provider=provider):
                    self.assertEqual(asr_error_code(RuntimeError(f"请求失败 (HTTP {status})"),
                                                    provider=provider), expected)

    def test_requests_http_error_and_business_code_styles(self):
        for detail in (
            "requests.exceptions.HTTPError: 401 Client Error: Unauthorized for url",
            "code=InvalidApiKey | message=Invalid API-key provided.",
            "ASR 任务失败 [invalid_api_key]: refused",
            "Soniox error_type=unauthenticated",
            "腾讯云 CreateRecTask 失败 [AuthFailure.SecretIdNotFound]: refused",
        ):
            self.assertEqual(asr_error_code(RuntimeError(detail), provider="qwen"), "asr_auth_failed")

    def test_multiline_child_error_retains_http_evidence(self):
        error = TranscriptionProcessError(1, [
            "RuntimeError: 获取上传凭证失败 (HTTP 403): code=AccessDenied",
            "建议：请确认地域与工作空间是否匹配。",
        ])
        self.assertEqual(asr_error_code(error, provider="qwen"), "asr_permission_denied")

    def test_last_response_wins_over_an_earlier_retry(self):
        error = TranscriptionProcessError(1, ["[warning] HTTP 503", "RuntimeError: HTTP 401"])
        self.assertEqual(asr_error_code(error, provider="qwen"), "asr_auth_failed")

    def test_retry_warning_does_not_override_the_final_failure(self):
        for final, expected in (
            ("requests.exceptions.ReadTimeout: timed out", "asr_timeout"),
            ("ValueError: unsupported result format", ""),
        ):
            error = TranscriptionProcessError(1, ["[warning] HTTP 503", final])
            self.assertEqual(asr_error_code(error, provider="qwen"), expected)
        error = TranscriptionProcessError(1, ["[warning] HTTP 401", "unclassified final failure"])
        self.assertEqual(asr_error_code(error, provider="qwen"), "")

    def test_network_and_timeout_failures_are_distinct(self):
        self.assertEqual(asr_error_code(TimeoutError("deadline exceeded"), provider="qwen"), "asr_timeout")
        for detail, expected in (
            ("requests.exceptions.ReadTimeout: timed out", "asr_timeout"),
            ("TimeoutError: ASR 任务超时", "asr_timeout"),
            ("requests.exceptions.ProxyError: connection failed", "asr_network_error"),
            ("requests.exceptions.SSLError: certificate verify failed", "asr_network_error"),
            ("requests.exceptions.ConnectionError: name resolution failed", "asr_network_error"),
        ):
            self.assertEqual(asr_error_code(RuntimeError(detail), provider="qwen"), expected)

    def test_local_and_unrelated_errors_keep_their_existing_classification(self):
        self.assertEqual(asr_error_code(RuntimeError("HTTP 401"), provider="local"), "")
        for detail in ('File "worker.py", line 401', "completed 403 words",
                       "provider failed", "InvalidHeader: unrelated header value"):
            self.assertEqual(asr_error_code(RuntimeError(detail), provider="qwen"), "")
