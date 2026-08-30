from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from threading import Event
from unittest import mock
from urllib.error import HTTPError
from urllib.request import Request

from maw.updater import (
    UPDATE_API_URL,
    InstallationInfo,
    UpdateClient,
    UpdateError,
    channel_for_version,
    detect_installation,
    select_release,
    version_text,
)
from maw import updater as updater_module


class FakeResponse:
    def __init__(self, body: bytes, *, status: int = 200, headers: dict[str, str] | None = None, url: str = "") -> None:
        self._body = body
        self.status = status
        self.headers = headers or {}
        self.url = url

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None

    def read(self, amount: int = -1) -> bytes:
        if amount < 0:
            body, self._body = self._body, b""
            return body
        body, self._body = self._body[:amount], self._body[amount:]
        return body

    def geturl(self) -> str:
        return self.url


def _asset(name: str, url: str, size: int = 3) -> dict[str, object]:
    return {"name": name, "browser_download_url": url, "size": size}


def _manifest(tag: str, version: str, *, prerelease: bool, name: str, platform: str = "windows", arch: str = "x64", kind: str = "portable", flavor: str = "standard", body: bytes = b"abc") -> dict[str, object]:
    return {
        "schemaVersion": 1,
        "version": version,
        "tag": tag,
        "prerelease": prerelease,
        "assets": [{
            "name": name,
            "platform": platform,
            "arch": arch,
            "kind": kind,
            "flavor": flavor,
            "size": len(body),
            "sha256": hashlib.sha256(body).hexdigest(),
        }],
    }


class UpdaterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_versions_keep_release_spelling_while_using_pep440_ordering(self) -> None:
        self.assertEqual(version_text("v1.5.0-beta.10"), "1.5.0-beta.10")
        self.assertEqual(channel_for_version("1.5.0-beta.10"), "beta")
        self.assertEqual(channel_for_version("1.5.0"), "stable")
        releases = [
            {"tag_name": "v1.5.0-beta.2", "prerelease": True, "assets": []},
            {"tag_name": "v1.5.0-beta.10", "prerelease": True, "assets": []},
            {"tag_name": "v1.5.0", "prerelease": False, "assets": []},
            {"tag_name": "v9.0.0-beta.1", "prerelease": True, "assets": []},
            {"tag_name": "v99.0.0", "draft": True, "assets": []},
        ]
        # A Beta channel may move to a newer stable release; drafts are excluded.
        self.assertEqual(select_release(releases, "1.5.0-beta.1").tag, "v9.0.0-beta.1")
        self.assertEqual(select_release(releases, "1.5.0").tag, "v1.5.0")

    def test_release_tags_with_pep440_local_build_metadata_are_accepted(self) -> None:
        release = select_release(
            [{"tag_name": "v1.5.0+build.1", "prerelease": False, "assets": []}],
            "1.4.0",
        )

        self.assertIsNotNone(release)
        self.assertEqual(release.tag, "v1.5.0+build.1")

    def test_pending_status_accepts_a_tagged_target_version(self) -> None:
        client = self._client(current="1.6.0")
        client.mark_pending("v1.6.0", "v1.6.0")

        status = client.startup_status()

        self.assertEqual(status, {"status": "success", "targetVersion": "v1.6.0", "tag": "v1.6.0"})
        self.assertFalse(client.pending_path.exists())

    def test_detect_installation_distinguishes_source_and_portable(self) -> None:
        source = detect_installation(system="win32", machine="AMD64", frozen=False)
        self.assertEqual(source.kind, "source")
        executable = self.root / "MAW" / "MAW.exe"
        portable = detect_installation(system="linux", machine="x86_64", frozen=True, executable=executable)
        self.assertEqual((portable.kind, portable.platform, portable.arch), ("portable", "linux", "x64"))

    def _client(self, current: str = "1.5.0-beta.9") -> UpdateClient:
        return UpdateClient(data_root=self.root / "data", current_version=current, system="win32", machine="AMD64", frozen=False)

    def _release_payload(self, *, tag: str = "v1.5.0", prerelease: bool = False, name: str = "MAW-Windows-x64-v1.5.0.zip", manifest_body: bytes = b"abc") -> tuple[list[dict[str, object]], dict[str, object]]:
        asset_url = f"https://github.com/Moyf/moys-asr-workflow/releases/download/{tag}/{name}"
        manifest_url = f"https://github.com/Moyf/moys-asr-workflow/releases/download/{tag}/update-manifest.json"
        manifest = _manifest(tag, tag[1:], prerelease=prerelease, name=name, body=manifest_body)
        release = {
            "tag_name": tag,
            "name": tag,
            "body": "- safe notes",
            "prerelease": prerelease,
            "draft": False,
            "html_url": f"https://github.com/Moyf/moys-asr-workflow/releases/tag/{tag}",
            "assets": [_asset(name, asset_url, len(manifest_body)), _asset("update-manifest.json", manifest_url, len(json.dumps(manifest).encode()))],
        }
        return [release], manifest

    def test_check_reads_release_manifest_and_selects_platform_asset(self) -> None:
        client = self._client()
        releases, manifest = self._release_payload()
        responses = iter([
            FakeResponse(json.dumps(releases).encode(), headers={"ETag": '"v1"'}, url=UPDATE_API_URL),
            FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json"),
        ])
        with mock.patch("maw.updater.urlopen", side_effect=lambda *_args, **_kwargs: next(responses)):
            result = client.check(force=True)
        self.assertTrue(result["available"])
        self.assertEqual(result["latestVersion"], "1.5.0")
        self.assertEqual(result["asset"]["name"], "MAW-Windows-x64-v1.5.0.zip")
        self.assertEqual(result["releaseNotes"], "- safe notes")
        self.assertEqual(json.loads(client.state_path.read_text(encoding="utf-8"))["etag"], '"v1"')

    def test_stable_channel_ignores_beta_and_draft_releases(self) -> None:
        client = self._client(current="1.5.0")
        releases = [
            {"tag_name": "v1.6.0-beta.1", "prerelease": True, "assets": []},
            {"tag_name": "v1.5.1", "prerelease": False, "assets": []},
            {"tag_name": "v9.0.0", "draft": True, "assets": []},
        ]
        self.assertEqual(select_release(releases, client.current_version).tag, "v1.5.1")

    def test_invalid_manifest_becomes_manual_result_instead_of_raising(self) -> None:
        client = self._client()
        releases, manifest = self._release_payload()
        manifest["schemaVersion"] = 99
        responses = iter([
            FakeResponse(json.dumps(releases).encode(), url=UPDATE_API_URL),
            FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json"),
        ])
        with mock.patch("maw.updater.urlopen", side_effect=lambda *_args, **_kwargs: next(responses)):
            result = client.check(force=True)
        self.assertEqual(result["errorCode"], "manifest_invalid")
        self.assertFalse(result["assetAvailable"])
        self.assertEqual(result["capability"], "manual")

    def test_etag_and_24_hour_cache_avoid_repeated_requests(self) -> None:
        client = self._client()
        releases, manifest = self._release_payload()
        calls: list[Request] = []

        def open_request(request: Request, **_kwargs: object) -> FakeResponse:
            calls.append(request)
            if len(calls) == 1:
                return FakeResponse(json.dumps(releases).encode(), headers={"ETag": '"v1"'}, url=UPDATE_API_URL)
            if len(calls) == 2:
                return FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json")
            raise AssertionError("24-hour cache should prevent a third request")

        with mock.patch("maw.updater.urlopen", side_effect=open_request):
            first = client.check(force=True)
            cached = client.check(force=False)
        self.assertTrue(cached["cached"])
        self.assertEqual(len(calls), 2)
        self.assertEqual(first["latestTag"], cached["latestTag"])
        self.assertTrue(client.should_check(force=True))

    def test_etag_304_regular_response_reuses_cached_release(self) -> None:
        client = self._client()
        releases, manifest = self._release_payload()
        responses = iter(
            [
                FakeResponse(json.dumps(releases).encode(), headers={"ETag": '"v1"'}, url=UPDATE_API_URL),
                FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json"),
                FakeResponse(b"", status=304, headers={"ETag": '"v1"'}, url=UPDATE_API_URL),
            ]
        )

        with mock.patch("maw.updater.urlopen", side_effect=lambda *_args, **_kwargs: next(responses)):
            first = client.check(force=True)
            cached = client.check(force=True)

        self.assertTrue(first["available"])
        self.assertTrue(cached["cached"])
        self.assertEqual(cached["latestTag"], first["latestTag"])

    def test_auto_check_preference_is_persisted_without_losing_result(self) -> None:
        client = self._client()
        client.set_preferences(auto_check=False)
        self.assertFalse(client.initial_status()["autoCheck"])
        self.assertFalse(client.should_check())
        skipped = client.check()
        self.assertTrue(skipped["autoSkipped"])

    def test_auto_check_preference_survives_a_release_check_and_304_cache(self) -> None:
        client = self._client()
        client.set_preferences(auto_check=False)
        releases, manifest = self._release_payload()
        responses = iter([
            FakeResponse(json.dumps(releases).encode(), headers={"ETag": '"v1"'}, url=UPDATE_API_URL),
            FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json"),
        ])
        with mock.patch("maw.updater.urlopen", side_effect=lambda *_args, **_kwargs: next(responses)):
            client.check(force=True)
        saved = json.loads(client.state_path.read_text(encoding="utf-8"))
        self.assertFalse(saved["autoCheck"])
        self.assertFalse(saved["result"]["autoCheck"])
        self.assertFalse(client.initial_status()["autoCheck"])
        self.assertFalse(client.should_check())

    def test_cached_result_reconciles_current_version_after_an_in_place_upgrade(self) -> None:
        client = self._client(current="1.6.0")
        client.state_path.parent.mkdir(parents=True, exist_ok=True)
        client.state_path.write_text(
            json.dumps(
                {
                    "autoCheck": True,
                    "lastCheckedAt": 123,
                    "result": {
                        "ok": True,
                        "currentVersion": "1.5.0-beta.9",
                        "channel": "beta",
                        "latestVersion": "1.6.0",
                        "latestTag": "v1.6.0",
                        "available": True,
                        "assetAvailable": True,
                    },
                }
            ),
            encoding="utf-8",
        )

        result = client.initial_status()

        self.assertEqual(result["currentVersion"], "1.6.0")
        self.assertEqual(result["channel"], "stable")
        self.assertFalse(result["available"])

    def test_release_asset_urls_are_limited_to_official_github_release_paths(self) -> None:
        self.assertTrue(updater_module._is_release_asset_url("https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/MAW.zip"))
        self.assertTrue(updater_module._is_release_asset_url("https://objects.githubusercontent.com/release-assets/123"))
        self.assertFalse(updater_module._is_release_asset_url("https://github.com/another/repo/releases/download/v1.5.0/MAW.zip"))
        self.assertFalse(updater_module._is_release_asset_url("http://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/MAW.zip"))

    def test_manifest_rejects_asset_filename_that_does_not_match_release_metadata(self) -> None:
        client = self._client()
        releases, manifest = self._release_payload(name="unexpected.zip")
        responses = iter([
            FakeResponse(json.dumps(releases).encode(), url=UPDATE_API_URL),
            FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json"),
        ])
        with mock.patch("maw.updater.urlopen", side_effect=lambda *_args, **_kwargs: next(responses)):
            result = client.check(force=True)
        self.assertEqual(result["errorCode"], "manifest_invalid")
        self.assertFalse(result["assetAvailable"])

    def test_duplicate_release_assets_make_the_manifest_invalid(self) -> None:
        client = self._client()
        releases, manifest = self._release_payload()
        duplicate = dict(releases[0]["assets"][0])
        releases[0]["assets"].append(duplicate)
        responses = iter(
            [
                FakeResponse(json.dumps(releases).encode(), url=UPDATE_API_URL),
                FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json"),
            ]
        )
        with mock.patch("maw.updater.urlopen", side_effect=lambda *_args, **_kwargs: next(responses)):
            result = client.check(force=True)
        self.assertEqual(result["errorCode"], "manifest_invalid")

    def test_failed_automatic_check_records_attempt_for_daily_throttle(self) -> None:
        client = self._client()
        with mock.patch("maw.updater.urlopen", side_effect=OSError("offline")):
            with self.assertRaisesRegex(UpdateError, "offline"):
                client.check(force=False)
        self.assertFalse(client.should_check())
        state = json.loads(client.state_path.read_text(encoding="utf-8"))
        self.assertGreater(float(state["lastCheckedAt"]), 0)

    def test_download_verifies_sha256_and_records_existing_file(self) -> None:
        client = self._client()
        releases, manifest = self._release_payload()
        data = b"abc"
        responses = iter([
            FakeResponse(json.dumps(releases).encode(), url=UPDATE_API_URL),
            FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json"),
            FakeResponse(data, headers={"Content-Length": str(len(data))}, url="https://objects.githubusercontent.com/release-assets/asset"),
        ])
        with mock.patch("maw.updater.urlopen", side_effect=lambda *_args, **_kwargs: next(responses)):
            client.check(force=True)
            path = client.download("v1.5.0")
        self.assertEqual(path.read_bytes(), data)
        self.assertEqual(path.parent, client.update_root / "v1.5.0")
        saved = json.loads(client.state_path.read_text(encoding="utf-8"))["result"]
        self.assertTrue(saved["downloaded"])
        self.assertEqual(Path(saved["downloadPath"]), path)
        with mock.patch("maw.updater.urlopen", side_effect=AssertionError("verified file should be reused")):
            self.assertEqual(client.download("v1.5.0"), path)

    def test_cancel_download_cleans_partial_file(self) -> None:
        client = self._client()
        releases, manifest = self._release_payload()
        responses = iter([
            FakeResponse(json.dumps(releases).encode(), url=UPDATE_API_URL),
            FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json"),
            FakeResponse(b"abc", headers={"Content-Length": "3"}, url="https://objects.githubusercontent.com/release-assets/asset"),
        ])
        cancel = Event()
        cancel.set()
        with mock.patch("maw.updater.urlopen", side_effect=lambda *_args, **_kwargs: next(responses)):
            client.check(force=True)
            with self.assertRaisesRegex(UpdateError, "update_cancelled"):
                client.download("v1.5.0", cancel_event=cancel)
        self.assertFalse(any(client.update_root.rglob("*.part")))

    def test_apply_installer_marks_pending_and_uses_restart_manager_flags(self) -> None:
        client = self._client()
        releases, manifest = self._release_payload(name="MAW-Setup-Windows-x64-v1.5.0.exe")
        manifest["assets"][0]["kind"] = "installer"
        data = b"abc"
        responses = iter([
            FakeResponse(json.dumps(releases).encode(), url=UPDATE_API_URL),
            FakeResponse(json.dumps(manifest).encode(), url="https://github.com/Moyf/moys-asr-workflow/releases/download/v1.5.0/update-manifest.json"),
            FakeResponse(data, headers={"Content-Length": "3"}, url="https://objects.githubusercontent.com/release-assets/asset"),
        ])
        executable = self.root / "install" / "MAW.exe"
        client.installation = InstallationInfo("installer", "windows", "x64", executable, executable.parent)
        with mock.patch("maw.updater.urlopen", side_effect=lambda *_args, **_kwargs: next(responses)), mock.patch("maw.updater.subprocess.Popen") as popen, mock.patch.object(client, "check_disk_space", return_value=True), mock.patch("maw.updater.os.access", return_value=True):
            client.check(force=True)
            client.download("v1.5.0")
            result = client.apply_installer("v1.5.0")
        self.assertTrue(result["restarting"])
        arguments = popen.call_args.args[0]
        self.assertIn("/CLOSEAPPLICATIONS", arguments)
        self.assertIn("/RESTARTAPPLICATIONS", arguments)
        self.assertNotIn("/NORESTART", arguments)
        pending = json.loads(client.pending_path.read_text(encoding="utf-8"))
        self.assertEqual(pending["status"], "applying")


if __name__ == "__main__":
    unittest.main()
