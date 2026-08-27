"""MOSS runtime 规格骨架（上游 moss 分支迁移期占位）。

TODO(moss 迁移)：上游 moss 分支（origin/main 3453e23）合入本分支后，
- 把下方手写 requirements 列表替换为 pyproject [optional-dependencies].moss
  经 CI ``uv export`` 生成的 frozen txt（依赖唯一真源，见 maw/runtimes/base.py
  的 requirements_path）；
- 移除 spec.install_uv 占位标记，moss 改走与 local/ocr 一致的
  embedded Python + get-pip + ``pip install --target``（uv 全量移除）；
- worker_module 与 verify 命令按合入后的实际 entrypoint 对齐。

本骨架不实现完整安装：``MOSS.install()`` 目前抛出 NotImplementedError。
"""

from __future__ import annotations

from maw.runtimes.base import ManagedRuntimeError, RuntimeCancelled, RuntimeSpec

MOSS_RUNTIME_VERSION = "1"
MOSS_PYTHON_VERSION = "3.12"

# 手写依赖列表：仅迁移期占位，最终以 pyproject moss extra 的 frozen txt 为准。
# 合入上游 moss 分支时请从上游 MOSS_REQUIREMENTS 的最终形态抄录并附版本约束。
_MOSS_REQUIREMENTS_TODO: tuple[str, ...] = (
    "torch",
    "torchaudio",
    "transformers",
)

_VERIFY_COMMAND_TODO = (
    "from transformers import AutoModel; "
    "import torch; print('MAW_MOSS_RUNTIME_READY')"
)


class MossRuntimeError(ManagedRuntimeError):
    """Raised when the managed MOSS runtime cannot be installed or used."""


class MossRuntimeCancelled(MossRuntimeError, RuntimeCancelled):
    """Raised when the user cancels MOSS runtime work."""


MOSS_SPEC = RuntimeSpec(
    key="moss",
    runtime_version=MOSS_RUNTIME_VERSION,
    python_version=MOSS_PYTHON_VERSION,
    embed_python_zip="python-3.12-embed-amd64.zip",
    requirements_emit="正在安装 MOSS 依赖（Torch、Transformers）……",
    requirements_key="moss",
    requirements_bundle_name="requirements-moss.txt",
    requirements=_MOSS_REQUIREMENTS_TODO,
    verify_command=_VERIFY_COMMAND_TODO,
    package_dirs=("torch", "transformers"),
    worker_module="maw.moss_runtime_worker",
    message_prefix="MOSS 运行环境",
    feature_label="MOSS 模型",
    missing_detail="MOSS 支持尚未安装。",
    ready_detail="MOSS 运行环境已就绪。",
    fix_action_label="修复 MOSS 支持",
    ready_emit_done="MOSS 支持安装完成。",
    dir_name="moss-runtime",
    root_env="MAW_MOSS_RUNTIME_ROOT",
    bundle_dir="moss-runtime",
    # 迁移期标记：moss 尚未迁 embedded（uv 全量移除后删除）。
    install_uv=True,
    error_class=MossRuntimeError,
    cancelled_class=MossRuntimeCancelled,
    cancelled_message="MOSS 运行环境操作已取消。",
)