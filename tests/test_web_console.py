"""Web 控制台测试 — 路由 / 错误码 / 任务调度 / 文件准备 / 路径校验。"""

import importlib.util
import json
import sys
import tempfile
import threading
import time
import unittest
from http import HTTPStatus
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from http.server import ThreadingHTTPServer

# web-console 目录名含连字符，无法直接用 import 语句
_SERVER_PATH = ROOT / "web-console" / "server.py"
_SPEC = importlib.util.spec_from_file_location("web_console_server", _SERVER_PATH)
_mod = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_mod)
# 导出模块级符号供测试类使用
ConsoleHandler = _mod.ConsoleHandler
_run_task = _mod._run_task
_tasks = _mod._tasks
_tasks_lock = _mod._tasks_lock
_is_model_downloaded = _mod._is_model_downloaded
_model_exists_cache = _mod._model_exists_cache
_model_exists_cache_lock = _mod._model_exists_cache_lock


def _free_port() -> int:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _get(url: str) -> tuple[int, bytes | dict]:
    import urllib.request
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            body = r.read()
            ct = r.headers.get("Content-Type", "")
            data = json.loads(body) if "json" in ct else body
            return r.status, data
    except urllib.error.HTTPError as e:
        body = e.read()
        ct = e.headers.get("Content-Type", "")
        data = json.loads(body) if "json" in ct else body
        return e.code, data


def _post(url: str, data: dict | None = None) -> tuple[int, dict]:
    import urllib.request
    body = json.dumps(data or {}).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


class WebConsoleRouteTests(unittest.TestCase):
    """启动完整服务器，测试 HTTP 路由和接口契约。"""

    @classmethod
    def setUpClass(cls):
        cls.port = _free_port()
        cls.base = f"http://127.0.0.1:{cls.port}"
        cls.server = ThreadingHTTPServer(("127.0.0.1", cls.port), ConsoleHandler)
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()
        time.sleep(0.3)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    # ---- 基本路由 ----

    def test_get_root_returns_html(self):
        status, body = _get(f"{self.base}/")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertTrue(body.startswith(b"<!DOCTYPE html>"))

    def test_unknown_route_returns_404(self):
        status, _ = _get(f"{self.base}/api/unknown")
        self.assertEqual(status, HTTPStatus.NOT_FOUND)

    # ---- P0: 已删除的安全敏感接口 ----

    def test_env_endpoint_deleted(self):
        """P0-2: /api/env 已删除。"""
        status, _ = _get(f"{self.base}/api/env")
        self.assertEqual(status, HTTPStatus.NOT_FOUND)

    def test_check_file_endpoint_deleted(self):
        """P0-3: /api/check-file 已删除。"""
        status, _ = _get(f"{self.base}/api/check-file")
        self.assertEqual(status, HTTPStatus.NOT_FOUND)

    def test_prepare_file_endpoint_deleted(self):
        """P0-3: /api/prepare-file 已删除。"""
        status, _ = _get(f"{self.base}/api/prepare-file")
        self.assertEqual(status, HTTPStatus.NOT_FOUND)

    # ---- P0-4: 路径遍历防护 ----

    def test_asset_path_traversal_blocked(self):
        status, _ = _get(f"{self.base}/assets/../../.env")
        self.assertEqual(status, HTTPStatus.NOT_FOUND)

        status, _ = _get(f"{self.base}/assets/../server.py")
        self.assertEqual(status, HTTPStatus.NOT_FOUND)

    # ---- 转写校验 ----

    def test_transcribe_missing_path_returns_400(self):
        status, data = _post(f"{self.base}/api/transcribe", {})
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        self.assertFalse(data.get("ok", True))
        self.assertIn("error", data)

    def test_transcribe_empty_path_returns_400(self):
        status, data = _post(f"{self.base}/api/transcribe", {"input_path": ""})
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        self.assertFalse(data.get("ok", True))

    def test_transcribe_rejects_path_outside_uploads(self):
        """uploads/ 外的绝对路径应被拒绝。"""
        status, data = _post(f"{self.base}/api/transcribe", {
            "input_path": "C:\\Windows\\win.ini",
            "model": "api",
        })
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)
        self.assertIn("源文件不存在", data.get("error", ""))

    def test_transcribe_rejects_nonexistent_uploads_path(self):
        status, data = _post(f"{self.base}/api/transcribe", {
            "input_path": str(ROOT / "uploads" / "nonexistent.mp4"),
            "model": "api",
        })
        self.assertEqual(status, HTTPStatus.BAD_REQUEST)

    # ---- 模型状态 ----

    def test_model_status_returns_json(self):
        status, data = _get(f"{self.base}/api/model/status")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertTrue(data.get("ok", False))
        self.assertIn("qwen", data)
        self.assertIn("whisper", data)

    # ---- P2-8: _unload_model 分拆 ----

    def test_unload_model_qwen(self):
        status, data = _post(f"{self.base}/api/model/unload", {"model": "qwen"})
        self.assertEqual(status, HTTPStatus.OK)
        self.assertTrue(data.get("ok", False))

    def test_unload_model_whisper(self):
        status, data = _post(f"{self.base}/api/model/unload", {"model": "whisper"})
        self.assertEqual(status, HTTPStatus.OK)
        self.assertTrue(data.get("ok", False))

    def test_unload_model_all(self):
        status, data = _post(f"{self.base}/api/model/unload", {"model": "all"})
        self.assertEqual(status, HTTPStatus.OK)
        self.assertTrue(data.get("ok", False))

    # ---- P2-9: length_limit 校验（后端逻辑） ----

    def test_transcribe_with_oversized_length_limit_rejected(self):
        """API 模式传递超限 length_limit 不会立即校验（仅在本地模式校验），
        但至少不应导致 500。"""
        status, data = _post(f"{self.base}/api/transcribe", {
            "input_path": str(ROOT / "uploads" / "nonexistent.mp4"),
            "model": "api",
            "length_limit": "10h",
        })
        self.assertIn(status, (HTTPStatus.BAD_REQUEST, HTTPStatus.OK))
        self.assertNotEqual(status, 500)

    # ---- 热词 ----

    def test_hotwords_roundtrip(self):
        test_content = "测试词A\n测试词B"
        status, data = _post(f"{self.base}/api/hotwords", {"content": test_content})
        self.assertEqual(status, HTTPStatus.OK)
        self.assertTrue(data.get("ok", False))

        status, data = _get(f"{self.base}/api/hotwords")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertEqual(data["content"], test_content)

    # ---- 编辑器 ----

    def test_open_editor_empty_path_returns_blank(self):
        status, data = _post(f"{self.base}/api/open-editor", {})
        self.assertEqual(status, HTTPStatus.OK)
        self.assertTrue(data.get("ok", False))

    # ---- 删除/清理 ----

    def test_clean_uploads_returns_ok(self):
        status, data = _post(f"{self.base}/api/clean-uploads")
        self.assertEqual(status, HTTPStatus.OK)
        self.assertTrue(data.get("ok", False))


