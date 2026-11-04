"""Security contracts for the CA bundle and model-runtime bootstrap."""
from __future__ import annotations

import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import re
import ssl
import subprocess
import sys
import tomllib
import unittest
from unittest import mock
from urllib.parse import urlsplit

import certifi
import requests
import urllib3

from maw.alignment_models import model_cache_environment as alignment_environment
from maw.runtimes.base import PIP_BOOTSTRAP_REQUIREMENT, _get_pip_command, model_cache_environment
from maw.runtimes import LOCAL, MOSS

ROOT = Path(__file__).resolve().parents[1]
EMSIGN_G3_SHA256 = "86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B"


class SecurityDependencyTests(unittest.TestCase):
    def test_installed_ca_bundle_does_not_trust_compromised_hierarchy(self) -> None:
        bundle = Path(certifi.where()).read_text(encoding="ascii")
        blocks = re.findall(r"-----BEGIN CERTIFICATE-----.*?-----END CERTIFICATE-----", bundle, re.S)
        fingerprints = {hashlib.sha256(ssl.PEM_cert_to_DER_cert(block)).hexdigest().upper() for block in blocks}
        self.assertGreater(len(fingerprints), 50)
        self.assertNotIn(EMSIGN_G3_SHA256, fingerprints)

    def test_frozen_install_cannot_restore_old_certifi(self) -> None:
        lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
        version = next(package["version"] for package in lock["package"] if package["name"] == "certifi")
        self.assertGreaterEqual(tuple(map(int, version.split("."))), (2026, 10, 19))

    def test_frozen_install_cannot_restore_vulnerable_urllib3(self) -> None:
        lock = tomllib.loads((ROOT / "uv.lock").read_text(encoding="utf-8"))
        version = next(package["version"] for package in lock["package"] if package["name"] == "urllib3")
        self.assertGreaterEqual(tuple(map(int, version.split("."))), (2, 8, 0))

    def test_pip_bootstrap_uses_independently_pinned_wheel_hash(self) -> None:
        url = PIP_BOOTSTRAP_REQUIREMENT.split(" @ ", 1)[1]
        parts = urlsplit(url)
        self.assertEqual(parts.scheme, "https")
        self.assertEqual(parts.hostname, "files.pythonhosted.org")
        self.assertEqual(parts.fragment, "sha256=fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70")
        command = _get_pip_command(Path("python"), Path("get-pip.py"))
        self.assertIn(PIP_BOOTSTRAP_REQUIREMENT, command)

    def test_source_entrypoints_disable_xet_before_optional_hub_import(self) -> None:
        code = (
            "import importlib, os, sys; "
            "importlib.import_module(sys.argv[1]); "
            "assert os.environ.get('HF_HUB_DISABLE_XET') == '1'; "
            "assert 'huggingface_hub' not in sys.modules"
        )
        for module in ("maw.asr.local", "maw.cli", "maw.local_runtime_worker", "maw.ocr_runtime_worker"):
            with self.subTest(module=module):
                completed = subprocess.run(
                    [sys.executable, "-c", code, module], cwd=ROOT,
                    env={**os.environ, "HF_HUB_DISABLE_XET": "0"},
                    capture_output=True, text=True, timeout=20,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr[-2000:])

    def test_model_workers_force_http_fallback_even_if_parent_enabled_xet(self) -> None:
        with mock.patch.dict(os.environ, {"HF_HUB_DISABLE_XET": "0"}):
            for runtime in (LOCAL, MOSS):
                self.assertEqual(runtime.environment(Path("runtime"))["HF_HUB_DISABLE_XET"], "1")
            self.assertEqual(model_cache_environment()["HF_HUB_DISABLE_XET"], "1")
            self.assertEqual(alignment_environment()["HF_HUB_DISABLE_XET"], "1")


class _ChunkedWire(io.BytesIO):
    def __init__(self, body: bytes) -> None:
        super().__init__(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n" + body)
        self.chunk_line_bytes: list[int] = []

    def readline(self, size: int = -1) -> bytes:
        line = super().readline(size)
        self.chunk_line_bytes.append(len(line))
        return line


def _streaming_response(wire: _ChunkedWire) -> requests.Response:
    socket = mock.Mock()
    socket.makefile.return_value = wire
    original = http.client.HTTPResponse(socket, method="GET")
    original.begin()
    wire.chunk_line_bytes.clear()
    response = requests.Response()
    response.status_code = original.status
    response.raw = urllib3.HTTPResponse(
        body=original, headers=dict(original.getheaders()),
        original_response=original, preload_content=False,
    )
    return response


class StreamingSecurityTests(unittest.TestCase):
    def test_requests_stream_rejects_oversized_chunk_size_with_bounded_read(self) -> None:
        # GHSA-vxq7-64xx-v4gw: read through requests, as the LLM SSE caller does.
        wire = _ChunkedWire(b"1" * 131072 + b"\r\n")
        with _streaming_response(wire) as response:
            with self.assertRaises(requests.exceptions.ChunkedEncodingError):
                list(response.iter_lines())
        self.assertTrue(wire.chunk_line_bytes)
        self.assertLessEqual(max(wire.chunk_line_bytes), 65537)

    def test_normal_chinese_sse_body_can_exceed_chunk_size_field_limit(self) -> None:
        event = ("data: " + json.dumps({"text": "中" * 30000}, ensure_ascii=False)).encode("utf-8")
        payload = event + b"\n\ndata: [DONE]\n\n"
        self.assertGreater(len(payload), 65536)
        wire = _ChunkedWire(f"{len(payload):x}\r\n".encode("ascii") + payload + b"\r\n0\r\n\r\n")
        with _streaming_response(wire) as response:
            lines = list(response.iter_lines(decode_unicode=False))
        self.assertEqual(lines, [event, b"", b"data: [DONE]", b""])
