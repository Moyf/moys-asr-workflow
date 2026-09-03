"""Release discovery, download verification, and Windows update handoff.

The updater deliberately keeps network and filesystem policy outside the
Launcher bridge.  GitHub release metadata is treated as untrusted input:
asset names, versions, sizes, hashes, and URLs are validated before a file is
written or an installer is started.
"""

from __future__ import annotations

import hashlib
import json
import os
import platform as platform_module
import re
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Callable, Final, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

from packaging.version import InvalidVersion, Version

from maw.app_paths import default_app_data_root
from maw.gui_platform import creationflags, startupinfo


UPDATE_REPOSITORY: Final[str] = "Moyf/moys-asr-workflow"
UPDATE_API_URL: Final[str] = f"https://api.github.com/repos/{UPDATE_REPOSITORY}/releases"
UPDATE_RELEASE_URL: Final[str] = f"https://github.com/{UPDATE_REPOSITORY}/releases"
UPDATE_MANIFEST_NAME: Final[str] = "update-manifest.json"
UPDATE_STATE_NAME: Final[str] = "state.json"
UPDATE_PENDING_NAME: Final[str] = "pending.json"
UPDATE_CHECK_INTERVAL_SECONDS: Final[int] = 24 * 60 * 60
UPDATE_MAX_DOWNLOAD_BYTES: Final[int] = 2 * 1024 * 1024 * 1024
UPDATE_MANIFEST_SCHEMA: Final[int] = 1
UPDATE_USER_AGENT: Final[str] = "MAW-updater/1"
UPDATE_INSTALL_REGISTRY_KEY: Final[str] = r"Software\Moy\MAW"
UPDATE_TAG_RE: Final[re.Pattern[str]] = re.compile(r"^v?[A-Za-z0-9][A-Za-z0-9._+\-]{0,100}$")
UPDATE_ASSET_NAME_RE: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+() -]{0,240}$")
SHA256_RE: Final[re.Pattern[str]] = re.compile(r"^[0-9a-fA-F]{64}$")


class UpdateError(RuntimeError):
    """A user-facing updater failure with a stable error code."""

    def __init__(self, code: str, detail: str = "") -> None:
        self.code = code
        self.detail = detail
        super().__init__(detail or code)


class UpdateCancelled(UpdateError):
    def __init__(self) -> None:
        super().__init__("update_cancelled")


@dataclass(frozen=True, slots=True)
class InstallationInfo:
    kind: str
    platform: str
    arch: str
    executable: Path | None = None
    install_root: Path | None = None
    marker_path: Path | None = None

    @property
    def can_apply(self) -> bool:
        return self.kind == "installer" and self.platform == "windows" and self.arch == "x64"

    def to_payload(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "platform": self.platform,
            "arch": self.arch,
            "canApply": self.can_apply,
            "executable": str(self.executable) if self.executable else "",
            "installRoot": str(self.install_root) if self.install_root else "",
        }


@dataclass(frozen=True, slots=True)
class UpdateAsset:
    name: str
    url: str
    platform: str
    arch: str
    kind: str
    flavor: str
    size: int
    sha256: str

    def to_payload(self) -> dict[str, object]:
        return {
            "name": self.name,
            "url": self.url,
            "platform": self.platform,
            "arch": self.arch,
            "kind": self.kind,
            "type": self.kind,
            "flavor": self.flavor,
            "size": self.size,
            "sha256": self.sha256,
        }

    @classmethod
    def from_payload(cls, value: Mapping[str, object]) -> "UpdateAsset":
        try:
            name = str(value["name"])
            url = str(value["url"])
            platform_name = str(value["platform"])
            arch = str(value["arch"])
            raw_kind = value.get("kind")
            raw_type = value.get("type")
            if raw_kind in (None, "") and raw_type in (None, ""):
                raise KeyError("kind")
            if raw_kind not in (None, "") and raw_type not in (None, "") and str(raw_kind) != str(raw_type):
                raise ValueError("kind/type mismatch")
            kind = str(raw_kind if raw_kind not in (None, "") else raw_type)
            flavor = str(value["flavor"])
            raw_size = value["size"]
            if isinstance(raw_size, bool) or not isinstance(raw_size, int):
                raise TypeError("asset size must be an integer")
            size = raw_size
            sha256 = str(value["sha256"]).lower()
        except (KeyError, TypeError, ValueError) as error:
            raise UpdateError("manifest_invalid", "asset fields are incomplete") from error
        _validate_asset_fields(name, url, platform_name, arch, kind, flavor, size, sha256)
        return cls(name, url, platform_name, arch, kind, flavor, size, sha256)


@dataclass(frozen=True, slots=True)
class UpdateRelease:
    tag: str
    version: Version
    version_text: str
    prerelease: bool
    name: str
    body: str
    published_at: str
    html_url: str
    api_assets: tuple[Mapping[str, object], ...]


