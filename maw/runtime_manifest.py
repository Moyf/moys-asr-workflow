"""Shared runtime.json manifest helpers for the managed local ASR / OCR runtimes.

Both ``maw.local_runtime`` and ``maw.ocr_runtime`` write and read a
``runtime.json`` manifest with the same shape.  ``RuntimeManifest`` is the
typed view of that file; callers read typed attributes instead of scattered
``dict.get(...)`` calls, and ``write_runtime_manifest`` preserves
runtime-specific fields (e.g. ``modelId``) via ``extra``.
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

MANIFEST_NAME = "runtime.json"
STATUS_INSTALLING = "installing"
STATUS_BROKEN = "broken"
STATUS_READY = "ready"


@dataclass(frozen=True, slots=True)
class RuntimeManifest:
    status: str
    runtime_version: str
    python_version: str
    installed_at: int
    model_id: str | None = None

    @classmethod
    def empty(cls) -> "RuntimeManifest":
        return cls(status="", runtime_version="", python_version="", installed_at=0)

    @classmethod
    def from_dict(cls, values: object) -> "RuntimeManifest":
        if not isinstance(values, dict):
            return cls.empty()
        model_id = values.get("modelId")
        return cls(
            status=str(values.get("status") or ""),
            runtime_version=str(values.get("runtimeVersion") or ""),
            python_version=str(values.get("pythonVersion") or ""),
            installed_at=int(values.get("installedAt") or 0),
            model_id=model_id if isinstance(model_id, str) else None,
        )

    @property
    def installing(self) -> bool:
        return self.status == STATUS_INSTALLING

    @property
    def ready(self) -> bool:
        return self.status == STATUS_READY

    def is_ready_for(self, runtime_version: str) -> bool:
        return self.ready and self.runtime_version == runtime_version


def read_runtime_manifest(root: Path) -> RuntimeManifest:
    """Read runtime.json into a typed RuntimeManifest; missing/invalid yields an empty one."""
    try:
        value = json.loads((root / MANIFEST_NAME).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return RuntimeManifest.empty()
    return RuntimeManifest.from_dict(value)


def write_runtime_manifest(
    root: Path,
    *,
    status: str,
    runtime_version: str,
    python_version: str,
    installed_at: int | None = None,
    extra: dict[str, object] | None = None,
) -> None:
    """Atomically write runtime.json, preserving runtime-specific fields via ``extra``."""
    values: dict[str, object] = {
        "status": status,
        "runtimeVersion": runtime_version,
        "pythonVersion": python_version,
        "installedAt": installed_at if installed_at is not None else int(time.time()),
    }
    if extra:
        values.update(extra)
    root.mkdir(parents=True, exist_ok=True)
    target = root / MANIFEST_NAME
    temporary = root / (MANIFEST_NAME + ".tmp")
    temporary.write_text(json.dumps(values, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(target)
