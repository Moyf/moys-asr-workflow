"""OCR runtime 的声明式规格（RuntimeSpec 实例 + 专属错误类与模型常量）。"""

from __future__ import annotations

from maw.runtimes.base import ManagedRuntimeError, RuntimeCancelled, RuntimeSpec

OCR_RUNTIME_VERSION = "3"
OCR_PYTHON_VERSION = "3.11"
OCR_MODEL_ID = "pp-ocrv6-tiny"
OCR_MODEL_LABEL = "PP-OCRv6 tiny（CPU）"
OCR_SMALL_MODEL_ID = "pp-ocrv6-small"
OCR_SMALL_MODEL_LABEL = "PP-OCRv6 small（CPU）"
OCR_MODEL_IDS: tuple[str, ...] = (OCR_MODEL_ID, OCR_SMALL_MODEL_ID)
OCR_MODEL_TYPES: dict[str, str] = {
    OCR_MODEL_ID: "tiny",
    OCR_SMALL_MODEL_ID: "small",
}
OCR_MODEL_LABELS: dict[str, str] = {
    OCR_MODEL_ID: OCR_MODEL_LABEL,
    OCR_SMALL_MODEL_ID: OCR_SMALL_MODEL_LABEL,
}
# OCR 依赖清单由 pyproject ocr dependency-group 经 CI uv export --only-group
# 冻结（build/requirements-ocr.txt），frozen 后随包分发于
# asset_path("ocr-runtime/requirements-ocr.txt")。

_VERIFY_COMMAND = (
    "from rapidocr import RapidOCR; import numpy, onnxruntime; "
    "from PIL import Image; print('MAW_OCR_RUNTIME_READY')"
)


class OcrRuntimeError(ManagedRuntimeError):
    """Raised when the managed OCR runtime cannot be installed or used."""


class OcrRuntimeCancelled(OcrRuntimeError, RuntimeCancelled):
    """Raised when the user cancels OCR runtime work."""


OCR_SPEC = RuntimeSpec(
    key="ocr",
    runtime_version=OCR_RUNTIME_VERSION,
    python_version=OCR_PYTHON_VERSION,
    embed_python_zip="python-3.11.9-embed-amd64.zip",
    requirements_emit="正在安装 OCR 模型和依赖……",
    requirements_key="ocr",
    requirements_bundle_name="requirements-ocr.txt",
    # OCR 是 pyproject dependency-groups 中的独立最小运行时依赖组。
    requirements_group="ocr",
    verify_command=_VERIFY_COMMAND,
    package_dirs=("numpy", "onnxruntime", "PIL", "rapidocr"),
    worker_module="maw.ocr_runtime_worker",
    message_prefix="OCR 运行环境",
    feature_label="OCR 模型",
    missing_detail="OCR 支持尚未安装。",
    ready_detail="OCR 模型已安装，可以在工具箱中使用。",
    fix_action_label="修复 OCR 支持",
    ready_emit_done="OCR 支持安装完成，现在可以在工具箱中选择 OCR 模型。",
    dir_name="ocr-runtime",
    root_env="MAW_OCR_RUNTIME_ROOT",
    bundle_dir="ocr-runtime",
    # OCR 是纯 CPU 运行时：不需要 cu130 extra，也不需要模型缓存变量。
    model_id=OCR_MODEL_ID,
    model_id_label=OCR_MODEL_LABEL,
    error_class=OcrRuntimeError,
    cancelled_class=OcrRuntimeCancelled,
    cancelled_message="OCR 运行环境操作已取消。",
)
