"""Hugging Face → ModelScope 回退下载助手。

Qwen3-ASR、MOSS-Transcribe-Diarize、Faster-Whisper 与 Qwen3-ForcedAligner
的权重都发布在 Hugging Face Hub，而国内网络直连 huggingface.co 经常失败。
这些仓库在 ModelScope 上均有官方或等价镜像（已逐一核对仓库内容），因此
模型准备统一走这里：先按原 Hugging Face 仓库 ID 下载，连接失败时自动改用
ModelScope 镜像下载；两者都写入 MAW 统一的模型缓存布局
（HF → ``<缓存根>/huggingface/hub``，MS → ``<缓存根>/modelscope``），
已下载完成的文件在重试时按缓存复用。

缓存扫描复用 ``maw.local_models`` 的发现逻辑（函数级导入，避免模块环），
因此 GUI「已安装」检测与本模块的「可加载」判断不会漂移。

与上游加载器一致，单个文件内的字节级续传由 hub 库自行处理；取消依赖
prepare 流程杀掉子进程来实现，本模块只在两次尝试之间响应 cancel_event。
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

HubEvent = Callable[[str], None]

# HF 与 ModelScope 仓库 ID 不同的模型（默认同名，仅组织名不一致时在此登记）。
MODELSCOPE_REPO_ALIASES: dict[str, str] = {
    "OpenMOSS-Team/MOSS-Transcribe-Diarize": "OpenMOSS/MOSS-Transcribe-Diarize",
}


def modelscope_repo_id(hf_repo_id: str) -> str:
    """Return the ModelScope repo id for an HF repo id (identity by default)."""
    repo_id = str(hf_repo_id or "").strip()
    return MODELSCOPE_REPO_ALIASES.get(repo_id, repo_id)


@dataclass(frozen=True, slots=True)
class HubSnapshot:
    """A locally usable model snapshot directory and where it came from."""

    path: Path
    source: str  # "cache" | "huggingface" | "modelscope"


def _cache_environment(model_cache_root: str | Path | None) -> dict[str, str]:
    # 唯一真源在 alignment_models（worker 打包依赖最少的模块）；函数级导入
    # 避免与 ``from maw import hub_download`` 形成模块环。
    from maw.alignment_models import model_cache_environment

    return model_cache_environment(model_cache_root)


def _find_cached_snapshot(
    repo_id: str,
    model_cache_root: str | Path | None,
) -> Path | None:
    from maw.local_models import _find_hub_model

    return _find_hub_model(repo_id, model_cache_root)


def _huggingface_snapshot_download(
    repo_id: str,
    model_cache_root: str | Path | None,
    revision: str = "",
) -> Path:
    from maw.alignment_models import resolve_model_cache_root

    try:
        from huggingface_hub import snapshot_download  # type: ignore[import-not-found]
    except ImportError as error:
        raise RuntimeError("缺少 huggingface_hub；请先安装本地模型支持。") from error

    cache_env = _cache_environment(model_cache_root)
    hub_cache = Path(cache_env["HF_HUB_CACHE"]) if cache_env.get("HF_HUB_CACHE") else resolve_model_cache_root(model_cache_root)
    hub_cache.mkdir(parents=True, exist_ok=True)
    kwargs: dict[str, object] = {
        "repo_id": repo_id,
        "cache_dir": str(hub_cache),
    }
    if revision:
        kwargs["revision"] = revision
    try:
        return Path(snapshot_download(**kwargs))
    except TypeError:
        # Older huggingface_hub versions accepted resume_download; newer ones
        # removed it. Keeping no version-specific keyword works for both.
        kwargs["resume_download"] = True
        return Path(snapshot_download(**kwargs))


def _modelscope_snapshot_download(
    repo_id: str,
    model_cache_root: str | Path | None,
    emit: HubEvent,
) -> Path:
    try:
        from modelscope import snapshot_download  # type: ignore[import-not-found]
    except ImportError as error:
        raise RuntimeError(
            "ModelScope 回退需要 modelscope 包；请先安装本地模型支持。"
        ) from error

    cache_env = _cache_environment(model_cache_root)
    ms_cache = cache_env.get("MODELSCOPE_CACHE") or str(
        Path.home() / ".cache" / "modelscope" / "hub"
    )
    Path(ms_cache).mkdir(parents=True, exist_ok=True)
    ms_repo_id = modelscope_repo_id(repo_id)
    if ms_repo_id != repo_id:
        emit(f"[hub] ModelScope 镜像仓库：{ms_repo_id}")
    # ModelScope 无法对齐 Hugging Face 的 commit pin；镜像仓库由 MS 侧维护，
    # 默认拉取其主版本。cache_dir 布局为 <cache>/models/<owner>--<name>/。
    return Path(snapshot_download(ms_repo_id, cache_dir=ms_cache))


def _is_cancelled(cancel_event: threading.Event | None) -> bool:
    return cancel_event is not None and cancel_event.is_set()


def prepare_hub_snapshot(
    repo_id: str,
    *,
    model_cache_root: str | Path | None = None,
    emit: HubEvent | None = None,
    cancel_event: threading.Event | None = None,
    revision: str = "",
) -> HubSnapshot:
    """Return a local snapshot dir for ``repo_id``, falling back to ModelScope.

    1. 复用既有缓存（HF / ModelScope，含 funasr 遗留布局）；
    2. Hugging Face ``snapshot_download``（``revision`` 仅在此步生效，用于
       固定默认模型的 commit pin）；
    3. 上一步因网络等原因失败时，ModelScope ``snapshot_download``（镜像
       仓库 ID 由 :data:`MODELSCOPE_REPO_ALIASES` 映射，默认同名；MS 侧
       无法对齐 HF 的 commit pin）。
    """
    repo_id = str(repo_id or "").strip()
    if "/" not in repo_id:
        raise ValueError(f"不是 Hugging Face 仓库 ID：{repo_id}")
    notify = emit or (lambda _message: None)
    if cancel_event is not None and cancel_event.is_set():
        raise RuntimeError("模型准备已取消。")

    cached = _find_cached_snapshot(repo_id, model_cache_root)
    if cached is not None:
        notify(f"[hub] 复用本地已缓存快照：{repo_id}")
        return HubSnapshot(cached, "cache")

    hub_error: Exception | None = None
    try:
        notify(f"[hub] 正在从 Hugging Face 下载 {repo_id}……")
        path = _huggingface_snapshot_download(repo_id, model_cache_root, revision=revision)
        notify(f"[hub] Hugging Face 下载完成：{repo_id}")
        return HubSnapshot(path, "huggingface")
    except Exception as error:  # noqa: BLE001 - 回退判断在 except 内分类
        # ``except ... as error`` 在块结束时会解除绑定，需另存供汇总使用。
        hub_error = error
        if _is_cancelled(cancel_event):
            raise RuntimeError("模型准备已取消。") from error

    notify(f"[hub] Hugging Face 下载失败（{hub_error}），改用 ModelScope 镜像……")
    try:
        path = _modelscope_snapshot_download(repo_id, model_cache_root, notify)
    except Exception as ms_error:  # noqa: BLE001 - 汇总两侧错误后向用户呈现
        if _is_cancelled(cancel_event):
            raise RuntimeError("模型准备已取消。") from ms_error
        raise RuntimeError(
            "Hugging Face 与 ModelScope 下载均失败。"
            f"Hugging Face：{hub_error}；ModelScope：{ms_error}"
        ) from ms_error
    notify(f"[hub] ModelScope 下载完成：{repo_id}")
    return HubSnapshot(path, "modelscope")


__all__ = [
    "MODELSCOPE_REPO_ALIASES",
    "HubSnapshot",
    "modelscope_repo_id",
    "prepare_hub_snapshot",
]
