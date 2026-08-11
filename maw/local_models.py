"""Local model discovery and preparation for the experimental Launcher mode.

This module deliberately keeps optional local runtimes lazy.  A cloud-only MAW
installation can therefore open the Launcher and report that the local runtime
is unavailable without importing Torch, QwenASR, or FunASR.
"""

from __future__ import annotations

import importlib.util
import os
import threading
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path

from maw.gui_config import ModelConfig
from maw.local_runtime import managed_runtime_status, prepare_model_in_process, prepare_model_in_runtime


LocalModelEvent = Callable[[str], None]
LocalModelProgress = Callable[[Mapping[str, object]], None]


# The upstream loaders do not expose a reliable total download size.  These
# intentionally broad ranges are only a user-facing estimate, not a promise
# about the exact cache footprint of a particular runtime/library version.
_ESTIMATED_CACHE_GIB: dict[str, tuple[float, float]] = {
    "sensevoice-small-local": (1.0, 2.0),
    "fun-asr-nano-local": (5.0, 10.0),
    "qwen3-asr-local": (2.5, 4.5),
    "qwen3-asr-1.7b-local": (5.0, 9.0),
    "funasr-local": (2.0, 4.0),
}


def _funasr_model_uses_vad(model_ref: str) -> bool:
    model_key = model_ref.casefold()
    return "sensevoice" in model_key or "fun-asr-nano" in model_key


_MODEL_WEIGHT_SUFFIXES = frozenset({
    ".bin", ".ckpt", ".gguf", ".model", ".onnx", ".pb", ".pt", ".pth", ".safetensors",
})


@dataclass(frozen=True, slots=True)
class LocalModelStatus:
    model_id: str
    engine: str
    model_ref: str
    status: str
    runtime_available: bool
    installed: bool
    path: str = ""
    detail: str = ""
    required_model_refs: tuple[str, ...] = ()
    runtime_source: str = "current"
    runtime_python: str = ""


def inspect_local_model(
    model: ModelConfig,
    model_path: str | Path = "",
    *,
    model_cache_root: str | Path | None = None,
) -> LocalModelStatus:
    """Return a UI-safe status without loading an optional model runtime."""
    missing_runtime = _missing_runtime_packages(model.requires_runtime)
    managed = managed_runtime_status(model_cache_root)
    runtime_source = "current" if not missing_runtime else ("managed" if managed.ready else "missing")
    runtime_python = managed.python_path if runtime_source == "managed" else ""
    runtime_available = not missing_runtime or managed.ready
    explicit = _normalise_directory(model_path)
    if model.kind != "local":
        return LocalModelStatus(
            model.id,
            model.engine,
            model.model_ref,
            "installed",
            True,
            True,
            str(explicit or ""),
            "",
            model.required_model_refs,
            runtime_source,
            runtime_python,
        )
    if explicit is not None and not explicit.is_dir():
        return LocalModelStatus(
            model.id,
            model.engine,
            model.model_ref,
            "path_invalid",
            runtime_available,
            False,
            str(explicit),
            "模型目录不存在，或所选路径不是文件夹。",
            model.required_model_refs,
            runtime_source,
            runtime_python,
        )
    if not runtime_available:
        return LocalModelStatus(
            model.id,
            model.engine,
            model.model_ref,
            "runtime_missing",
            False,
            False,
            str(explicit or ""),
            _runtime_detail(missing_runtime),
            model.required_model_refs,
            runtime_source,
            runtime_python,
        )

    if explicit is not None:
        mismatch = _explicit_path_mismatch(model, explicit)
        if mismatch:
            return LocalModelStatus(
                model.id,
                model.engine,
                model.model_ref,
                "path_mismatch",
                True,
                False,
                str(explicit),
                mismatch,
                model.required_model_refs,
                runtime_source,
                runtime_python,
            )
        if not _model_directory_has_file(explicit, require_weight=True):
            return LocalModelStatus(
                model.id,
                model.engine,
                model.model_ref,
                "path_invalid",
                True,
                False,
                str(explicit),
                "模型目录为空，或尚未包含有效模型文件。",
                model.required_model_refs,
                runtime_source,
                runtime_python,
            )
        return LocalModelStatus(
            model.id,
            model.engine,
            model.model_ref,
            "installed",
            True,
            True,
            str(explicit),
            "已使用指定的模型目录。",
            model.required_model_refs,
            runtime_source,
            runtime_python,
        )

    paths = _find_model_paths(model, model_cache_root)
    if not paths:
        return LocalModelStatus(
            model.id,
            model.engine,
            model.model_ref,
            "missing",
            True,
            False,
            "",
            "尚未检测到本地模型。",
            model.required_model_refs,
            runtime_source,
            runtime_python,
        )
    main_path, missing_refs = paths
    if missing_refs:
        return LocalModelStatus(
            model.id,
            model.engine,
            model.model_ref,
            "partial",
            True,
            False,
            str(main_path),
            "缺少模型组件：" + "、".join(missing_refs),
            model.required_model_refs,
            runtime_source,
            runtime_python,
        )
    return LocalModelStatus(
        model.id,
        model.engine,
        model.model_ref,
        "installed",
        True,
        True,
        str(main_path),
        "已检测到本地模型。",
        model.required_model_refs,
        runtime_source,
        runtime_python,
    )


