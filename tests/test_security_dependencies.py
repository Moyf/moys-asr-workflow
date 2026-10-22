"""Security contracts for the CA bundle and model-runtime bootstrap."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import re
import ssl
import tomllib
import unittest
from unittest import mock
from urllib.parse import urlsplit

import certifi

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

    def test_pip_bootstrap_uses_independently_pinned_wheel_hash(self) -> None:
        url = PIP_BOOTSTRAP_REQUIREMENT.split(" @ ", 1)[1]
        parts = urlsplit(url)
        self.assertEqual(parts.scheme, "https")
        self.assertEqual(parts.hostname, "files.pythonhosted.org")
        self.assertEqual(parts.fragment, "sha256=fd7f4dfa8190e014013b9f08f3e973f4e4c26ffd179a204895533a7254813a70")
        command = _get_pip_command(Path("python"), Path("get-pip.py"))
        self.assertIn(PIP_BOOTSTRAP_REQUIREMENT, command)

    def test_model_workers_force_http_fallback_even_if_parent_enabled_xet(self) -> None:
        with mock.patch.dict(os.environ, {"HF_HUB_DISABLE_XET": "0"}):
            for runtime in (LOCAL, MOSS):
                self.assertEqual(runtime.environment(Path("runtime"))["HF_HUB_DISABLE_XET"], "1")
            self.assertEqual(model_cache_environment()["HF_HUB_DISABLE_XET"], "1")
            self.assertEqual(alignment_environment()["HF_HUB_DISABLE_XET"], "1")