def normalize_version(value: object) -> Version:
    text = str(value or "").strip()
    if text.lower().startswith("v"):
        text = text[1:]
    if not text:
        raise InvalidVersion(str(value))
    return Version(text)


def version_text(value: object) -> str:
    """Return the project-facing version without a leading ``v``.

    ``packaging.Version`` is used for ordering, but its canonical spelling
    turns ``1.5.0-beta.10`` into ``1.5.0b10``.  Keep the repository's spelling
    in UI/state payloads so tags, manifests, and release notes remain familiar.
    """
    text = str(value or "").strip()
    if text.lower().startswith("v"):
        text = text[1:]
    _ = normalize_version(text)
    return text


def channel_for_version(value: object) -> str:
    try:
        return "beta" if normalize_version(value).is_prerelease else "stable"
    except InvalidVersion:
        return "stable"


def _release_from_api(value: Mapping[str, object]) -> UpdateRelease | None:
    tag = str(value.get("tag_name") or "").strip()
    if (
        not tag
        or not UPDATE_TAG_RE.fullmatch(tag)
        or bool(value.get("draft"))
    ):
        return None
    try:
        parsed = normalize_version(tag)
    except InvalidVersion:
        return None
    raw_assets = value.get("assets")
    api_assets: tuple[Mapping[str, object], ...]
    if isinstance(raw_assets, list):
        api_assets = tuple(item for item in raw_assets if isinstance(item, Mapping))
    else:
        api_assets = ()
    html_url = str(value.get("html_url") or "").strip()
    if not _is_release_url(html_url):
        html_url = f"{UPDATE_RELEASE_URL}/tag/{tag}"
    return UpdateRelease(
        tag=tag,
        version=parsed,
        version_text=version_text(tag),
        prerelease=bool(value.get("prerelease")) or parsed.is_prerelease,
        name=str(value.get("name") or tag),
        body=str(value.get("body") or ""),
        published_at=str(value.get("published_at") or value.get("created_at") or ""),
        html_url=html_url,
        api_assets=api_assets,
    )


def select_release(releases: list[Mapping[str, object]], current_version: object) -> UpdateRelease | None:
    """Select the highest release allowed by the current stable/Beta channel."""
    channel = channel_for_version(current_version)
    candidates: list[UpdateRelease] = []
    for raw in releases:
        if not isinstance(raw, Mapping):
            continue
        release = _release_from_api(raw)
        if release is None:
            continue
        if channel == "stable" and release.prerelease:
            continue
        candidates.append(release)
    if not candidates:
        return None
    return max(candidates, key=lambda item: item.version)


def _is_release_url(url: str) -> bool:
    parsed = urlparse(url)
    return parsed.scheme == "https" and parsed.netloc.casefold() == "github.com" and parsed.path.startswith(
        f"/{UPDATE_REPOSITORY}/releases/"
    )


def _validate_asset_fields(
    name: str,
    url: str,
    platform_name: str,
    arch: str,
    kind: str,
    flavor: str,
    size: int,
    sha256: str,
) -> None:
    if not UPDATE_ASSET_NAME_RE.fullmatch(name) or Path(name).name != name:
        raise UpdateError("manifest_invalid", "asset name is unsafe")
    if not _is_release_asset_url(url):
        raise UpdateError("asset_url_invalid", "asset URL must point to GitHub over HTTPS")
    if platform_name not in {"windows", "macos", "linux"} or arch not in {"x64", "arm64"}:
        raise UpdateError("manifest_invalid", "unsupported platform or architecture")
    if kind not in {"installer", "portable"} or flavor not in {"standard", "lite"}:
        raise UpdateError("manifest_invalid", "unsupported asset kind or flavor")
    if size <= 0 or size > UPDATE_MAX_DOWNLOAD_BYTES:
        raise UpdateError("asset_size_invalid", "asset size is outside the allowed range")
    if not SHA256_RE.fullmatch(sha256):
        raise UpdateError("manifest_invalid", "asset SHA-256 is invalid")


def _platform_arch(system: str | None = None, machine: str | None = None) -> tuple[str, str]:
    system = system or sys.platform
    machine = (machine or platform_module.machine()).casefold()
    arch = "arm64" if machine in {"arm64", "aarch64"} else "x64" if machine in {"amd64", "x86_64", "x64"} else machine
    if system == "win32":
        return "windows", arch
    if system == "darwin":
        return "macos", arch
    if system.startswith("linux"):
        return "linux", arch
    return system, arch


def _installer_registry(executable: Path, *, system: str | None = None) -> Path | None:
    if (system or sys.platform) != "win32":
        return None
    try:
        import winreg

        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, UPDATE_INSTALL_REGISTRY_KEY) as key:
            marker = Path(str(winreg.QueryValueEx(key, "ExecutablePath")[0])).expanduser().resolve(strict=False)
    except (AttributeError, ImportError, OSError, TypeError, ValueError):
        return None
    return marker if marker == executable else None