def local_model_payload(
    model: ModelConfig,
    model_path: str | Path = "",
    *,
    model_cache_root: str | Path | None = None,
) -> dict[str, object]:
    status = inspect_local_model(model, model_path, model_cache_root=model_cache_root)
    return {
        "status": status.status,
        "runtimeAvailable": status.runtime_available,
        "installed": status.installed,
        "path": status.path,
        "detail": status.detail,
        "runtimeSource": status.runtime_source,
        "runtimePython": status.runtime_python,
        "engine": model.engine,
        "modelRef": model.model_ref,
        "requiredModelRefs": list(status.required_model_refs),
        "canPrepare": status.runtime_available and status.status not in {"path_invalid", "path_mismatch", "installed"},
    }


def prepare_local_model(
    model: ModelConfig,
    *,
    model_path: str | Path = "",
    device: str = "auto",
    forced_aligner: str = "",
    model_cache_root: str | Path | None = None,
    on_event: LocalModelEvent | None = None,
    on_progress: LocalModelProgress | None = None,
    cancel_event: threading.Event | None = None,
) -> LocalModelStatus:
    """Load a local engine once so its upstream runtime prepares model caches.

    QwenASR and FunASR currently download through their own loaders.  Their
    completed cache files are reused on a later attempt, while cancellation
    stops the child loader process without promising byte-level resume for an
    individual temporary file.
    """
    status = inspect_local_model(model, model_path, model_cache_root=model_cache_root)
    if status.status == "path_invalid":
        raise ValueError(status.detail)
    if not status.runtime_available:
        raise RuntimeError(status.detail)
    if model.kind != "local":
        raise ValueError("only local models can be prepared")

    if status.runtime_source == "managed":
        return _prepare_in_managed_runtime(
            model,
            model_path=str(model_path).strip(),
            device=device,
            forced_aligner=forced_aligner,
            model_cache_root=model_cache_root,
            on_event=on_event,
            on_progress=on_progress,
            cancel_event=cancel_event,
        )

    emit = on_event or (lambda _message: None)
    aligner = forced_aligner or (model.required_model_refs[0] if model.required_model_refs else "")
    emit(f"[local] 正在准备 {model.label}；首次运行可能需要下载多个 GB，请保持窗口打开。")
    refs = [model.model_ref, *model.required_model_refs]
    emit(f"[local] 模型组件：{'；'.join(ref for ref in refs if ref)}")
    stop_heartbeat = threading.Event()
    heartbeat = threading.Thread(
        target=_report_prepare_progress,
        args=(model, model_path, model_cache_root, stop_heartbeat, emit, on_progress),
        name="maw-local-model-progress",
        daemon=True,
    )
    started = time.monotonic()
    heartbeat.start()
    try:
        prepare_model_in_process(
            engine=model.engine,
            model=model.model_ref,
            model_path=str(model_path).strip(),
            device=device,
            forced_aligner=aligner,
            vad_model="fsmn-vad" if _funasr_model_uses_vad(model.model_ref) else "",
            trust_remote_code="fun-asr-nano" in model.model_ref.casefold(),
            model_cache_root=model_cache_root,
            on_event=emit,
            cancel_event=cancel_event,
        )
    finally:
        stop_heartbeat.set()
        heartbeat.join(timeout=1.0)
    emit(f"[local] 模型准备调用已返回，用时 {_format_elapsed(time.monotonic() - started)}。正在重新扫描缓存。")
    return inspect_local_model(model, model_path, model_cache_root=model_cache_root)


