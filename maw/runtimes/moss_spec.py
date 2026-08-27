"""MOSS runtime 的声明式规格（RuntimeSpec 实例 + 专属错误类与常量）。

MOSS Transcribe-Diarize 依赖 Transformers 5.x，与本地 QwenASR / FunASR
（funasr / Transformers 4.x 侧）不能共享同一个环境，因此独立安装到
``local-runtime-moss``（Python 3.11，与 local 共用同一个 embedded zip，
避免 bundle 额外携带 3.12）。依赖声明于仓库根 ``moss-requirements.in``
（与 local/ocr 的 pyproject extra 同一「单一真源」机制；因 Transformers
与 qwen-asr 互斥无法共容于 uv.lock，故独立声明、独立冻结），构建期由
``uv pip compile`` 生成 ``requirements-moss.txt``。
"""

from __future__ import annotations

from maw.runtimes.base import RuntimeCancelled, RuntimeSpec
from maw.runtimes.local_spec import LocalRuntimeError

MOSS_RUNTIME_VERSION = "1"
MOSS_PYTHON_VERSION = "3.11"
PYTORCH_INDEX = "https://download.pytorch.org/whl/cu130"


class MossRuntimeError(LocalRuntimeError):
    """Raised when the managed MOSS runtime cannot be installed or used.

    继承 LocalRuntimeError：GUI 的本地模型安装入口统一捕获
    ``(LocalRuntimeError, OSError)``，moss 与 local 共享该契约。
    """


class MossRuntimeCancelled(MossRuntimeError, RuntimeCancelled):
    """Raised when the user cancels MOSS runtime work."""


_VERIFY_COMMAND = (
    "from moss_transcribe_diarize import parse_transcript; "
    "import transformers, torch, torchaudio; print('MAW_LOCAL_RUNTIME_READY')"
)

MOSS_SPEC = RuntimeSpec(
    key="moss",
    runtime_version=MOSS_RUNTIME_VERSION,
    python_version=MOSS_PYTHON_VERSION,
    embed_python_zip="python-3.11.9-embed-amd64.zip",
    requirements_emit="正在安装 MOSS 本地依赖（Transformers 5.x、Torch）……",
    requirements_key="moss",
    requirements_bundle_name="requirements-moss.txt",
    verify_command=_VERIFY_COMMAND,
    package_dirs=("moss_transcribe_diarize", "transformers", "torch", "torchaudio"),
    worker_module="maw.local_runtime_worker",
    message_prefix="MOSS 运行环境",
    feature_label="MOSS 模型",
    missing_detail="MOSS 运行环境尚未安装。",
    ready_detail="MOSS 运行环境已就绪。",
    fix_action_label="修复 MOSS 运行环境",
    ready_emit_done="MOSS 本地运行环境已安装完成。现在可以下载模型。",
    dir_name="local-runtime-moss",
    root_env="MAW_MOSS_RUNTIME_ROOT",
    bundle_dir="moss-runtime",
    extra_index_url=PYTORCH_INDEX,
    cuda_fallback_packages=("torch==2.13.0", "torchaudio==2.11.0"),
    has_model_cache=True,
    error_class=MossRuntimeError,
    cancelled_class=MossRuntimeCancelled,
    cancelled_message="MOSS 运行环境安装已取消。",
)