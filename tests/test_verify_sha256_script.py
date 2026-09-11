from __future__ import annotations

import hashlib
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
VERIFIER = ROOT / "scripts" / "verify_sha256.sh"
ASSET = "ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz"
ARCHIVE_BYTES = b"tarball-bytes"


def usable_bash() -> str | None:
    """挑一个真能执行本脚本的 bash。

    Windows 上 PATH 里排第一的往往是 WSL 的 bash，它看不到 ``C:\\`` 形式的仓库路径；
    这里直接让它 ``test -f`` 本脚本，顺带确认 sha256sum/awk/grep 可用，读不到就跳过，
    避免把维护者本机跑成一片红。Linux CI 上探测必然通过，测试真实执行。
    """
    candidate = shutil.which("bash")
    if not candidate:
        return None
    probe = (
        f'test -f "{VERIFIER.as_posix()}"'
        " && command -v sha256sum >/dev/null"
        " && command -v awk >/dev/null"
        " && command -v grep >/dev/null"
    )
    try:
        proc = subprocess.run([candidate, "-c", probe], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return candidate if proc.returncode == 0 else None


BASH = usable_bash()


def manifest_line(name: str, digest: str) -> str:
    """上游清单的一行：哈希 + 两个空格 + 裸文件名（不含任何路径成分）。"""
    return f"{digest}  {name}\n"


@unittest.skipUnless(BASH, "需要能读取仓库路径且带 sha256sum/awk/grep 的 bash（WSL bash 看不到 C:\\ 路径）")
class VerifySha256ScriptTests(unittest.TestCase):
    """Given the checksum verifier, When the manifest lists bare file names while the archive sits
    in a sub-directory, Then it validates the target by the path it was given, and fails loudly on
    tampered content, a missing entry, or a missing file."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        # 复刻 Linux 打包的目录布局：脚本从仓库根运行，归档落在 build-appimage/ 子目录
        self.repo_root = Path(tmp.name) / "repo"
        self.build_dir = self.repo_root / "build-appimage"
        self.build_dir.mkdir(parents=True)
        self.target = self.build_dir / ASSET
        self.target.write_bytes(ARCHIVE_BYTES)
        self.checksums = self.build_dir / "btbn-checksums.sha256"

    def run_verifier(self, checksums: Path, asset: str, target: Path) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [BASH, str(VERIFIER), str(checksums), asset, str(target)],
            cwd=str(self.repo_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

    def write_manifest(self, name: str = ASSET, digest: str | None = None) -> str:
        resolved = hashlib.sha256(ARCHIVE_BYTES).hexdigest() if digest is None else digest
        self.checksums.write_text(manifest_line(name, resolved), encoding="utf-8")
        return resolved

    def test_accepts_upstream_manifest_when_target_is_in_subdirectory(self) -> None:
        self.write_manifest()

        proc = self.run_verifier(self.checksums, ASSET, self.target)

        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_plain_sha256sum_c_cannot_resolve_the_same_layout(self) -> None:
        """钉住成因：同一份清单与目录布局，把裸文件名喂给 sha256sum -c 会按当前目录找不到归档。"""
        self.write_manifest()

        proc = subprocess.run(
            [BASH, "-c", f'grep -F "{ASSET}" "{self.checksums}" | sha256sum -c -'],
            cwd=str(self.repo_root),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        self.assertNotEqual(proc.returncode, 0, "sha256sum -c 若能在仓库根解析裸文件名，本坑的说明需重写")
        self.assertIn("No such file or directory", proc.stderr)

    def test_rejects_tampered_archive(self) -> None:
        self.write_manifest(digest=hashlib.sha256(b"someone-elses-bytes").hexdigest())

        proc = self.run_verifier(self.checksums, ASSET, self.target)

        self.assertEqual(proc.returncode, 1)
        self.assertIn("SHA-256 不匹配", proc.stderr)

    def test_does_not_accept_a_different_asset_sharing_the_name_as_substring(self) -> None:
        self.write_manifest(name=f"old-{ASSET}")

        proc = self.run_verifier(self.checksums, ASSET, self.target)

        self.assertEqual(proc.returncode, 1)
        self.assertIn(f"没有 {ASSET} 的条目", proc.stderr)

    def test_rejects_missing_manifest(self) -> None:
        proc = self.run_verifier(self.checksums, ASSET, self.target)

        self.assertEqual(proc.returncode, 1)
        self.assertIn("checksums 清单不存在", proc.stderr)

    def test_rejects_missing_archive(self) -> None:
        self.write_manifest()
        self.target.unlink()

        proc = self.run_verifier(self.checksums, ASSET, self.target)

        self.assertEqual(proc.returncode, 1)
        self.assertIn("待校验文件不存在", proc.stderr)


if __name__ == "__main__":
    unittest.main()
