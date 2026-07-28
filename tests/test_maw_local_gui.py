"""Tests for maw_local_gui.py — tkinter 本地模型 GUI。"""

from __future__ import annotations

import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import MagicMock, PropertyMock, call, patch, sentinel

import queue as _real_queue


# 准备 ttk 专用 mock 工厂
def _make_combobox(*args, **kwargs):
    mb = MagicMock()
    mb.current = MagicMock(return_value=0)
    return mb


def _make_widget(*args, **kwargs):
    """ttk 组件工厂：忽略参数返回一个新 MagicMock。"""
    return MagicMock()


# 创建一个 Mock 模块冒充 tkinter.ttk
class _MockTtk:
    Frame = MagicMock
    Label = MagicMock
    Entry = MagicMock
    Button = MagicMock
    Checkbutton = MagicMock
    Combobox = staticmethod(_make_combobox)
    Style = MagicMock


_mock_tkinter = MagicMock()
_mock_tkinter.Tk = MagicMock
_mock_tkinter.StringVar = MagicMock
_mock_tkinter.BooleanVar = MagicMock
_mock_tkinter.font = MagicMock()


class TestImportErrors(unittest.TestCase):
    """P2-11: 缺少 local 依赖时的降级行为。"""

    def setUp(self):
        # 清理可能缓存的上次 import
        for key in list(sys.modules):
            if key.startswith("maw_local_gui") or key in ("tkinter", "tkinter.ttk",
                                                           "tkinter.filedialog",
                                                           "tkinter.messagebox",
                                                           "tkinter.font"):
                sys.modules.pop(key, None)

    def test_import_error_handled(self):
        """依赖缺失时 _HAS_LOCAL = False。"""
        with patch.dict("sys.modules", {"maw.local_transcriber": None}):
            if "maw_local_gui" in sys.modules:
                del sys.modules["maw_local_gui"]
            import maw_local_gui as gui_mod
            self.assertFalse(gui_mod._HAS_LOCAL)


