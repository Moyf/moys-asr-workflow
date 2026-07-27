"""
MAW Web Console - 一站式 ASR 转写控制台
========================================
支持云端 API / 本地模型（可预加载/卸载）、文件上传、编辑器启动。
"""

from __future__ import annotations

import argparse
import atexit
import gc
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

HERE = Path(__file__).parent
HISTORY_FILE = ROOT / ".console-history.json"
MAX_HISTORY = 100

# 任务存储
_tasks: dict[str, dict] = {}
_tasks_lock = threading.Lock()
_task_counter = 0

# 编辑器进程管理
_editor_procs: list[dict] = []
_editor_procs_lock = threading.Lock()

# Whisper 模型（CPU 推理，专攻英文）
_whisper_model = None
_whisper_lock = threading.Lock()
_whisper_status: dict = {"loaded": False, "loading": False, "error": ""}

# 模型下载管理
DOWNLOADABLE_MODELS = {
    "qwen-0.6B": {
        "name": "Qwen3-ASR-0.6B",
        "model_id": "Qwen/Qwen3-ASR-0.6B",
        "local_dir": str(ROOT / "models" / "Qwen3-ASR-0.6B"),
        "size_gb": 1.9,
        "source": "modelscope",
    },
    "qwen-1.7B": {
        "name": "Qwen3-ASR-1.7B",
        "model_id": "Qwen/Qwen3-ASR-1.7B",
        "local_dir": str(ROOT / "models" / "Qwen3-ASR-1.7B"),
        "size_gb": 4.2,
        "source": "modelscope",
    },
    "aligner": {
        "name": "Qwen3-ForcedAligner-0.6B",
        "model_id": "Qwen/Qwen3-ForcedAligner-0.6B",
        "local_dir": str(ROOT / "models" / "Qwen3-ForcedAligner-0.6B"),
        "size_gb": 1.8,
        "source": "modelscope",
    },
    "faster-whisper": {
        "name": "faster-whisper-large-v3",
        "model_id": "Systran/faster-whisper-large-v3",
        "local_dir": str(ROOT / "models" / "faster-whisper-large-v3"),
        "size_gb": 3.1,
        "source": "huggingface",
    },
}
_download_tasks: dict[str, dict] = {}
_download_lock = threading.Lock()


def _check_download_progress(key: str) -> dict:
    """检查下载进度：统计目标目录中的文件数和总大小。"""
    info = DOWNLOADABLE_MODELS.get(key)
    if not info:
        return {"progress": 0}
    dest = Path(info["local_dir"])
    if not dest.exists():
        return {"progress": 0}
    files = list(dest.rglob("*"))
    total_size = sum(f.stat().st_size for f in files if f.is_file())
    # 估算进度：config.json 约 6KB + model 权重文件
    return {"file_count": len(files), "total_bytes": total_size}


def _do_download(key: str):
    """在后台线程中下载模型。"""
    info = DOWNLOADABLE_MODELS.get(key)
    if not info:
        return
    with _download_lock:
        _download_tasks[key] = {"status": "running", "progress": 0, "error": ""}

    dest = Path(info["local_dir"])
    dest.mkdir(parents=True, exist_ok=True)

    try:
        target_bytes = int(info["size_gb"] * 1024 ** 3)
        source = info.get("source", "modelscope")

        if source == "modelscope":
            from modelscope.hub.snapshot_download import snapshot_download
            snapshot_download(model_id=info["model_id"], cache_dir=str(dest))
            # modelscope 的 cache_dir 会创建嵌套目录，把文件移到目标根目录
            import shutil as _shutil
            for p in Path(dest).rglob("config.json"):
                src_dir = p.parent
                if src_dir != dest:
                    for f in src_dir.iterdir():
                        _shutil.copy2(str(f), str(dest / f.name))
                    print(f"[download] moved files from {src_dir}")
                    break
            proc = subprocess.CompletedProcess(args=[], returncode=0)
        else:
            # huggingface 镜像，使用 Python API
            import os as _os
            _os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
            from huggingface_hub import snapshot_download
            snapshot_download(
                repo_id=info["model_id"],
                local_dir=str(dest),
                resume_download=True,
            )

        with _download_lock:
            if key in _download_tasks:
                _download_tasks[key] = {"status": "done", "progress": 100}
        print(f"[download] {key} completed")
    except Exception as e:
        with _download_lock:
            if key in _download_tasks:
                _download_tasks[key] = {"status": "failed", "error": str(e)}
        print(f"[download] {key} failed: {e}")


def _cleanup_editors():
    """进程退出时杀掉所有编辑器进程。"""
    with _editor_procs_lock:
        pids = [e["pid"] for e in _editor_procs]
    for pid in pids:
        try:
            subprocess.run(["taskkill", "/f", "/pid", str(pid)],
                          capture_output=True, timeout=5)
        except Exception:
            pass
    if pids:
        print(f"[cleanup] killed {len(pids)} editor process(es)")


