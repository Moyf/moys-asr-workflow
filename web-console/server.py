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
RESULTS_DIR = ROOT / "results"  # 转写结果输出目录（JSON/SRT/HTML），与 uploads/ 分离
MAX_LENGTH_LIMIT_SEC = 3600 * 4  # P2-9: length_limit 上限 4 小时

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

# P1-6: 模型已存在缓存，避免每次轮询遍历目录
_model_exists_cache: dict[str, bool] = {}
_model_exists_cache_lock = threading.Lock()


def _is_model_downloaded(key: str) -> bool:
    """检查模型是否已下载完成（优先使用缓存）。"""
    with _model_exists_cache_lock:
        if key in _model_exists_cache:
            return _model_exists_cache[key]
    info = DOWNLOADABLE_MODELS.get(key)
    if not info:
        return False
    dest = Path(info["local_dir"])
    # 用 marker 文件判断：Qwen 系列用 config.json，Whisper 用 model.bin
    # P1-6: Whisper 系列没有 config.json，用 model.bin 或 model.onnx 或 .bin 文件
    markers = ["config.json", "model.bin", "model.onnx"]
    exists = any((dest / m).exists() for m in markers)
    # 没有 marker 文件时检查目录是否有文件
    if not exists and dest.exists():
        files = list(dest.iterdir())
        exists = len(files) > 0 and any(f.suffix in (".bin", ".onnx", ".safetensors", ".json") for f in files)
    with _model_exists_cache_lock:
        _model_exists_cache[key] = exists
    return exists


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
    """在后台子进程中下载模型，可被 proc.kill() 取消。"""
    info = DOWNLOADABLE_MODELS.get(key)
    if not info:
        return
    with _download_lock:
        _download_tasks[key] = {"status": "running", "progress": 0, "error": ""}

    # 把 info 写到临时文件传给子进程（避免 pickling 问题）
    info_tmp = ROOT / f".dl_info_{key}.json"
    try:
        info_tmp.write_text(json.dumps(info), encoding="utf-8")
        worker = HERE / "_download_worker.py"
        proc = subprocess.Popen(
            [sys.executable, str(worker), key, str(info_tmp)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        with _download_lock:
            if key in _download_tasks:
                _download_tasks[key]["_proc"] = proc
        output, _ = proc.communicate(timeout=7200)
        print(output, end="")
        if proc.returncode == 0:
            with _download_lock:
                if key in _download_tasks:
                    _download_tasks[key] = {"status": "done", "progress": 100}
            with _model_exists_cache_lock:
                _model_exists_cache.pop(key, None)
            print(f"[download] {key} completed")
        else:
            raise RuntimeError(f"exit code {proc.returncode}")
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
        with _download_lock:
            if key in _download_tasks:
                _download_tasks[key] = {"status": "failed", "error": "timed out"}
    except Exception as e:
        with _download_lock:
            if key in _download_tasks:
                _download_tasks[key] = {"status": "failed", "error": str(e)}
        print(f"[download] {key} failed: {e}")
    finally:
        info_tmp.unlink(missing_ok=True)
        with _download_lock:
            if key in _download_tasks:
                _download_tasks[key].pop("_proc", None)


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


def _save_task_params(result_dir: Path, body: dict, script: str = "", args: list[str] | None = None):
    """将转写参数持久化到结果目录下的 _params.json。"""
    try:
        params = {
            "model": body.get("model", "api"),
            "language": body.get("language", ""),
            "keep_punct": body.get("keep_punct", False),
            "length_limit": body.get("length_limit", ""),
            "hotwords": body.get("hotwords", ""),
            "script": script or body.get("model", "api"),
            "args": args or [],
            "input_path": body.get("input_path", ""),
            "display_name": body.get("_display_name", ""),
        }
        (result_dir / "_params.json").write_text(
            json.dumps(params, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
    except Exception:
        pass


def _load_task_params(result_dir: Path) -> dict | None:
    """从结果目录读取 _params.json，返回参数字典或 None。"""
    try:
        p = result_dir / "_params.json"
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        pass
    return None


def _sync_results():
    """扫描 results/ 目录，将磁盘上有 JSON 但不在 _tasks 中的结果补全到内存。"""
    global _task_counter
    if not RESULTS_DIR.exists():
        return
    with _tasks_lock:
        existing = set(_tasks.keys())
        # 收集已有任务已占用的结果目录
        occupied_dirs = set()
        for t in _tasks.values():
            jp = t.get("json_path", "")
            if jp:
                p = Path(jp).parent
                try:
                    p.relative_to(RESULTS_DIR)
                    occupied_dirs.add(str(p.resolve()))
                except ValueError:
                    pass
        for d in sorted(RESULTS_DIR.iterdir()):
            if not d.is_dir():
                continue
            tid = f"results-{d.name}"
            if tid in existing:
                continue
            # 跳过已被现有任务引用的目录
            if str(d.resolve()) in occupied_dirs:
                continue
            json_files = list(d.glob("*.json"))
            # 排除 _params.json
            json_files = [j for j in json_files if j.name != "_params.json"]
            params = _load_task_params(d) or {}
            if not json_files:
                # 有 _params.json 但无主 JSON → 转写失败/崩溃，创建 failed 记录
                if params:
                    _tasks[tid] = {
                        "id": tid, "status": "failed",
                        "script": params.get("script", params.get("model", "unknown")),
                        "args": params.get("args", []),
                        "json_path": None,
                        "body": params,
                        "started_at": d.name[-6:],
                        "display_name": params.get("display_name", d.name),
                    }
                continue
            jp = json_files[0]
            try:
                data = json.loads(jp.read_text(encoding="utf-8"))
            except Exception:
                continue
            params = _load_task_params(d) or {}
            _tasks[tid] = {
                "id": tid, "status": "done",
                "script": params.get("script", data.get("model", params.get("model", "unknown"))),
                "args": params.get("args", []),
                "json_path": str(jp),
                "body": params,
                "started_at": d.name[-6:],
                "display_name": params.get("display_name", jp.stem),
            }
            _task_counter = max(_task_counter, 0)

        # 清理：json_path 指向的 results/ 子目录已不存在的任务
        for tid in list(_tasks.keys()):
            jp = _tasks[tid].get("json_path", "")
            if jp:
                p = Path(jp).parent
                try:
                    p.relative_to(RESULTS_DIR)
                    if not p.is_dir():
                        del _tasks[tid]
                except ValueError:
                    pass
            elif tid.startswith("results-"):
                # failed 任务（json_path=None），检查对应目录
                dir_name = tid[len("results-"):]
                if not (RESULTS_DIR / dir_name).is_dir():
                    del _tasks[tid]


# 模型管理
_asr_model = None
_model_lock = threading.Lock()
_model_status: dict = {"loaded": False, "loading": False, "error": "", "model_size": ""}


def _run_task(task_id: str, script: str, args: list[str], cwd: str) -> None:
    """在后台线程中运行转写脚本（仅云端 API 模式），收集输出。
    P1-2/P1-9: 改用 Popen 以便 _cancel_task 可以实际终止进程。
    """
    proc = None

    try:
        proc = subprocess.Popen(
            [sys.executable, str(ROOT / script)] + args,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        with _tasks_lock:
            if task_id in _tasks:
                _tasks[task_id]["_proc"] = proc
        output, _ = proc.communicate(timeout=7200)
        with _tasks_lock:
            if task_id in _tasks:
                if proc.returncode == 0:
                    _tasks[task_id]["status"] = "done"
                    stored_jp = _tasks[task_id].get("json_path", "")
                    if stored_jp and Path(stored_jp).exists():
                        _tasks[task_id]["json_path"] = stored_jp
                    else:
                        _tasks[task_id]["json_path"] = _find_output_json(args, cwd)
                else:
                    _tasks[task_id]["status"] = "failed"
                _tasks[task_id]["log"] = output
    except subprocess.TimeoutExpired:
        if proc:
            proc.kill()
            proc.wait()
        with _tasks_lock:
            if task_id in _tasks:
                _tasks[task_id]["status"] = "failed"
                _tasks[task_id]["log"] = "[ERROR] Task timed out (2h limit)"
    except Exception as e:
        with _tasks_lock:
            if task_id in _tasks:
                _tasks[task_id]["status"] = "failed"
                _tasks[task_id]["log"] = f"[ERROR] {e}"
    finally:
        with _tasks_lock:
            if task_id in _tasks:
                _tasks[task_id].pop("_proc", None)


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
    candidates = sorted(
        (x for x in parent.glob(pattern) if not x.name.endswith(".waveform.json")),
        key=lambda x: x.stat().st_mtime, reverse=True,
    )
    return str(candidates[0]) if candidates else None


def _setup_logging(task_id):
    """创建转写任务的日志系统，返回 (log_lines, log_lock, log_fn)。"""
    log_lines = []
    log_lock = threading.Lock()

    def _flush():
        with log_lock:
            txt = "\n".join(log_lines)
        with _tasks_lock:
            t = _tasks.get(task_id)
            if t:
                t["log"] = txt

    def _log(msg):
        with log_lock:
            log_lines.append(msg)
        print(f"[{task_id}] {msg}")
        _flush()

    return log_lines, log_lock, _log


def _finalize_task(task_id, success, json_path, log_lines):
    """在 transcribe 结束时设置最终状态。"""
    with _tasks_lock:
        task = _tasks.get(task_id)
        if task:
            task["status"] = "done" if success else "failed"
            task["log"] = "\n".join(log_lines)
            task["json_path"] = str(json_path) if json_path and json_path.exists() else None


def _write_output(out_dir, inp, segments, srt_content, model_tag, language, speed_tag, task_id, log):
    """写入 SRT/JSON 文件并调用 edit.py 生成 HTML，返回 json_path。"""
    ts_prefix = datetime.now().strftime("%y%m%d%H%M")
    base = out_dir / f"[{ts_prefix}]{inp.stem}.{model_tag}.{speed_tag}"

    srt_path = base.with_suffix(".srt")
    srt_path.write_text(srt_content, encoding="utf-8")
    log(f"[ok] SRT: {srt_path}")

    json_data = {
        "media": str(inp),
        "language": language,
        "model": model_tag,
        "segments": [
            {"start": s["start"], "end": s["end"], "text": s["text"],
             "items": s.get("items", [])} for s in segments
        ],
    }
    json_path = base.with_suffix(".json")
    json_path.write_text(json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"[ok] JSON: {json_path}")

    # 生成 standalone .edit.html
    try:
        edit_script = ROOT / "edit.py"
        if edit_script.exists():
            subprocess.run(
                [sys.executable, str(edit_script), str(json_path)],
                cwd=str(ROOT), capture_output=True, text=True, timeout=30,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
            )
            log(f"[ok] HTML: {base.with_suffix('.edit.html')}")
        else:
            log("[warning] edit.py not found, skip HTML")
    except Exception as ex:
        log(f"[warning] edit.py failed: {ex}")

    return json_path


def _do_local_transcribe(task_id: str, input_path: str, language: str,
                         keep_punct: bool, length_limit: str,
                         model_size: str, out_dir: Path) -> None:
    """在服务器进程中直接使用已加载的模型进行转写。"""
    log_lines, log_lock, log = _setup_logging(task_id)

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
    from maw.utils import (
        extract_audio, get_duration_sec, split_words_to_segments,
        generate_srt, parse_duration,
        SPLIT_MAX_CHARS, SPLIT_MIN_CHARS, SPLIT_GAP_MS,
    )

    # P1-1: 用显式的 success/exception 判断状态，不扫日志字符串
    success = False
    json_path = None
    stop_heartbeat = None
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
                limit_sec = parse_duration(length_limit)
                # P2-9: length_limit 上限校验
                if limit_sec > MAX_LENGTH_LIMIT_SEC:
                    raise ValueError(f"length_limit exceeds {MAX_LENGTH_LIMIT_SEC}s ({MAX_LENGTH_LIMIT_SEC // 3600}h)")
                if limit_sec < duration:
                    limited = str(Path(tmpdir) / "audio_limited.wav")
                    subprocess.run(["ffmpeg", "-i", audio_path, "-t", str(limit_sec),
                                    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                                    "-y", limited], check=True, capture_output=True)
                    audio_path = limited
                    duration = limit_sec
                    log(f"[info] trimmed to {limit_sec}s")

            # 热词：统一从 hotwords.txt 读取（不存在则回退 hotwords.example.txt）
            hotwords = []
            hw_path = ROOT / "hotwords.txt"
            if not hw_path.exists():
                hw_path = ROOT / "hotwords.example.txt"
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
                segments = split_words_to_segments(items, SPLIT_MAX_CHARS, SPLIT_MIN_CHARS, SPLIT_GAP_MS)

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
            log(f"[ok] segments: {len(segments)}")

            # 输出文件
            speed_tag = f"{duration/elapsed:.1f}x" if elapsed > 0 else "na"
            model_tag = f"qwen3-asr-local-{model_size}"
            json_path = _write_output(out_dir, inp, segments, srt_content, model_tag,
                                       result.language or "", speed_tag, task_id, log)
            log("[ok] DONE")
            success = True

    except Exception as e:
        log(f"[ERROR] {e}")
    finally:
        if stop_heartbeat:
            stop_heartbeat.set()
        _finalize_task(task_id, success, json_path, log_lines)


def _do_whisper_transcribe(task_id: str, input_path: str, language: str,
                           out_dir: Path) -> None:
    """使用 faster-whisper 进行转写，返回句子级时间戳。"""
    log_lines, log_lock, log = _setup_logging(task_id)

    import shutil
    from maw.utils import extract_audio, get_duration_sec, generate_srt,\
        split_words_to_segments, SPLIT_MAX_CHARS, SPLIT_MIN_CHARS, SPLIT_GAP_MS

    # 自动查找 faster-whisper 模型路径（snapshot hash 可能变化）
    fw_base = ROOT / "models" / "faster-whisper-large-v3" / "snapshots"
    snapshots = sorted(fw_base.glob("*")) if fw_base.exists() else []
    FW_MODEL_PATH = str(snapshots[0]) if snapshots else str(ROOT / "models" / "faster-whisper-large-v3")

    # P1-1: 用显式的 success/exception 判断状态，不扫日志字符串
    success = False
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

            # P2-6: Whisper 输出已是句子级，直接使用原生 segment 边界，不二次切分
            segments_out = [
                {"start": int(s.start * 1000), "end": int(s.end * 1000),
                 "text": s.text.strip(), "items": []}
                for s in seg_list
            ]
            if not segments_out:
                segments_out = [{"start": 0, "end": int(duration * 1000), "text": full_text, "items": []}]

            srt_content = generate_srt(segments_out)
            speed_tag = f"{duration/elapsed:.1f}x" if elapsed > 0 else "na"
            json_path = _write_output(out_dir, inp, segments_out, srt_content,
                                       "faster-whisper-large-v3",
                                       detected_lang or language or "en",
                                       speed_tag, task_id, log)
            log("[ok] DONE")
            success = True

    except Exception as e:
        log(f"[ERROR] {e}")
    finally:
        _finalize_task(task_id, success, json_path, log_lines)


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
        # /api/env 已删除（P0-2: .env 不可通过 HTTP 暴露）
        # /api/check-file 已删除（P0-3: 禁止任意路径查询）
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
        # /api/env 已删除（P0-2: .env 不可通过 HTTP 暴露）
        elif path == "/api/model/load":
            self._load_model()
        elif path == "/api/model/unload":
            self._unload_model()
        elif path == "/api/model/download":
            self._start_download()
        elif path == "/api/task/delete":
            self._delete_task()
        elif path == "/api/clean-uploads":
            self._clean_uploads()
        elif path == "/api/task/prepare":
            self._prepare_task()
        elif path == "/api/editor/kill":
            self._kill_editor()
        elif path == "/api/hotwords":
            self._save_hotwords()
        # /api/prepare-file 已删除（P0-3: 禁止任意路径复制）
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

    ALLOWED_ASSET_EXTS = {".js", ".css", ".png", ".svg", ".ico", ".woff", ".woff2"}

    def _serve_asset(self, path: str):
        # P2-12: 限定只服务 web-console/assets/ 子目录
        rel = path.lstrip("/").removeprefix("assets/")
        asset_path = (HERE / "assets" / rel).resolve()
        base = (HERE / "assets").resolve()
        try:
            asset_path.relative_to(base)
        except ValueError:
            self.send_error(HTTPStatus.NOT_FOUND)
            return
        if not asset_path.is_file() or asset_path.suffix.lower() not in self.ALLOWED_ASSET_EXTS:
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
        """验证媒体文件路径是否在 uploads/ 白名单内。
        使用 md5(source_path + size + mtime) 去重，避免同一文件产生多份副本。
        只接受 ROOT/uploads/ 下的文件，拒绝任意路径。
        返回已在 uploads/ 下的有效路径。
        """
        src = Path(path)
        if not src.exists():
            return None
        # P0-3: 路径白名单校验 — 只接受 uploads/ 下的文件
        try:
            src.resolve().relative_to((ROOT / "uploads").resolve())
        except ValueError:
            print(f"[prepare] rejected path outside uploads/: {path}")
            return None
        # P1-5: 已在 uploads/ 下，直接复用，不创建冗余副本
        return str(src)

    # ---- transcribe ----
    def _create_task(self, body: dict) -> str | None:
        """启动转写任务的核心逻辑。返回 task_id 或 None（错误时已发送 HTTP 响应）。"""
        input_path = body.get("input_path", "").strip()
        if not input_path:
            self._send_json({"ok": False, "error": "Path required"}, 400)
            return None

        model_type = body.get("model", "api")
        language = body.get("language", "")
        keep_punct = body.get("keep_punct", False)
        length_limit = body.get("length_limit", "").strip()
        reuse_id = body.get("_task_id", "").strip()
        hotwords_raw = body.get("hotwords", "").strip()

        # 统一保存热词到文件
        self._save_hotwords_file(hotwords_raw)

        # 检查模型状态
        if model_type == "whisper":
            with _whisper_lock:
                if not _whisper_status["loaded"]:
                    self._send_json({"ok": False, "error": "faster-whisper 未加载，请先加载模型"}, 400)
                    return None
        elif model_type not in ("api",):
            size = "1.7B" if model_type == "local-1.7B" else "0.6B"
            with _model_lock:
                if not _model_status["loaded"] or _model_status["model_size"] != size:
                    self._send_json({"ok": False, "error": f"Qwen3-ASR-{size} 未加载，请先加载模型"}, 400)
                    return None

        # 文件准备（只接受 uploads/ 下的文件）
        input_path = self._prepare_input_file(input_path)
        if input_path is None:
            self._send_json({"ok": False, "error": "源文件不存在，请重新选择文件"}, 400)
            return None

        global _task_counter

        # 创建结果目录
        out_dir = RESULTS_DIR / datetime.now().strftime("%Y%m%d_%H%M%S")
        out_dir.mkdir(parents=True, exist_ok=True)
        task_id = f"results-{out_dir.name}"

        with _tasks_lock:
            if reuse_id:
                task_id = reuse_id
                old_display = _tasks[reuse_id].get("display_name", "") if reuse_id in _tasks else ""
                _tasks[task_id] = {"id": task_id, "display_name": old_display, "status": "running", "log": ""}
            else:
                _task_counter += 1

        if model_type == "api":
            script = "generate_subtitle_qwen_api.py"
            input_name = Path(input_path).stem
            api_out_srt = out_dir / f"{input_name}.srt"
            cli_args = [input_path, "--json", "-o", str(api_out_srt)]
            if language: cli_args += ["--language", language]
            if keep_punct: cli_args += ["--keep-punct"]
            if length_limit: cli_args += ["-ll", length_limit]
            expected_json = api_out_srt.with_suffix(".json")
            _save_task_params(out_dir, body, script=script, args=cli_args)
            with _tasks_lock:
                _tasks[task_id] = {
                    "id": task_id, "status": "running", "script": script,
                    "args": cli_args, "log": "", "log_path": None,
                    "json_path": str(expected_json),
                    "started_at": datetime.now().strftime("%H:%M:%S"),
                    "body": body,
                    "display_name": body.get("_display_name", "") if isinstance(body, dict) else "",
                }
            t = threading.Thread(target=_run_task, args=(task_id, script, cli_args, str(ROOT)), daemon=True)
            t.start()

        elif model_type == "whisper":
            _save_task_params(out_dir, body, script="faster-whisper-large-v3", args=[input_path])
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
                args=(task_id, input_path, language, out_dir), daemon=True,
            )
            with _tasks_lock:
                if task_id in _tasks:
                    _tasks[task_id]["_thread"] = t
            t.start()

        else:
            size = "1.7B" if model_type == "local-1.7B" else "0.6B"
            _save_task_params(out_dir, body, script=f"local Qwen3-ASR-{size}", args=[input_path])
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
                args=(task_id, input_path, language, keep_punct, length_limit, size, out_dir),
                daemon=True,
            )
            with _tasks_lock:
                if task_id in _tasks:
                    _tasks[task_id]["_thread"] = t
            t.start()

        return task_id

    def _start_transcribe(self):
        """HTTP handler：解析 body → 创建任务 → 返回 JSON 响应。"""
        body = self._read_body()
        task_id = self._create_task(body)
        if task_id:
            self._send_json({"ok": True, "task_id": task_id})
        # _create_task 在出错时已发送错误响应

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
                if _model_status["loaded"]:
                    if _model_status["model_size"] == size:
                        self._send_json({"ok": True, "message": f"Qwen3-ASR-{size} already loaded"})
                        return
                    self._send_json({"ok": False, "error": f"Qwen3-ASR-{_model_status['model_size']} 已加载，请先卸载后再切换"})
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
        body = self._read_body()
        target = body.get("model", "all")  # "qwen" / "whisper" / "all"
        msg = []
        if target in ("qwen", "all"):
            global _asr_model, _model_status
            with _model_lock:
                model = _asr_model
                _asr_model = None
                _model_status = {"loaded": False, "loading": False, "error": "", "model_size": ""}
            # 显式释放模型资源（含内部 forced_aligner），移至 CPU 后让 GC 回收
            if model is not None:
                try:
                    model.to("cpu")
                except Exception:
                    pass
                del model
            msg.append("Qwen")
        if target in ("whisper", "all"):
            global _whisper_model, _whisper_status
            with _whisper_lock:
                _whisper_model = None
                _whisper_status = {"loaded": False, "loading": False, "error": ""}
            msg.append("Whisper")
        gc.collect()
        try:
            import torch
            torch.cuda.empty_cache()
        except ImportError:
            pass
        joined = " + ".join(msg) if msg else "None"
        print(f"[model] unloaded: {joined}")
        self._send_json({"ok": True, "message": f"{joined} unloaded"})

    # ---- task helpers ----
    def _list_tasks(self):
        _sync_results()
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
            t.pop("_thread", None)
            t.pop("_proc", None)
        self._send_json({"ok": True, "tasks": tasks})

    def _get_log(self, params):
        task_id = params.get("task_id", [None])[0]
        if not task_id or task_id not in _tasks:
            self._send_json({"ok": False, "error": "task not found"}, 404)
            return
        with _tasks_lock:
            task = dict(_tasks[task_id])
        task.pop("_thread", None)
        task.pop("_proc", None)
        self._send_json({"ok": True, "task": task})

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
        # 清除缓存后重新检测是否已下载
        with _model_exists_cache_lock:
            _model_exists_cache.pop(key, None)
        info = DOWNLOADABLE_MODELS[key]
        if _is_model_downloaded(key):
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
            # 刷新前清除缓存，检测手动删改
            with _model_exists_cache_lock:
                _model_exists_cache.clear()
            for key, info in DOWNLOADABLE_MODELS.items():
                status = _download_tasks.get(key, {"status": "idle", "progress": 0, "error": ""})
                exists = _is_model_downloaded(key)
                # 估算进度：用 file_count 表示已下载文件数
                progress = status.get("progress", 0)
                if exists and status.get("status") != "running":
                    status_str = "done"
                    progress = 100
                elif status.get("status") == "running":
                    status_str = "running"
                    prog_info = _check_download_progress(key)
                    file_count = prog_info.get("file_count", 0)
                    total_bytes = prog_info.get("total_bytes", 0)
                    target_bytes = int(info["size_gb"] * 1024 ** 3)
                    pct = min(99, int(total_bytes / target_bytes * 100)) if target_bytes > 0 else 0
                    progress = pct
                else:
                    status_str = "idle"
                result[key] = {
                    "name": info["name"],
                    "status": status_str,
                    "progress": progress,
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
            # 验证 JSON 有效性（P0-6: 不自动改写工程 JSON）
            try:
                with open(json_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if "segments" not in data:
                    is_blank = True
                else:
                    # 仅提示 media 缺失，不修改文件
                    media = data.get("media", "")
                    if media and not Path(media).exists():
                        print(f"[editor] media missing: {media}, editor will prompt")
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
        # 先查转写任务，再查下载任务
        with _tasks_lock:
            in_tasks = task_id in _tasks and _tasks[task_id]["status"] == "running"
        with _download_lock:
            in_downloads = task_id in _download_tasks and _download_tasks[task_id].get("status") == "running"

        if not in_tasks and not in_downloads:
            self._send_json({"ok": False, "error": "Task not running"}, 400)
            return

        if in_tasks:
            with _tasks_lock:
                task = _tasks[task_id]
                script = task.get("script", "")
                task["status"] = "failed"
                task["log"] += "\n[CANCELLED]\n"

            if script in ("generate_subtitle_qwen_api.py",):
                proc: subprocess.Popen | None = task.get("_proc")
                if proc and proc.poll() is None:
                    proc.kill()
                    print(f"[cancel] killed subprocess for {task_id}")
            elif script.startswith("local") or script == "faster-whisper-large-v3":
                thread: threading.Thread | None = task.get("_thread")
                if thread and thread.is_alive():
                    try:
                        import ctypes
                        tid = thread.native_id
                        ret = ctypes.pythonapi.PyThreadState_SetAsyncExc(
                            ctypes.c_long(tid), ctypes.py_object(KeyboardInterrupt))
                        if ret == 0:
                            print(f"[cancel] thread {tid} not found")
                        elif ret > 1:
                            ctypes.pythonapi.PyThreadState_SetAsyncExc(ctypes.c_long(tid), None)
                        print(f"[cancel] interrupted thread {tid} for {task_id}")
                    except Exception as ex:
                        print(f"[cancel] failed to interrupt thread: {ex}")
                with _tasks_lock:
                    if task_id in _tasks:
                        _tasks[task_id]["log"] += "\n[提示] 模型状态可能已受损，请点「卸载模型」后重新加载\n"

        if in_downloads:
            with _download_lock:
                dt = _download_tasks.get(task_id, {})
                proc: subprocess.Popen | None = dt.get("_proc")
                if proc and proc.poll() is None:
                    proc.kill()
                    print(f"[cancel] killed download subprocess for {task_id}")
                dt["status"] = "failed"
                dt["error"] = "cancelled"

        self._send_json({"ok": True})

    @staticmethod
    def _safe_remove_dir(path: Path) -> bool:
        """移入回收站，失败则返回 False（不移入回收站就不删）。"""
        try:
            from send2trash import send2trash
            send2trash(str(path))
            print(f"[rm] sent to trash: {path}")
            return True
        except Exception as e:
            print(f"[rm] FAILED to send to trash: {e}")
            return False

    def _delete_task(self):
        """删除任务记录及该次转写的结果目录（results/<ts>/），不动上传的媒体文件。"""
        body = self._read_body()
        task_id = body.get("task_id", "")
        delete_results = body.get("delete_results", True)
        result_dir = None
        with _tasks_lock:
            task = _tasks.get(task_id)
            if task:
                # 从 json_path 取结果目录（done 任务）
                jp = task.get("json_path", "")
                if jp:
                    result_dir = Path(jp).parent
                # failed 任务没有 json_path，从 task_id 推导
                elif task_id.startswith("results-"):
                    result_dir = RESULTS_DIR / task_id[len("results-"):]
            if task_id in _tasks:
                del _tasks[task_id]

        if delete_results and result_dir:
            try:
                result_dir.resolve().relative_to(RESULTS_DIR.resolve())
                if result_dir.exists():
                    if self._safe_remove_dir(result_dir):
                        print(f"[task] deleted result dir: {result_dir}")
                    else:
                        self._send_json({"ok": False, "error": "无法移入回收站，请检查权限"})
                        return
            except ValueError:
                print(f"[task] skip deletion outside results/: {result_dir}")
        self._send_json({"ok": True})

    def _clean_uploads(self):
        """清理 uploads/ 目录下所有上传缓存文件。"""
        uploads_dir = ROOT / "uploads"
        if not uploads_dir.exists():
            self._send_json({"ok": True, "message": "没有需要清理的缓存"})
            return
        count = 0
        errors = 0
        for sub in sorted(uploads_dir.iterdir()):
            if sub.is_dir():
                if self._safe_remove_dir(sub):
                    count += 1
                else:
                    errors += 1
        msg = f"已清理 {count} 个上传缓存目录"
        if errors:
            msg += f"，{errors} 个目录因权限问题未能移入回收站"
        print(f"[clean] cleaned {count}, failed {errors}")
        self._send_json({"ok": True, "message": msg})

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
        ts = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        new_dir = ROOT / "uploads" / ts
        new_dir.mkdir(parents=True, exist_ok=True)
        src = Path(old_path)
        dest = new_dir / src.name
        # 优先硬链接（省空间），失败则复制
        try:
            import os as _os
            if dest.exists():
                _os.remove(str(dest))
            _os.link(str(src), str(dest))
            print(f"[prepare] hardlink: {src} -> {dest}")
        except Exception:
            import shutil as _su
            if dest.exists():
                dest.unlink()
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
                # 尝试从结果目录的 _params.json 恢复
                jp = task.get("json_path", "")
                if jp:
                    params_from_file = _load_task_params(Path(jp).parent)
                    if params_from_file:
                        body = params_from_file
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
        kill = subprocess.run(
            ["taskkill", "/f", "/pid", str(pid)],
            capture_output=True, text=True, timeout=5,
        )
        if kill.returncode != 0:
            # 进程可能已自行退出
            print(f"[editor] taskkill {pid} failed: {kill.stderr.strip()}")
        with _editor_procs_lock:
            _editor_procs[:] = [e for e in _editor_procs if e["pid"] != pid]
        self._send_json({"ok": True})

    # ---- upload ----
    MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024  # 2GB

    def _read_multipart(self) -> tuple[str, bytes] | None:
        """解析 multipart/form-data，返回 (filename, bytes) 或 None。"""
        ct = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ct:
            return None
        boundary = None
        for part in ct.split(";"):
            part = part.strip()
            if part.startswith("boundary="):
                boundary = part[len("boundary="):].strip('"')
                break
        if not boundary:
            return None
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > self.MAX_UPLOAD_BYTES:
            return None
        body = self.rfile.read(length)
        delim = b"--" + boundary.encode()
        chunks = body.split(delim)
        for chunk in chunks:
            if b"filename=" not in chunk:
                continue
            header_end = chunk.find(b"\r\n\r\n")
            if header_end < 0:
                continue
            header_str = chunk[:header_end].decode("utf-8", errors="ignore")
            content = chunk[header_end + 4:].rstrip(b"\r\n-")
            fname = None
            for line in header_str.split("\r\n"):
                if "filename=" in line:
                    idx = line.find('filename="')
                    if idx >= 0:
                        end = line.find('"', idx + 10)
                        fname = line[idx + 10:end]
                    break
            if fname:
                return fname, content
        return None

    def _upload_file(self):
        # P1-7: 先检查 Content-Length 大小，超限直接拒绝
        length = int(self.headers.get("Content-Length", "0"))
        if length > self.MAX_UPLOAD_BYTES:
            self._send_json({"ok": False, "error": f"File too large (max {self.MAX_UPLOAD_BYTES // (1024**3)}GB)"}, 413)
            # 关闭连接，避免浏览器已发出的残余 body 被解析为下一个 HTTP 请求
            self.close_connection = True
            return
        try:
            result = self._read_multipart()
            if result is None:
                self._send_json({"ok": False, "error": "No file in request"}, 400)
                return
            fname, content = result
            # P1-5: 用内容 md5 去重，相同文件复用已有目录
            import hashlib
            content_hash = hashlib.md5(content).hexdigest()[:12]
            upload_dir = ROOT / "uploads" / content_hash
            upload_dir.mkdir(parents=True, exist_ok=True)
            dest = upload_dir / Path(fname).name
            if not dest.exists():
                dest.write_bytes(content)
            mb = dest.stat().st_size / 1024 / 1024
            print(f"[upload] {dest} ({mb:.1f} MB)")
            self._send_json({"ok": True, "path": str(dest), "name": dest.name,
                             "size_mb": round(mb, 1), "dir": str(upload_dir)})
        except Exception as e:
            self._send_json({"ok": False, "error": str(e)}, 500)

    # ---- hotwords ----
    @staticmethod
    def _load_hotwords_file() -> str:
        """读取 hotwords.txt（运行时），不存在则回退到 hotwords.example.txt（模板）。"""
        hw_path = ROOT / "hotwords.txt"
        if hw_path.exists():
            return hw_path.read_text(encoding="utf-8")
        fallback = ROOT / "hotwords.example.txt"
        if fallback.exists():
            return fallback.read_text(encoding="utf-8")
        return ""

    @staticmethod
    def _save_hotwords_file(content: str):
        """覆写 hotwords.txt（原子写入：先写 .tmp，再 rename）。"""
        dest = ROOT / "hotwords.txt"
        tmp = dest.with_suffix(".txt.tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(dest)

    def _get_hotwords(self):
        self._send_json({"ok": True, "content": self._load_hotwords_file()})

    def _save_hotwords(self):
        body = self._read_body()
        content = body.get("content", "")
        self._save_hotwords_file(content)
        self._send_json({"ok": True})

    def log_message(self, fmt: str, *args):
        print(f"[console] {fmt % args}")


def main():
    parser = argparse.ArgumentParser(description="MAW Web Console")
    parser.add_argument("--port", type=int, default=10101, help="Port (default 10101)")
    parser.add_argument("--no-open", action="store_true", help="Don't open browser")
    args = parser.parse_args()
    _sync_results()
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
