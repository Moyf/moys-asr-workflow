"""Debug artifacts for the optional local ASR pipeline.

Online providers already expose their complete response through
``--debug-raw``.  Local engines do not share one native response shape, so
this module writes a small, provider-neutral manifest plus any engine-specific
stage payloads that an adapter can provide.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import fields, is_dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from maw.output_naming import debug_artifact_dir

DEBUG_SCHEMA = "moy.asr.local_debug.v1"


def local_debug_manifest_path(
    output_srt: str | Path,
    *,
    media_path: str | Path | None = None,
    explicit_output: bool = False,
) -> Path:
    """Return the manifest path associated with one local SRT output."""
    output = Path(output_srt).expanduser().resolve(strict=False)
    directory = (
        debug_artifact_dir(
            media_path,
            output,
            explicit_output=explicit_output,
        )
        if media_path is not None
        else output.parent
    )
    return directory / f"{output.stem}.local-debug.json"


def _json_default(value: object) -> object:
    if isinstance(value, Path):
        return str(value)
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return item()
        except (TypeError, ValueError):
            pass
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        try:
            return tolist()
        except (TypeError, ValueError):
            pass
    return str(value)


def debug_json_value(value: object, *, _depth: int = 0) -> object:
    """Convert common model-return objects into bounded JSON-compatible data."""
    if _depth > 8:
        return str(value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, Mapping):
        return {
            str(key): debug_json_value(item, _depth=_depth + 1)
            for key, item in value.items()
        }
    if isinstance(value, (list, tuple, set)):
        return [debug_json_value(item, _depth=_depth + 1) for item in value]
    for method_name in ("model_dump", "to_dict"):
        method = getattr(value, method_name, None)
        if callable(method):
            try:
                return debug_json_value(method(), _depth=_depth + 1)
            except (TypeError, ValueError):
                pass
    if is_dataclass(value):
        return {
            field.name: debug_json_value(getattr(value, field.name), _depth=_depth + 1)
            for field in fields(value)
        }
    item = getattr(value, "item", None)
    if callable(item):
        try:
            return debug_json_value(item(), _depth=_depth + 1)
        except (TypeError, ValueError):
            pass
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        try:
            return debug_json_value(tolist(), _depth=_depth + 1)
        except (TypeError, ValueError):
            pass
    attributes = getattr(value, "__dict__", None)
    if isinstance(attributes, dict):
        return {
            str(key): debug_json_value(item, _depth=_depth + 1)
            for key, item in attributes.items()
            if not str(key).startswith("_")
        }
    return _json_default(value)


def transcription_payload(transcription: Any) -> dict[str, object]:
    """Convert a ``LocalTranscription``-like object to a JSON payload."""
    return {
        "text": str(getattr(transcription, "text", "") or ""),
        "language": str(getattr(transcription, "language", "") or ""),
        "languageSource": str(getattr(transcription, "language_source", "unknown") or "unknown"),
        "splitMode": str(getattr(transcription, "split_mode", "") or ""),
        "timestampGranularity": str(getattr(transcription, "timestamp_granularity", "unknown") or "unknown"),
        "model": str(getattr(transcription, "model", "") or ""),
        "preservePunctuation": bool(getattr(transcription, "preserve_punctuation", False)),
        "items": list(getattr(transcription, "items", []) or []),
        "segments": list(getattr(transcription, "segments", []) or []),
    }


class LocalDebugWriter:
    """Write local debug stages according to the selected output layout."""

    def __init__(
        self,
        output_srt: str | Path,
        *,
        engine: str,
        model: str = "",
        media_path: str | Path | None = None,
        explicit_output: bool = False,
    ) -> None:
        self.output_srt = Path(output_srt).expanduser().resolve(strict=False)
        self.engine = str(engine or "local")
        self.model = str(model or "")
        self.media_path = media_path
        self.explicit_output = explicit_output
        self.artifact_dir = (
            debug_artifact_dir(
                media_path,
                self.output_srt,
                explicit_output=explicit_output,
            )
            if media_path is not None
            else self.output_srt.parent
        )
        self.artifacts: dict[str, Path] = {}

    def write(self, stage: str, payload: object) -> Path:
        stage_name = str(stage or "stage").strip().replace("/", "-").replace("\\", "-")
        path = self.artifact_dir / f"{self.output_srt.stem}.local-debug.{stage_name}.json"
        envelope = {
            "schema": DEBUG_SCHEMA,
            "stage": stage_name,
            "engine": self.engine,
            "model": self.model,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "payload": debug_json_value(payload),
        }
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(envelope, ensure_ascii=False, indent=2, default=_json_default) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        self.artifacts[stage_name] = path
        return path

    def write_transcription(self, stage: str, transcription: Any) -> Path:
        return self.write(stage, transcription_payload(transcription))

    def write_manifest(self, *, outputs: Mapping[str, str | Path] | None = None) -> Path:
        path = local_debug_manifest_path(
            self.output_srt,
            media_path=self.media_path,
            explicit_output=self.explicit_output,
        )
        payload: dict[str, object] = {
            "schema": DEBUG_SCHEMA,
            "engine": self.engine,
            "model": self.model,
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "outputSrt": str(self.output_srt),
            "artifacts": {stage: str(artifact) for stage, artifact in self.artifacts.items()},
        }
        if outputs:
            payload["outputs"] = {name: str(value) for name, value in outputs.items() if value}
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, default=_json_default) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        return path


__all__ = [
    "DEBUG_SCHEMA",
    "LocalDebugWriter",
    "debug_json_value",
    "local_debug_manifest_path",
    "transcription_payload",
]
