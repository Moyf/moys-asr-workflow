from __future__ import annotations

import io
import os
import stat
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path

from maw.runtime_bootstrap import (
    GET_PIP_ASSET,
    RuntimeBootstrapError,
    asset_matches,
    bootstrap_for_key,
    current_bootstrap_key,
    extract_python_bootstrap,
    supported_bootstrap_keys,
)


class RuntimeBootstrapRegistryTests(unittest.TestCase):
    def test_supported_release_platforms_have_pinned_assets(self) -> None:
        self.assertEqual(
            supported_bootstrap_keys(),
            ("windows-x86_64", "macos-arm64", "linux-x86_64"),
        )
        for key in supported_bootstrap_keys():
            bootstrap = bootstrap_for_key(key)
            self.assertEqual(len(bootstrap.asset.sha256), 64)
            self.assertTrue(bootstrap.asset.url.startswith("https://"))
            self.assertIn(bootstrap.archive_format, {"zip", "tar.gz"})
            self.assertTrue(bootstrap.python_relative_path)
        self.assertEqual(len(GET_PIP_ASSET.sha256), 64)
        self.assertIn("f6f644156f23dfe9acc06e7b9ca75eee311f2e37", GET_PIP_ASSET.url)

    def test_platform_aliases_map_to_release_keys(self) -> None:
        self.assertEqual(
            current_bootstrap_key(system="Windows", machine="AMD64"),
            "windows-x86_64",
        )
        self.assertEqual(
            current_bootstrap_key(system="Darwin", machine="aarch64"),
            "macos-arm64",
        )
        self.assertEqual(
            current_bootstrap_key(system="Linux", machine="x86_64"),
            "linux-x86_64",
        )

    def test_unsupported_platform_is_actionable(self) -> None:
        with self.assertRaisesRegex(RuntimeBootstrapError, "linux/arm64"):
            current_bootstrap_key(system="Linux", machine="arm64")

    def test_asset_checksum_rejects_missing_and_corrupt_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_name:
            path = Path(temp_name) / "get-pip.py"
            self.assertFalse(asset_matches(path, GET_PIP_ASSET))
            path.write_bytes(b"corrupt")
            self.assertFalse(asset_matches(path, GET_PIP_ASSET))


class RuntimeBootstrapExtractionTests(unittest.TestCase):
    def test_windows_zip_enables_site_and_target_packages(self) -> None:
        bootstrap = bootstrap_for_key("windows-x86_64")
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            archive = root / "python.zip"
            with zipfile.ZipFile(archive, mode="w") as bundle:
                bundle.writestr("python.exe", b"python")
                bundle.writestr("python311._pth", "python311.zip\n.\n#import site\n")

            python = extract_python_bootstrap(archive, root / "runtime", bootstrap)

            self.assertEqual(python, root / "runtime" / "python.exe")
            pth = (root / "runtime" / "python311._pth").read_text(encoding="utf-8")
            self.assertIn("import site", pth)
            self.assertIn("../site-packages", pth)

    def test_tar_preserves_python_symlink_and_executable_mode(self) -> None:
        bootstrap = bootstrap_for_key("macos-arm64")
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            payload = root / "payload" / "python" / "bin"
            payload.mkdir(parents=True)
            executable = payload / "python3.11"
            executable.write_bytes(b"python")
            executable.chmod(0o755)
            (payload / "python").symlink_to("python3.11")
            archive = root / "python.tar.gz"
            with tarfile.open(archive, mode="w:gz") as bundle:
                bundle.add(root / "payload" / "python", arcname="python")

            python = extract_python_bootstrap(archive, root / "runtime", bootstrap)

            self.assertTrue(python.is_symlink())
            self.assertEqual(os.readlink(python), "python3.11")
            self.assertTrue(python.stat().st_mode & stat.S_IXUSR)

    def test_tar_allows_internal_parent_relative_symlink(self) -> None:
        bootstrap = bootstrap_for_key("linux-x86_64")
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            archive = root / "python.tar.gz"
            with tarfile.open(archive, mode="w:gz") as bundle:
                for directory_name in ("python", "python/bin", "python/lib"):
                    directory = tarfile.TarInfo(directory_name)
                    directory.type = tarfile.DIRTYPE
                    directory.mode = 0o755
                    bundle.addfile(directory)
                payload = tarfile.TarInfo("python/lib/python3.11")
                payload.mode = 0o755
                payload.size = 6
                bundle.addfile(payload, io.BytesIO(b"python"))
                link = tarfile.TarInfo("python/bin/python")
                link.type = tarfile.SYMTYPE
                link.linkname = "../lib/python3.11"
                bundle.addfile(link)

            python = extract_python_bootstrap(archive, root / "runtime", bootstrap)

            self.assertTrue(python.is_symlink())
            self.assertEqual(os.readlink(python), "../lib/python3.11")
            self.assertTrue(python.resolve().is_file())

    def test_zip_path_traversal_is_rejected_without_partial_runtime(self) -> None:
        bootstrap = bootstrap_for_key("windows-x86_64")
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            archive = root / "bad.zip"
            with zipfile.ZipFile(archive, mode="w") as bundle:
                bundle.writestr("../escape", b"bad")

            target = root / "runtime"
            with self.assertRaisesRegex(RuntimeBootstrapError, "越界路径"):
                extract_python_bootstrap(archive, target, bootstrap)
            self.assertFalse(target.exists())
            self.assertFalse((root / "escape").exists())

    def test_archive_without_python_entry_leaves_no_partial_runtime(self) -> None:
        bootstrap = bootstrap_for_key("windows-x86_64")
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            archive = root / "incomplete.zip"
            with zipfile.ZipFile(archive, mode="w") as bundle:
                bundle.writestr("python311.zip", b"incomplete")

            target = root / "runtime"
            with self.assertRaisesRegex(RuntimeBootstrapError, "缺少入口"):
                extract_python_bootstrap(archive, target, bootstrap)
            self.assertFalse(target.exists())

    def test_tar_link_traversal_is_rejected_without_partial_runtime(self) -> None:
        bootstrap = bootstrap_for_key("linux-x86_64")
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            archive = root / "bad.tar.gz"
            with tarfile.open(archive, mode="w:gz") as bundle:
                directory = tarfile.TarInfo("python/bin")
                directory.type = tarfile.DIRTYPE
                bundle.addfile(directory)
                link = tarfile.TarInfo("python/bin/python")
                link.type = tarfile.SYMTYPE
                link.linkname = "../../../escape"
                bundle.addfile(link)
                payload = tarfile.TarInfo("python/bin/python3.11")
                payload.size = 6
                bundle.addfile(payload, io.BytesIO(b"python"))

            target = root / "runtime"
            with self.assertRaisesRegex(RuntimeBootstrapError, "越界链接"):
                extract_python_bootstrap(archive, target, bootstrap)
            self.assertFalse(target.exists())
            self.assertFalse((root / "escape").exists())

    def test_tar_special_file_is_rejected_without_partial_runtime(self) -> None:
        bootstrap = bootstrap_for_key("linux-x86_64")
        with tempfile.TemporaryDirectory() as temp_name:
            root = Path(temp_name)
            archive = root / "bad.tar.gz"
            with tarfile.open(archive, mode="w:gz") as bundle:
                fifo = tarfile.TarInfo("python/unsafe-pipe")
                fifo.type = tarfile.FIFOTYPE
                bundle.addfile(fifo)

            target = root / "runtime"
            with self.assertRaisesRegex(RuntimeBootstrapError, "特殊文件"):
                extract_python_bootstrap(archive, target, bootstrap)
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
