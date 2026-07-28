"""模型下载模块 —— 从 ModelScope / HuggingFace 下载 ASR 模型权重。

供 Launcher GUI 调用。
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODELS_DIR = ROOT / "models"

DOWNLOADABLE_MODELS: dict[str, dict] = {
    "qwen-0.6B": {
        "label": "Qwen3-ASR-0.6B",
        "model_id": "Qwen/Qwen3-ASR-0.6B",
        "local_dir": str(MODELS_DIR / "Qwen3-ASR-0.6B"),
        "source": "modelscope",
    },
    "qwen-1.7B": {
        "label": "Qwen3-ASR-1.7B",
        "model_id": "Qwen/Qwen3-ASR-1.7B",
        "local_dir": str(MODELS_DIR / "Qwen3-ASR-1.7B"),
        "source": "modelscope",
    },
    "whisper": {
        "label": "faster-whisper-large-v3",
        "model_id": "Systran/faster-whisper-large-v3",
        "local_dir": str(MODELS_DIR / "faster-whisper-large-v3"),
        "source": "huggingface",
    },
    "aligner": {
        "label": "Qwen3-ForcedAligner-0.6B",
        "model_id": "Qwen/Qwen3-ForcedAligner-0.6B",
        "local_dir": str(MODELS_DIR / "Qwen3-ForcedAligner-0.6B"),
        "source": "modelscope",
    },
}


# ===== 下载状态缓存（P1-6） =====

_model_exists_cache: dict[str, bool] = {}
_download_lock = threading.Lock()
MIN_SIZE = 100 * 1024 * 1024  # 100MB
MARKERS = ["config.json", "model.bin", "model.onnx", "model.safetensors"]


# ===== 下载进程管理 =====

_download_procs: dict[str, subprocess.Popen] = {}
_download_progress: dict[str, str] = {}
_download_cancel: dict[str, threading.Event] = {}


def is_model_downloaded(key: str) -> bool:
    """检查模型是否已下载（带缓存，P1-6）。检测不完全/损坏的下载。"""
    if key in _model_exists_cache:
        return _model_exists_cache[key]
    info = DOWNLOADABLE_MODELS.get(key)
    if not info:
        return False
    dest = Path(info["local_dir"])
    if not dest.exists():
        return False

    # 有本地清单 → 逐文件校验（覆盖手动删除/修改）
    manifest_path = dest / "manifest.json"
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for rel_path, expected_size in manifest.items():
                fp = dest / rel_path
                if not fp.exists():
                    _model_exists_cache[key] = False
                    return False
                if expected_size > 0 and fp.stat().st_size != expected_size:
                    _model_exists_cache[key] = False
                    return False
            _model_exists_cache[key] = True
            return True
        except (json.JSONDecodeError, OSError):
            pass

    # 有完成标记但无清单（旧版）→ 检查总大小
    if (dest / ".download_ok").exists():
        total_size = sum(f.stat().st_size for f in dest.rglob("*") if f.is_file() and f.name != ".download_ok")
        if total_size < MIN_SIZE:
            _model_exists_cache[key] = False
            return False
        for m in MARKERS:
            p = dest / m
            if p.exists() and p.stat().st_size >= 1024:
                _model_exists_cache[key] = True
                return True
        for m in MARKERS:
            for p in dest.rglob(m):
                if p.stat().st_size >= 1024:
                    _model_exists_cache[key] = True
                    return True
        _model_exists_cache[key] = False
        return False

    # 无任何标记 → 从源仓库拉取清单校验（覆盖首次下载中断的情况）
    try:
        source_manifest = _fetch_source_manifest(info)
        if source_manifest is not None:
            ok = True
            for rel_path, expected_size in source_manifest.items():
                fp = dest / rel_path
                if not fp.exists():
                    ok = False
                    break
                if fp.stat().st_size != expected_size and expected_size > 0:
                    ok = False
                    break
            _model_exists_cache[key] = ok
            return ok
    except Exception:
        pass

    # 兜底：检查是否有 > 100MB 的完整文件
    for m in MARKERS:
        p = dest / m
        if p.exists() and p.stat().st_size >= MIN_SIZE:
            _model_exists_cache[key] = True
            return True
    for m in MARKERS:
        for p in dest.rglob(m):
            if p.stat().st_size >= MIN_SIZE:
                _model_exists_cache[key] = True
                return True
    _model_exists_cache[key] = False
    return False


def _fetch_source_manifest(info: dict) -> dict[str, int] | None:
    """从源仓库 API 拉取文件清单 {相对路径: 字节数}。失败返回 None。"""
    import requests
    source = info.get("source", "modelscope")
    model_id = info["model_id"]

    try:
        if source == "huggingface":
            url = f"https://huggingface.co/api/models/{model_id}"
            resp = requests.get(url, timeout=10)
            resp.raise_for_status()
            data = resp.json()
            siblings = data.get("siblings", [])
            manifest = {}
            for sib in siblings:
                rpath = sib.get("rfilename", "")
                size = sib.get("size", 0)
                if rpath:
                    # HF API 有时不返回 size（LFS 文件），存 0 表示只检查存在性
                    manifest[rpath] = size
            return manifest if manifest else None
        elif source == "modelscope":
            url = f"https://www.modelscope.cn/api/v1/models/{model_id}/repo/files?Revision=master"
            resp = requests.get(url, timeout=10)
            if resp.ok:
                data = resp.json()
                files_list = (data.get("Data") or {}).get("Files") or []
                manifest = {}
                for item in files_list if isinstance(files_list, list) else []:
                    path = item.get("Path", "")
                    size = item.get("Size", 0)
                    if path and size > 0:
                        manifest[path] = size
                return manifest if manifest else None
        return None
    except Exception:
        return None


def refresh_manifest(key: str) -> dict:
    """从源仓库拉取文件清单并保存到本地。返回 {"ok": bool, "count": int, "error": str}。"""
    info = DOWNLOADABLE_MODELS.get(key)
    if not info:
        return {"ok": False, "error": f"Unknown model: {key}"}
    dest = Path(info["local_dir"])
    if not dest.exists():
        dest.mkdir(parents=True, exist_ok=True)
    try:
        manifest = _fetch_source_manifest(info)
        if manifest is None:
            return {"ok": False, "error": "Failed to fetch manifest from source"}
        (dest / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        invalidate_cache(key)
        return {"ok": True, "count": len(manifest)}
    except Exception as e:
        return {"ok": False, "error": str(e)}


def invalidate_cache(key: str | None = None) -> None:
    """清除缓存（下载完成后调用）。"""
    if key:
        _model_exists_cache.pop(key, None)
    else:
        _model_exists_cache.clear()


def start_download(key: str, progress_cb=None) -> threading.Event:
    """启动模型下载（子进程，可取消）。返回一个 Event，下载完成时被 set。"""
    if key in _download_procs:
        proc = _download_procs[key]
        if proc and proc.poll() is None:
            raise RuntimeError(f"Download for {key} is already running")

    info = DOWNLOADABLE_MODELS.get(key)
    if not info:
        raise ValueError(f"Unknown model key: {key}")

    dest = Path(info["local_dir"])
    dest.mkdir(parents=True, exist_ok=True)

    cancel_ev = threading.Event()
    done_ev = threading.Event()
    with _download_lock:
        _download_cancel[key] = cancel_ev
        # 写入临时 info 文件供子进程读取（在锁内，避免并发覆盖）
        info_path = ROOT / ".download_info.json"
        info_path.write_text(json.dumps(info), encoding="utf-8")

    worker = Path(__file__).parent / "_download_worker.py"
    if not worker.exists():
        # 从当前模块的内容内联执行
        _download_in_process(key, info, progress_cb)
        return done_ev

    proc = subprocess.Popen(
        [sys.executable, str(worker), key, str(info_path)],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    with _download_lock:
        _download_procs[key] = proc
        _download_progress[key] = "starting..."

    # 轮询进度
    def _poll():
        while True:
            line = proc.stdout.readline() if proc.stdout else ""
            if not line and proc.poll() is not None:
                break
            if line:
                line = line.strip()
                with _download_lock:
                    _download_progress[key] = line
                if progress_cb:
                    progress_cb(line)
        with _download_lock:
            if proc.returncode == 0:
                _download_progress[key] = "completed"
                invalidate_cache(key)
                done_ev.set()
            else:
                _download_progress[key] = "failed"
                done_ev.set()  # 通知调用方下载失败
            _download_procs.pop(key, None)
        with _download_lock:
            _download_cancel.pop(key, None)

    t = threading.Thread(target=_poll, daemon=True)
    t.start()
    return done_ev


def _download_in_process(key: str, info: dict, progress_cb=None) -> None:
    """如果没有独立的 _download_worker.py，在进程内下载。"""
    dest = Path(info["local_dir"])
    dest.mkdir(parents=True, exist_ok=True)
    source = info.get("source", "modelscope")

    def log(msg: str):
        with _download_lock:
            _download_progress[key] = msg
        if progress_cb:
            progress_cb(msg)

    def check_cancel():
        if _download_cancel.get(key, threading.Event()).is_set():
            raise RuntimeError("Cancelled by user")

    try:
        check_cancel()
        if source == "modelscope":
            from modelscope.hub.snapshot_download import snapshot_download

            # 用 callback 估算进度
            total_files = 0
            downloaded_files = 0

            def ms_callback(file_path: str, current: int, total: int):
                nonlocal total_files, downloaded_files
                if total > total_files:
                    total_files = total
                downloaded_files = current
                pct = int(downloaded_files / max(total_files, 1) * 100) if total_files else 0
                log(f"downloading... {pct}%")

            log("downloading from ModelScope...")
            kwargs = dict(model_id=info["model_id"], cache_dir=str(dest))
            try:
                snapshot_download(**kwargs, callback=ms_callback)
            except TypeError:
                # 旧版 snapshot_download 不支持 callback 或签名不匹配
                log("downloading... (no progress info available)")
                snapshot_download(**kwargs)
                log("downloading... 100%")

            # 文件迁移
            for p in Path(dest).rglob("config.json"):
                src_dir = p.parent
                if src_dir != dest:
                    check_cancel()
                    for f in src_dir.iterdir():
                        shutil.copy2(str(f), str(dest / f.name))
                    log("moved files")
                    break

            # 清理嵌套缓存（P0-5: send2trash 优先，失败则提示手动清理）
            check_cancel()
            for sub in list(dest.iterdir()):
                if sub.is_dir() and not sub.name.startswith("."):
                    try:
                        from send2trash import send2trash
                        send2trash(str(sub))
                        log(f"cleaned {sub.name}")
                    except Exception:
                        log(f"WARNING: 无法删除临时目录 {sub.name}，请手动清理")
        else:
            os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"
            from huggingface_hub import snapshot_download
            log("downloading from HuggingFace...")
            snapshot_download(
                repo_id=info["model_id"],
                local_dir=str(dest),
                resume_download=True,
            )
        log("completed")
        try:
            # 写入文件清单
            manifest = {}
            for f in dest.rglob("*"):
                if f.is_file() and f.name not in (".download_ok", "manifest.json"):
                    manifest[str(f.relative_to(dest))] = f.stat().st_size
            (dest / "manifest.json").write_text(
                json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            (dest / ".download_ok").write_text("ok", encoding="utf-8")
        except Exception:
            pass
        invalidate_cache(key)
        try:
            done_ev.set()
        except NameError:
            pass
    except Exception as e:
        log(f"FAILED: {e}")
        raise
    finally:
        with _download_lock:
            _download_cancel.pop(key, None)


def cancel_download(key: str) -> None:
    """取消正在进行的下载。"""
    with _download_lock:
        proc = _download_procs.get(key)
        if proc and proc.poll() is None:
            proc.kill()
            _download_procs.pop(key, None)
        _download_progress.pop(key, None)
        ev = _download_cancel.pop(key, None)
        if ev:
            ev.set()


def get_download_progress(key: str) -> str:
    """获取下载进度状态。"""
    with _download_lock:
        return _download_progress.get(key, "")


def get_download_status(key: str) -> dict:
    """获取模型下载状态（含是否已下载）。"""
    return {
        "downloaded": is_model_downloaded(key),
        "progress": get_download_progress(key),
        "running": key in _download_procs,
    }