def _prepare_in_managed_runtime(
    model: ModelConfig,
    *,
    model_path: str,
    device: str,
    forced_aligner: str,
    model_cache_root: str | Path | None,
    on_event: LocalModelEvent | None,
    on_progress: LocalModelProgress | None,
    cancel_event: threading.Event | None,
) -> LocalModelStatus:
    emit = on_event or (lambda _message: None)
    refs = [model.model_ref, *model.required_model_refs]
    emit(f"[local] 正在准备 {model.label}；使用 MAW 独立运行环境。")
    emit(f"[local] 模型组件：{'；'.join(ref for ref in refs if ref)}")
    stop_heartbeat = threading.Event()
    heartbeat = threading.Thread(
        target=_report_prepare_progress,
        args=(model, model_path, model_cache_root, stop_heartbeat, emit, on_progress),
        name="maw-local-model-progress",
        daemon=True,
    )
    started = time.monotonic()
    heartbeat.start()
    try:
        prepare_model_in_runtime(
            engine=model.engine,
            model=model.model_ref,
            model_path=model_path,
            device=device,
            forced_aligner=forced_aligner or (model.required_model_refs[0] if model.required_model_refs else ""),
            vad_model="fsmn-vad" if _funasr_model_uses_vad(model.model_ref) else "",
            trust_remote_code="fun-asr-nano" in model.model_ref.casefold(),
            model_cache_root=model_cache_root,
            on_event=emit,
            cancel_event=cancel_event,
        )
    finally:
        stop_heartbeat.set()
        heartbeat.join(timeout=1.0)
    emit(f"[local] 模型准备调用已返回，用时 {_format_elapsed(time.monotonic() - started)}。正在重新扫描缓存。")
    return inspect_local_model(model, model_path, model_cache_root=model_cache_root)


def _report_prepare_progress(
    model: ModelConfig,
    model_path: str | Path,
    model_cache_root: str | Path | None,
    stop_event: threading.Event,
    on_event: LocalModelEvent,
    on_progress: LocalModelProgress | None = None,
) -> None:
    started = time.monotonic()
    paths = _model_watch_paths(model, model_path, model_cache_root)
    last_size = -1
    last_files = -1
    while not stop_event.is_set():
        file_count, total_size = _cache_snapshot(paths)
        elapsed = _format_elapsed(time.monotonic() - started)
        payload = _prepare_progress_payload(model, elapsed, file_count, total_size)
        message = str(payload["message"])
        if file_count == last_files and total_size == last_size:
            payload = dict(payload)
            payload["message"] = f"[local] 仍在准备……已等待 {elapsed}；上游模型加载器尚未报告新的缓存写入。"
            if payload.get("estimatedMinBytes"):
                payload["message"] += (
                    f" 预计总量约 {_format_bytes(int(payload['estimatedMinBytes']))}–"
                    f"{_format_bytes(int(payload['estimatedMaxBytes']))}，"
                    f"估算进度约 {_format_percent(float(payload['percentMin']))}–"
                    f"{_format_percent(float(payload['percentMax']))}。"
                )
            message = str(payload["message"])
        else:
            last_files = file_count
            last_size = total_size
        if on_progress is not None:
            on_progress(payload)
        else:
            on_event(message)
        if stop_event.wait(5.0):
            return