def detect_installation(
    *,
    system: str | None = None,
    machine: str | None = None,
    frozen: bool | None = None,
    executable: Path | None = None,
) -> InstallationInfo:
    system = system or sys.platform
    platform_name, arch = _platform_arch(system, machine)
    if frozen is None:
        frozen = bool(getattr(sys, "frozen", False))
    if not frozen:
        return InstallationInfo("source", platform_name, arch)
    executable = (executable or Path(sys.executable)).expanduser().resolve(strict=False)
    root = executable.parent
    marker = _installer_registry(executable, system=system) if system == "win32" else None
    if marker is not None:
        return InstallationInfo("installer", platform_name, arch, executable, root, marker)
    return InstallationInfo("portable", platform_name, arch, executable, root)


def _json_write(path: Path, value: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".part")
    temporary.write_text(json.dumps(dict(value), ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(path)


def _json_read(path: Path) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return {}
    return dict(value) if isinstance(value, Mapping) else {}


def _state_write_error(path: Path, error: BaseException) -> UpdateError:
    return UpdateError("state_write_failed", f"unable to write updater state {path}: {error}")


def _is_release_asset_url(url: str, *, tag: str | None = None) -> bool:
    parsed = urlparse(url)
    if parsed.scheme != "https":
        return False
    host = parsed.netloc.casefold()
    if host == "github.com":
        prefix = f"/{UPDATE_REPOSITORY}/releases/download/"
        if tag:
            prefix += f"{tag}/"
        return parsed.path.startswith(prefix)
    # GitHub redirects release downloads to one of these immutable asset
    # hosts.  The API response is still required to come from the official
    # repository before this URL is ever accepted.
    return host in {"objects.githubusercontent.com", "release-assets.githubusercontent.com"} and bool(parsed.path)


def _header_value(headers: Mapping[str, object], name: str) -> str:
    """Read an HTTP header without relying on a particular mapping casing."""
    wanted = name.casefold()
    for key, value in headers.items():
        if str(key).casefold() == wanted:
            return str(value)
    return ""


def _expected_asset_name(
    *,
    version: str,
    platform_name: str,
    arch: str,
    kind: str,
    flavor: str,
) -> str | None:
    """Return the schema-v1 filename for a known MAW release asset."""
    suffix = f"v{version}"
    if platform_name == "windows" and arch == "x64":
        if kind == "installer" and flavor == "standard":
            return f"MAW-Setup-Windows-x64-{suffix}.exe"
        if kind == "portable" and flavor == "standard":
            return f"MAW-Windows-x64-{suffix}.zip"
        if kind == "portable" and flavor == "lite":
            return f"MAW-lite-Windows-x64-{suffix}.zip"
    if platform_name == "macos" and arch == "arm64" and kind == "portable":
        if flavor == "standard":
            return f"MAW-macOS-arm64-{suffix}.zip"
        if flavor == "lite":
            return f"MAW-lite-macOS-arm64-{suffix}.zip"
    if platform_name == "linux" and arch == "x64" and kind == "portable" and flavor == "standard":
        return f"MAW-Linux-x86_64-{suffix}.AppImage"
    return None


class UpdateClient:
    """Stateful updater used by the Launcher API and easy to test in isolation."""

    def __init__(
        self,
        *,
        data_root: Path | None = None,
        current_version: object,
        system: str | None = None,
        machine: str | None = None,
        frozen: bool | None = None,
        executable: Path | None = None,
    ) -> None:
        self.data_root = (data_root or default_app_data_root()).expanduser().resolve(strict=False)
        self.current_version = version_text(current_version)
        self.installation = detect_installation(system=system, machine=machine, frozen=frozen, executable=executable)
        self._last_result: dict[str, object] | None = None

    @property
    def update_root(self) -> Path:
        return self.data_root / "updates"

    @property
    def state_path(self) -> Path:
        return self.update_root / UPDATE_STATE_NAME

    @property
    def pending_path(self) -> Path:
        return self.update_root / UPDATE_PENDING_NAME

    def startup_status(self) -> dict[str, object] | None:
        pending = _json_read(self.pending_path)
        if not pending:
            return None
        target = str(pending.get("targetVersion") or "")
        target_matches_current = False
        if target:
            try:
                target_matches_current = normalize_version(target) == normalize_version(self.current_version)
            except InvalidVersion:
                target_matches_current = target == self.current_version
        if target_matches_current:
            try:
                self.pending_path.unlink(missing_ok=True)
            except OSError:
                pass
            return {"status": "success", "targetVersion": target, "tag": str(pending.get("tag") or "")}
        if pending.get("status") == "applying":
            return {"status": "failed", "targetVersion": target, "tag": str(pending.get("tag") or "")}
        return {"status": str(pending.get("status") or "failed"), "targetVersion": target, "tag": str(pending.get("tag") or "")}

    def _currentize_result(self, cached: Mapping[str, object]) -> dict[str, object]:
        """Reconcile a persisted result with the version that is running now.

        The update state survives an in-place upgrade.  A result written by the
        previous process must therefore not keep advertising that old process
        as the current version (or keep ``available`` true after installing
        that exact target).
        """
        result = dict(cached)
        current = normalize_version(self.current_version)
        result["currentVersion"] = self.current_version
        result["channel"] = channel_for_version(self.current_version)
        latest_value = result.get("latestVersion") or result.get("latestTag")
        try:
            latest = normalize_version(latest_value)
        except InvalidVersion:
            result["available"] = False
        else:
            result["available"] = latest > current and not (
                channel_for_version(self.current_version) == "stable" and latest.is_prerelease
            )
        result["installation"] = self.installation.to_payload()
        return result

    def initial_status(self) -> dict[str, object]:
        state = _json_read(self.state_path)
        cached = state.get("result") if isinstance(state.get("result"), Mapping) else {}
        result = self._currentize_result(cached)
        result.setdefault("ok", True)
        result.setdefault("available", False)
        result.setdefault("checking", False)
        # Keep the preference authoritative at the top level.  Older state
        # files may only have copied it into the cached result, while newer
        # writes preserve both locations for compatibility.
        if "autoCheck" in state:
            result["autoCheck"] = bool(state.get("autoCheck"))
        else:
            result.setdefault("autoCheck", bool(cached.get("autoCheck", True)))
        if state.get("lastCheckedAt") is not None:
            result.setdefault("lastCheckedAt", state.get("lastCheckedAt"))
        result["cached"] = bool(cached)
        startup = self.startup_status()
        if startup:
            result["startup"] = startup
        return result

    def should_check(self, *, force: bool = False) -> bool:
        """Return whether an automatic check is due.

        ``force`` is reserved for the explicit Settings-page action and always
        bypasses both the preference and the 24-hour throttle.
        """
        if force:
            return True
        state = _json_read(self.state_path)
        if not bool(state.get("autoCheck", True)):
            return False
        try:
            checked_at = float(state.get("lastCheckedAt") or 0)
        except (TypeError, ValueError):
            checked_at = 0
        return not checked_at or time.time() - checked_at >= UPDATE_CHECK_INTERVAL_SECONDS

    def set_preferences(self, *, auto_check: bool) -> dict[str, object]:
        """Persist update preferences without discarding cached release data."""
        state = _json_read(self.state_path)
        enabled = bool(auto_check)
        state["autoCheck"] = enabled
        cached = state.get("result")
        if isinstance(cached, Mapping):
            cached_result = dict(cached)
            cached_result["autoCheck"] = enabled
            state["result"] = cached_result
        try:
            _json_write(self.state_path, state)
        except (OSError, UnicodeError, TypeError, ValueError) as error:
            raise _state_write_error(self.state_path, error) from error
        result = self.initial_status()
        result["autoCheck"] = enabled
        return {"ok": True, "autoCheck": enabled, "update": result}

    def _http_json(
        self,
        url: str,
        headers: Mapping[str, str] | None = None,
        *,
        require_release_asset_redirect: bool = False,
        release_asset_tag: str | None = None,
    ) -> tuple[int, Mapping[str, str], object]:
        request = Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": UPDATE_USER_AGENT, **dict(headers or {})})
        try:
            with urlopen(request, timeout=20) as response:  # noqa: S310
                status = int(getattr(response, "status", 200) or 200)
                response_headers = dict(response.headers.items())
                # urllib normally raises HTTPError for a 304, but test doubles
                # and alternate handlers may return it as a regular response.
                # Treat both forms identically so ETag revalidation never
                # attempts to decode an empty body as JSON.
                if status == 304:
                    return 304, response_headers, None
                if require_release_asset_redirect:
                    geturl = getattr(response, "geturl", None)
                    final_url = str(geturl() or "") if callable(geturl) else ""
                    if final_url and not _is_release_asset_url(final_url, tag=release_asset_tag):
                        raise UpdateError("asset_url_invalid", "manifest download redirected outside GitHub release assets")
                body = response.read(8 * 1024 * 1024 + 1)
                if len(body) > 8 * 1024 * 1024:
                    raise UpdateError("response_too_large")
                return status, response_headers, json.loads(body.decode("utf-8"))
        except HTTPError as error:
            if error.code == 304:
                return 304, dict(error.headers.items()), None
            if error.code in {403, 429}:
                raise UpdateError("rate_limited", f"GitHub returned HTTP {error.code}") from error
            raise UpdateError("update_http_error", f"GitHub returned HTTP {error.code}") from error
        except json.JSONDecodeError as error:
            raise UpdateError("update_response_invalid", "GitHub returned invalid JSON") from error
        except (URLError, TimeoutError, OSError, UnicodeError) as error:
            raise UpdateError("offline", str(error)) from error

    @staticmethod
    def _manifest_asset(release: UpdateRelease) -> Mapping[str, object] | None:
        matches = [asset for asset in release.api_assets if str(asset.get("name") or "") == UPDATE_MANIFEST_NAME]
        if len(matches) > 1:
            raise UpdateError("manifest_invalid", "Release contains duplicate update manifests")
        return matches[0] if matches else None

    def _read_manifest(self, release: UpdateRelease) -> Mapping[str, object] | None:
        asset = self._manifest_asset(release)
        if asset is None:
            return None
        url = str(asset.get("browser_download_url") or "")
        if not _is_release_asset_url(url, tag=release.tag):
            raise UpdateError("manifest_invalid", "manifest download URL is not a GitHub release asset")
        try:
            _status, _headers, payload = self._http_json(
                url,
                {"Accept": "application/json"},
                require_release_asset_redirect=True,
                release_asset_tag=release.tag,
            )
        except UpdateError as error:
            if error.code == "update_response_invalid":
                raise UpdateError("manifest_invalid", "manifest is not valid JSON") from error
            raise
        if not isinstance(payload, Mapping):
            raise UpdateError("manifest_invalid", "manifest is not a JSON object")
        if type(payload.get("schemaVersion")) is not int or payload.get("schemaVersion") != UPDATE_MANIFEST_SCHEMA:
            raise UpdateError("manifest_invalid", "unsupported update manifest schema")
        if str(payload.get("tag") or "") != release.tag:
            raise UpdateError("manifest_invalid", "manifest version does not match the Release")
        try:
            raw_manifest_version = str(payload.get("version") or "").strip()
            manifest_version_text = version_text(raw_manifest_version)
            manifest_version = normalize_version(manifest_version_text)
        except InvalidVersion as error:
            raise UpdateError("manifest_invalid", "manifest version is invalid") from error
        if raw_manifest_version != release.version_text or manifest_version != release.version:
            raise UpdateError("manifest_invalid", "manifest version does not match the Release")
        if not isinstance(payload.get("prerelease"), bool) or payload["prerelease"] != release.prerelease:
            raise UpdateError("manifest_invalid", "manifest prerelease flag does not match the Release")
        return payload

    def _api_asset_map(self, release: UpdateRelease) -> dict[str, Mapping[str, object]]:
        result: dict[str, Mapping[str, object]] = {}
        seen: set[str] = set()
        for asset in release.api_assets:
            name = str(asset.get("name") or "")
            if name and name != UPDATE_MANIFEST_NAME:
                if name in seen:
                    raise UpdateError("manifest_invalid", f"Release contains duplicate asset: {name}")
                seen.add(name)
            url = str(asset.get("browser_download_url") or "")
            if name and name != UPDATE_MANIFEST_NAME and _is_release_asset_url(url, tag=release.tag):
                result[name] = asset
        return result

    def _select_asset(self, release: UpdateRelease, manifest: Mapping[str, object]) -> UpdateAsset | None:
        raw_assets = manifest.get("assets")
        if not isinstance(raw_assets, list):
            raise UpdateError("manifest_invalid", "manifest assets must be a list")
        api_assets = self._api_asset_map(release)
        platform_name = self.installation.platform
        arch = self.installation.arch
        desired_kind = "installer" if self.installation.can_apply else "portable"
        desired_flavor = "standard"
        if self.installation.kind == "portable" and self.installation.install_root:
            ffmpeg_root = self.installation.install_root / "ffmpeg" / "bin"
            bundled_ffmpeg = ffmpeg_root / ("ffmpeg.exe" if platform_name == "windows" else "ffmpeg")
            bundled_ffprobe = ffmpeg_root / ("ffprobe.exe" if platform_name == "windows" else "ffprobe")
            desired_flavor = "standard" if bundled_ffmpeg.is_file() and bundled_ffprobe.is_file() else "lite"
        candidates: list[UpdateAsset] = []
        for raw in raw_assets:
            if not isinstance(raw, Mapping):
                raise UpdateError("manifest_invalid", "manifest contains a non-object asset")
            name = str(raw.get("name") or "")
            if name in {asset.name for asset in candidates}:
                raise UpdateError("manifest_invalid", f"manifest contains a duplicate asset: {name}")
            api = api_assets.get(name)
            if api is None:
                raise UpdateError("manifest_invalid", f"manifest asset is missing from the Release: {name}")
            merged = dict(raw)
            merged["url"] = str(api.get("browser_download_url") or "")
            if api.get("size") not in (None, ""):
                try:
                    api_size = int(api.get("size") or 0)
                    manifest_size = int(raw.get("size") or 0)
                except (TypeError, ValueError) as error:
                    raise UpdateError("manifest_invalid", f"asset size is invalid: {name}") from error
                if api_size <= 0 or api_size != manifest_size:
                    raise UpdateError("asset_size_invalid", f"asset size does not match the Release: {name}")
            asset = UpdateAsset.from_payload(merged)
            expected_name = _expected_asset_name(
                version=release.version_text,
                platform_name=asset.platform,
                arch=asset.arch,
                kind=asset.kind,
                flavor=asset.flavor,
            )
            if expected_name is not None and asset.name != expected_name:
                raise UpdateError("manifest_invalid", f"asset filename does not match its release metadata: {asset.name}")
            candidates.append(asset)
        matches = [
            asset
            for asset in candidates
            if asset.platform == platform_name and asset.arch == arch and asset.kind == desired_kind and asset.flavor == desired_flavor
        ]
        if matches:
            return matches[0]
        # A missing platform asset is a valid Release state: show the release
        # page, but never present a misleading automatic-update action.
        return None

    def _result_for_release(self, release: UpdateRelease, manifest: Mapping[str, object] | None, manifest_error: UpdateError | None) -> dict[str, object]:
        current = normalize_version(self.current_version)
        available = release.version > current
        result: dict[str, object] = {
            "ok": True,
            "currentVersion": self.current_version,
            "channel": channel_for_version(self.current_version),
            "latestVersion": release.version_text,
            "latestTag": release.tag,
            "available": available,
            "releaseName": release.name,
            "releaseNotes": release.body[:12000],
            "publishedAt": release.published_at,
            "releaseUrl": release.html_url,
            "asset": None,
            "assetAvailable": False,
            "capability": "manual",
            "installation": self.installation.to_payload(),
        }
        if manifest_error is not None:
            result["errorCode"] = manifest_error.code
            result["errorDetail"] = manifest_error.detail
        if manifest is not None:
            try:
                asset = self._select_asset(release, manifest)
            except UpdateError as error:
                result["errorCode"] = error.code
                result["errorDetail"] = error.detail
            else:
                if asset is not None:
                    result["asset"] = asset.to_payload()
                    result["assetAvailable"] = True
                    result["capability"] = "installer" if asset.kind == "installer" and self.installation.can_apply else "manual"
        return result

    def check(self, *, force: bool = False) -> dict[str, object]:
        if not self.should_check(force=force):
            result = self.initial_status()
            result["cached"] = True
            result["autoSkipped"] = True
            self._last_result = result
            return result
        state = _json_read(self.state_path)
        cached = state.get("result") if isinstance(state.get("result"), Mapping) else None
        if isinstance(cached, Mapping):
            migrated = self._currentize_result(cached)
            cached = migrated
        try:
            checked_at = float(state.get("lastCheckedAt") or 0)
        except (TypeError, ValueError):
            checked_at = 0
        if not force and cached and time.time() - checked_at < UPDATE_CHECK_INTERVAL_SECONDS:
            result = self._currentize_result(cached)
            result["cached"] = True
            self._last_result = result
            return result
        # Record the attempt before any network request.  This guarantees that
        # an automatic check still honors the 24-hour request budget when the
        # machine is offline or GitHub returns an error.
        attempt_at = time.time()
        state["autoCheck"] = bool(state.get("autoCheck", True))
        state["lastCheckedAt"] = attempt_at
        try:
            _json_write(self.state_path, state)
        except (OSError, UnicodeError, TypeError, ValueError) as error:
            raise _state_write_error(self.state_path, error) from error
        headers: dict[str, str] = {}
        if state.get("etag"):
            headers["If-None-Match"] = str(state["etag"])
        status, response_headers, payload = self._http_json(UPDATE_API_URL, headers)
        if status == 304 and cached:
            result = self._currentize_result(cached)
            result["cached"] = True
            result["autoCheck"] = bool(state.get("autoCheck", True))
            result["lastCheckedAt"] = time.time()
            try:
                _json_write(
                    self.state_path,
                    {
                        **state,
                        "autoCheck": bool(state.get("autoCheck", True)),
                        "lastCheckedAt": result["lastCheckedAt"],
                        "result": result,
                    },
                )
            except (OSError, UnicodeError, TypeError, ValueError) as error:
                raise _state_write_error(self.state_path, error) from error
            self._last_result = result
            return result
        if status != 200 or not isinstance(payload, list):
            raise UpdateError("update_response_invalid", "GitHub releases response is invalid")
        release = select_release([item for item in payload if isinstance(item, Mapping)], self.current_version)
        if release is None:
            result = {
                "ok": True,
                "currentVersion": self.current_version,
                "channel": channel_for_version(self.current_version),
                "latestVersion": self.current_version,
                "latestTag": "",
                "available": False,
                "releaseName": "",
                "releaseNotes": "",
                "publishedAt": "",
                "releaseUrl": UPDATE_RELEASE_URL,
                "asset": None,
                "assetAvailable": False,
                "capability": "none",
                "installation": self.installation.to_payload(),
            }
        else:
            manifest: Mapping[str, object] | None = None
            manifest_error: UpdateError | None = None
            try:
                manifest = self._read_manifest(release)
                if manifest is None:
                    manifest_error = UpdateError("manifest_missing", "Release does not include update-manifest.json")
            except UpdateError as error:
                manifest_error = error
            result = self._result_for_release(release, manifest, manifest_error)
        result["lastCheckedAt"] = time.time()
        result["cached"] = False
        result["autoCheck"] = bool(state.get("autoCheck", True))
        try:
            _json_write(
                self.state_path,
                {
                    "autoCheck": bool(state.get("autoCheck", True)),
                    "lastCheckedAt": result["lastCheckedAt"],
                    "etag": _header_value(response_headers, "ETag"),
                    "result": result,
                },
            )
        except (OSError, UnicodeError, TypeError, ValueError) as error:
            raise _state_write_error(self.state_path, error) from error
        self._last_result = result
        return result

    def _cached_result_for_tag(self, tag: str) -> dict[str, object]:
        if not UPDATE_TAG_RE.fullmatch(tag):
            raise UpdateError("update_target_invalid", "the requested update tag is invalid")
        result = self._last_result or self.initial_status()
        if str(result.get("latestTag") or "") != tag or not result.get("available") or not result.get("assetAvailable"):
            raise UpdateError("update_target_invalid", "the requested update is not the verified latest asset")
        asset = result.get("asset")
        if not isinstance(asset, Mapping):
            raise UpdateError("update_target_invalid", "the requested update has no verified asset")
        return result

    def download(
        self,
        tag: str,
        *,
        cancel_event: Event | None = None,
        on_progress: Callable[[int, int], None] | None = None,
    ) -> Path:
        result = self._cached_result_for_tag(tag)
        asset = UpdateAsset.from_payload(result["asset"] if isinstance(result.get("asset"), Mapping) else {})
        # Keep the exact Release tag in the directory name.  Besides making
        # state inspection less surprising, this avoids collisions between a
        # hypothetical ``v1.2.3`` tag and a bare ``1.2.3`` tag.
        destination_dir = self.update_root / tag
        destination = destination_dir / asset.name
        if destination.exists() and _verify_file(destination, asset.size, asset.sha256):
            self._record_download(destination, result)
            return destination
        destination_dir.mkdir(parents=True, exist_ok=True)
        partial = destination.with_name(destination.name + ".part")
        try:
            with urlopen(Request(asset.url, headers={"User-Agent": UPDATE_USER_AGENT}), timeout=60) as response:  # noqa: S310
                status = int(getattr(response, "status", 200) or 200)
                if status != 200:
                    raise UpdateError("download_failed", f"asset returned HTTP {status}")
                response_url = ""
                geturl = getattr(response, "geturl", None)
                if callable(geturl):
                    response_url = str(geturl() or "")
                if response_url and not _is_release_asset_url(response_url, tag=tag):
                    raise UpdateError("asset_url_invalid", "download redirected outside GitHub release assets")
                total = asset.size
                content_length = _header_value(response.headers, "Content-Length")
                if content_length:
                    try:
                        if int(content_length) > UPDATE_MAX_DOWNLOAD_BYTES or int(content_length) != asset.size:
                            raise UpdateError("asset_size_invalid", "download size does not match the manifest")
                    except ValueError as error:
                        raise UpdateError("download_failed", "asset Content-Length is invalid") from error
                digest = hashlib.sha256()
                received = 0
                with partial.open("wb") as handle:
                    while True:
                        if cancel_event is not None and cancel_event.is_set():
                            raise UpdateCancelled()
                        chunk = response.read(1 << 16)
                        if not chunk:
                            break
                        received += len(chunk)
                        if received > asset.size or received > UPDATE_MAX_DOWNLOAD_BYTES:
                            raise UpdateError("asset_size_invalid", "download exceeded the manifest size")
                        digest.update(chunk)
                        handle.write(chunk)
                        if on_progress:
                            on_progress(received, total)
                if received != asset.size:
                    raise UpdateError("asset_size_invalid", "download ended before the manifest size")
                if digest.hexdigest().lower() != asset.sha256:
                    raise UpdateError("checksum_mismatch", "download SHA-256 does not match the manifest")
            partial.replace(destination)
        except UpdateError:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass
            raise
        except (HTTPError, URLError, OSError, TimeoutError) as error:
            try:
                partial.unlink(missing_ok=True)
            except OSError:
                pass
            raise UpdateError("download_failed", str(error)) from error
        self._record_download(destination, result)
        return destination

    def _record_download(self, destination: Path, result: Mapping[str, object]) -> None:
        state = _json_read(self.state_path)
        if isinstance(self._last_result, Mapping):
            latest_result = dict(self._last_result)
        elif isinstance(state.get("result"), Mapping):
            latest_result = dict(state["result"])
        else:
            latest_result = dict(result)
        latest_result["downloaded"] = True
        latest_result["downloadPath"] = str(destination)
        try:
            _json_write(self.state_path, {**state, "result": latest_result})
        except (OSError, UnicodeError, TypeError, ValueError) as error:
            raise _state_write_error(self.state_path, error) from error
        self._last_result = latest_result

    def cached_download(self, tag: str) -> Path:
        result = self._cached_result_for_tag(tag)
        path = Path(str(result.get("downloadPath") or ""))
        asset = UpdateAsset.from_payload(result["asset"] if isinstance(result.get("asset"), Mapping) else {})
        expected_dir = (self.update_root / tag).resolve(strict=False)
        if path.name != asset.name or path.resolve(strict=False).parent != expected_dir:
            raise UpdateError("update_not_downloaded", "verified update package is not available")
        if not path.is_file() or not _verify_file(path, asset.size, asset.sha256):
            raise UpdateError("update_not_downloaded", "verified update package is not available")
        return path

    def check_disk_space(self, path: Path, asset_size: int) -> bool:
        try:
            stats = os.statvfs(path)
            return int(stats.f_bavail * stats.f_frsize) >= asset_size * 3
        except (AttributeError, OSError):
            # Windows has no statvfs in normal Python; shutil.disk_usage is
            # imported lazily to keep this module cheap during startup.
            try:
                import shutil

                return shutil.disk_usage(path).free >= asset_size * 3
            except OSError:
                return False

    def mark_pending(self, tag: str, target_version: str) -> None:
        try:
            _json_write(self.pending_path, {"status": "applying", "tag": tag, "targetVersion": target_version, "startedAt": time.time()})
        except (OSError, UnicodeError, TypeError, ValueError) as error:
            raise _state_write_error(self.pending_path, error) from error

    def mark_failed(self, tag: str, target_version: str, detail: str = "") -> None:
        _json_write(
            self.pending_path,
            {
                "status": "failed",
                "tag": tag,
                "targetVersion": target_version,
                "detail": detail,
                "failedAt": time.time(),
            },
        )

    def apply_installer(self, tag: str) -> dict[str, object]:
        if not self.installation.can_apply or self.installation.executable is None:
            raise UpdateError("update_manual_only", "this MAW copy is not an installed Windows package")
        path = self.cached_download(tag)
        result = self._cached_result_for_tag(tag)
        asset = UpdateAsset.from_payload(result["asset"] if isinstance(result.get("asset"), Mapping) else {})
        if asset.kind != "installer" or asset.platform != "windows" or asset.arch != "x64":
            raise UpdateError("update_manual_only", "the verified asset is not a Windows installer")
        parent = self.installation.install_root or self.installation.executable.parent
        if not self.check_disk_space(parent, asset.size):
            raise UpdateError("disk_space_low", "not enough free disk space for the update")
        if not os.access(parent, os.W_OK):
            raise UpdateError("install_not_writable", "the MAW installation directory is not writable")
        self.mark_pending(tag, str(result.get("latestVersion") or ""))
        log_path = self.update_root / f"installer-{tag}.log"
        arguments = [
            str(path),
            "/VERYSILENT",
            "/SUPPRESSMSGBOXES",
            "/CLOSEAPPLICATIONS",
            "/RESTARTAPPLICATIONS",
            f"/LOG={log_path}",
        ]
        try:
            subprocess.Popen(arguments, cwd=str(path.parent), startupinfo=startupinfo(), creationflags=creationflags(), close_fds=True)
        except OSError as error:
            self.mark_failed(tag, str(result.get("latestVersion") or ""), str(error))
            raise UpdateError("installer_start_failed", str(error)) from error
        return {"ok": True, "restarting": True, "tag": tag, "targetVersion": result.get("latestVersion", "")}


def _verify_file(path: Path, size: int, expected_sha256: str) -> bool:
    try:
        if path.stat().st_size != size:
            return False
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1 << 16), b""):
                digest.update(chunk)
        return digest.hexdigest().lower() == expected_sha256.lower()
    except OSError:
        return False


__all__ = [
    "UPDATE_API_URL",
    "UPDATE_CHECK_INTERVAL_SECONDS",
    "UPDATE_INSTALL_REGISTRY_KEY",
    "UPDATE_MANIFEST_NAME",
    "UPDATE_MAX_DOWNLOAD_BYTES",
    "InstallationInfo",
    "UpdateAsset",
    "UpdateCancelled",
    "UpdateClient",
    "UpdateError",
    "UpdateRelease",
    "channel_for_version",
    "detect_installation",
    "normalize_version",
    "select_release",
    "version_text",
]
