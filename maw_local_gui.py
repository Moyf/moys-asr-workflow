"""MAW 本地模型转写工具 — 独立的 tkinter 图形界面。

用法：
  uv sync --extra local
  uv run python maw_local_gui.py

依赖：Python 3.11+, tkinter（内置），可选 local extra（qwen-asr, faster-whisper, torch）
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
import time
from pathlib import Path

# 确保项目根目录在路径中
ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# ── 导入核心模块 ──────────────────────────────────────────

try:
    from maw.local_transcriber import (
        QwenModelHandle,
        WhisperModelHandle,
        transcribe_qwen,
        transcribe_whisper,
        write_output_files,
    )
    from maw.model_downloader import (
        DOWNLOADABLE_MODELS,
        invalidate_cache,
        is_model_downloaded,
        refresh_manifest,
        start_download,
        cancel_download,
        get_download_status,
    )
    _HAS_LOCAL = True
except ImportError as e:
    _HAS_LOCAL = False
    _IMPORT_ERR = str(e)

# ── tkinter ────────────────────────────────────────────────

import tkinter as tk
from tkinter import ttk, filedialog, messagebox, font
import queue
import re

# ── 常量 ────────────────────────────────────────────────────

MODEL_OPTIONS = [
    ("qwen-0.6B", "Qwen3-ASR-0.6B  (约 1.2GB, CPU 可用)"),
    ("qwen-1.7B", "Qwen3-ASR-1.7B  (约 3.5GB, 建议 GPU)"),
    ("whisper",   "faster-whisper-large-v3  (约 3.1GB, 适合英文)"),
]
LANG_OPTIONS = [("", "自动识别"), ("zh", "中文"), ("en", "英语"), ("ja", "日语"),
                ("ko", "韩语"), ("fr", "法语"), ("de", "德语"), ("es", "西班牙语")]


# ── 主窗口 ──────────────────────────────────────────────────

class LocalGui:
    def __init__(self):
        self.root = tk.Tk()
        self.root.title("MAW 本地模型转写工具")
        self.root.geometry("900x620")
        self.root.minsize(800, 520)
        self.bg = "#1e1e2e"
        self.fg = "#cdd6f4"
        self.accent = "#89b4fa"
        self.root.configure(bg=self.bg)

        # ttk 暗色主题
        style = ttk.Style()
        style.theme_use("clam")
        style.configure(".", background=self.bg, foreground=self.fg,
                         fieldbackground="#181825", bordercolor="#313244",
                         lightcolor="#313244", darkcolor="#313244",
                         arrowcolor=self.fg, selectbackground=self.accent,
                         selectforeground=self.bg)
        style.configure("TFrame", background=self.bg)
        style.configure("TLabel", background=self.bg, foreground=self.fg)
        style.configure("TButton", background="#313244", foreground=self.fg,
                         bordercolor="#45475a", focuscolor=self.accent)
        style.map("TButton", background=[("active", "#45475a"), ("disabled", "#1e1e2e")],
                  foreground=[("disabled", "#585b70")])
        style.configure("TEntry", fieldbackground="#181825", foreground=self.fg,
                         bordercolor="#45475a")
        style.configure("TCombobox", fieldbackground="#181825", foreground=self.fg,
                         arrowcolor=self.fg)
        style.map("TCombobox", fieldbackground=[("readonly", "#181825")])
        style.configure("TCheckbutton", background=self.bg, foreground=self.fg)
        style.map("TCheckbutton", background=[("active", self.bg)])
        style.configure("Vertical.TScrollbar", background="#313244",
                         troughcolor=self.bg, bordercolor=self.bg)

        # 字体（黑体）
        self.font_bold = font.Font(family="SimHei", size=11, weight="bold")
        self.font_normal = font.Font(family="SimHei", size=10)
        self.font_small = font.Font(family="SimHei", size=9)
        self.font_mono = font.Font(family="SimHei", size=10)

        self.qwen = QwenModelHandle()
        self.whisper = WhisperModelHandle()
        self.media_path = tk.StringVar()
        self.output_dir = tk.StringVar()
        self.lang_var = tk.StringVar(value="自动识别")
        self.keep_punct = tk.BooleanVar(value=True)
        self.model_var = tk.StringVar()
        self.hotwords: list[str] = []
        self.transcribe_cancel = threading.Event()
        self._transcribe_thread = None
        self._build_ui()
        self.model_var.trace_add("write", self._on_model_change)

    # ── 构建界面 ──────────────────────────────────────────────

    def _build_ui(self):
        if not _HAS_LOCAL:
            ttk.Label(self.root, text=f"需要安装 local 依赖:\n  uv sync --extra local\n\n{_IMPORT_ERR}",
                      foreground="#f38ba8", justify="center").pack(expand=True, padx=20, pady=40)
            return

        main = ttk.Frame(self.root)
        main.pack(fill="both", expand=True, padx=16, pady=12)

        # ── 模型管理 ──
        self._section(main, "模型管理", 0)
        mf = ttk.Frame(main)
        mf.grid(row=1, column=0, sticky="ew", pady=(0, 4))
        self.model_combo = ttk.Combobox(mf, textvariable=self.model_var,
                                         values=[v for _, v in MODEL_OPTIONS],
                                         state="readonly", width=48)
        self.model_combo.grid(row=0, column=0, padx=(0, 8))
        self.model_combo.current(0)
        self.load_btn = ttk.Button(mf, text="加载模型", command=self._load_model, width=10)
        self.load_btn.grid(row=0, column=1, padx=4)
        self.unload_btn = ttk.Button(mf, text="卸载", command=self._unload_model, width=8, state="disabled")
        self.unload_btn.grid(row=0, column=2, padx=4)
        ttk.Button(mf, text="管理模型", command=self._open_model_manager, width=10).grid(row=0, column=3, padx=4)

        # GPU 开关（仅 Qwen 本地模型生效）
        self.use_gpu = tk.BooleanVar(value=True)
        self.gpu_check = ttk.Checkbutton(mf, text="使用 GPU (CUDA)",
                                          variable=self.use_gpu)
        self.gpu_check.grid(row=0, column=4, padx=(12, 0))

        self.model_status = ttk.Label(main, text="未加载", foreground="#6c7086")
        self.model_status.grid(row=2, column=0, sticky="w", pady=(0, 8))

        # ── 媒体与输出 ──
        self._section(main, "媒体与输出", 3)
        pf = ttk.Frame(main)
        pf.grid(row=4, column=0, sticky="ew", pady=(0, 4))
        pf.columnconfigure(0, weight=1)
        ttk.Entry(pf, textvariable=self.media_path).grid(row=0, column=0, sticky="ew", padx=(0, 4))
        ttk.Button(pf, text="选择媒体", command=self._pick_media, width=10).grid(row=0, column=1)

        of = ttk.Frame(main)
        of.grid(row=5, column=0, sticky="ew", pady=(0, 10))
        of.columnconfigure(0, weight=1)
        ttk.Entry(of, textvariable=self.output_dir).grid(row=0, column=0, sticky="ew", padx=(0, 4))
        ttk.Button(of, text="输出目录", command=self._pick_output, width=10).grid(row=0, column=1)

        # ── 选项 ──
        self._section(main, "选项", 6)
        opt = ttk.Frame(main)
        opt.grid(row=7, column=0, sticky="ew", pady=(0, 4))

        ttk.Label(opt, text="语言:").pack(side="left", padx=(0, 4))
        lang_combo = ttk.Combobox(opt, textvariable=self.lang_var,
                                   values=[v for _, v in LANG_OPTIONS],
                                   state="readonly", width=14)
        lang_combo.pack(side="left", padx=(0, 16))
        lang_combo.current(0)

        # ── Qwen 专用选项（whisper 时隐藏） ──
        self.qwen_opts = ttk.Frame(opt)
        self.qwen_opts.pack(side="left")
        self.keep_punct_cb = ttk.Checkbutton(self.qwen_opts, text="保留句末标点",
                                               variable=self.keep_punct)
        self.keep_punct_cb.pack(side="left", padx=(0, 16))

        ttk.Label(self.qwen_opts, text="热词:").pack(side="left", padx=(0, 4))
        self.hw_entry = ttk.Entry(self.qwen_opts, width=16)
        self.hw_entry.pack(side="left", padx=(0, 4))
        self.hw_entry.bind("<Return>", lambda e: self._add_hotword())
        ttk.Button(self.qwen_opts, text="添加", command=self._add_hotword, width=6).pack(side="left")

        # 热词标签区
        self.hw_frame = ttk.Frame(main)
        self.hw_frame.grid(row=8, column=0, sticky="ew", pady=(0, 10))
        self._render_hotwords()

        # ── 开始/停止按钮 ──
        btn_frame = ttk.Frame(main)
        btn_frame.grid(row=9, column=0, pady=(0, 8))
        self.start_btn = ttk.Button(btn_frame, text="▶ 开始转写", command=self._start_transcribe, width=14)
        self.start_btn.pack(side="left", padx=4)
        self.stop_btn = ttk.Button(btn_frame, text="■ 停止", command=self._stop_transcribe,
                                    width=8, state="disabled")
        self.stop_btn.pack(side="left", padx=4)

        # ── 日志（显示后台信息）──
        self._section(main, "日志", 10)
        self.log_text = tk.Text(main, height=10, bg="#11111b", fg="#bac2de",
                                 relief="flat", font=self.font_mono, wrap="word",
                                 state="disabled")
        self.log_text.grid(row=11, column=0, sticky="nsew", pady=(0, 0))
        main.rowconfigure(11, weight=1)
        main.columnconfigure(0, weight=1)

        # 日志队列：后台线程入队，主线程定时刷新
        self._log_queue: queue.Queue[str] = queue.Queue()
        self._poll_log()

        # 状态栏
        self.status_var = tk.StringVar(value="就绪")
        status_bar = ttk.Label(self.root, textvariable=self.status_var,
                                foreground="#6c7086", anchor="w")
        status_bar.pack(fill="x", padx=16, pady=(0, 8))

        self._on_model_change()

    # ── 模型切换 ──────────────────────────────────────────────

    def _on_model_change(self, *_args):
        """Whisper 时隐藏 Qwen 专用选项。"""
        is_whisper = self._model_key() == "whisper"
        if is_whisper:
            self.qwen_opts.pack_forget()
            self.gpu_check.configure(state="disabled")
        else:
            self.qwen_opts.pack(side="left")
            self.gpu_check.configure(state="normal")

    # ── 辅助方法 ──────────────────────────────────────────────

    def _section(self, parent: ttk.Frame, text: str, row: int):
        ttk.Label(parent, text=text, font=self.font_bold,
                  foreground="#89b4fa").grid(row=row, column=0, sticky="w", pady=(8, 4))

    def _log(self, msg: str):
        """线程安全：后台线程入消息队列，主线程刷新。"""
        self._log_queue.put(msg)

    def _poll_log(self):
        """主线程定时刷新日志。"""
        while True:
            try:
                msg = self._log_queue.get_nowait()
                self.log_text.config(state="normal")
                self.log_text.insert("end", msg + "\n")
                self.log_text.see("end")
                self.log_text.config(state="disabled")
            except queue.Empty:
                break
        self.root.after(200, self._poll_log)

    def _model_key(self) -> str:
        idx = self.model_combo.current()
        return MODEL_OPTIONS[idx][0] if 0 <= idx < len(MODEL_OPTIONS) else "qwen-0.6B"

    def _set_busy(self, busy: bool):
        state = "disabled" if busy else "normal"
        self.start_btn.config(state=state)
        self.root.update_idletasks()

    # ── 模型管理 ──────────────────────────────────────────────

    def _load_model(self):
        key = self._model_key()
        self._set_busy(True)
        self.model_combo.config(state="disabled")
        self.load_btn.config(state="disabled")
        self.model_status.config(text="加载中…", foreground="#f9e2af")
        self._log(f"[model] 正在加载 {key}...")
        t = threading.Thread(target=self._do_load, args=(key,), daemon=True)
        t.start()

    def _do_load(self, key: str):
        try:
            if key == "whisper":
                if not is_model_downloaded("whisper"):
                    self._log("[model] 模型未下载，正在下载…")
                    start_download("whisper", progress_cb=lambda m: self._log(f"  {m}"))
                self.whisper.load(progress_cb=lambda m: self._log(f"  {m}"))
            else:
                model_size = key.replace("qwen-", "")
                if not is_model_downloaded(key):
                    self._log("[model] 模型未下载，正在下载…")
                    start_download(key, progress_cb=lambda m: self._log(f"  {m}"))
                device = "cuda" if self.use_gpu.get() else "cpu"
                self.qwen.load(model_size, device=device, progress_cb=lambda m: self._log(f"  {m}"))
            model_label = {"qwen-0.6B": "Qwen3-ASR-0.6B", "qwen-1.7B": "Qwen3-ASR-1.7B", "whisper": "faster-whisper"}.get(key, key)
            self.root.after(0, lambda: self.model_status.config(text=f"{model_label} 已加载", foreground="#a6e3a1"))
            self.root.after(0, lambda: self.unload_btn.config(state="normal"))
            self.root.after(0, lambda: self.load_btn.config(state="disabled"))
            self.root.after(0, lambda: self._log("[model] 加载完成"))
            # 加载后锁定模型切换
            self.root.after(0, lambda: self.model_combo.config(state="disabled"))
        except Exception as e:
            self.root.after(0, lambda: self.model_status.config(text=f"加载失败: {e}", foreground="#f38ba8"))
            self.root.after(0, lambda: self._log(f"[model] 错误: {e}"))
        finally:
            self.root.after(0, lambda: self._set_busy(False))

    def _unload_model(self):
        key = self._model_key()
        if key == "whisper":
            self.whisper.unload()
        else:
            self.qwen.unload()
        self.model_status.config(text="未加载", foreground="#6c7086")
        self.unload_btn.config(state="disabled")
        self.load_btn.config(state="normal")
        self.model_combo.config(state="readonly")
        self._log("[model] 已卸载")

    def _build_model_rows(self, frame: ttk.Frame, win: tk.Toplevel):
        """在 frame 中构建模型行和关闭按钮。"""
        if not hasattr(self, "_dl_rows"):
            self._dl_rows = {}
        self._dl_rows.clear()
        for key, info in DOWNLOADABLE_MODELS.items():
            row = ttk.Frame(frame)
            row.pack(fill="x", pady=5)
            row.columnconfigure(1, weight=1)

            downloaded = is_model_downloaded(key)
            status_text = "✓ 已下载" if downloaded else "○ 未下载"
            status_color = "#a6e3a1" if downloaded else "#6c7086"

            ttk.Label(row, text=info["label"], width=30, anchor="w").grid(row=0, column=0, padx=(0, 8))
            status_lbl = ttk.Label(row, text=status_text, foreground=status_color, width=10)
            status_lbl.grid(row=0, column=1, padx=4)

            if not downloaded:
                dl_btn = ttk.Button(row, text="下载", width=6,
                                     command=lambda k=key: self._start_model_dl(k, win))
                dl_btn.grid(row=0, column=2, padx=4)
                cancel_btn = ttk.Button(row, text="停止", width=6,
                                         command=lambda k=key: self._cancel_model_dl(k))
                cancel_btn.grid(row=0, column=3, padx=4)
                cancel_btn.grid_remove()
            else:
                dl_btn = ttk.Button(row, text="重新下载", width=8,
                                     command=lambda k=key: self._start_model_dl(k, win))
                dl_btn.grid(row=0, column=2, padx=4)
                cancel_btn = ttk.Button(row, text="停止", width=6,
                                         command=lambda k=key: self._cancel_model_dl(k))
                cancel_btn.grid(row=0, column=3, padx=4)
                cancel_btn.grid_remove()

            sync_btn = ttk.Button(row, text="在线更新清单", width=10,
                                   command=lambda k=key: self._sync_manifest(k))
            sync_btn.grid(row=0, column=4, padx=4)

            self._dl_rows[key] = {
                "status": status_lbl,
                "dl_btn": dl_btn, "cancel_btn": cancel_btn,
            }
        ttk.Button(frame, text="关闭", command=win.destroy).pack(anchor="e", pady=(12, 0))

    def _open_model_manager(self):
        """打开独立的模型管理窗口。"""
        invalidate_cache()
        win = tk.Toplevel(self.root)
        win.title("模型管理")
        win.geometry("520x380")
        win.configure(bg=self.bg)
        win.resizable(False, False)
        win.transient(self.root)
        win.grab_set()

        frame = ttk.Frame(win, padding=14)
        frame.pack(fill="both", expand=True)

        ttk.Label(frame, text="管理已下载的模型", font=self.font_bold,
                  foreground="#89b4fa").pack(anchor="w", pady=(0, 10))

        self._dl_cancel_flags: dict[str, threading.Event] = {}
        self._build_model_rows(frame, win)

    def _start_model_dl(self, key: str, win: tk.Toplevel):
        row = self._dl_rows.get(key)
        if row:
            row["dl_btn"].grid_remove()
            row["cancel_btn"].grid()
            row["status"].config(text="下载中…", foreground="#f9e2af")

        flag = threading.Event()
        self._dl_cancel_flags[key] = flag

        t = threading.Thread(
            target=self._do_model_dl,
            args=(key, win, flag),
            daemon=True,
        )
        t.start()

    def _cancel_model_dl(self, key: str):
        flag = self._dl_cancel_flags.get(key)
        if flag:
            flag.set()
            cancel_download(key)
            self._log(f"[download] 已取消 {key}")
        row = self._dl_rows.get(key)
        if row:
            row["dl_btn"].grid()
            row["cancel_btn"].grid_remove()
            row["status"].config(text="已取消", foreground="#6c7086")

    def _sync_manifest(self, key: str):
        """从源拉取文件清单并保存。"""
        self._log(f"[manifest] 正在获取 {key} 的文件清单...")
        result = refresh_manifest(key)
        if result.get("ok"):
            self._log(f"[manifest] 完成: {result['count']} 个文件")
            # 刷新面板
            for w in self.root.winfo_children():
                if isinstance(w, tk.Toplevel) and w.title() == "模型管理":
                    self._refresh_model_win(w)
                    break
        else:
            self._log(f"[manifest] 失败: {result.get('error', '未知错误')}")

    def _do_model_dl(self, key: str, win: tk.Toplevel,
                      cancel_flag: threading.Event):
        def log(msg):
            self._log(msg)

        try:
            log(f"[download] 开始下载 {key}...")
            done_ev = start_download(key, progress_cb=log)
            while not done_ev.is_set():
                if cancel_flag.is_set():
                    log(f"[download] 已取消 {key}")
                    return
                done_ev.wait(0.5)
            # done_ev 被 set：检查是否真正完成
            if cancel_flag.is_set():
                log(f"[download] 已取消 {key}")
                return
            invalidate_cache()
            if is_model_downloaded(key):
                log(f"[download] {key} 下载完成")
                self.root.after(0, lambda: self._refresh_model_win(win))
            else:
                log(f"[download] {key} 下载失败或已取消")
                self.root.after(0, lambda: self._refresh_model_win(win))
        except Exception as e:
            if cancel_flag.is_set():
                return
            log(f"[download] 失败: {e}")
            self.root.after(0, lambda: self._refresh_model_win(win))
        finally:
            self._dl_cancel_flags.pop(key, None)

    def _refresh_model_win(self, win: tk.Toplevel):
        """刷新模型管理窗口内容（原地更新，不关闭）。"""
        invalidate_cache()
        frame = None
        for child in win.winfo_children():
            if isinstance(child, ttk.Frame):
                frame = child
                break
        if frame is None:
            return
        for child in list(frame.winfo_children()):
            child.destroy()
        ttk.Label(frame, text="管理已下载的模型", font=self.font_bold,
                  foreground="#89b4fa").pack(anchor="w", pady=(0, 10))
        self._build_model_rows(frame, win)

    # ── 文件选择 ──────────────────────────────────────────────

    def _pick_media(self):
        path = filedialog.askopenfilename(
            title="选择音频/视频文件",
            filetypes=[("音视频文件", "*.mp4 *.mkv *.avi *.mov *.mp3 *.wav *.m4a *.flac *.ogg"),
                       ("所有文件", "*.*")])
        if path:
            self.media_path.set(path)
            # 自动设置输出目录为媒体文件所在目录
            media_dir = str(Path(path).parent)
            if not self.output_dir.get().strip():
                self.output_dir.set(media_dir)

    def _pick_output(self):
        path = filedialog.askdirectory(title="选择输出目录")
        if path:
            self.output_dir.set(path)

    # ── 热词 ─────────────────────────────────────────────────

    def _add_hotword(self):
        w = self.hw_entry.get().strip()
        if not w:
            return
        if w in self.hotwords:
            self.status_var.set(f"热词已存在: {w}")
            return
        self.hotwords.append(w)
        self.hw_entry.delete(0, "end")
        self._render_hotwords()

    def _remove_hotword(self, idx: int):
        if 0 <= idx < len(self.hotwords):
            self.hotwords.pop(idx)
            self._render_hotwords()

    def _render_hotwords(self):
        for w in self.hw_frame.winfo_children():
            w.destroy()
        if not self.hotwords:
            ttk.Label(self.hw_frame, text="暂无热词", foreground="#6c7086",
                      font=self.font_small).pack(side="left")
            return
        for i, w in enumerate(self.hotwords):
            frame = ttk.Frame(self.hw_frame)
            frame.pack(side="left", padx=3, pady=2)
            ttk.Label(frame, text=w, foreground="#89b4fa",
                      font=self.font_small).pack(side="left", padx=(4, 2))
            btn = tk.Button(frame, text="×", font=self.font_small,
                            bg="#1e1e2e", fg="#f38ba8", bd=0,
                            command=lambda i=i: self._remove_hotword(i))
            btn.pack(side="left", padx=(0, 4))

    # ── 转写 ─────────────────────────────────────────────────

    def _check_ffmpeg(self) -> bool:
        """检查 ffmpeg/ffprobe 是否可用。返回 True 表示可用。"""
        exe_suffix = ".exe" if os.name == "nt" else ""
        ffmpeg = shutil.which("ffmpeg")
        ffprobe = shutil.which("ffprobe")
        if ffmpeg and ffprobe:
            return True
        # 检查 FFMPEG_PATH 环境变量
        ffmpeg_dir = os.environ.get("FFMPEG_PATH", "")
        if ffmpeg_dir:
            ffmpeg = shutil.which(os.path.join(ffmpeg_dir, f"ffmpeg{exe_suffix}"))
            ffprobe = shutil.which(os.path.join(ffmpeg_dir, f"ffprobe{exe_suffix}"))
            if ffmpeg and ffprobe:
                return True
        # 检查内置 bundle（MAWxFF 分发）
        bundle = Path(sys.executable).resolve().parent / "ffmpeg" / "bin" if getattr(sys, "frozen", False) else None
        if bundle and (bundle / f"ffmpeg{exe_suffix}").is_file() and (bundle / f"ffprobe{exe_suffix}").is_file():
            return True
        return False

    def _start_transcribe(self):
        media = self.media_path.get().strip()
        if not media or not Path(media).exists():
            messagebox.showerror("错误", "请选择有效的媒体文件")
            return

        if not self._check_ffmpeg():
            if os.name == "nt":
                msg = (
                    "未检测到 FFmpeg。\n\n"
                    "转写视频文件需要 ffmpeg.exe 和 ffprobe.exe。\n\n"
                    "安装方式：\n"
                    "  1. 下载 MAWxFF 版（已内置 FFmpeg）\n"
                    "  2. 从 https://ffmpeg.org/download.html 下载，\n"
                    "     将 ffmpeg/bin 目录加入系统 PATH\n"
                    "  3. 或在 .env 中设置 FFMPEG_PATH=路径"
                )
            else:
                msg = (
                    "未检测到 FFmpeg。\n\n"
                    "转写视频文件需要 ffmpeg 和 ffprobe。\n\n"
                    "安装方式：\n"
                    "  apt install ffmpeg   (Debian/Ubuntu)\n"
                    "  brew install ffmpeg   (macOS)\n"
                    "  或从 https://ffmpeg.org/download.html 下载"
                )
            messagebox.showerror("缺少 FFmpeg", msg)
            return

        key = self._model_key()
        if key == "whisper" and not self.whisper.loaded:
            messagebox.showerror("错误", "请先加载 faster-whisper 模型")
            return
        if key != "whisper" and not self.qwen.loaded:
            messagebox.showerror("错误", "请先加载 Qwen3-ASR 模型")
            return

        self._set_busy(True)
        self.stop_btn.config(state="normal")
        self.transcribe_cancel.clear()
        self.log_text.config(state="normal")
        self.log_text.delete("1.0", "end")
        self.log_text.config(state="disabled")
        self._log(f"[info] 开始转写: {Path(media).name}")
        self._transcribe_thread = threading.Thread(target=self._do_transcribe, daemon=True)
        self._transcribe_thread.start()

    def _stop_transcribe(self):
        """停止当前转写：优先协同取消，超时后兜底强制打断。"""
        self.transcribe_cancel.set()
        self.qwen.cancel()
        self.whisper.cancel()
        self._log("[info] 正在停止转写…")
        self.stop_btn.config(state="disabled")

        # 后台等待线程自行退出，超时后兜底用 ctypes 强制打断
        def _wait_and_force():
            thread = getattr(self, "_transcribe_thread", None)
            if thread and thread.is_alive():
                thread.join(timeout=5.0)
                if thread.is_alive():
                    import ctypes
                    tid = thread.ident
                    if tid:
                        for _ in range(3):
                            ret = ctypes.pythonapi.PyThreadState_SetAsyncExc(
                                ctypes.c_long(tid), ctypes.py_object(KeyboardInterrupt)
                            )
                            if ret != 0:
                                break
        t = threading.Thread(target=_wait_and_force, daemon=True)
        t.start()

    def _do_transcribe(self):
        media = self.media_path.get().strip()
        key = self._model_key()
        out_dir = self.output_dir.get().strip() or str(Path(media).parent)

        def log(msg):
            self.root.after(0, lambda: self._log(msg))

        def done():
            self.root.after(0, lambda: self._set_busy(False))
            self.root.after(0, lambda: self.stop_btn.config(state="disabled"))
            self._transcribe_thread = None

        if self.transcribe_cancel.is_set():
            log("[info] 已取消")
            done()
            return

        # 语言标签 → 代码
        lang_code = ""
        for code, label in LANG_OPTIONS:
            if label == self.lang_var.get():
                lang_code = code
                break

        try:
            if key == "whisper":
                result = transcribe_whisper(media, self.whisper, language=lang_code or None, progress_cb=log)
            else:
                hw = self.hotwords if self.hotwords else None
                result = transcribe_qwen(media, self.qwen, language=lang_code or None,
                                          keep_punct=self.keep_punct.get(), hotwords=hw, progress_cb=log)

            json_path = write_output_files(result, media, out_dir=out_dir, progress_cb=log)
            log(f"[ok] JSON: {json_path}")
            log(f"[ok] SRT: {json_path.with_suffix('.srt')}")
            self.root.after(0, lambda: self.status_var.set("完成 ✓"))
            done()
        except BaseException as e:
            self.root.after(0, lambda: self._log(f"[ERROR] {e}"))
            self.root.after(0, lambda: self._set_busy(False))
            self.root.after(0, lambda: self.stop_btn.config(state="disabled"))
            self.root.after(0, lambda: self.status_var.set("失败"))
            self._transcribe_thread = None

    # ── 启动 ─────────────────────────────────────────────────

    def run(self):
        self.root.mainloop()


def main():
    gui = LocalGui()
    gui.run()


if __name__ == "__main__":
    main()