def _prepare_progress_payload(
    model: ModelConfig,
    elapsed: str,
    file_count: int,
    total_size: int,
) -> dict[str, object]:
    payload: dict[str, object] = {
        "message": (
            f"[local] 仍在准备……已等待 {elapsed}；缓存已写入 "
            f"{file_count} 个文件 / {_format_bytes(total_size)}。"
        ),
        "elapsed": elapsed,
        "fileCount": file_count,
        "currentBytes": total_size,
    }
    estimate = _estimated_cache_bytes(model)
    if estimate is None:
        return payload
    minimum, maximum = estimate
    percent_min = min(99.0, total_size / maximum * 100) if maximum else 0.0
    percent_max = min(99.0, total_size / minimum * 100) if minimum else 0.0
    payload.update({
        "estimatedMinBytes": minimum,
        "estimatedMaxBytes": maximum,
        "percentMin": percent_min,
        "percentMax": percent_max,
        "percent": (percent_min + percent_max) / 2,
    })
    payload["message"] = (
        f"[local] 仍在准备……已等待 {elapsed}；缓存已写入 "
        f"{file_count} 个文件 / {_format_bytes(total_size)}；预计总量约 "
        f"{_format_bytes(minimum)}–{_format_bytes(maximum)}，估算进度约 "
        f"{_format_percent(percent_min)}–{_format_percent(percent_max)}。"
    )
    return payload


def _estimated_cache_bytes(model: ModelConfig) -> tuple[int, int] | None:
    estimate = _ESTIMATED_CACHE_GIB.get(model.id)
    if estimate is None:
        return None
    gib = 1024**3
    return int(estimate[0] * gib), int(estimate[1] * gib)


def _model_watch_paths(
    model: ModelConfig,
    model_path: str | Path,
    model_cache_root: str | Path | None = None,
) -> list[Path]:
    explicit = _normalise_directory(model_path)
    paths: list[Path] = [explicit] if explicit is not None else []
    if model.engine in {"qwen-asr", "qwen", "qwen3-asr"}:
        for ref in (model.model_ref, *model.required_model_refs):
            paths.extend(_huggingface_repo_paths(ref, model_cache_root))
    elif model.engine in {"funasr", "fun-asr"}:
        for ref in (model.model_ref, *model.cache_refs):
            parts = [part for part in ref.split("/") if part]
            if not parts:
                continue
            for root in _modelscope_cache_roots(model_cache_root):
                paths.extend(_modelscope_repo_candidates(root, parts))
    return _unique_paths(paths)


def _cache_snapshot(paths: Iterable[Path]) -> tuple[int, int]:
    file_count = 0
    total_size = 0
    pending = list(paths)
    visited: set[str] = set()
    while pending:
        path = pending.pop()
        try:
            key = str(path.resolve(strict=False)).casefold()
            if key in visited:
                continue
            visited.add(key)
            if path.is_file():
                file_count += 1
                total_size += path.stat().st_size
                continue
            if not path.is_dir():
                continue
            pending.extend(child for child in path.iterdir() if child.is_dir() or child.is_file())
        except OSError:
            continue
    return file_count, total_size


def _format_elapsed(seconds: float) -> str:
    total = max(0, int(seconds))
    minutes, seconds = divmod(total, 60)
    hours, minutes = divmod(minutes, 60)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d}" if hours else f"{minutes:02d}:{seconds:02d}"


