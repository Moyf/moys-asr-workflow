"""Sequential batch transcription for the Launcher bridge."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from pathlib import Path
from threading import Event

from maw.gui_workflow import (
    MissingOutputError,
    TranscriptionCancelledError,
    TranscriptionProcessError,
    TranscriptionRequest,
    TranscriptionResult,
    build_output_paths,
    run_transcription,
)
from maw.postprocess_pipeline import PostprocessCancelled, PostprocessPipelineError, enabled_steps


@dataclass(frozen=True, slots=True)
class BatchItem:
    item_id: str
    request: TranscriptionRequest | None
    preflight_error: str = ""


BatchEvent = Callable[[Mapping[str, object]], None]
TranscribeRunner = Callable[..., TranscriptionResult]
PostprocessRunner = Callable[..., object]


def manifest_payload(items: Sequence[BatchItem], settings: Mapping[str, object]) -> dict[str, object]:
    """Return a persisted batch manifest without credentials or secret fields."""
    return {
        "version": 1,
        "settings": _without_secrets(settings),
        "items": [
            {
                "id": item.item_id,
                "mediaPath": str(item.request.media_path) if item.request else "",
                "srtPath": str(item.request.srt_path) if item.request else "",
                "status": "pending",
            }
            for item in items
        ],
    }


def run_batch(
    items: Sequence[BatchItem],
    *,
    settings: Mapping[str, object],
    manifest_path: Path,
    cancel_event: Event,
    on_event: BatchEvent | None = None,
    transcribe: TranscribeRunner = run_transcription,
    postprocess: PostprocessRunner | None = None,
    env_path: Path | None = None,
    ffmpeg_path: Path | None = None,
    ocr_runtime_root: Path | None = None,
) -> dict[str, object]:
    """Run items FIFO, never overlapping workers, and isolate item failures."""
    manifest = manifest_payload(items, settings)
    if postprocess is None:
        from maw.postprocess_pipeline import run_postprocess_pipeline

        postprocess = run_postprocess_pipeline
    _write_manifest(manifest_path, manifest)
    _emit(on_event, {"type": "batch_started", "total": len(items), "manifestPath": str(manifest_path)})
    outcomes: list[dict[str, object]] = []
    reserved: set[Path] = set()
    for index, item in enumerate(items):
        if item.preflight_error or item.request is None:
            outcome = {
                "id": item.item_id,
                "status": "failed",
                "index": index,
                "error": item.preflight_error or "Batch item is invalid.",
            }
            outcomes.append(outcome)
            _update_manifest(manifest, index, outcome, manifest_path)
            _emit(on_event, {"type": "batch_item", **outcome})
            continue
        if cancel_event.is_set():
            outcome = {"id": item.item_id, "status": "cancelled", "index": index}
            outcomes.append(outcome)
            _update_manifest(manifest, index, outcome, manifest_path)
            _emit(on_event, {"type": "batch_item", **outcome})
            continue
        _emit(on_event, {"type": "batch_item", "id": item.item_id, "index": index, "status": "running"})
        try:
            request = replace(item.request, srt_path=_batch_unique_output_path(item.request.srt_path, reserved))
            reserved.update(_artifact_paths(request.srt_path))
            result = transcribe(request, cancel_event=cancel_event)
            if request.postprocess_plan:
                assert postprocess is not None
                sanitized_plan = _batch_postprocess_plan(request.postprocess_plan)
                if enabled_steps(sanitized_plan):
                    pipeline_result = postprocess(
                    sanitized_plan,
                    media_path=request.media_path,
                    project_path=result.json_path,
                    srt_path=result.srt_path,
                    env_path=env_path or manifest_path.parent / ".env",
                    ffmpeg_path=ffmpeg_path,
                    ocr_runtime_root=ocr_runtime_root,
                    cancel_event=cancel_event,
                    llm_settings=request.postprocess_llm_settings,
                    on_event=lambda event: _emit_item_log(on_event, item, index, event),
                    )
                else:
                    pipeline_result = None
            else:
                pipeline_result = None
            final_srt = getattr(pipeline_result, "srt_path", result.srt_path)
            final_json: Path | None = getattr(pipeline_result, "project_path", result.json_path)
            final_html: Path | None = getattr(pipeline_result, "html_path", result.html_path)
            if request.srt_only:
                if final_json is not None:
                    final_json.unlink(missing_ok=True)
                if final_html:
                    Path(final_html).unlink(missing_ok=True)
                final_json = None
                final_html = None
            outcome = {
                "id": item.item_id,
                "status": "done",
                "index": index,
                "srtPath": str(final_srt),
                "jsonPath": str(final_json or ""),
                "htmlPath": str(final_html or ""),
            }
        except (TranscriptionCancelledError, PostprocessCancelled):
            outcome = {"id": item.item_id, "status": "cancelled", "index": index}
            cancel_event.set()
        except (
            MissingOutputError,
            OSError,
            PostprocessPipelineError,
            RuntimeError,
            TranscriptionProcessError,
            ValueError,
        ) as error:
            outcome = {"id": item.item_id, "status": "failed", "index": index, "error": str(error)}
        outcomes.append(outcome)
        _update_manifest(manifest, index, outcome, manifest_path)
        _emit(on_event, {"type": "batch_item", **outcome})
        if outcome["status"] == "cancelled":
            for remaining_index in range(index + 1, len(items)):
                remaining = items[remaining_index]
                remaining_outcome = {"id": remaining.item_id, "status": "cancelled", "index": remaining_index}
                outcomes.append(remaining_outcome)
                _update_manifest(manifest, remaining_index, remaining_outcome, manifest_path)
                _emit(on_event, {"type": "batch_item", **remaining_outcome})
            break
    status = "cancelled" if cancel_event.is_set() else "done"
    manifest["status"] = status
    manifest["outcomes"] = outcomes
    _write_manifest(manifest_path, manifest)
    _emit(on_event, {"type": "batch_done", "status": status, "outcomes": outcomes, "manifestPath": str(manifest_path)})
    return {"status": status, "manifestPath": str(manifest_path), "outcomes": outcomes}


def _batch_postprocess_plan(plan: Mapping[str, object]) -> dict[str, object]:
    """Batch V1 deliberately skips manuscript matching for every item."""
    steps = plan.get("steps")
    if not isinstance(steps, Sequence) or isinstance(steps, (str, bytes)):
        return dict(plan)
    return {
        **dict(plan),
        "steps": [
            {**dict(step), "enabled": False} if isinstance(step, Mapping) and str(step.get("id") or "") == "match" else step
            for step in steps
        ],
    }


def _artifact_paths(path: Path) -> set[Path]:
    return {path, path.with_suffix(".mosp"), path.with_suffix(".edit.html")}


def _batch_unique_output_path(path: Path, reserved: set[Path]) -> Path:
    candidate = path
    counter = 1
    while _artifact_paths(candidate) & reserved or any(item.exists() for item in _artifact_paths(candidate)):
        candidate = path.with_name(f"{path.stem}-{counter}{path.suffix}")
        counter += 1
    return candidate


def _update_manifest(manifest: dict[str, object], index: int, outcome: Mapping[str, object], path: Path) -> None:
    raw_items = manifest["items"]
    assert isinstance(raw_items, list)
    raw_items[index] = {**raw_items[index], **dict(outcome)}
    _write_manifest(path, manifest)


def _write_manifest(path: Path, manifest: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(manifest, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_name, path)
    finally:
        Path(temporary_name).unlink(missing_ok=True)


def _emit(on_event: BatchEvent | None, event: Mapping[str, object]) -> None:
    if on_event is not None:
        on_event(event)


def _emit_item_log(on_event: BatchEvent | None, item: BatchItem, index: int, event: Mapping[str, object]) -> None:
    message = str(event.get("message") or event.get("detail") or event.get("step") or "").strip()
    if message:
        _emit(on_event, {"type": "batch_item_log", "id": item.item_id, "index": index, "message": message})


def _without_secrets(value: object) -> object:
    if isinstance(value, Mapping):
        return {
            str(key): _without_secrets(item)
            for key, item in value.items()
            if not any(token in str(key).casefold() for token in ("key", "secret", "token", "password"))
        }
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [_without_secrets(item) for item in value]
    return value
