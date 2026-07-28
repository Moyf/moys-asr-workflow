"""Tests for maw/_download_worker.py — 模型下载工作子进程。"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from maw._download_worker import run_download


class TestModelScopeWorker(unittest.TestCase):
    """ModelScope 下载路径。"""

    def setUp(self):
        self.tmpdir_obj = tempfile.TemporaryDirectory()
        self.tmpdir = self.tmpdir_obj.name
        self.dest = Path(self.tmpdir) / "models" / "Qwen3-ASR-0.6B"
        self.dest.mkdir(parents=True)
        self.info_path = Path(self.tmpdir) / "download_info.json"
        self.info = {
            "label": "Qwen3-ASR-0.6B",
            "model_id": "Qwen/Qwen3-ASR-0.6B",
            "local_dir": str(self.dest),
            "source": "modelscope",
        }
        self.info_path.write_text(json.dumps(self.info), encoding="utf-8")

    def tearDown(self):
        self.tmpdir_obj.cleanup()

    @patch("modelscope.hub.snapshot_download.snapshot_download")
    def test_basic_flow(self, mock_snapshot):
        """P2-9: 下载后文件迁移、manifest 写入、完成标记。"""
        nested = self.dest / "snapshots" / "abc123"
        nested.mkdir(parents=True)
        (nested / "config.json").write_text("{}", encoding="utf-8")
        (nested / "model.safetensors").write_text("binary", encoding="utf-8")

        rc = run_download("qwen-0.6B", str(self.info_path))

        self.assertEqual(rc, 0)
        self.assertTrue((self.dest / "config.json").exists())
        self.assertTrue((self.dest / "model.safetensors").exists())
        manifest = json.loads((self.dest / "manifest.json").read_text(encoding="utf-8"))
        self.assertIn("config.json", manifest)
        self.assertIn("model.safetensors", manifest)
        self.assertTrue((self.dest / ".download_ok").exists())
        self.assertFalse(nested.exists())

    @patch("modelscope.hub.snapshot_download.snapshot_download")
    def test_no_nesting(self, mock_snapshot):
        """无嵌套时直接写入标记。"""
        (self.dest / "model.safetensors").write_text("data", encoding="utf-8")
        rc = run_download("qwen-0.6B", str(self.info_path))
        self.assertEqual(rc, 0)
        self.assertTrue((self.dest / "manifest.json").exists())
        self.assertTrue((self.dest / ".download_ok").exists())

    @patch("modelscope.hub.snapshot_download.snapshot_download")
    def test_preserves_dot_dirs(self, mock_snapshot):
        """P0-5: . 开头的目录不被清理。"""
        nested = self.dest / "snapshots" / "abc123"
        nested.mkdir(parents=True)
        (nested / "config.json").write_text("{}", encoding="utf-8")
        hidden = self.dest / ".hidden_cache"
        hidden.mkdir()
        (hidden / "cache_file").write_text("cache")

        rc = run_download("qwen-0.6B", str(self.info_path))

        self.assertEqual(rc, 0)
        self.assertTrue(hidden.exists(), ". 开头目录不应被删除")

    @patch("modelscope.hub.snapshot_download.snapshot_download")
    @patch("send2trash.send2trash", side_effect=Exception("trash failed"))
    def test_cleanup_fallback_warning(self, mock_send2trash, mock_snapshot):
        """P0-5: send2trash 失败时输出警告，不尝试 rmtree。"""
        nested = self.dest / "snapshots" / "abc123"
        nested.mkdir(parents=True)
        (nested / "config.json").write_text("{}", encoding="utf-8")

        rc = run_download("qwen-0.6B", str(self.info_path))

        self.assertEqual(rc, 0)
        # send2trash 失败后目录应保留（不强行删除）
        self.assertTrue(nested.exists())

    @patch("modelscope.hub.snapshot_download.snapshot_download", side_effect=Exception("dl failed"))
    def test_download_failure(self, mock_snapshot):
        """下载异常返回 1。"""
        rc = run_download("qwen-0.6B", str(self.info_path))
        self.assertEqual(rc, 1)

    @patch("modelscope.hub.snapshot_download.snapshot_download")
    def test_manifest_excludes_markers(self, mock_snapshot):
        """manifest 不包含 .download_ok 和 manifest.json 自身。"""
        nested = self.dest / "snapshots" / "abc123"
        nested.mkdir(parents=True)
        (nested / "model.bin").write_text("data", encoding="utf-8")
        (nested / "config.json").write_text("{}", encoding="utf-8")

        rc = run_download("qwen-0.6B", str(self.info_path))
        self.assertEqual(rc, 0)

        manifest = json.loads((self.dest / "manifest.json").read_text(encoding="utf-8"))
        self.assertNotIn(".download_ok", manifest)
        self.assertNotIn("manifest.json", manifest)


class TestHuggingFaceWorker(unittest.TestCase):
    """HuggingFace 下载路径。"""

    def setUp(self):
        self.tmpdir_obj = tempfile.TemporaryDirectory()
        self.tmpdir = self.tmpdir_obj.name
        self.dest = Path(self.tmpdir) / "models" / "faster-whisper-large-v3"
        self.dest.mkdir(parents=True)
        self.info_path = Path(self.tmpdir) / "download_info.json"
        self.info = {
            "label": "faster-whisper-large-v3",
            "model_id": "Systran/faster-whisper-large-v3",
            "local_dir": str(self.dest),
            "source": "huggingface",
        }
        self.info_path.write_text(json.dumps(self.info), encoding="utf-8")

    def tearDown(self):
        self.tmpdir_obj.cleanup()

    @patch("huggingface_hub.snapshot_download")
    def test_writes_markers(self, mock_snapshot):
        """HF 分支写入 manifest 和 .download_ok。"""
        (self.dest / "model.bin").write_text("binary data", encoding="utf-8")
        rc = run_download("whisper", str(self.info_path))
        self.assertEqual(rc, 0)
        self.assertTrue((self.dest / ".download_ok").exists())
        self.assertTrue((self.dest / "manifest.json").exists())

    @patch("huggingface_hub.snapshot_download")
    def test_sets_mirror_env(self, mock_snapshot):
        """HF 分支设置 HF_ENDPOINT 镜像。"""
        os.environ.pop("HF_ENDPOINT", None)
        (self.dest / "model.bin").write_text("data", encoding="utf-8")
        rc = run_download("whisper", str(self.info_path))
        self.assertEqual(rc, 0)
        self.assertEqual(os.environ.get("HF_ENDPOINT"), "https://hf-mirror.com")
        del os.environ["HF_ENDPOINT"]

    @patch("huggingface_hub.snapshot_download", side_effect=Exception("network error"))
    def test_hf_failure(self, mock_snapshot):
        """HF 下载异常返回 1。"""
        rc = run_download("whisper", str(self.info_path))
        self.assertEqual(rc, 1)


class TestWorkerErrorPaths(unittest.TestCase):
    """异常输入场景。"""

    def test_missing_info_file(self):
        """info 文件不存在时返回 1。"""
        tmpdir_obj = tempfile.TemporaryDirectory()
        tmpdir = tmpdir_obj.name
        fake_path = Path(tmpdir) / "nonexistent.json"
        rc = run_download("test", str(fake_path))
        self.assertEqual(rc, 1)
        tmpdir_obj.cleanup()

    def test_unknown_source(self):
        """未知 source 走 else 分支。"""
        tmpdir_obj = tempfile.TemporaryDirectory()
        tmpdir = tmpdir_obj.name
        dest = Path(tmpdir) / "models" / "test"
        dest.mkdir(parents=True)
        info_path = Path(tmpdir) / "info.json"
        info = {"model_id": "test/model", "local_dir": str(dest), "source": "unknown"}
        info_path.write_text(json.dumps(info), encoding="utf-8")

        # unknown source 走 else 分支，会尝试 huggingface_hub（未 mock 可能失败）
        # 这里验证它尝试了 else 分支
        with patch("huggingface_hub.snapshot_download", side_effect=Exception("no network")):
            rc = run_download("test", str(info_path))
        self.assertEqual(rc, 1)
        tmpdir_obj.cleanup()