class WebConsoleTaskFuncTests(unittest.TestCase):
    """测试模块级任务函数，不启动完整服务器。"""

    def setUp(self):
        with _tasks_lock:
            _tasks.clear()

    def _make_task(self, tid: str, status: str = "running") -> dict:
        task = {"id": tid, "status": status, "log": "", "script": "generate_subtitle_qwen_api.py"}
        with _tasks_lock:
            _tasks[tid] = task
        return task

    # ---- P1-1: 显式状态判断 ----

    def test_run_task_success_sets_done(self):
        tid = "test-success"
        self._make_task(tid)
        # 用 --help 参数调 generate_subtitle_qwen_api.py，快速返回 0
        t = threading.Thread(
            target=_run_task,
            args=(tid, "generate_subtitle_qwen_api.py", ["--help"], str(ROOT)),
            daemon=True,
        )
        t.start()
        t.join(timeout=15)
        with _tasks_lock:
            self.assertIn(tid, _tasks)
            self.assertEqual(
                _tasks[tid]["status"], "done",
                f"expected done, got {_tasks[tid]['status']}: {_tasks[tid].get('log', '')[:200]}"
            )

    def test_run_task_failure_sets_failed(self):
        tid = "test-fail"
        self._make_task(tid)
        t = threading.Thread(
            target=_run_task,
            args=(tid, "generate_subtitle_qwen_api.py", [
                "--nonexistent-flag-that-causes-error"
            ], str(ROOT)),
            daemon=True,
        )
        t.start()
        t.join(timeout=10)
        with _tasks_lock:
            self.assertEqual(_tasks[tid]["status"], "failed")

    def test_run_task_removes_proc_after_completion(self):
        """完成后 _proc 应从任务字典中移除。"""
        tid = "test-proc-clean"
        self._make_task(tid)
        t = threading.Thread(
            target=_run_task,
            args=(tid, sys.executable, ["-c", "print('ok')"], str(ROOT)),
            daemon=True,
        )
        t.start()
        t.join(timeout=10)
        self.assertNotIn("_proc", _tasks.get(tid, {}))


class WebConsoleFileFuncTests(unittest.TestCase):
    """测试文件准备和路径校验逻辑。"""

    def setUp(self):
        self.tmpdir = Path(tempfile.mkdtemp())
        self.valid_dir = ROOT / "uploads"
        self.valid_dir.mkdir(parents=True, exist_ok=True)
        self.valid_file = self.valid_dir / "test_media.mp4"
        self.valid_file.write_text("fake media content")

    def tearDown(self):
        self.valid_file.unlink(missing_ok=True)
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    # ---- P0-3: 路径白名单 ----

    def test_prepare_accepts_uploads_path(self):
        result = ConsoleHandler._prepare_input_file(str(self.valid_file))
        self.assertIsNotNone(result)

    def test_prepare_rejects_outside_path(self):
        outside = self.tmpdir / "outside.mp4"
        outside.write_text("test")
        result = ConsoleHandler._prepare_input_file(str(outside))
        self.assertIsNone(result)

    def test_prepare_returns_none_for_missing(self):
        result = ConsoleHandler._prepare_input_file(
            str(self.valid_dir / "nonexistent.mp4")
        )
        self.assertIsNone(result)


class WebConsoleCacheTests(unittest.TestCase):
    """测试 P1-6: 模型已存在缓存。"""

    def setUp(self):
        with _model_exists_cache_lock:
            _model_exists_cache.clear()

    def test_is_model_downloaded_uses_cache(self):
        with _model_exists_cache_lock:
            _model_exists_cache["qwen-0.6B"] = True
        result = _is_model_downloaded("qwen-0.6B")
        self.assertTrue(result)

    def test_is_model_downloaded_returns_false_for_unknown(self):
        result = _is_model_downloaded("nonexistent-model")
        self.assertFalse(result)


if __name__ == "__main__":
    unittest.main()