def _save_history():
    """将任务历史持久化到磁盘。"""
    try:
        with _tasks_lock:
            tasks = list(_tasks.values())
        # 深拷贝，避免修改原 _tasks 中的数据
        import copy
        tasks = [copy.deepcopy(t) for t in tasks]
        # 精简：保留最近 MAX_HISTORY 条，去掉大日志字段
        tasks = sorted(tasks, key=lambda x: x.get("started_at", ""), reverse=True)[:MAX_HISTORY]
        for t in tasks:
            t.pop("log", None)
            t.pop("log_path", None)
            # 将 input_path 存为相对路径，方便迁移
            body = t.get("body")
            if body and isinstance(body, dict):
                ip = body.get("input_path", "")
                if ip:
                    try:
                        body["input_path"] = str(Path(ip).relative_to(ROOT))
                    except ValueError:
                        pass
            # json_path 也存为相对路径
            jp = t.get("json_path", "")
            if jp:
                try:
                    t["json_path"] = str(Path(jp).relative_to(ROOT))
                except ValueError:
                    pass
        HISTORY_FILE.write_text(
            json.dumps(tasks, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )
    except Exception:
        pass


def _load_history():
    """启动时从磁盘加载历史任务。"""
    global _task_counter
    try:
        if HISTORY_FILE.exists():
            data = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
            # 去重：同一 task_id 只保留最后一条
            seen = {}
            for t in data:
                tid = t.get("id", "")
                if tid:
                    seen[tid] = t
            data = list(seen.values())
            # 写回去重后的数据
            HISTORY_FILE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
            for t in data:
                tid = t.get("id", "")
                if tid:
                    t["log"] = ""
                    t["log_path"] = None
                    # 路径修正：相对路径补全 ROOT，绝对路径尝试适配
                    def _fix_path(val):
                        if not val: return val
                        p = Path(val)
                        if not p.is_absolute():
                            abs_path = ROOT / val
                            return str(abs_path) if abs_path.exists() else val
                        if not p.exists():
                            try:
                                rel = p.relative_to(ROOT.parent)
                                # 跳过多余的项目目录段，直到与 ROOT 匹配
                                for i in range(len(rel.parts)):
                                    candidate = ROOT.joinpath(*rel.parts[i:])
                                    if candidate.exists():
                                        return str(candidate)
                            except Exception: pass
                        return val

                    body = t.get("body")
                    if body and isinstance(body, dict):
                        body["input_path"] = _fix_path(body.get("input_path", ""))
                    t["json_path"] = _fix_path(t.get("json_path", ""))
                    _tasks[tid] = t
            if data:
                # 恢复计数器
                max_id = max(int(t["id"].split("-")[1]) for t in data if "-" in t.get("id", ""))
                _task_counter = max_id
    except Exception:
        pass

# 模型管理
_asr_model = None
_model_lock = threading.Lock()
_model_status: dict = {"loaded": False, "loading": False, "error": "", "model_size": ""}


def _run_task(task_id: str, script: str, args: list[str], cwd: str) -> None:
    """在后台线程中运行转写脚本（仅云端 API 模式），收集输出。"""
    try:
        proc = subprocess.run(
            [sys.executable, str(ROOT / script)] + args,
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=7200,
        )
        output = proc.stdout + proc.stderr
        with _tasks_lock:
            if proc.returncode == 0:
                _tasks[task_id]["status"] = "done"
                _tasks[task_id]["json_path"] = _find_output_json(args, cwd)
            else:
                _tasks[task_id]["status"] = "failed"
            _tasks[task_id]["log"] = output
    except subprocess.TimeoutExpired:
        with _tasks_lock:
            _tasks[task_id]["status"] = "failed"
            _tasks[task_id]["log"] = "[ERROR] Task timed out (2h limit)"
    except Exception as e:
        with _tasks_lock:
            _tasks[task_id]["status"] = "failed"
            _tasks[task_id]["log"] = f"[ERROR] {e}"


def _find_output_json(cli_args: list[str], cwd: str) -> str | None:
    input_path = None
    for i, arg in enumerate(cli_args):
        if i == 0 and not arg.startswith("-"):
            input_path = arg
            break
    if not input_path:
        return None
    p = Path(input_path)
    parent = p.parent if p.parent.exists() else Path(cwd)
    pattern = f"*{p.stem}*.json"
    candidates = sorted(parent.glob(pattern), key=lambda x: x.stat().st_mtime, reverse=True)
    return str(candidates[0]) if candidates else None


def _do_local_transcribe(task_id: str, input_path: str, language: str,
                         keep_punct: bool, length_limit: str,
                         model_size: str) -> None:
    """在服务器进程中直接使用已加载的模型进行转写。"""
    log_lines = []
    log_lock = threading.Lock()

    def _flush():
        with log_lock:
            txt = "\n".join(log_lines)
        with _tasks_lock:
            t = _tasks.get(task_id)
            if t:
                t["log"] = txt

    def log(msg):
        with log_lock:
            log_lines.append(msg)
        print(f"[{task_id}] {msg}")
        _flush()

    def _start_heartbeat():
        """转写期间每秒追加心跳，结束后自动停止。"""
        t0 = time.perf_counter()
        stop_event = threading.Event()

        def _beat():
            while not stop_event.is_set():
                elapsed = time.perf_counter() - t0
                with log_lock:
                    # 移除上一条心跳（如果有）
                    if log_lines and log_lines[-1].startswith("[progress]"):
                        log_lines.pop()
                    log_lines.append(f"[progress] transcribing... ({elapsed:.0f}s)")
                _flush()
                stop_event.wait(1)
            # 清除最后一条心跳
            with log_lock:
                if log_lines and log_lines[-1].startswith("[progress]"):
                    log_lines.pop()
            _flush()

        t = threading.Thread(target=_beat, daemon=True)
        t.start()
        return stop_event

    import shutil
    from generate_subtitle_qwen_api import (
        extract_audio, get_duration_sec, split_words_to_segments,
        generate_srt, _parse_duration,
    )

    json_path = None
    try:
        inp = Path(input_path)
        is_video = inp.suffix.lower() in {".mp4", ".mkv", ".avi", ".mov",
                                           ".wmv", ".flv", ".webm", ".ts", ".m4v"}

        with tempfile.TemporaryDirectory() as tmpdir:
            if is_video:
                audio_path = str(Path(tmpdir) / "audio.wav")
                extract_audio(input_path, audio_path)
                log(f"[ffmpeg] audio extracted")
            else:
                audio_path = str(Path(tmpdir) / inp.name)
                shutil.copy2(input_path, audio_path)

            duration = get_duration_sec(audio_path)
            m, s = divmod(int(duration), 60)
            log(f"[info] duration: {m}m{s}s")

            if length_limit:
                limit_sec = _parse_duration(length_limit)
                if limit_sec < duration:
                    limited = str(Path(tmpdir) / "audio_limited.wav")
                    subprocess.run(["ffmpeg", "-i", audio_path, "-t", str(limit_sec),
                                    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                                    "-y", limited], check=True, capture_output=True)
                    audio_path = limited
                    duration = limit_sec
                    log(f"[info] trimmed to {limit_sec}s")

            # 热词：统一从 hotwords.txt 读取
            hotwords = []
            hw_path = ROOT / "hotwords.txt"
            if hw_path.exists():
                for line in hw_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if line and not line.startswith("#"):
                        hotwords.append(line)
            context_str = " ".join(hotwords) if hotwords else ""
            if context_str:
                log(f"[hotwords] {' '.join(hotwords)}")

            # 使用已加载的模型
            import torch
            with _model_lock:
                model = _asr_model
            if model is None:
                raise RuntimeError("Model not loaded")

            lang_param = language if language else None
            log(f"[local] transcribing (lang={lang_param or 'auto'})...")
            stop_heartbeat = _start_heartbeat()
            t0 = time.perf_counter()

            results = model.transcribe(
                audio=[audio_path],
                language=[lang_param] if lang_param else [None],
                context=[context_str] if context_str else None,
                return_time_stamps=True,
            )

            stop_heartbeat.set()
            elapsed = time.perf_counter() - t0
            if not results:
                raise RuntimeError("No result from model")
            result = results[0]
            log(f"[info] language: {result.language}")
            log(f"[info] text: {result.text[:80]}...")
            log(f"[info] transcribe time: {elapsed:.1f}s")

            # 转标准 items 格式
            items = []
            if result.time_stamps:
                for ts in result.time_stamps:
                    items.append({
                        "text": ts.text,
                        "start": int(ts.start_time * 1000),
                        "end": int(ts.end_time * 1000),
                    })

            if not items:
                segments = [{"start": 0, "end": int(duration * 1000), "text": result.text}]
            else:
                segments = split_words_to_segments(items, 21, 5, 1500)

            if not keep_punct:
                for seg in segments:
                    seg["text"] = seg["text"].rstrip("，。")
                    seg_items = seg.get("items")
                    if seg_items:
                        k = len(seg_items) - 1
                        while k >= 0:
                            seg_items[k]["text"] = seg_items[k]["text"].rstrip("，。")
                            if seg_items[k]["text"]:
                                break
                            k -= 1

            srt_content = generate_srt(segments)

            # 输出文件
            ts_prefix = datetime.now().strftime("%y%m%d%H%M")
            speed_tag = f"{duration/elapsed:.1f}x" if elapsed > 0 else "na"
            model_tag = f"qwen3-asr-local-{model_size}"
            out_dir = inp.parent
            base = out_dir / f"[{ts_prefix}]{inp.stem}.{model_tag}.{speed_tag}"

            srt_path = base.with_suffix(".srt")
            srt_path.write_text(srt_content, encoding="utf-8")
            log(f"[ok] SRT: {srt_path}")
            log(f"[ok] segments: {len(segments)}")

            json_data = {
                "media": str(inp),
                "language": result.language or "",
                "model": model_tag,
                "segments": [
                    {"start": s["start"], "end": s["end"], "text": s["text"],
                     "items": s.get("items", [])}
                    for s in segments
                ],
            }
            json_path = base.with_suffix(".json")
            json_path.write_text(json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8")
            log(f"[ok] JSON: {json_path}")
            log("[ok] DONE")

    except Exception as e:
        log(f"[ERROR] {e}")

    output = "\n".join(log_lines)

    with _tasks_lock:
        task = _tasks.get(task_id)
        if task:
            task["status"] = "done" if "[ERROR]" not in output else "failed"
            task["log"] = output
            task["json_path"] = str(json_path) if json_path and json_path.exists() else None
    _save_history()


def _do_whisper_transcribe(task_id: str, input_path: str, language: str) -> None:
    """使用 faster-whisper 进行转写，返回句子级时间戳。"""
    log_lines = []
    log_lock = threading.Lock()

    def _flush():
        with log_lock: txt = "\n".join(log_lines)
        with _tasks_lock:
            t = _tasks.get(task_id)
            if t: t["log"] = txt

    def log(msg):
        with log_lock: log_lines.append(msg)
        print(f"[{task_id}] {msg}")
        _flush()

    import shutil
    from generate_subtitle_qwen_api import extract_audio, get_duration_sec, generate_srt

    # 自动查找 faster-whisper 模型路径（snapshot hash 可能变化）
    fw_base = ROOT / "models" / "faster-whisper-large-v3" / "snapshots"
    snapshots = sorted(fw_base.glob("*")) if fw_base.exists() else []
    FW_MODEL_PATH = str(snapshots[0]) if snapshots else str(ROOT / "models" / "faster-whisper-large-v3")

    json_path = None
    try:
        inp = Path(input_path)
        is_video = inp.suffix.lower() in {".mp4", ".mkv", ".avi", ".mov",
                                           ".wmv", ".flv", ".webm", ".ts", ".m4v"}

        with tempfile.TemporaryDirectory() as tmpdir:
            if is_video:
                audio_path = str(Path(tmpdir) / "audio.wav")
                extract_audio(input_path, audio_path)
                log(f"[ffmpeg] audio extracted")
            else:
                audio_path = str(Path(tmpdir) / inp.name)
                shutil.copy2(input_path, audio_path)

            duration = get_duration_sec(audio_path)
            m, s = divmod(int(duration), 60)
            log(f"[info] duration: {m}m{s}s")

            with _whisper_lock:
                model = _whisper_model
            if model is None:
                raise RuntimeError("Whisper model not loaded")

            log(f"[whisper] transcribing...")
            t0 = time.perf_counter()

            segments, info = model.transcribe(
                audio_path,
                language=language if language else None,
                beam_size=5,
                vad_filter=True,
                vad_parameters=dict(min_silence_duration_ms=500),
            )

            elapsed = time.perf_counter() - t0
            seg_list = list(segments)
            detected_lang = info.language if info else ""
            log(f"[info] language: {detected_lang}")
            log(f"[info] segments: {len(seg_list)}")
            log(f"[info] transcribe time: {elapsed:.1f}s")

            if not seg_list:
                raise RuntimeError("No transcription result")

            # 构建 segments（带句子级时间戳）
            items = []
            text_parts = []
            for seg in seg_list:
                text_parts.append(seg.text.strip())
                items.append({
                    "text": seg.text.strip(),
                    "start": int(seg.start * 1000),
                    "end": int(seg.end * 1000),
                })
            full_text = " ".join(text_parts)
            log(f"[info] text: {full_text[:80]}...")

            from generate_subtitle_qwen_api import split_words_to_segments
            segments_out = split_words_to_segments(items, 21, 5, 1500) if items else []
            if not segments_out:
                segments_out = [{"start": 0, "end": int(duration * 1000), "text": full_text, "items": []}]

            srt_content = generate_srt(segments_out)
            ts_prefix = datetime.now().strftime("%y%m%d%H%M")
            speed_tag = f"{duration/elapsed:.1f}x" if elapsed > 0 else "na"
            out_dir = inp.parent
            base = out_dir / f"[{ts_prefix}]{inp.stem}.whisper.{speed_tag}"

            srt_path = base.with_suffix(".srt")
            srt_path.write_text(srt_content, encoding="utf-8")
            log(f"[ok] SRT: {srt_path}")

            json_data = {
                "media": str(inp),
                "language": detected_lang or language or "en",
                "model": "faster-whisper-large-v3",
                "segments": [
                    {"start": s["start"], "end": s["end"], "text": s["text"],
                     "items": s.get("items", [])} for s in segments_out
                ],
            }
            json_path = base.with_suffix(".json")
            json_path.write_text(json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8")
            log(f"[ok] JSON: {json_path}")
            log("[ok] DONE")

    except Exception as e:
        log(f"[ERROR] {e}")

    output = "\n".join(log_lines)
    with _tasks_lock:
        task = _tasks.get(task_id)
        if task:
            task["status"] = "done" if "[ERROR]" not in output else "failed"
            task["log"] = output
            task["json_path"] = str(json_path) if json_path and json_path.exists() else None
    _save_history()


class ConsoleHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        params = parse_qs(parsed.query)

        if path == "/":
            self._serve_html()
        elif path == "/api/tasks":
            self._list_tasks()
        elif path == "/api/log":
            self._get_log(params)
        elif path == "/api/env":
            self._get_env(params)
        elif path == "/api/check-file":
            self._check_file(params)
        elif path == "/api/model/status":
            self._model_status_api()
        elif path == "/api/editors":
            self._list_editors()
        elif path == "/api/task/load":
            self._load_task_config(params)
        elif path == "/api/model/download-status":
            self._download_status_api(params)
        elif path == "/api/hotwords":
            self._get_hotwords()
        elif path.startswith("/assets/"):
            self._serve_asset(path)
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/transcribe":
            self._start_transcribe()
        elif path == "/api/open-editor":
            self._open_editor()
        elif path == "/api/cancel-task":
            self._cancel_task()
        elif path == "/api/upload":
            self._upload_file()
        elif path == "/api/env":
            self._set_env()
        elif path == "/api/model/load":
            self._load_model()
        elif path == "/api/model/unload":
            self._unload_model()
        elif path == "/api/model/download":
            self._start_download()
        elif path == "/api/task/re-run":
            self._re_run_task()
        elif path == "/api/task/delete":
            self._delete_task()
        elif path == "/api/task/prepare":
            self._prepare_task()
        elif path == "/api/editor/kill":
            self._kill_editor()
        elif path == "/api/hotwords":
            self._save_hotwords()
        elif path == "/api/prepare-file":
            self._prepare_file_api()
        else:
            self.send_error(HTTPStatus.NOT_FOUND)

    # ---- static ----
    def _serve_html(self):
        html_path = HERE / "index.html"
        if not html_path.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "index.html not found")
            return
        body = html_path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _serve_asset(self, path: str):
        rel = path.lstrip("/")
        asset_path = HERE / rel
        if not asset_path.exists() or not asset_path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        body = asset_path.read_bytes()
        ct = {".js": "application/javascript", ".css": "text/css",
              ".png": "image/png", ".svg": "image/svg+xml",
              ".ico": "image/x-icon"}.get(asset_path.suffix.lower(), "application/octet-stream")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ct)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 1024 * 1024:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _send_json(self, data: dict, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    @staticmethod
    def _prepare_input_file(path: str) -> str | None:
        """将媒体文件复制到新的 uploads/ 子目录。
        每次转写都会创建一个带时间戳的子目录，确保各次转写互不干扰。
        文件不存在时返回 None。
        """
        src = Path(path)
        if not src.exists():
            return None
        # 创建新的时间戳子目录
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        dest_dir = ROOT / "uploads" / ts
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / src.name
        try:
            import os as _os
            _os.link(str(src), str(dest))
            print(f"[prepare] hardlink: {src.name}")
        except Exception:
            import shutil as _su
            _su.copy2(str(src), str(dest))
            print(f"[prepare] copy: {src.name}")
        return str(dest)

    # ---- transcribe ----
    def _start_transcribe(self):
        body = self._read_body()
        input_path = body.get("input_path", "").strip()
        if not input_path:
            self._send_json({"ok": False, "error": "Path required"}, 400)
            return

        model_type = body.get("model", "api")
        language = body.get("language", "")
        keep_punct = body.get("keep_punct", False)
        length_limit = body.get("length_limit", "").strip()
        reuse_id = body.get("_task_id", "").strip()

        # 统一保存热词到文件（仅本地 Qwen3-ASR 模型使用）
        self._save_hotwords_file(body.get("hotwords", "").strip())

        # 先检查模型状态（在文件操作之前，快速返回）
        if model_type == "whisper":
            with _whisper_lock:
                if not _whisper_status["loaded"]:
                    self._send_json({"ok": False, "error": "faster-whisper 未加载，请先加载模型"}, 400)
                    return
        elif model_type not in ("api",):
            size = "1.7B" if model_type == "local-1.7B" else "0.6B"
            with _model_lock:
                if not _model_status["loaded"] or _model_status["model_size"] != size:
                    self._send_json({"ok": False, "error": f"Qwen3-ASR-{size} 未加载，请先加载模型"}, 400)
                    return

        # 文件准备（硬链接/复制到 uploads/）
        input_path = self._prepare_input_file(input_path)
        if input_path is None:
            self._send_json({"ok": False, "error": "源文件不存在，请重新选择文件"}, 400)
            return

        global _task_counter
        with _tasks_lock:
            if reuse_id:
                task_id = reuse_id
                old_display = _tasks[reuse_id].get("display_name", "") if reuse_id in _tasks else ""
                _tasks[task_id] = {"id": task_id, "display_name": old_display, "status": "running", "log": ""}
            else:
                _task_counter += 1
                task_id = f"task-{_task_counter:04d}"

        if model_type == "api":
            # 云端：走子进程
            script = "generate_subtitle_qwen_api.py"
            cli_args = [input_path, "--json"]
            if language:
                cli_args += ["--language", language]
            if keep_punct:
                cli_args += ["--keep-punct"]
            if length_limit:
                cli_args += ["-ll", length_limit]

            with _tasks_lock:
                _tasks[task_id] = {
                    "id": task_id, "status": "running", "script": script,
                    "args": cli_args, "log": "", "log_path": None,
                    "json_path": None, "started_at": datetime.now().strftime("%H:%M:%S"),
                    "body": body,
                    "display_name": body.get("_display_name", "") if isinstance(body, dict) else "",
                }
            t = threading.Thread(target=_run_task, args=(task_id, script, cli_args, str(ROOT)), daemon=True)
            t.start()
            self._send_json({"ok": True, "task_id": task_id})

        elif model_type == "whisper":
            # whisper：直接服务器进程转写
            with _tasks_lock:
                _tasks[task_id] = {
                    "id": task_id, "status": "running",
                    "script": "faster-whisper-large-v3",
                    "args": [input_path], "log": "", "log_path": None,
                    "body": body,
                    "json_path": None, "started_at": datetime.now().strftime("%H:%M:%S"),
                }
            t = threading.Thread(
                target=_do_whisper_transcribe,
                args=(task_id, input_path, language), daemon=True,
            )
            t.start()
            self._send_json({"ok": True, "task_id": task_id})

        else:
            # 本地 Qwen3-ASR：直接服务器进程转写
            size = "1.7B" if model_type == "local-1.7B" else "0.6B"
            with _tasks_lock:
                _tasks[task_id] = {
                    "id": task_id, "status": "running",
                    "script": f"local Qwen3-ASR-{size}",
                    "args": [input_path], "log": "", "log_path": None,
                    "body": body,
                    "display_name": body.get("_display_name", "") if isinstance(body, dict) else "",
                    "json_path": None, "started_at": datetime.now().strftime("%H:%M:%S"),
                }
            t = threading.Thread(
                target=_do_local_transcribe,
                args=(task_id, input_path, language, keep_punct, length_limit, size),
                daemon=True,
            )
            t.start()
            self._send_json({"ok": True, "task_id": task_id})

    # ---- model management ----
    def _model_status_api(self):
        with _model_lock:
            qwen = dict(_model_status)
        with _whisper_lock:
            whisper = dict(_whisper_status)
        self._send_json({"ok": True, "qwen": qwen, "whisper": whisper})

    def _load_model(self):
        body = self._read_body()
        model_type = body.get("model", "local-0.6B")
        use_gpu = body.get("use_gpu", True)

        # === Whisper 分支 ===
        if model_type == "whisper":
            global _whisper_model, _whisper_status
            with _whisper_lock:
                if _whisper_status["loading"]:
                    self._send_json({"ok": False, "error": "Whisper is already loading"})
                    return
                if _whisper_status["loaded"]:
                    self._send_json({"ok": True, "message": "Whisper already loaded"})
                    return
                _whisper_status = {"loaded": False, "loading": True, "error": ""}

            def _do_load_whisper():
                global _whisper_model, _whisper_status
                try:
                    from faster_whisper import WhisperModel
                    fw_base = ROOT / "models" / "faster-whisper-large-v3" / "snapshots"
                    snaps = sorted(fw_base.glob("*")) if fw_base.exists() else []
                    model_path = str(snaps[0]) if snaps else str(ROOT / "models" / "faster-whisper-large-v3")
                    import torch
                    if use_gpu and torch.cuda.is_available():
                        device = "cuda"
                        compute_type = "float16"
                    else:
                        device = "cpu"
                        compute_type = "int8"
                    print(f"[whisper] loading on {device} ({compute_type})...")
                    m = WhisperModel(model_path, device=device, compute_type=compute_type)
                    with _whisper_lock:
                        _whisper_model = m
                        _whisper_status = {"loaded": True, "loading": False, "error": "", "device": device}
                    print(f"[whisper] loaded on {device}")
                except Exception as e:
                    with _whisper_lock:
                        _whisper_status = {"loaded": False, "loading": False, "error": str(e)}
                    print(f"[whisper] load failed: {e}")

            threading.Thread(target=_do_load_whisper, daemon=True).start()
            self._send_json({"ok": True, "message": "Loading Whisper..."})
            return

        # === Qwen3-ASR 分支 ===
        global _model_status
        try:
            size = "1.7B" if model_type == "local-1.7B" else "0.6B"
            with _model_lock:
                if _model_status["loading"]:
                    self._send_json({"ok": False, "error": "Model is already loading"})
                    return
                if _model_status["loaded"] and _model_status["model_size"] == size:
                    self._send_json({"ok": True, "message": f"Qwen3-ASR-{size} already loaded"})
                    return
                _model_status = {"loaded": False, "loading": True, "error": "", "model_size": size}

            def _do_load():
                global _asr_model, _model_status
                try:
                    import torch
                    import os as _os
                    _os.environ["CUDNN_IGNORE_CUDNN_GETLIB_CONFIG_ERROR"] = "1"
                    from qwen_asr import Qwen3ASRModel

                    name = str(ROOT / "models" / f"Qwen3-ASR-{size}")
                    aligner = str(ROOT / "models" / "Qwen3-ForcedAligner-0.6B")
                    if not Path(name).exists(): name = f"Qwen/Qwen3-ASR-{size}"
                    if not Path(aligner).exists(): aligner = "Qwen/Qwen3-ForcedAligner-0.6B"

                    if use_gpu and torch.cuda.is_available():
                        device = "cuda:0"
                        dtype = torch.bfloat16
                    else:
                        device = "cpu"
                        dtype = torch.float32
                    print(f"[model] loading Qwen3-ASR-{size} on {device}...")
                    m = Qwen3ASRModel.from_pretrained(
                        name, dtype=dtype, device_map=device,
                        forced_aligner=aligner,
                        forced_aligner_kwargs=dict(dtype=dtype, device_map=device),
                        max_inference_batch_size=1, max_new_tokens=256,
                    )
                    with _model_lock:
                        _asr_model = m
                        _model_status = {"loaded": True, "loading": False, "error": "", "model_size": size, "device": device}
                    print(f"[model] Qwen3-ASR-{size} loaded on {device}")
                except Exception as e:
                    with _model_lock:
                        _model_status = {"loaded": False, "loading": False, "error": str(e), "model_size": size}
                    print(f"[model] load failed: {e}")

            threading.Thread(target=_do_load, daemon=True).start()
            self._send_json({"ok": True, "message": f"Loading Qwen3-ASR-{size}..."})
        except Exception as e:
            print(f"[model] _load_model error: {e}")
            import traceback; traceback.print_exc()
            try: self._send_json({"ok": False, "error": str(e)}, 500)
            except Exception: pass

    def _unload_model(self):
        global _asr_model, _model_status, _whisper_model, _whisper_status
        # 卸载 Qwen3-ASR
        with _model_lock:
            _asr_model = None
            _model_status = {"loaded": False, "loading": False, "error": "", "model_size": ""}
        # 卸载 Whisper
        with _whisper_lock:
            _whisper_model = None
            _whisper_status = {"loaded": False, "loading": False, "error": ""}
        gc.collect()
        try:
            import torch
            torch.cuda.empty_cache()
        except ImportError:
            pass
        print("[model] all models unloaded")
        self._send_json({"ok": True, "message": "All models unloaded"})

    # ---- task helpers ----
    def _list_tasks(self):
        with _tasks_lock:
            tasks = sorted(_tasks.values(), key=lambda x: x["id"], reverse=True)[:20]
        # 返回前修正 json_path
        def _fix(jp):
            if not jp: return jp
            p = Path(jp)
            if not p.is_absolute():
                ap = ROOT / jp
                return str(ap) if ap.exists() else jp
            if p.exists(): return jp
            try:
                rel = p.relative_to(ROOT.parent)
                for i in range(len(rel.parts)):
                    c = ROOT.joinpath(*rel.parts[i:])
                    if c.exists(): return str(c)
            except Exception: pass
            return jp
        for t in tasks:
            t["json_path"] = _fix(t.get("json_path", ""))
        self._send_json({"ok": True, "tasks": tasks})

    def _get_log(self, params):
        task_id = params.get("task_id", [None])[0]
        if not task_id or task_id not in _tasks:
            self._send_json({"ok": False, "error": "task not found"}, 404)
            return
        with _tasks_lock:
            task = dict(_tasks[task_id])
        self._send_json({"ok": True, "task": task})

    def _check_file(self, params):
        filepath = params.get("path", [None])[0]
        if filepath:
            p = Path(filepath)
            exists = p.exists()
            is_dir = p.is_dir()
            size = p.stat().st_size if exists and not is_dir else 0
            self._send_json({"ok": True, "exists": exists, "is_dir": is_dir, "size": size})
        else:
            self._send_json({"ok": False}, 400)

    def _start_download(self):
        """启动模型下载任务。"""
        body = self._read_body()
        key = body.get("key", "")
        if key not in DOWNLOADABLE_MODELS:
            self._send_json({"ok": False, "error": "Unknown model"}, 400)
            return
        with _download_lock:
            if key in _download_tasks and _download_tasks[key]["status"] == "running":
                self._send_json({"ok": False, "error": "Already downloading"})
                return
        # 检查是否已下载
        info = DOWNLOADABLE_MODELS[key]
        dest = Path(info["local_dir"])
        if dest.exists() and len(list(dest.rglob("*"))) > 1:
            self._send_json({"ok": True, "message": f"{info['name']} already exists"})
            return
        # 确保 huggingface-cli 可用（仅限 huggingface 源）
        if info.get("source") == "huggingface":
            import shutil
            if not shutil.which("huggingface-cli"):
                self._send_json({"ok": False, "error": "huggingface-cli not found. Run: pip install huggingface_hub"})
                return
        t = threading.Thread(target=_do_download, args=(key,), daemon=True)
        t.start()
        self._send_json({"ok": True, "message": f"Downloading {info['name']}..."})

    def _download_status_api(self, params):
        """查询所有下载任务的状态。"""
        result = {}
        with _download_lock:
            for key, info in DOWNLOADABLE_MODELS.items():
                status = _download_tasks.get(key, {"status": "idle", "progress": 0, "error": ""})
                exists = Path(info["local_dir"]).exists() and len(list(Path(info["local_dir"]).rglob("*"))) > 1
                result[key] = {
                    "name": info["name"],
                    "status": "done" if exists and status.get("status") != "running" else status.get("status", "idle"),
                    "progress": 100 if exists else status.get("progress", 0),
                    "error": status.get("error", ""),
                    "size_gb": info["size_gb"],
                }
        self._send_json({"ok": True, "models": result})

    # ---- editor ----
    def _open_editor(self):
        body = self._read_body()
        json_path = body.get("json_path", "").strip()
        # 相对路径补全 ROOT
        if json_path and not Path(json_path).is_absolute():
            json_path = str(ROOT / json_path)
        # 绝对路径但文件不存在，尝试修正旧目录结构
        if json_path and not Path(json_path).exists():
            try:
                p = Path(json_path)
                rel = p.relative_to(ROOT.parent)
                for i in range(len(rel.parts)):
                    cand = ROOT.joinpath(*rel.parts[i:])
                    if cand.exists():
                        json_path = str(cand)
                        break
            except Exception:
                pass
        is_blank = False

        if not json_path or not Path(json_path).exists():
            is_blank = True
        else:
            # 验证 JSON 有效性
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if "segments" not in data:
                    is_blank = True
                else:
                    # 修正 media 字段路径
                    media = data.get("media", "")
                    if media and not Path(media).exists():
                        try:
                            mp = Path(media)
                            rel = mp.relative_to(ROOT.parent)
                            for i in range(len(rel.parts)):
                                cand = ROOT.joinpath(*rel.parts[i:])
                                if cand.exists():
                                    data["media"] = str(cand)
                                    with open(json_path, "w", encoding="utf-8") as fw:
                                        json.dump(data, fw, ensure_ascii=False, indent=2)
                                    break
                        except Exception:
                            pass
            except json.JSONDecodeError:
                is_blank = True

        if is_blank:
            json_path = ""

        # 用随机端口，避免和旧编辑器进程冲突
        import socket
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            editor_port = s.getsockname()[1]
        editor_url = f"http://127.0.0.1:{editor_port}/"

        try:
            cmd = [sys.executable, str(ROOT / "server-editor" / "serve.py")]
            if is_blank:
                cmd += ["--blank"]
            else:
                cmd += [json_path]
            cmd += ["--port", str(editor_port), "--no-open"]

            proc = subprocess.Popen(
                cmd,
                cwd=str(ROOT),
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            time.sleep(1.5)
            if proc.poll() is not None:
                self._send_json({
                    "ok": False,
                    "error": f"Editor exited (code {proc.returncode})",
                })
                return
            # 记录编辑器进程
            label = json_path if json_path else "(blank)"
            with _editor_procs_lock:
                _editor_procs.append({
                    "pid": proc.pid,
                    "port": editor_port,
                    "label": os.path.basename(label),
                    "started_at": datetime.now().strftime("%H:%M:%S"),
                })
            self._send_json({"ok": True, "url": editor_url, "pid": proc.pid})
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    # ---- cancel ----
    def _cancel_task(self):
        body = self._read_body()
        task_id = body.get("task_id", "")
        with _tasks_lock:
            if task_id in _tasks and _tasks[task_id]["status"] == "running":
                _tasks[task_id]["status"] = "cancelled"
                _tasks[task_id]["log"] += "\n[CANCELLED]\n"
        self._send_json({"ok": True})

    def _re_run_task(self):
        """用相同参数重新运行任务。"""
        body = self._read_body()
        task_id = body.get("task_id", "")
        with _tasks_lock:
            old = _tasks.get(task_id)
            if not old:
                self._send_json({"ok": False, "error": "Task not found"}, 404)
                return
            old_body = old.get("body")
            if not old_body:
                self._send_json({"ok": False, "error": "No original parameters"}, 400)
                return
        # 复用 _start_transcribe 的逻辑，把原 body 传进去重新提交
        tid = self._start_transcribe_with_body(old_body)
        if tid:
            self._send_json({"ok": True, "task_id": tid})
        # 错误响应由 _start_transcribe_with_body 内部处理

    def _start_transcribe_with_body(self, body: dict):
        """用给定的 body 参数直接启动转写。返回 task_id 或 None。"""
        input_path = body.get("input_path", "").strip()
        if not input_path:
            self._send_json({"ok": False, "error": "Path required"}, 400)
            return None

        model_type = body.get("model", "api")
        language = body.get("language", "")
        hotwords = body.get("hotwords", "").strip()
        keep_punct = body.get("keep_punct", False)
        length_limit = body.get("length_limit", "").strip()

        # 统一保存热词到文件（所有模型入口一致）
        self._save_hotwords_file(hotwords)

        # 先检查模型状态（在文件操作之前）
        if model_type not in ("api",):
            size = "1.7B" if model_type == "local-1.7B" else "0.6B"
            with _model_lock:
                if not _model_status["loaded"] or _model_status["model_size"] != size:
                    self._send_json({"ok": False, "error": f"Qwen3-ASR-{size} 未加载，请先加载模型"}, 400)
                    return None

        # 文件准备（硬链接/复制到 uploads/）
        input_path = self._prepare_input_file(input_path)
        if input_path is None:
            self._send_json({"ok": False, "error": "源文件不存在，请重新选择文件"}, 400)
            return None

        global _task_counter
        with _tasks_lock:
            _task_counter += 1
            task_id = f"task-{_task_counter:04d}"

        if model_type == "api":
            script = "generate_subtitle_qwen_api.py"
            cli_args = [input_path, "--json"]
            if language: cli_args += ["--language", language]
            if keep_punct: cli_args += ["--keep-punct"]
            if length_limit: cli_args += ["-ll", length_limit]
            with _tasks_lock:
                _tasks[task_id] = {"id": task_id, "status": "running", "script": script,
                    "args": cli_args, "log": "", "log_path": None,
                    "json_path": None, "started_at": datetime.now().strftime("%H:%M:%S"), "body": body}
            t = threading.Thread(target=_run_task, args=(task_id, script, cli_args, str(ROOT)), daemon=True)
            t.start()
            return task_id

        size = "1.7B" if model_type == "local-1.7B" else "0.6B"
        with _tasks_lock:
            _tasks[task_id] = {"id": task_id, "status": "running",
                "script": f"local Qwen3-ASR-{size}",
                "args": [input_path], "log": "", "log_path": None,
                "json_path": None, "started_at": datetime.now().strftime("%H:%M:%S"), "body": body}
        t = threading.Thread(target=_do_local_transcribe,
            args=(task_id, input_path, language, keep_punct, length_limit, size), daemon=True)
        t.start()
        return task_id

    def _delete_task(self):
        """删除任务记录，可选删除上传文件。"""
        body = self._read_body()
        task_id = body.get("task_id", "")
        delete_files = body.get("delete_files", False)
        upload_dir = None
        with _tasks_lock:
            task = _tasks.get(task_id)
            if task and delete_files:
                input_path = (task.get("body") or {}).get("input_path", "")
                if input_path:
                    p = Path(input_path)
                    # 只删除 uploads/ 目录下的文件（上传的副本，非源文件）
                    if "uploads" in p.parts:
                        upload_dir = p.parent if p.parent.exists() else None
            if task_id in _tasks:
                del _tasks[task_id]
        if upload_dir:
            import shutil
            shutil.rmtree(upload_dir, ignore_errors=True)
            print(f"[task] deleted upload dir: {upload_dir}")
        _save_history()
        self._send_json({"ok": True})

    def _prepare_task(self):
        """加载旧任务配置，复制媒体文件到新 uploads 目录，返回新路径和参数。"""
        body = self._read_body()
        task_id = body.get("task_id", "")
        with _tasks_lock:
            task = _tasks.get(task_id)
            if not task:
                self._send_json({"ok": False, "error": "Task not found"}, 404)
                return
            old_body = task.get("body")
            if not old_body:
                self._send_json({"ok": False, "error": "No saved parameters"}, 400)
                return
            config = dict(old_body)
            old_path = config.get("input_path", "")
            if not old_path or not Path(old_path).exists():
                self._send_json({"ok": False, "error": f"File not found: {old_path}", "config": config}, 404)
                return

        # 复制文件到新 uploads 子目录
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        new_dir = ROOT / "uploads" / ts
        new_dir.mkdir(parents=True, exist_ok=True)
        src = Path(old_path)
        dest = new_dir / src.name
        # 优先硬链接（省空间），失败则复制
        try:
            import os as _os
            _os.link(str(src), str(dest))
            print(f"[prepare] hardlink: {src} -> {dest}")
        except Exception:
            import shutil as _su
            _su.copy2(str(src), str(dest))
            print(f"[prepare] copy: {src} -> {dest}")
        config["input_path"] = str(dest)
        config["_display_name"] = task.get("display_name") or task.get("id", "")
        print(f"[prepare] {old_path} -> {dest}")
        self._send_json({"ok": True, "config": config})



    def _load_task_config(self, params):
        """加载任务的原始配置参数到表单。"""
        task_id = params.get("task_id", [None])[0]
        if not task_id:
            self._send_json({"ok": False, "error": "task_id required"}, 400)
            return
        with _tasks_lock:
            task = _tasks.get(task_id)
            if not task:
                self._send_json({"ok": False, "error": "Task not found"}, 404)
                return
            body = task.get("body")
            if not body:
                self._send_json({"ok": False, "error": "No saved parameters"}, 400)
                return
            config = dict(body)
            # 补全相对路径
            raw_path = config.get("input_path", "")
            if raw_path and not Path(raw_path).is_absolute():
                config["input_path"] = str(ROOT / raw_path)
            # 检查文件是否存在
            input_path = config.get("input_path", "")
            if input_path and not Path(input_path).exists():
                self._send_json({
                    "ok": False,
                    "error": f"File not found: {input_path}",
                    "config": config,
                }, 404)
                return
            config["_display_name"] = task.get("display_name") or task.get("id", "")
        self._send_json({"ok": True, "config": config})

    def _list_editors(self):
        """返回正在运行的编辑器进程列表。"""
        # 清理已退出的进程
        with _editor_procs_lock:
            alive = []
            for e in _editor_procs:
                p = subprocess.run(
                    ["tasklist", "/FI", f"PID eq {e['pid']}", "/NH"],
                    capture_output=True, text=True, timeout=5
                )
                if str(e['pid']) in p.stdout:
                    alive.append(e)
            _editor_procs[:] = alive
        self._send_json({"ok": True, "editors": list(_editor_procs)})

    def _kill_editor(self):
        """杀掉指定编辑器进程。"""
        body = self._read_body()
        pid = body.get("pid", 0)
        if not pid:
            self._send_json({"ok": False, "error": "PID required"}, 400)
            return
        subprocess.run(["taskkill", "/f", "/pid", str(pid)], capture_output=True, timeout=5)
        with _editor_procs_lock:
            _editor_procs[:] = [e for e in _editor_procs if e["pid"] != pid]
        self._send_json({"ok": True})

    # ---- upload ----
    def _upload_file(self):
        import cgi
        ct = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ct:
            self._send_json({"ok": False, "error": "Expected multipart/form-data"}, 400)
            return
        try:
            form = cgi.FieldStorage(fp=self.rfile, headers=self.headers,
                                     environ={"REQUEST_METHOD": "POST"})
            file_item = form["file"]
            if not file_item.filename:
                self._send_json({"ok": False, "error": "No file"}, 400)
                return
            # 保存到项目 uploads/ 目录下的带时间戳子目录
            ts = datetime.now().strftime("%Y%m%d_%H%M%S")
            upload_dir = ROOT / "uploads" / ts
            upload_dir.mkdir(parents=True, exist_ok=True)
            dest = upload_dir / Path(file_item.filename).name
            with open(dest, "wb") as f:
                f.write(file_item.file.read())
            mb = dest.stat().st_size / 1024 / 1024
            print(f"[upload] {dest} ({mb:.1f} MB)")
            self._send_json({"ok": True, "path": str(dest), "name": dest.name,
                             "size_mb": round(mb, 1), "dir": str(upload_dir)})
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    # ---- prepare file ----
    def _prepare_file_api(self):
        """将外部文件复制到 uploads/ 目录。"""
        body = self._read_body()
        path = body.get("path", "").strip()
        if not path:
            self._send_json({"ok": False, "error": "path required"}, 400)
            return
        new_path = self._prepare_input_file(path)
        if new_path is None:
            self._send_json({"ok": False, "error": "文件不存在"})
            return
        self._send_json({"ok": True, "path": new_path})

    # ---- env ----
    @staticmethod
    def _load_hotwords_file() -> str:
        """读取 hotwords.txt，返回纯文本内容。"""
        hw_path = ROOT / "hotwords.txt"
        if hw_path.exists():
            return hw_path.read_text(encoding="utf-8")
        return ""

    @staticmethod
    def _save_hotwords_file(content: str):
        """覆写 hotwords.txt。"""
        (ROOT / "hotwords.txt").write_text(content, encoding="utf-8")

    def _get_hotwords(self):
        self._send_json({"ok": True, "content": self._load_hotwords_file()})

    def _save_hotwords(self):
        body = self._read_body()
        content = body.get("content", "")
        self._save_hotwords_file(content)
        self._send_json({"ok": True})

    def _get_env(self, params):
        key = params.get("key", [None])[0]
        if not key:
            self._send_json({"ok": False, "error": "missing key"}, 400)
            return
        env_path = ROOT / ".env"
        value = ""
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith(key + "="):
                    value = line.split("=", 1)[1]
                    break
        self._send_json({"ok": True, "key": key, "value": value})

    def _set_env(self):
        body = self._read_body()
        key = body.get("key", "").strip()
        value = body.get("value", "").strip()
        if not key:
            self._send_json({"ok": False, "error": "missing key"}, 400)
            return
        env_path = ROOT / ".env"
        lines = []
        found = False
        if env_path.exists():
            lines = env_path.read_text(encoding="utf-8").splitlines()
        for i, line in enumerate(lines):
            if line.strip().startswith(key + "="):
                lines[i] = f"{key}={value}"
                found = True
                break
        if not found:
            lines.append(f"{key}={value}")
        env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        print(f"[env] updated {key}")
        self._send_json({"ok": True, "key": key})

    def log_message(self, fmt: str, *args):
        print(f"[console] {fmt % args}")


def main():
    parser = argparse.ArgumentParser(description="MAW Web Console")
    parser.add_argument("--port", type=int, default=10101, help="Port (default 10101)")
    parser.add_argument("--no-open", action="store_true", help="Don't open browser")
    args = parser.parse_args()
    _load_history()
    atexit.register(_cleanup_editors)

    server = ThreadingHTTPServer(("127.0.0.1", args.port), ConsoleHandler)
    host, port = server.server_address[:2]
    url = f"http://{host}:{port}/"

    print(f"MAW Console started (local only)")
    print(f"  URL: {url}")
    print(f"  Editor: 动态端口（启动后显示在日志中）")
    print("  Press Ctrl+C to stop.")

    if not args.no_open:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nConsole stopped.")


if __name__ == "__main__":
    main()