class TestLocalGui(unittest.TestCase):
    """LocalGui 类的核心逻辑（不依赖 tkinter 显示）。"""

    @classmethod
    def setUpClass(cls):
        # 在首次加载 maw_local_gui 之前 mock tkinter 全家
        sys.modules.setdefault("tkinter", _mock_tkinter)
        sys.modules.setdefault("tkinter.ttk", _MockTtk())
        sys.modules.setdefault("tkinter.filedialog", MagicMock())
        sys.modules.setdefault("tkinter.messagebox", MagicMock())
        sys.modules.setdefault("tkinter.font", MagicMock())
        # 清除模块缓存以确保重新加载
        for key in list(sys.modules):
            if key.startswith("maw_local_gui"):
                del sys.modules[key]
        import maw_local_gui as gui_mod
        cls.gui_mod = gui_mod

    def setUp(self):
        gui_mod = self.__class__.gui_mod
        # mock ttk 组件（模块级已绑定，直接替换引用）
        mock_ttk = MagicMock()
        mock_ttk.Combobox = _make_combobox
        mock_ttk.Frame = _make_widget
        mock_ttk.Label = _make_widget
        mock_ttk.Entry = _make_widget
        mock_ttk.Button = _make_widget
        mock_ttk.Checkbutton = _make_widget
        mock_ttk.Style = _make_widget
        gui_mod.ttk = mock_ttk

        # mock tk 变量和对话框
        mock_stringvar = MagicMock()
        mock_stringvar.get = MagicMock(return_value="")
        gui_mod.tk.StringVar = MagicMock(return_value=mock_stringvar)
        gui_mod.tk.BooleanVar = MagicMock(return_value=MagicMock())
        gui_mod.tk.Tk = MagicMock(return_value=MagicMock())
        gui_mod.tk.Text = MagicMock(return_value=MagicMock())

        # mock filedialog / messagebox（在模块级是独立引用）
        gui_mod.filedialog = MagicMock()
        gui_mod.messagebox = MagicMock()
        gui_mod.font = MagicMock()

        gui_mod._HAS_LOCAL = True
        self.gui = gui_mod.LocalGui()
        self.gui._HAS_LOCAL = True

    def test_initial_state(self):
        """初始状态：无媒体、无模型加载。"""
        self.assertEqual(self.gui.media_path.get(), "")
        self.assertFalse(self.gui.qwen.loaded)
        self.assertFalse(self.gui.whisper.loaded)
        self.assertIsNotNone(self.gui.model_var)

    def test_model_key_qwen(self):
        """_model_key 返回 Qwen 键名。"""
        self.gui.model_combo.current = MagicMock(return_value=0)
        self.assertEqual(self.gui._model_key(), "qwen-0.6B")
        self.gui.model_combo.current = MagicMock(return_value=1)
        self.assertEqual(self.gui._model_key(), "qwen-1.7B")

    def test_model_key_whisper(self):
        """_model_key 返回 whisper。"""
        self.gui.model_combo.current = MagicMock(return_value=2)
        self.assertEqual(self.gui._model_key(), "whisper")

    def test_model_key_fallback(self):
        """无效索引回退到 qwen-0.6B。"""
        self.gui.model_combo.current = MagicMock(return_value=999)
        self.assertEqual(self.gui._model_key(), "qwen-0.6B")

    def test_on_model_change_whisper_hides_qwen_opts(self):
        """Whisper 选中时隐藏 Qwen 专用选项。"""
        self.gui._model_key = MagicMock(return_value="whisper")
        self.gui.qwen_opts.pack_forget = MagicMock()
        self.gui.gpu_check = MagicMock()
        self.gui._on_model_change()
        self.gui.qwen_opts.pack_forget.assert_called_once()
        self.gui.gpu_check.configure.assert_called_once_with(state="disabled")

    def test_on_model_change_qwen_shows_qwen_opts(self):
        """Qwen 选中时显示 Qwen 专用选项。"""
        self.gui._model_key = MagicMock(return_value="qwen-0.6B")
        self.gui.qwen_opts.pack = MagicMock()
        self.gui.gpu_check = MagicMock()
        self.gui._on_model_change()
        self.gui.qwen_opts.pack.assert_called_once_with(side="left")
        self.gui.gpu_check.configure.assert_called_once_with(state="normal")

    def test_add_hotword(self):
        """添加热词。"""
        self.gui.hw_entry = MagicMock()
        self.gui.hw_entry.get = MagicMock(return_value="测试热词")
        self.gui.hotwords = []
        self.gui._render_hotwords = MagicMock()
        self.gui._add_hotword()
        self.assertIn("测试热词", self.gui.hotwords)
        self.gui._render_hotwords.assert_called_once()

    def test_add_hotword_duplicate(self):
        """重复热词不被添加。"""
        self.gui.hw_entry = MagicMock()
        self.gui.hw_entry.get = MagicMock(return_value="已存在")
        self.gui.hotwords = ["已存在"]
        self.gui._render_hotwords = MagicMock()
        self.gui.status_var = MagicMock()
        self.gui._add_hotword()
        self.assertEqual(len(self.gui.hotwords), 1)
        self.gui.status_var.set.assert_called_once()

    def test_add_hotword_empty(self):
        """空字符串不被添加。"""
        self.gui.hw_entry = MagicMock()
        self.gui.hw_entry.get = MagicMock(return_value="")
        self.gui.hotwords = []
        self.gui._add_hotword()
        self.assertEqual(len(self.gui.hotwords), 0)

    def test_remove_hotword(self):
        """删除热词。"""
        self.gui.hotwords = ["词1", "词2", "词3"]
        self.gui._render_hotwords = MagicMock()
        self.gui._remove_hotword(1)
        self.assertEqual(self.gui.hotwords, ["词1", "词3"])
        self.gui._render_hotwords.assert_called_once()

    def test_remove_hotword_invalid_index(self):
        """无效索引不报错。"""
        self.gui.hotwords = ["词1"]
        self.gui._render_hotwords = MagicMock()
        self.gui._remove_hotword(5)
        self.gui._remove_hotword(-1)
        self.assertEqual(self.gui.hotwords, ["词1"])

    def test_log_queue_polled(self):
        """日志队列被定时轮询。"""
        self.gui.root = MagicMock()
        self.gui.log_text = MagicMock()
        self.gui._log_queue = _real_queue.Queue()
        self.gui._log_queue.put("test message")
        self.gui._poll_log()
        self.gui.log_text.config.assert_called()
        self.gui.log_text.insert.assert_called()
        self.gui.root.after.assert_called_once_with(200, self.gui._poll_log)

    def test_log_queue_empty(self):
        """空队列不插入日志。"""
        self.gui.root = MagicMock()
        self.gui.log_text = MagicMock()
        self.gui._poll_log()
        self.gui.log_text.insert.assert_not_called()
        self.gui.root.after.assert_called_once()

    def test_set_busy(self):
        """_set_busy 控制开始按钮。"""
        self.gui.start_btn = MagicMock()
        self.gui.root = MagicMock()
        self.gui._set_busy(True)
        self.gui.start_btn.config.assert_called_once_with(state="disabled")
        self.gui.start_btn.reset_mock()
        self.gui._set_busy(False)
        self.gui.start_btn.config.assert_called_once_with(state="normal")

    def test_start_transcribe_no_media(self):
        """无媒体时弹出错误。"""
        self.gui.media_path.get = MagicMock(return_value="")
        mbox = self.__class__.gui_mod.messagebox
        self.gui._start_transcribe()
        mbox.showerror.assert_called_once()

    def test_start_transcribe_media_not_found(self):
        """媒体不存在时弹出错误。"""
        self.gui.media_path.get = MagicMock(return_value="/nonexistent/path.mp3")
        mbox = self.__class__.gui_mod.messagebox
        self.gui._start_transcribe()
        mbox.showerror.assert_called_once()

    def test_start_transcribe_model_not_loaded(self):
        """模型未加载时弹出错误。"""
        tmpfile = Path(tempfile.gettempdir()) / f"_maw_test_{os.getpid()}.mp4"
        try:
            tmpfile.write_text("fake", encoding="utf-8")
            self.gui.media_path.get = MagicMock(return_value=str(tmpfile))
            self.gui._model_key = MagicMock(return_value="qwen-0.6B")
            with patch.object(self.gui.qwen.__class__, 'loaded', new_callable=PropertyMock, return_value=False):
                mbox = self.__class__.gui_mod.messagebox
                self.gui._start_transcribe()
                mbox.showerror.assert_called_once()
        finally:
            tmpfile.unlink(missing_ok=True)

    def test_stop_transcribe_sets_events(self):
        """停止转写设置取消事件。"""
        self.gui.transcribe_cancel = threading.Event()
        self.gui.qwen.cancel = MagicMock()
        self.gui.whisper.cancel = MagicMock()
        self.gui._log = MagicMock()
        self.gui.stop_btn = MagicMock()
        self.gui._transcribe_thread = None
        self.gui._stop_transcribe()
        self.assertTrue(self.gui.transcribe_cancel.is_set())
        self.gui.qwen.cancel.assert_called_once()
        self.gui.whisper.cancel.assert_called_once()

    def test_stop_transcribe_waits_for_thread(self):
        """停止转写优先等待线程退出。"""
        self.gui.transcribe_cancel = threading.Event()
        self.gui.qwen.cancel = MagicMock()
        self.gui.whisper.cancel = MagicMock()
        self.gui._log = MagicMock()
        self.gui.stop_btn = MagicMock()
        done = threading.Event()

        def fake_thread():
            done.wait(2)
        t = threading.Thread(target=fake_thread, daemon=True)
        t.start()
        self.gui._transcribe_thread = t
        self.gui._stop_transcribe()
        self.gui._log.assert_any_call("[info] 正在停止转写…")
        done.set()
        t.join(timeout=2)

    # ── FFmpeg 检测 ───────────────────────────────────────────

    @patch("shutil.which", side_effect=lambda x: f"/usr/bin/{x}")
    def test_check_ffmpeg_found_in_path(self, mock_which):
        """PATH 中找到 ffmpeg/ffprobe。"""
        self.assertTrue(self.gui._check_ffmpeg())

    @patch("shutil.which", return_value=None)
    def test_check_ffmpeg_not_found(self, mock_which):
        """任何地方都找不到 ffmpeg，返回 False。"""
        with patch.dict(os.environ, {}, clear=True):
            with patch.object(sys, "frozen", False, create=True):
                self.assertFalse(self.gui._check_ffmpeg())

    @patch("shutil.which", side_effect=lambda x: None if "ffmpeg" in x or "ffprobe" in x else "/usr/bin/fake")
    def test_check_ffmpeg_not_in_path_found_in_env(self, mock_which):
        """PATH 中没有但 FFMPEG_PATH 有效。"""
        fake_dir = "/fake/ffmpeg_dir"
        # 第一次调用 which("ffmpeg") 返回 None（PATH 中没有）
        # 第二次调用 which("/fake/ffmpeg_dir/ffmpeg") → 模拟找到
        which_calls: list[str] = []

        def _which(x):
            which_calls.append(x)
            if "ffmpeg" in x or "ffprobe" in x:
                if fake_dir in x:
                    return x  # 模拟通过目录找到
                return None
            return x

        with patch("shutil.which", side_effect=_which):
            with patch.dict(os.environ, {"FFMPEG_PATH": fake_dir}, clear=True):
                result = self.gui._check_ffmpeg()

        self.assertTrue(result)
        self.assertTrue(any(fake_dir in c for c in which_calls))

    @patch("shutil.which", return_value=None)
    def test_check_ffmpeg_triggers_error_in_start(self, mock_which):
        """FFmpeg 缺失时 _start_transcribe 弹出错误。"""
        tmpfile = Path(tempfile.gettempdir()) / f"_maw_ffmpeg_test_{os.getpid()}.mp4"
        try:
            tmpfile.write_text("fake", encoding="utf-8")
            with patch.dict(os.environ, {}, clear=True):
                with patch.object(sys, "frozen", False, create=True):
                    mbox = self.__class__.gui_mod.messagebox
                    self.gui.media_path.get = MagicMock(return_value=str(tmpfile))
                    self.gui._start_transcribe()
                    mbox.showerror.assert_called_once()
                    title, msg = mbox.showerror.call_args[0]
                    self.assertIn("FFmpeg", title)
                    self.assertIn("ffmpeg", msg.lower())
        finally:
            tmpfile.unlink(missing_ok=True)

    def test_pick_media_sets_path(self):
        """选择媒体设置路径并自动填充输出目录。"""
        tmpfile = Path(tempfile.gettempdir()) / f"_maw_test_media_{os.getpid()}.mp4"
        try:
            tmpfile.write_text("fake", encoding="utf-8")
            fd = self.__class__.gui_mod.filedialog
            fd.askopenfilename = MagicMock(return_value=str(tmpfile))
            self.gui.media_path = MagicMock()
            self.gui.output_dir = MagicMock()
            self.gui.output_dir.get = MagicMock(return_value="")
            self.gui._pick_media()
            self.gui.media_path.set.assert_called_once_with(str(tmpfile))
            self.gui.output_dir.set.assert_called_once_with(str(tmpfile.parent))
        finally:
            tmpfile.unlink(missing_ok=True)

    def test_pick_media_cancelled(self):
        """取消选择不修改路径。"""
        fd = self.__class__.gui_mod.filedialog
        fd.askopenfilename = MagicMock(return_value="")
        self.gui.media_path = MagicMock()
        self.gui._pick_media()
        self.gui.media_path.set.assert_not_called()
