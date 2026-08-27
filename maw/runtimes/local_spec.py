"""本地 ASR runtime 的声明式规格（RuntimeSpec 实例 + 专属错误类与常量）。"""

from __future__ import annotations

from maw.runtimes.base import ManagedRuntimeError, RuntimeCancelled, RuntimeSpec

RUNTIME_VERSION = "5"
PYTHON_VERSION = "3.11"
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu130"
EMBED_PYTHON_ZIP = "python-3.11.9-embed-amd64.zip"

_VERIFY_COMMAND = (
    "from funasr import AutoModel; from qwen_asr import Qwen3ASRModel; "
    "import jieba, torch, torchaudio; print('MAW_LOCAL_RUNTIME_READY')"
)


class LocalRuntimeError(ManagedRuntimeError):
    """Raised when the managed local ASR runtime cannot be installed."""


class LocalRuntimeCancelled(LocalRuntimeError, RuntimeCancelled):
    """Raised when the user closes MAW or cancels local runtime installation."""


LOCAL_SPEC = RuntimeSpec(
    key="local",
    runtime_version=RUNTIME_VERSION,
    python_version=PYTHON_VERSION,
    embed_python_zip=EMBED_PYTHON_ZIP,
    requirements_emit="正在安装本地 ASR 依赖（Torch、FunASR、QwenASR）……",
    requirements_key="local",
    requirements_bundle_name="requirements-local.txt",
    verify_command=_VERIFY_COMMAND,
    package_dirs=("funasr", "qwen_asr", "jieba", "torch", "torchaudio", "reapeaks"),
    worker_module="maw.local_runtime_worker",
    message_prefix="本地运行环境",
    feature_label="本地模型",
    missing_detail="本地运行环境尚未安装。",
    ready_detail="本地运行环境已就绪。",
    fix_action_label="修复运行环境",
    ready_emit_done="本地运行环境已安装完成。现在可以下载模型。",
    dir_name="local-runtime",
    root_env="MAW_LOCAL_RUNTIME_ROOT",
    bundle_dir="local-runtime",
    # torch 固定版本来自 pyproject local extra 的 CPU 兜底（cu130 构建额外走
    # pytorch index；无 NVIDIA GPU 时切回 CPU wheel，见 base 的 cuda 兜底步）。
    extra_index_url=PYTORCH_INDEX,
    cuda_fallback_packages=("torch==2.13.0", "torchaudio==2.11.0"),
    has_model_cache=True,
    error_class=LocalRuntimeError,
    cancelled_class=LocalRuntimeCancelled,
    cancelled_message="本地运行环境安装已取消。",
)