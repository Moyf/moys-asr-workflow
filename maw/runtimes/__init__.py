"""托管 Runtime 共性抽象：RuntimeSpec + ManagedRuntime 生命周期 + 单例注册表。

``maw.runtimes`` 把 local / ocr / moss 三个用户级托管运行时的安装、状态、
路径、依赖与镜像选择统一到 ``maw.runtimes.base``。各 Runtime 只提供一份
声明式 ``RuntimeSpec``，模块级导出 LOCAL / OCR / MOSS 现成实例，
GUI / CLI 经 ``maw.local_runtime`` / ``maw.ocr_runtime`` 薄壳调用。
"""

from __future__ import annotations

from maw.runtimes.base import ManagedRuntime, RuntimeSpec
from maw.runtimes.local_spec import LOCAL_SPEC
from maw.runtimes.moss_spec import MOSS_SPEC
from maw.runtimes.ocr_spec import OCR_SPEC

LOCAL = ManagedRuntime(LOCAL_SPEC)
OCR = ManagedRuntime(OCR_SPEC)
MOSS = ManagedRuntime(MOSS_SPEC)

_RUNTIMES: dict[str, ManagedRuntime] = {
    LOCAL.spec.key: LOCAL,
    OCR.spec.key: OCR,
    MOSS.spec.key: MOSS,
}


def get_runtime(key: str) -> ManagedRuntime:
    """按 spec.key（"local"/"ocr"/"moss"）取托管 Runtime 实例。"""
    try:
        return _RUNTIMES[key]
    except KeyError as error:
        raise KeyError(
            f"未知的托管 Runtime：{key}（可选：{', '.join(sorted(_RUNTIMES))}）"
        ) from error


__all__ = [
    "LOCAL",
    "MOSS",
    "OCR",
    "ManagedRuntime",
    "RuntimeSpec",
    "get_runtime",
]