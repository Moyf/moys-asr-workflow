# pyright: reportAny=false, reportArgumentType=false, reportAttributeAccessIssue=false, reportUnknownArgumentType=false, reportUnknownMemberType=false

"""Automatic subtitle post-processing after a successful transcription."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from threading import Event
from typing import Final

from maw.gui_config import load_env
from maw.postprocess import (
    LlmPostprocessRequest,
    OutputMode,
    Replacement,
    ReplacementRequest,
    run_fixed_replacement,
    run_llm_postprocess,
)
from maw.postprocess_io import SubtitleArtifact
from maw.postprocess_llm import (
    DEFAULT_REASONING_MODE,
    LlmSettings,
    complete_subtitle_groups,
    normalize_reasoning_mode,
    preset_by_id,
)
from maw.postprocess_match import ScriptMatchRequest, run_script_match
from maw.postprocess_ocr import OcrDedupRequest, OcrRegion, run_ocr_dedup
from maw.project_preview import JsonValue


POSTPROCESS_PLAN_VERSION: Final[int] = 1
POSTPROCESS_CONFIG_FILENAME: Final[str] = "maw-postprocess.json"
POSTPROCESS_WORKSPACE_NAME: Final[str] = "MAW-Postprocess"
STEP_ORDER: Final[tuple[str, ...]] = (
    "match",
    "replace",
    "proofread",
    "resegment",
    "ocr",
    "translate",
)
TRANSLATION_TARGETS: Final[frozenset[str]] = frozenset({"zh", "en"})
SCRIPT_EXTENSIONS: Final[frozenset[str]] = frozenset({".txt", ".md", ".markdown"})
VIDEO_EXTENSIONS: Final[frozenset[str]] = frozenset({
    ".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v",
})


def default_postprocess_plan() -> dict[str, object]:
    return {
        "version": POSTPROCESS_PLAN_VERSION,
        "enabled": False,
        "retainIntermediate": False,
        "steps": [
            {"id": "match", "enabled": False, "scriptPath": ""},
            {"id": "replace", "enabled": False, "replacements": []},
            {"id": "proofread", "enabled": False, "providerId": "deepseek", "customPrompt": ""},
            {"id": "resegment", "enabled": False, "providerId": "deepseek", "customPrompt": ""},
            {"id": "ocr", "enabled": False, "videoPath": "", "regionMode": "full", "regionX1": 0, "regionY1": 0, "regionX2": 100, "regionY2": 100, "threshold": 0.5, "report": False},
            {"id": "translate", "enabled": False, "providerId": "deepseek", "target": "zh", "customPrompt": ""},
        ],
    }


def normalize_plan(raw: object) -> dict[str, object]:
    """Return a safe, versioned plan containing only supported step fields."""

    defaults = default_postprocess_plan()
    if not isinstance(raw, Mapping):
        return defaults
    plan: dict[str, object] = {
        "version": POSTPROCESS_PLAN_VERSION,
        "enabled": bool(raw.get("enabled")),
        "retainIntermediate": bool(raw.get("retainIntermediate")),
        "steps": [],
    }
    by_id: dict[str, Mapping[str, object]] = {}
    raw_steps = raw.get("steps")
    if isinstance(raw_steps, Sequence) and not isinstance(raw_steps, (str, bytes)):
        for item in raw_steps:
            if isinstance(item, Mapping):
                step_id = str(item.get("id") or "")
                if step_id in STEP_ORDER:
                    by_id[step_id] = item
    normalized_steps: list[dict[str, object]] = []
    for default_step in defaults["steps"]:
        assert isinstance(default_step, dict)
        step_id = str(default_step["id"])
        source = by_id.get(step_id, {})
        step = dict(default_step)
        step["enabled"] = bool(source.get("enabled"))
        for key in default_step:
            if key in {"id", "enabled"} or key not in source:
                continue
            value = source[key]
            if key == "replacements":
                step[key] = _normalize_replacements(value)
            elif key == "target":
                step[key] = str(value or "zh") if str(value or "zh") in TRANSLATION_TARGETS else "zh"
            elif key in {"regionX1", "regionY1", "regionX2", "regionY2", "threshold"}:
                step[key] = _number_or_default(value, step[key])
            elif key == "report":
                step[key] = bool(value)
            else:
                step[key] = str(value or "").strip()
        normalized_steps.append(step)
    plan["steps"] = normalized_steps
    return plan


def enabled_steps(plan: Mapping[str, object]) -> list[dict[str, object]]:
    raw_steps = plan.get("steps")
    if not isinstance(raw_steps, Sequence) or isinstance(raw_steps, (str, bytes)):
        return []
    by_id = {
        str(item.get("id")): dict(item)
        for item in raw_steps
        if isinstance(item, Mapping) and str(item.get("id") or "") in STEP_ORDER and bool(item.get("enabled"))
    }
    return [by_id[step_id] for step_id in STEP_ORDER if step_id in by_id]


def postprocess_config_path(env_path: Path) -> Path:
    return Path(env_path).expanduser().resolve().with_name(POSTPROCESS_CONFIG_FILENAME)


def load_postprocess_config(path: Path) -> dict[str, object]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, UnicodeError, json.JSONDecodeError):
        return {"version": POSTPROCESS_PLAN_VERSION, "plan": default_postprocess_plan(), "verification": {}}
    if not isinstance(raw, Mapping):
        return {"version": POSTPROCESS_PLAN_VERSION, "plan": default_postprocess_plan(), "verification": {}}
    verification = raw.get("verification")
    return {
        "version": POSTPROCESS_PLAN_VERSION,
        "plan": normalize_plan(raw.get("plan")),
        "verification": dict(verification) if isinstance(verification, Mapping) else {},
    }


def load_postprocess_plan(env_path: Path) -> dict[str, object]:
    return normalize_plan(load_postprocess_config(postprocess_config_path(env_path)).get("plan"))


def save_postprocess_plan(env_path: Path, raw_plan: object) -> dict[str, object]:
    path = postprocess_config_path(env_path)
    config = load_postprocess_config(path)
    plan = normalize_plan(raw_plan)
    _save_config(path, {"version": POSTPROCESS_PLAN_VERSION, "plan": plan, "verification": config.get("verification", {})})
    return plan


def _llm_values(env_path: Path, provider_id: str) -> dict[str, str]:
    preset = preset_by_id(provider_id)
    values = load_env(env_path)
    prefix = preset.env_prefix
    return {
        "apiKey": os.environ.get(f"{prefix}_API_KEY") or values.get(f"{prefix}_API_KEY", ""),
        "baseUrl": os.environ.get(f"{prefix}_BASE_URL") or values.get(f"{prefix}_BASE_URL", "") or preset.base_url,
        "model": os.environ.get(f"{prefix}_MODEL") or values.get(f"{prefix}_MODEL", "") or preset.model,
    }


def _llm_fingerprint(provider_id: str, values: Mapping[str, str]) -> str:
    payload = {
        "providerId": provider_id,
        "apiKey": values.get("apiKey", ""),
        "baseUrl": values.get("baseUrl", ""),
        "model": values.get("model", ""),
    }
    return hashlib.sha256(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()


def is_llm_verified(env_path: Path, provider_id: str) -> bool:
    values = _llm_values(env_path, provider_id)
    config = load_postprocess_config(postprocess_config_path(env_path))
    verification = config.get("verification")
    return isinstance(verification, Mapping) and verification.get(provider_id) == _llm_fingerprint(provider_id, values)


def record_llm_verification(env_path: Path, provider_id: str, values: Mapping[str, str] | None = None) -> None:
    path = postprocess_config_path(env_path)
    config = load_postprocess_config(path)
    verification = dict(config.get("verification") or {})
    current = dict(values or _llm_values(env_path, provider_id))
    verification[provider_id] = _llm_fingerprint(provider_id, current)
    _save_config(path, {"version": POSTPROCESS_PLAN_VERSION, "plan": config["plan"], "verification": verification})


def invalidate_llm_verification_if_changed(
    env_path: Path,
    provider_id: str,
    previous_values: Mapping[str, str],
    current_values: Mapping[str, str],
) -> None:
    if _llm_fingerprint(provider_id, previous_values) == _llm_fingerprint(provider_id, current_values):
        return
    path = postprocess_config_path(env_path)
    config = load_postprocess_config(path)
    verification = dict(config.get("verification") or {})
    verification.pop(provider_id, None)
    _save_config(path, {"version": POSTPROCESS_PLAN_VERSION, "plan": config["plan"], "verification": verification})


def postprocess_provider_status(env_path: Path, provider_id: str) -> dict[str, object]:
    values = _llm_values(env_path, provider_id)
    return {
        "verified": is_llm_verified(env_path, provider_id),
        "hasApiKey": bool(values["apiKey"]),
        "hasBaseUrl": bool(values["baseUrl"]),
        "hasModel": bool(values["model"]),
    }


def snapshot_postprocess_llm_settings(
    env_path: Path,
    plan: Mapping[str, object],
) -> dict[str, dict[str, str]]:
    """Capture effective LLM settings for a run without writing them anywhere."""

    snapshot: dict[str, dict[str, str]] = {}
    for step in enabled_steps(plan):
        if str(step.get("id") or "") not in {"proofread", "resegment", "translate"}:
            continue
        provider_id = str(step.get("providerId") or "deepseek")
        if provider_id in snapshot:
            continue
        values = _llm_values(env_path, provider_id)
        preset = preset_by_id(provider_id)
        env_values = load_env(env_path)
        snapshot[provider_id] = {
            "apiKey": values["apiKey"],
            "baseUrl": values["baseUrl"],
            "model": values["model"],
            "verified": "1" if is_llm_verified(env_path, provider_id) else "",
            "reasoningMode": normalize_reasoning_mode(
                os.environ.get(f"{preset.env_prefix}_REASONING_MODE")
                or env_values.get(f"{preset.env_prefix}_REASONING_MODE", DEFAULT_REASONING_MODE)
            ),
        }
    return snapshot


def validate_plan(
    raw_plan: object,
    *,
    env_path: Path,
    media_path: Path,
    ffmpeg_path: Path | None = None,
    llm_settings: Mapping[str, Mapping[str, str]] | None = None,
) -> tuple[dict[str, object], tuple[dict[str, str], ...]]:
    plan = normalize_plan(raw_plan)
    if not bool(plan.get("enabled")):
        return plan, ()
    errors: list[dict[str, str]] = []
    active_steps = enabled_steps(plan)
    if not active_steps:
        return plan, ({"step": "", "field": "autoPostprocessEnabled", "message": "启用自动后处理时至少选择一个处理步骤。"},)
    for step in active_steps:
        step_id = str(step["id"])
        if step_id == "match":
            path = Path(str(step.get("scriptPath") or "")).expanduser()
            if path.suffix.lower() not in SCRIPT_EXTENSIONS or not path.is_file():
                errors.append({"step": step_id, "field": "postprocessScriptPath", "message": "文稿匹配需要一个存在的 .txt、.md 或 .markdown 文稿文件。"})
        elif step_id == "replace":
            if not _normalize_replacements(step.get("replacements")):
                errors.append({"step": step_id, "field": "postprocessReplacements", "message": "固定替换至少需要一条有效替换规则。"})
        elif step_id in {"proofread", "resegment", "translate"}:
            provider_id = str(step.get("providerId") or "deepseek")
            status = _snapshot_provider_status(llm_settings.get(provider_id)) if llm_settings and provider_id in llm_settings else postprocess_provider_status(env_path, provider_id)
            if not status["hasApiKey"]:
                errors.append({"step": step_id, "field": "llmApiKey", "message": "LLM 供应商缺少 API Key，请在工具箱设置中填写并保存。"})
            elif not status["hasBaseUrl"]:
                errors.append({"step": step_id, "field": "llmBaseUrl", "message": "LLM 供应商缺少 API URL，请在工具箱设置中填写并保存。"})
            elif not status["hasModel"]:
                errors.append({"step": step_id, "field": "llmModel", "message": "LLM 供应商缺少模型，请在工具箱设置中填写并保存。"})
            elif not status["verified"]:
                errors.append({"step": step_id, "field": "llmModel", "message": "LLM 连接尚未验证，请在设置中点击“测试连接”。"})
            if step_id == "translate" and str(step.get("target") or "zh") not in TRANSLATION_TARGETS:
                errors.append({"step": step_id, "field": "autoTranslateTarget", "message": "翻译目标必须是中文或英文。"})
        elif step_id == "ocr":
            video_text = str(step.get("videoPath") or "").strip()
            video = Path(video_text).expanduser() if video_text else media_path
            if video.suffix.lower() not in VIDEO_EXTENSIONS or not video.is_file():
                errors.append({"step": step_id, "field": "ocrVideoPath", "message": "OCR 字幕去重需要一个存在的视频文件。音频转写请在工具箱中指定视频。"})
            region_mode = str(step.get("regionMode") or "full")
            if region_mode not in {"full", "bottom30", "custom"}:
                errors.append({"step": step_id, "field": "ocrRegionMode", "message": "OCR 画面区域配置无效。"})
            elif region_mode == "custom":
                coordinates = {
                    "ocrRegionX1": _number_or_default(step.get("regionX1"), 0),
                    "ocrRegionY1": _number_or_default(step.get("regionY1"), 0),
                    "ocrRegionX2": _number_or_default(step.get("regionX2"), 100),
                    "ocrRegionY2": _number_or_default(step.get("regionY2"), 100),
                }
                if any(value < 0 or value > 100 for value in coordinates.values()):
                    errors.append({"step": step_id, "field": "ocrRegionX1", "message": "OCR 自定义画面区域必须在 0 到 100 之间。"})
                elif coordinates["ocrRegionX2"] <= coordinates["ocrRegionX1"]:
                    errors.append({"step": step_id, "field": "ocrRegionX2", "message": "OCR 自定义区域的右边界必须大于左边界。"})
                elif coordinates["ocrRegionY2"] <= coordinates["ocrRegionY1"]:
                    errors.append({"step": step_id, "field": "ocrRegionY2", "message": "OCR 自定义区域的下边界必须大于上边界。"})
            threshold = _number_or_default(step.get("threshold"), 0.5)
            if not 0 <= threshold <= 1:
                errors.append({"step": step_id, "field": "ocrThreshold", "message": "OCR 相似度阈值必须在 0 到 1 之间。"})
            if ffmpeg_path is None or not ffmpeg_path.is_file():
                errors.append({"step": step_id, "field": "ocrVideoPath", "message": "找不到 FFmpeg，无法执行 OCR 字幕去重。"})
    return plan, tuple(errors)


@dataclass(frozen=True, slots=True)
class PipelineResult:
    project_path: Path
    srt_path: Path
    run_directory: Path
    completed_steps: tuple[str, ...]
    warnings: tuple[str, ...] = ()


class PostprocessCancelled(RuntimeError):
    """Raised when the transcription cancellation event reaches the pipeline."""


class PostprocessPipelineError(RuntimeError):
    """A failed step with enough local state to support a later retry."""

    def __init__(
        self,
        message: str,
        *,
        run_directory: Path,
        failed_index: int,
        current_project: Path,
        current_srt: Path,
        completed_steps: Sequence[str],
    ) -> None:
        super().__init__(message)
        self.run_directory = run_directory
        self.failed_index = failed_index
        self.current_project = current_project
        self.current_srt = current_srt
        self.completed_steps = tuple(completed_steps)


PipelineEvent = Callable[[Mapping[str, object]], None]


def run_postprocess_pipeline(
    plan: Mapping[str, object],
    *,
    media_path: Path,
    project_path: Path,
    srt_path: Path,
    env_path: Path,
    ffmpeg_path: Path | None,
    cancel_event: Event,
    on_event: PipelineEvent | None = None,
    llm_settings: Mapping[str, Mapping[str, str]] | None = None,
    resume_directory: Path | None = None,
    resume_from: int = 0,
    resume_project_path: Path | None = None,
    resume_srt_path: Path | None = None,
) -> PipelineResult:
    normalized, errors = validate_plan(plan, env_path=env_path, media_path=media_path, ffmpeg_path=ffmpeg_path, llm_settings=llm_settings)
    if errors:
        raise ValueError(errors[0]["message"])
    steps = enabled_steps(normalized)
    if not steps:
        raise ValueError("自动后处理没有选择任何步骤。")
    run_directory = resume_directory.expanduser().resolve() if resume_directory is not None else _create_run_directory(media_path)
    if resume_directory is not None and not run_directory.is_dir():
        raise ValueError(f"找不到可恢复的后处理目录：{run_directory}")
    manifest: dict[str, object]
    if resume_directory is not None:
        manifest = _load_manifest(run_directory)
    else:
        manifest = {
            "version": POSTPROCESS_PLAN_VERSION,
            "mediaPath": str(media_path),
            "sourceProjectPath": str(project_path),
            "sourceSrtPath": str(srt_path),
            "retainIntermediate": bool(normalized.get("retainIntermediate")),
            "steps": [{"id": str(step["id"]), "status": "pending"} for step in steps],
        }
    _write_manifest(run_directory, manifest)
    _emit(on_event, {"stage": "start", "total": len(steps), "resumed": resume_directory is not None, "runDirectory": str(run_directory)})
    current_project = resume_project_path or project_path
    current_srt = resume_srt_path or srt_path
    completed: list[str] = [str(step["id"]) for step in steps[:max(0, resume_from)]]
    warnings: list[str] = []
    try:
        for index, step in enumerate(steps[max(0, resume_from):], max(0, resume_from) + 1):
            _check_cancel(cancel_event)
            step_id = str(step["id"])
            manifest_steps = manifest["steps"]
            assert isinstance(manifest_steps, list)
            manifest_steps[index - 1]["status"] = "running"
            _write_manifest(run_directory, manifest)
            _emit(on_event, {"stage": "step_start", "index": index, "total": len(steps), "step": step_id})
            try:
                artifact = _run_step(
                    step,
                    project_path=current_project,
                    srt_path=current_srt,
                    media_path=media_path,
                    env_path=env_path,
                    ffmpeg_path=ffmpeg_path,
                    output_directory=run_directory,
                    cancel_event=cancel_event,
                    on_event=on_event,
                    llm_settings=llm_settings,
                )
            except PostprocessCancelled:
                raise
            except Exception as error:
                raise PostprocessPipelineError(
                    str(error),
                    run_directory=run_directory,
                    failed_index=index - 1,
                    current_project=current_project,
                    current_srt=current_srt,
                    completed_steps=completed,
                ) from error
            _check_cancel(cancel_event)
            current_project = artifact.project_path or current_project
            current_srt = artifact.srt_path or current_srt
            completed.append(step_id)
            warnings.extend(artifact.warnings)
            manifest_steps[index - 1]["status"] = "done"
            manifest_steps[index - 1]["projectPath"] = str(current_project)
            manifest_steps[index - 1]["srtPath"] = str(current_srt)
            _write_manifest(run_directory, manifest)
            _emit(on_event, {
                "stage": "step_done",
                "index": index,
                "total": len(steps),
                "step": step_id,
                "projectName": current_project.name,
                "srtName": current_srt.name,
            })
        final_project, final_srt = _publish_final(project_path, srt_path, current_project, current_srt)
        manifest["status"] = "done"
        manifest["finalProjectPath"] = str(final_project)
        manifest["finalSrtPath"] = str(final_srt)
        _write_manifest(run_directory, manifest)
        _emit(on_event, {"stage": "done", "total": len(steps), "projectName": final_project.name, "srtName": final_srt.name})
        result = PipelineResult(final_project, final_srt, run_directory, tuple(completed), tuple(warnings))
        if not bool(normalized.get("retainIntermediate")):
            shutil.rmtree(run_directory, ignore_errors=True)
        return result
    except PostprocessCancelled:
        manifest["status"] = "cancelled"
        _write_manifest(run_directory, manifest)
        _emit(on_event, {"stage": "cancelled", "completed": len(completed), "total": len(steps), "runDirectory": str(run_directory)})
        raise
    except Exception:
        manifest["status"] = "failed"
        _write_manifest(run_directory, manifest)
        _emit(on_event, {"stage": "failed", "completed": len(completed), "total": len(steps), "runDirectory": str(run_directory)})
        raise


def _run_step(
    step: Mapping[str, object],
    *,
    project_path: Path,
    srt_path: Path,
    media_path: Path,
    env_path: Path,
    ffmpeg_path: Path | None,
    output_directory: Path,
    cancel_event: Event,
    on_event: PipelineEvent | None,
    llm_settings: Mapping[str, Mapping[str, str]] | None,
) -> SubtitleArtifact:
    step_id = str(step["id"])
    output_mode = OutputMode.BOTH
    if step_id == "match":
        return run_script_match(ScriptMatchRequest(
            project_path=project_path,
            srt_path=srt_path,
            script_path=Path(str(step.get("scriptPath") or "")).expanduser(),
            output_mode=output_mode,
            output_directory=output_directory,
        ))
    if step_id == "replace":
        replacements = tuple(
            Replacement(source=str(item.get("source") or ""), target=str(item.get("target") or ""))
            for item in _normalize_replacements(step.get("replacements"))
            if isinstance(item, Mapping) and str(item.get("source") or "")
        )
        return run_fixed_replacement(ReplacementRequest(
            project_path=project_path,
            srt_path=srt_path,
            output_mode=output_mode,
            replacements=replacements,
            output_directory=output_directory,
        ))
    if step_id == "ocr":
        if ffmpeg_path is None:
            raise ValueError("找不到 FFmpeg，无法执行 OCR 字幕去重。")
        region_mode = str(step.get("regionMode") or "full")
        region = OcrRegion(
            mode=region_mode,
            x1=float(_number_or_default(step.get("regionX1"), 0)) / 100,
            y1=float(_number_or_default(step.get("regionY1"), 0)) / 100,
            x2=float(_number_or_default(step.get("regionX2"), 100)) / 100,
            y2=float(_number_or_default(step.get("regionY2"), 100)) / 100,
        )
        def on_status(key: str, details: Mapping[str, int]) -> None:
            _check_cancel(cancel_event)
            _emit(on_event, {"stage": "detail", "step": step_id, "key": key, **dict(details)})
        return run_ocr_dedup(OcrDedupRequest(
            project_path=project_path,
            srt_path=srt_path,
            video_path=Path(str(step.get("videoPath") or "")).expanduser() if str(step.get("videoPath") or "").strip() else None,
            fallback_video_path=media_path,
            output_mode=output_mode,
            region=region,
            threshold=float(_number_or_default(step.get("threshold"), 0.5)),
            report=bool(step.get("report")),
            output_directory=output_directory,
        ), ffmpeg_path=ffmpeg_path, on_status=on_status)
    operation = "translate_zh" if step_id == "translate" and str(step.get("target") or "zh") == "zh" else (
        "translate_en" if step_id == "translate" else step_id
    )
    provider_id = str(step.get("providerId") or "deepseek")
    values = dict(llm_settings.get(provider_id)) if llm_settings and provider_id in llm_settings else _llm_values(env_path, provider_id)
    settings = LlmSettings(
        provider_id=provider_id,
        api_key=values["apiKey"],
        base_url=values["baseUrl"],
        model=values["model"],
        reasoning_mode=normalize_reasoning_mode(values.get("reasoningMode", DEFAULT_REASONING_MODE)),
    )
    def complete(prompt: str, cues: list[dict[str, JsonValue]]) -> Mapping[str, JsonValue]:
        _check_cancel(cancel_event)
        return complete_subtitle_groups(settings, prompt, cues)

    def on_status(key: str, details: Mapping[str, int]) -> None:
        _check_cancel(cancel_event)
        _emit(on_event, {"stage": "detail", "step": step_id, "key": key, **dict(details)})

    return run_llm_postprocess(LlmPostprocessRequest(
        project_path=project_path,
        srt_path=srt_path,
        output_mode=output_mode,
        operation=operation,
        custom_prompt=str(step.get("customPrompt") or "").strip(),
        output_directory=output_directory,
    ), complete=complete, on_status=on_status)


def _create_run_directory(media_path: Path) -> Path:
    root = media_path.expanduser().resolve().parent / POSTPROCESS_WORKSPACE_NAME
    root.mkdir(parents=True, exist_ok=True)
    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", media_path.stem).strip(".-") or "media"
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = root / f"{stem}-{timestamp}"
    candidate = base
    counter = 2
    while True:
        try:
            candidate.mkdir()
            return candidate.resolve()
        except FileExistsError:
            candidate = root / f"{base.name}-{counter}"
            counter += 1


def _publish_final(source_project: Path, source_srt: Path, project: Path, srt: Path) -> tuple[Path, Path]:
    source_srt = source_srt.expanduser().resolve()
    source_project = source_project.expanduser().resolve()
    suffix = source_project.suffix.lower() if source_project.suffix.lower() in {".mosp", ".json"} else ".mosp"
    base = source_srt.with_name(f"{source_srt.stem}.postprocess")
    counter = 1
    while True:
        marker = "" if counter == 1 else f"-{counter}"
        final_srt = base.with_name(f"{base.name}{marker}.srt")
        final_project = base.with_name(f"{base.name}{marker}{suffix}")
        if not final_srt.exists() and not final_project.exists():
            _copy_atomic(srt, final_srt)
            _copy_atomic(project, final_project)
            return final_project.resolve(), final_srt.resolve()
        counter += 1


def _copy_atomic(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".tmp", dir=destination.parent)
    os.close(descriptor)
    try:
        shutil.copyfile(source, temporary_name)
        os.replace(temporary_name, destination)
    except OSError:
        Path(temporary_name).unlink(missing_ok=True)
        raise


def _write_manifest(directory: Path, payload: Mapping[str, object]) -> None:
    target = directory / "manifest.json"
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(prefix=".manifest.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary_name, target)
    except (OSError, UnicodeError):
        Path(temporary_name).unlink(missing_ok=True)
        raise


def _load_manifest(directory: Path) -> dict[str, object]:
    try:
        raw = json.loads((directory / "manifest.json").read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise ValueError(f"无法读取后处理恢复清单：{directory}") from error
    if not isinstance(raw, dict):
        raise ValueError(f"后处理恢复清单格式无效：{directory}")
    return raw


def _save_config(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
        os.replace(temporary_name, path)
    except (OSError, UnicodeError):
        Path(temporary_name).unlink(missing_ok=True)
        raise


def _normalize_replacements(value: object) -> list[dict[str, str]]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        return []
    return [
        {"source": str(item.get("source") or "").strip(), "target": str(item.get("target") or "")}
        for item in value
        if isinstance(item, Mapping) and str(item.get("source") or "").strip()
    ]


def _number_or_default(value: object, default: object) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _snapshot_provider_status(values: Mapping[str, str] | None) -> dict[str, object]:
    values = values or {}
    return {
        "verified": bool(values.get("verified", "")),
        "hasApiKey": bool(values.get("apiKey", "")),
        "hasBaseUrl": bool(values.get("baseUrl", "")),
        "hasModel": bool(values.get("model", "")),
    }


def _check_cancel(cancel_event: Event) -> None:
    if cancel_event.is_set():
        raise PostprocessCancelled("后处理已取消。")


def _emit(callback: PipelineEvent | None, event: Mapping[str, object]) -> None:
    if callback is not None:
        callback(event)
