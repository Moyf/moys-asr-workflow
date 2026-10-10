"""Compare the browser fallback configuration with an isolated real bridge."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from maw.gui_web import LauncherApi, LauncherPaths


ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node is required for the browser contract")
class LauncherContractTests(unittest.TestCase):
    def test_browser_mock_keeps_backend_configuration_keys(self):
        script = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('web/launcher/boot/launcher-mock-api.js', 'utf8');
vm.runInNewContext(source + '\nmockApi().get_config().then(value => console.log(JSON.stringify(value)))', {
  console, navigator: {platform: 'Win32'}, localStorage: {getItem: () => null},
  LAST_MODEL_KEY: 'model', LAST_LANGUAGE_KEY: 'language', ZOOM_PERCENT_KEY: 'zoom',
  ZOOM_DEFAULT: 100, OPENAI_ASR_CUSTOM_MODEL_ID: 'custom', state: {config: null},
});
"""
        result = subprocess.run(["node", "-e", script], cwd=ROOT, capture_output=True,
                                text=True, encoding="utf-8", timeout=15, check=True)
        browser = json.loads(result.stdout)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = LauncherPaths(root=root, env_path=root / ".env", launcher_html=root / "launcher.html")
            with mock.patch.dict(os.environ, {"MAW_APP_DATA_ROOT": str(root / "app")}, clear=True):
                real = LauncherApi(paths=paths, window_getter=lambda: None).get_config()
        self.assertEqual(set(real), set(browser))
        for key in ("asrPresetRoot", "asrPresetRootConfigured", "serverPort", "models", "regions", "languages"):
            with self.subTest(key=key):
                self.assertIs(type(browser[key]), type(real[key]))
        provider = next(item for item in browser["providers"] if item["id"] == browser["providerId"])
        for key in ("models", "regions", "languages"):
            self.assertEqual(browser[key], provider[key])
