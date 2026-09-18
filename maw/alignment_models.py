"""Optional local alignment-model registry, discovery, and preparation.

The alignment models intentionally live outside the ordinary ASR model list.
They are shared components: Qwen3-ASR can use the same Forced Aligner that is
also used for MOSS, an imported SRT, or a project whose item timings were lost.
Keeping the registry here avoids coupling the post-processing toolbox to one
particular transcription provider.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import tarfile
import tempfile
import threading
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from maw.app_paths import default_app_data_root


def resolve_model_cache_root(configured: str | Path | None = None) -> Path:
    """Resolve the shared model cache without importing the host GUI runtime.

    Alignment workers are copied into the managed local runtime as a small
    ``maw`` package.  Keeping this path helper dependency-free lets those
    workers use the same cache even though the host-only RuntimeSpec modules
    are not part of the managed environment.
    """
    override = str(configured or "").strip() or os.environ.get("MAW_MODEL_CACHE_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False)
    return default_app_data_root() / "model-cache"


def model_cache_environment(model_cache_root: str | Path | None = None) -> dict[str, str]:
    root = resolve_model_cache_root(model_cache_root)
    huggingface = root / "huggingface"
    modelscope = root / "modelscope"
    return {
        "MAW_MODEL_CACHE_ROOT": str(root),
        "HF_HOME": str(huggingface),
        "HF_HUB_CACHE": str(huggingface / "hub"),
        "HUGGINGFACE_HUB_CACHE": str(huggingface / "hub"),
        "MODELSCOPE_CACHE": str(modelscope),
        "MODELSCOPE_HOME": str(modelscope),
    }


QWEN_FORCED_ALIGNER_MODEL_ID = "qwen3-forced-aligner-0.6b"
QWEN_FORCED_ALIGNER_REF = "Qwen/Qwen3-ForcedAligner-0.6B"
FIRERED_ASR2_CTC_MODEL_ID = "firered-asr2-ctc"
FIRERED_ASR2_CTC_REF = FIRERED_ASR2_CTC_MODEL_ID
FIRERED_ASR2_CTC_ARCHIVE = "sherpa-onnx-fire-red-asr2-ctc-zh_en-int8-2026-02-25.tar.bz2"
FIRERED_ASR2_CTC_DIRECTORY = FIRERED_ASR2_CTC_ARCHIVE.removesuffix(".tar.bz2")
FIRERED_ASR2_CTC_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/"
    f"{FIRERED_ASR2_CTC_ARCHIVE}"
)
FIRERED_ASR2_CTC_MODEL_FILE = "model.int8.onnx"
FIRERED_ASR2_CTC_TOKENS_FILE = "tokens.txt"


AlignmentEvent = Callable[[str], None]
AlignmentProgress = Callable[[Mapping[str, object]], None]


@dataclass(frozen=True, slots=True)
class AlignmentModelConfig:
    id: str
    label: str
    engine: str
    model_ref: str
    runtime_packages: tuple[str, ...]
    note: str
    estimated_size: str
    languages: tuple[str, ...]
    device_support: str = ""
    resource_level: str = ""
    supports_word_timestamps: bool = True


@dataclass(frozen=True, slots=True)
class AlignmentModelStatus:
    model_id: str
    engine: str
    model_ref: str
    status: str
    runtime_available: bool
    installed: bool
    path: str = ""
    detail: str = ""
    runtime_source: str = "current"
    runtime_python: str = ""
    installed_size: str = ""

    def to_payload(self) -> dict[str, object]:
        return {
            "id": self.model_id,
            "modelId": self.model_id,
            "engine": self.engine,
            "modelRef": self.model_ref,
            "status": self.status,
            "runtimeAvailable": self.runtime_available,
            "installed": self.installed,
            "path": self.path,
            "detail": self.detail,
            "installedSize": self.installed_size,
            "runtimeSource": self.runtime_source,
            "runtimePython": self.runtime_python,
        }


ALIGNMENT_MODELS: tuple[AlignmentModelConfig, ...] = (
    AlignmentModelConfig(
        id=QWEN_FORCED_ALIGNER_MODEL_ID,
        label="Qwen3-ForcedAligner 0.6B",
        engine="qwen",
        model_ref=QWEN_FORCED_ALIGNER_REF,
        runtime_packages=("qwen_asr", "torch"),
        note="文本 + 音频输入，输出字词级时间码；与 Qwen Local 共用 Hugging Face 缓存。",
        estimated_size="1.7G+",
        languages=("zh", "yue", "en", "ja", "ko", "fr", "de", "es"),
        device_support="gpu_preferred",
        resource_level="medium",
    ),
    AlignmentModelConfig(
        id=FIRERED_ASR2_CTC_MODEL_ID,
        label="FireRedASR2-CTC（CPU）",
        engine="firered",
        model_ref=FIRERED_ASR2_CTC_REF,
        runtime_packages=("sherpa_onnx", "soundfile"),
        note="sherpa-onnx int8 CTC；可独立运行，也可将识别 token 与已有稿件对齐。",
        estimated_size="0.9G",
        languages=("zh", "en"),
        device_support="cpu",
        resource_level="low",
    ),
)


def alignment_model_by_id(model_id: str) -> AlignmentModelConfig:
    normalized = normalize_alignment_model_id(model_id)
    for model in ALIGNMENT_MODELS:
        if model.id == normalized:
            return model
    raise ValueError(f"未知的对齐模型：{model_id}")


def normalize_alignment_model_id(model_id: str) -> str:
    value = str(model_id or "").strip().casefold().replace("_", "-")
    aliases = {
        "": "",
        "none": "",
        "off": "",
        "qwen": QWEN_FORCED_ALIGNER_MODEL_ID,
        "qwen3-forced-aligner": QWEN_FORCED_ALIGNER_MODEL_ID,
        "qwen3-forced-aligner-0.6b": QWEN_FORCED_ALIGNER_MODEL_ID,
        QWEN_FORCED_ALIGNER_REF.casefold(): QWEN_FORCED_ALIGNER_MODEL_ID,
        "fire-red": FIRERED_ASR2_CTC_MODEL_ID,
        "firered": FIRERED_ASR2_CTC_MODEL_ID,
        "firered-asr2": FIRERED_ASR2_CTC_MODEL_ID,
        "firered-asr2-ctc": FIRERED_ASR2_CTC_MODEL_ID,
    }
    return aliases.get(value, value)


def alignment_models_payload(
    model_cache_root: str | Path | None = None,
    *,
    runtime_available: bool | None = None,
    runtime_source: str = "current",
    runtime_python: str = "",
) -> list[dict[str, object]]:
    payload: list[dict[str, object]] = []
    for model in ALIGNMENT_MODELS:
        item: dict[str, object] = {
            "id": model.id,
            "modelId": model.id,
            "engine": model.engine,
            "modelRef": model.model_ref,
            "label": model.label,
            "note": model.note,
            "estimatedSize": model.estimated_size,
            "deviceSupport": model.device_support,
            "resourceLevel": model.resource_level,
            "supportsWordTimestamps": model.supports_word_timestamps,
            "languages": list(model.languages),
            "runtimePackages": list(model.runtime_packages),
        }
        item.update(
            inspect_alignment_model(
                model.id,
                model_cache_root=model_cache_root,
                runtime_available=runtime_available,
                runtime_source=runtime_source,
                runtime_python=runtime_python,
            ).to_payload()
        )
        payload.append(item)
    return payload


def inspect_alignment_model(
    model_id: str,
    model_path: str | Path = "",
    *,
    model_cache_root: str | Path | None = None,
    runtime_available: bool | None = None,
    runtime_source: str = "current",
    runtime_python: str = "",
) -> AlignmentModelStatus:
    model = alignment_model_by_id(model_id)
    if runtime_available is None:
        runtime_available = not _missing_runtime_packages(model.runtime_packages)
    explicit = _normalise_path(model_path)
    if explicit is not None and not explicit.is_dir():
        return _status(model, "path_invalid", runtime_available, False, explicit, "所选对齐模型目录不存在，或不是文件夹。", runtime_source, runtime_python)
    if not runtime_available:
        return _status(model, "runtime_missing", False, False, explicit, f"缺少对齐模型依赖：{', '.join(model.runtime_packages)}。请先安装本地模型支持。", runtime_source, runtime_python)
    if explicit is not None:
        if not _model_files_present(model, explicit):
            return _status(model, "path_invalid", True, False, explicit, "对齐模型目录缺少有效模型文件。", runtime_source, runtime_python)
        return _status(model, "installed", True, True, explicit, "已使用指定的对齐模型目录。", runtime_source, runtime_python)
    found = find_alignment_model_path(model.id, model_cache_root=model_cache_root)
    if found is None:
        return _status(model, "missing", True, False, None, "尚未检测到对齐模型；可点击下载。", runtime_source, runtime_python)
    return _status(model, "installed", True, True, found, "已检测到对齐模型。", runtime_source, runtime_python)


def find_alignment_model_path(
    model_id: str,
    *,
    model_cache_root: str | Path | None = None,
) -> Path | None:
    model = alignment_model_by_id(model_id)
    if model.engine == "qwen":
        return _find_qwen_model(model.model_ref, model_cache_root)
    root = resolve_model_cache_root(model_cache_root) / "aligners"
    candidates = (
        root / FIRERED_ASR2_CTC_DIRECTORY,
        root / FIRERED_ASR2_CTC_MODEL_ID,
        resolve_model_cache_root(model_cache_root) / FIRERED_ASR2_CTC_DIRECTORY,
    )
    for candidate in candidates:
        if _model_files_present(model, candidate):
            return candidate.resolve(strict=False)
    return None


def resolve_alignment_model_path(
    model_id: str,
    model_path: str | Path = "",
    *,
    model_cache_root: str | Path | None = None,
) -> Path | str:
    model = alignment_model_by_id(model_id)
    explicit = _normalise_path(model_path)
    if explicit is not None:
        if not _model_files_present(model, explicit):
            raise FileNotFoundError(f"对齐模型目录缺少有效模型文件：{explicit}")
        return explicit
    found = find_alignment_model_path(model.id, model_cache_root=model_cache_root)
    if found is not None:
        return found
    if model.engine == "qwen":
        # Qwen's loader can download on demand. The cache environment is still
        # supplied by the caller, so this path reuses the normal QwenLocal cache.
        return model.model_ref
    raise FileNotFoundError(f"尚未下载对齐模型：{model.label}")


def prepare_alignment_model(
    model_id: str,
    *,
    model_path: str | Path = "",
    model_cache_root: str | Path | None = None,
    on_event: AlignmentEvent | None = None,
    on_progress: AlignmentProgress | None = None,
    cancel_event: threading.Event | None = None,
) -> AlignmentModelStatus:
    """Download one alignment model and return its freshly scanned status."""
    model = alignment_model_by_id(model_id)
    status = inspect_alignment_model(model.id, model_path, model_cache_root=model_cache_root)
    if status.status == "installed":
        return status
    if status.status in {"runtime_missing", "path_invalid"}:
        raise RuntimeError(status.detail)
    emit = on_event or (lambda _message: None)
    stop = cancel_event or threading.Event()
    emit(f"[aligner] 正在准备 {model.label}（{model.estimated_size}）……")
    if model.engine == "qwen":
        _download_qwen(model.model_ref, model_cache_root, emit, on_progress, stop)
    else:
        _download_firered(model_cache_root, emit, on_progress, stop)
    result = inspect_alignment_model(model.id, model_path, model_cache_root=model_cache_root)
    if not result.installed:
        raise RuntimeError(f"对齐模型下载完成但未通过完整性检查：{result.detail}")
    emit(f"[aligner] {model.label} 已准备完成。")
    return result


def _status(
    model: AlignmentModelConfig,
    status: str,
    runtime_available: bool,
    installed: bool,
    path: Path | None,
    detail: str,
    runtime_source: str,
    runtime_python: str,
) -> AlignmentModelStatus:
    return AlignmentModelStatus(
        model.id,
        model.engine,
        model.model_ref,
        status,
        bool(runtime_available),
        bool(installed),
        str(path or ""),
        detail,
        runtime_source,
        runtime_python,
        _installed_model_size(path) if installed else "",
    )


def _download_qwen(
    model_ref: str,
    model_cache_root: str | Path | None,
    emit: AlignmentEvent,
    on_progress: AlignmentProgress | None,
    cancel_event: threading.Event,
) -> None:
    if cancel_event.is_set():
        raise RuntimeError("对齐模型准备已取消。")
    try:
        from huggingface_hub import snapshot_download  # type: ignore[import-not-found]
    except ImportError as error:
        raise RuntimeError("缺少 huggingface_hub；请先安装本地模型支持。") from error
    cache_env = model_cache_environment(model_cache_root)
    hub_cache = Path(cache_env["HF_HUB_CACHE"])
    hub_cache.mkdir(parents=True, exist_ok=True)
    emit(f"[aligner] 正在复用 Hugging Face 缓存下载 {model_ref}……")
    kwargs: dict[str, object] = {
        "repo_id": model_ref,
        "cache_dir": str(hub_cache),
    }
    try:
        path = snapshot_download(**kwargs)
    except TypeError:
        # Older huggingface_hub versions accepted resume_download; newer ones
        # removed it. Keeping no version-specific keyword works for both.
        kwargs["resume_download"] = True
        path = snapshot_download(**kwargs)
    if cancel_event.is_set():
        raise RuntimeError("对齐模型准备已取消。")
    if on_progress is not None:
        file_count, total_size = _cache_snapshot([Path(path)])
        on_progress({
            "message": f"[aligner] Hugging Face 缓存已写入 {file_count} 个文件 / {_format_bytes(total_size)}。",
            "fileCount": file_count,
            "currentBytes": total_size,
            "percent": 100,
        })


def _download_firered(
    model_cache_root: str | Path | None,
    emit: AlignmentEvent,
    on_progress: AlignmentProgress | None,
    cancel_event: threading.Event,
) -> None:
    cache_root = resolve_model_cache_root(model_cache_root)
    target_root = cache_root / "aligners"
    target_root.mkdir(parents=True, exist_ok=True)
    final_dir = target_root / FIRERED_ASR2_CTC_DIRECTORY
    if _model_files_present(alignment_model_by_id(FIRERED_ASR2_CTC_MODEL_ID), final_dir):
        return
    archive_dir = target_root / "downloads"
    archive_dir.mkdir(parents=True, exist_ok=True)
    archive_path = archive_dir / FIRERED_ASR2_CTC_ARCHIVE
    partial = archive_path.with_suffix(archive_path.suffix + ".part")
    emit(f"[aligner] 正在下载 FireRedASR2-CTC：{FIRERED_ASR2_CTC_URL}")
    request = Request(FIRERED_ASR2_CTC_URL, headers={"User-Agent": "MAW/aligner"})
    downloaded = 0
    try:
        with urlopen(request, timeout=60) as response, partial.open("wb") as handle:  # noqa: S310 - fixed official URL
            total = int(response.headers.get("Content-Length") or 0)
            while True:
                if cancel_event.is_set():
                    raise RuntimeError("对齐模型准备已取消。")
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                handle.write(chunk)
                downloaded += len(chunk)
                if on_progress is not None:
                    on_progress({
                        "message": f"[aligner] FireRed 下载中：{_format_bytes(downloaded)}"
                        + (f" / {_format_bytes(total)}" if total else ""),
                        "currentBytes": downloaded,
                        "totalBytes": total,
                        "percent": min(99, downloaded / total * 100) if total else 0,
                    })
        partial.replace(archive_path)
    except RuntimeError:
        # Cancellation is deliberately allowed to keep its user-facing error
        # while still removing the partial archive.
        partial.unlink(missing_ok=True)
        raise
    except (HTTPError, URLError, OSError) as error:
        partial.unlink(missing_ok=True)
        raise RuntimeError(f"FireRed 模型下载失败：{error}") from error
    temp_parent = Path(tempfile.mkdtemp(prefix=".firered-extract-", dir=target_root))
    try:
        with tarfile.open(archive_path, mode="r:bz2") as archive:
            _validate_tar_members(archive, temp_parent)
            archive.extractall(temp_parent)
        extracted = _find_firered_extracted_root(temp_parent)
        if extracted is None:
            raise RuntimeError("FireRed 压缩包中未找到 model.int8.onnx 和 tokens.txt。")
        if final_dir.exists():
            # Another preparation process won the race; retain its complete
            # directory and discard only our private extraction directory.
            if not _model_files_present(alignment_model_by_id(FIRERED_ASR2_CTC_MODEL_ID), final_dir):
                raise RuntimeError(f"FireRed 目标目录已存在但不完整：{final_dir}")
        else:
            os.replace(str(extracted), str(final_dir))
    finally:
        shutil.rmtree(temp_parent, ignore_errors=True)
        archive_path.unlink(missing_ok=True)
    if on_progress is not None:
        on_progress({
            "message": "[aligner] FireRed 模型解压完成。",
            "currentBytes": _cache_snapshot([final_dir])[1],
            "percent": 100,
        })


def _validate_tar_members(archive: tarfile.TarFile, root: Path) -> None:
    root_resolved = root.resolve()
    for member in archive.getmembers():
        if member.issym() or member.islnk():
            raise RuntimeError("FireRed 模型压缩包包含不支持的链接文件。")
        candidate = (root / member.name).resolve(strict=False)
        try:
            candidate.relative_to(root_resolved)
        except ValueError as error:
            raise RuntimeError("FireRed 模型压缩包包含越界路径。") from error


def _find_firered_extracted_root(root: Path) -> Path | None:
    candidates = [root, *[path for path in root.rglob("*") if path.is_dir()]]
    for candidate in candidates:
        if (candidate / FIRERED_ASR2_CTC_MODEL_FILE).is_file() and (candidate / FIRERED_ASR2_CTC_TOKENS_FILE).is_file():
            return candidate
    return None


def _find_qwen_model(model_ref: str, model_cache_root: str | Path | None) -> Path | None:
    if "/" not in model_ref:
        return None
    owner, name = model_ref.split("/", 1)
    repo_name = f"models--{owner}--{name}"
    for cache_root in _huggingface_cache_roots(model_cache_root):
        repo = cache_root / repo_name
        snapshots = repo / "snapshots"
        if snapshots.is_dir():
            candidates = [path for path in snapshots.iterdir() if path.is_dir() and _model_files_present(alignment_model_by_id(QWEN_FORCED_ALIGNER_MODEL_ID), path)]
            if candidates:
                return max(candidates, key=lambda path: path.stat().st_mtime).resolve(strict=False)
        if _model_files_present(alignment_model_by_id(QWEN_FORCED_ALIGNER_MODEL_ID), repo):
            return repo.resolve(strict=False)
    return None


def _huggingface_cache_roots(model_cache_root: str | Path | None) -> list[Path]:
    roots: list[Path] = []
    for key in ("HF_HUB_CACHE", "HUGGINGFACE_HUB_CACHE"):
        value = os.environ.get(key, "").strip()
        if value:
            roots.append(Path(value).expanduser())
    home = os.environ.get("HF_HOME", "").strip()
    if home:
        roots.append(Path(home).expanduser() / "hub")
    cache_env = model_cache_environment(model_cache_root)
    roots.extend((Path(cache_env["HF_HUB_CACHE"]), resolve_model_cache_root(model_cache_root)))
    roots.append(Path.home() / ".cache" / "huggingface" / "hub")
    return _unique_paths(roots)


def _model_files_present(model: AlignmentModelConfig, path: Path) -> bool:
    if not path.is_dir():
        return False
    if model.engine == "firered":
        return all((path / name).is_file() and (path / name).stat().st_size > 0 for name in (FIRERED_ASR2_CTC_MODEL_FILE, FIRERED_ASR2_CTC_TOKENS_FILE))
    try:
        return any(
            child.is_file() and child.stat().st_size > 0 and child.suffix.casefold() in {".safetensors", ".bin", ".pt", ".pth"}
            for child in path.rglob("*")
        ) and any((path / name).is_file() for name in ("config.json", "preprocessor_config.json", "tokenizer_config.json"))
    except OSError:
        return False


def _missing_runtime_packages(packages: Iterable[str]) -> tuple[str, ...]:
    missing: list[str] = []
    for package in packages:
        try:
            if importlib.util.find_spec(package) is None:
                missing.append(package)
        except (ImportError, ModuleNotFoundError, ValueError):
            missing.append(package)
    return tuple(missing)


def _normalise_path(value: str | Path) -> Path | None:
    text = str(value or "").strip()
    return Path(text).expanduser().resolve(strict=False) if text else None


def _unique_paths(paths: Iterable[Path]) -> list[Path]:
    result: list[Path] = []
    seen: set[str] = set()
    for path in paths:
        key = str(path.resolve(strict=False)).casefold()
        if key not in seen:
            seen.add(key)
            result.append(path)
    return result


def _cache_snapshot(paths: Iterable[Path]) -> tuple[int, int]:
    files = 0
    size = 0
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
                files += 1
                size += path.stat().st_size
            elif path.is_dir():
                pending.extend(path.iterdir())
        except OSError:
            continue
    return files, size


def _format_bytes(value: int) -> str:
    if value >= 1024**3:
        return f"{value / 1024**3:.2f} GB"
    if value >= 1024**2:
        return f"{value / 1024**2:.1f} MB"
    if value >= 1024:
        return f"{value / 1024:.1f} KB"
    return f"{value} B"


def _installed_model_size(path: Path | None) -> str:
    if path is None:
        return ""
    _file_count, total_size = _cache_snapshot([path])
    return _format_bytes(total_size) if total_size else ""


__all__ = [
    "ALIGNMENT_MODELS",
    "AlignmentModelConfig",
    "AlignmentModelStatus",
    "FIRERED_ASR2_CTC_ARCHIVE",
    "FIRERED_ASR2_CTC_DIRECTORY",
    "FIRERED_ASR2_CTC_MODEL_ID",
    "FIRERED_ASR2_CTC_MODEL_FILE",
    "FIRERED_ASR2_CTC_REF",
    "FIRERED_ASR2_CTC_TOKENS_FILE",
    "FIRERED_ASR2_CTC_URL",
    "QWEN_FORCED_ALIGNER_MODEL_ID",
    "QWEN_FORCED_ALIGNER_REF",
    "alignment_model_by_id",
    "alignment_models_payload",
    "find_alignment_model_path",
    "inspect_alignment_model",
    "normalize_alignment_model_id",
    "prepare_alignment_model",
    "resolve_alignment_model_path",
]