def _format_bytes(value: int) -> str:
    if value >= 1024**3:
        return f"{value / 1024**3:.2f} GB"
    if value >= 1024**2:
        return f"{value / 1024**2:.1f} MB"
    if value >= 1024:
        return f"{value / 1024:.1f} KB"
    return f"{value} B"


def _format_percent(value: float) -> str:
    return f"{value:.0f}%"


def _missing_runtime_packages(packages: Iterable[str]) -> tuple[str, ...]:
    missing: list[str] = []
    for package in packages:
        try:
            if importlib.util.find_spec(package) is None:
                missing.append(package)
        except (ImportError, ModuleNotFoundError, ValueError):
            missing.append(package)
    return tuple(missing)


def _runtime_available(packages: Iterable[str]) -> bool:
    return not _missing_runtime_packages(packages)


def _runtime_detail(packages: Iterable[str]) -> str:
    missing = ", ".join(packages)
    return f"缺少本地模型依赖 {missing}；请先点击“安装本地模型支持”。"


def _normalise_directory(value: str | Path) -> Path | None:
    text = str(value or "").strip()
    if not text:
        return None
    return Path(text).expanduser().resolve(strict=False)


def _explicit_path_mismatch(model: ModelConfig, path: Path) -> str:
    """Reject an obvious model-family mix-up without blocking custom folders."""
    value = str(path).casefold().replace("_", "-")
    if model.engine in {"qwen-asr", "qwen", "qwen3-asr"}:
        if "funasr" in value or "paraformer" in value:
            return "当前目录看起来属于 FunASR / Paraformer，不是 Qwen3-ASR。"
    if model.engine in {"funasr", "fun-asr"}:
        if "qwen3-asr" in value or "forcedaligner" in value or "forced-aligner" in value:
            return "当前目录看起来属于 Qwen3-ASR，不是 FunASR / Paraformer。"
    return ""


def _find_model_paths(
    model: ModelConfig,
    model_cache_root: str | Path | None = None,
) -> tuple[Path, list[str]] | None:
    if model.engine in {"qwen-asr", "qwen", "qwen3-asr"}:
        main = _find_huggingface_model(model.model_ref, model_cache_root)
        if main is None:
            return None
        missing = [
            ref for ref in model.required_model_refs
            if _find_huggingface_model(ref, model_cache_root) is None
        ]
        return main, missing
    if model.engine in {"funasr", "fun-asr"}:
        for ref in (model.model_ref, *model.cache_refs):
            main = _find_modelscope_model(ref, model_cache_root)
            if main is not None:
                return main, []
        return None
    return None


def _find_huggingface_model(
    model_ref: str,
    model_cache_root: str | Path | None = None,
) -> Path | None:
    if not model_ref or "/" not in model_ref:
        return None
    for repo in _huggingface_repo_paths(model_ref, model_cache_root):
        snapshot_root = repo / "snapshots"
        candidates = (
            [path for path in snapshot_root.iterdir() if path.is_dir() and _model_directory_has_file(path, require_weight=True)]
            if snapshot_root.is_dir()
            else []
        )
        if candidates:
            return max(candidates, key=lambda path: path.stat().st_mtime)
        if repo.is_dir() and _model_directory_has_file(repo, require_weight=True):
            return repo
    return None


def _huggingface_repo_paths(
    model_ref: str,
    model_cache_root: str | Path | None = None,
) -> list[Path]:
    if not model_ref or "/" not in model_ref:
        return []
    owner, name = model_ref.split("/", 1)
    repo_dir_name = f"models--{owner}--{name}"
    return _unique_paths(root / repo_dir_name for root in _huggingface_cache_roots(model_cache_root))


def _find_modelscope_model(
    model_ref: str,
    model_cache_root: str | Path | None = None,
) -> Path | None:
    model_name = model_ref.strip()
    if not model_name:
        return None
    parts = [part for part in model_name.split("/") if part]
    for root in _modelscope_cache_roots(model_cache_root):
        for candidate in _modelscope_repo_candidates(root, parts):
            resolved = _modelscope_snapshot_dir(candidate)
            if resolved is not None:
                return resolved
        for parent in (root, root / "models", root / "hub"):
            if not parent.is_dir():
                continue
            try:
                for candidate in parent.iterdir():
                    if candidate.is_dir() and model_name.lower() in candidate.name.lower():
                        resolved = _modelscope_snapshot_dir(candidate)
                        if resolved is not None:
                            return resolved
            except OSError:
                continue
    return None


def _modelscope_repo_candidates(root: Path, parts: list[str]) -> list[Path]:
    """Cover both the legacy ``<owner>/<name>`` and the hub-style ``<owner>--<name>`` layouts."""
    candidates = [root.joinpath(*parts), root / "models" / Path(*parts), root / "hub" / Path(*parts)]
    if len(parts) == 2:
        joined = "--".join(parts)
        candidates.extend([root / joined, root / "models" / joined, root / "hub" / joined])
    if len(parts) == 1:
        candidates.extend([root / "iic" / parts[0], root / "damo" / parts[0]])
    return candidates


def _modelscope_snapshot_dir(candidate: Path) -> Path | None:
    """Return the newest snapshot of a hub-style ModelScope repo, else the repo dir itself."""
    if not candidate.is_dir():
        return None
    snapshots = candidate / "snapshots"
    if snapshots.is_dir():
        revisions = [
            path for path in snapshots.iterdir()
            if path.is_dir() and _model_directory_has_file(path, require_weight=True)
        ]
        if revisions:
            return max(revisions, key=lambda path: path.stat().st_mtime)
    return candidate if _model_directory_has_file(candidate, require_weight=True) else None


def _model_directory_has_file(path: Path, *, require_weight: bool = False) -> bool:
    """Return whether a model directory contains a non-empty usable file."""
    pending = [path]
    visited: set[str] = set()
    while pending:
        current = pending.pop()
        try:
            key = str(current.resolve(strict=False)).casefold()
            if key in visited:
                continue
            visited.add(key)
            children = list(current.iterdir())
        except OSError:
            continue
        for child in children:
            try:
                if child.is_file():
                    if child.stat().st_size <= 0:
                        continue
                    if not require_weight or child.suffix.casefold() in _MODEL_WEIGHT_SUFFIXES:
                        return True
                elif child.is_dir():
                    pending.append(child)
            except OSError:
                continue
    return False


def _huggingface_cache_roots(model_cache_root: str | Path | None = None) -> list[Path]:
    env = os.environ
    roots: list[Path] = []
    for key in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        if env.get(key):
            roots.append(Path(env[key]).expanduser())
    if env.get("HF_HOME"):
        roots.append(Path(env["HF_HOME"]).expanduser() / "hub")
    managed_root = managed_runtime_status(model_cache_root).model_cache_path
    if managed_root:
        roots.append(Path(managed_root) / "huggingface" / "hub")
    roots.append(Path.home() / ".cache" / "huggingface" / "hub")
    return _unique_paths(roots)


def _modelscope_cache_roots(model_cache_root: str | Path | None = None) -> list[Path]:
    env = os.environ
    roots: list[Path] = []
    for key in ("MODELSCOPE_CACHE", "MODELSCOPE_HOME"):
        if env.get(key):
            roots.append(Path(env[key]).expanduser())
    managed_root = managed_runtime_status(model_cache_root).model_cache_path
    if managed_root:
        roots.append(Path(managed_root) / "modelscope")
    roots.append(Path.home() / ".cache" / "modelscope" / "hub")
    return _unique_paths(roots)


def _unique_paths(paths: Iterable[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        resolved = str(path.resolve(strict=False)).casefold()
        if resolved not in seen:
            seen.add(resolved)
            result.append(path)
    return result


__all__ = ["LocalModelStatus", "inspect_local_model", "local_model_payload", "prepare_local_model"]
