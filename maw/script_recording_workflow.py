"""ASR evidence -> existing take review -> script timestamps in source time.

This module adds a conservative review layer, not a new candidate matcher.
"""
from __future__ import annotations

import copy
import hashlib
import json
import os
import tempfile
import unicodedata
import uuid
import wave
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any

from maw.postprocess_io import write_artifacts
from maw.project import normalize_project
from maw.project_io import strip_inline_caches
from maw.script_alignment import (
    align_project_to_script, apply_alignment_to_project, make_selection_manifest,
    normalize_alignment_text,
)
from maw.script_timestamp_alignment import (
    MAX_SCRIPT_ALIGNMENT_MS, read_script_lines, tokens_to_script_segments,
)
from maw.timestamp_alignment import (
    AlignmentBackend, QwenForcedAlignerBackend, _check_cancel,
)
from maw.ffmpeg import resolve_ffmpeg_tool
from maw.media import resolve_default_audio_track


class RecordingWorkflowError(ValueError):
    """A review or source-time contract is not satisfied."""


def _digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(",", ":")).encode("utf-8")).hexdigest()


def input_signature(project_path: Path, script_path: Path, media: Path) -> str:
    stat = media.stat()
    return _digest([1, str(project_path.resolve()), hashlib.sha256(project_path.read_bytes()).hexdigest(),
                    str(script_path.resolve()), hashlib.sha256(script_path.read_bytes()).hexdigest(),
                    str(media.resolve()), stat.st_size, stat.st_mtime_ns])


def validate_media_binding(project: Mapping[str, Any], project_path: Path, media: Path) -> None:
    declared = str(project.get("media") or "").strip()
    if declared:
        expected = Path(declared).expanduser()
        if not expected.is_absolute():
            expected = project_path.parent / expected
        if expected.is_file() and not expected.samefile(media):
            raise RecordingWorkflowError("所选媒体与 ASR 工程绑定的录音不同；请使用对应录音，不能把旧识别套到另一份声音。")


def evidence_errors(project: Mapping[str, Any], source_confirmed: bool) -> list[str]:
    errors = []
    metadata = project.get("script_alignment")
    if metadata is not None and not isinstance(metadata, Mapping):
        errors.append("口播审查元数据格式无效；请使用原始 ASR 工程。")
    recording = metadata.get("recording") if isinstance(metadata, Mapping) else None
    if recording or "aligner" in str(project.get("model", "")).lower():
        errors.append("文稿时间码工程不能当作独立 ASR 证据；请选择原始 ASR 工程。")
    if project.get("translation") or project.get("overlay_track") or project.get("subtitle_tracks"):
        errors.append("此流程目前支持单主字幕轨原始 ASR 工程。")
    if not source_confirmed:
        errors.append("请确认输入是未被文稿替换的原始 ASR 结果。")
    return errors


def canonical_review_request(request: Mapping[str, Any], gap_remove: Mapping[str, Any]) -> dict[str, Any]:
    """Persist semantic review choices, never transport tokens or client paths."""
    maps = {}
    for key in ("selectedByLine", "candidateActions", "extraActions", "confirmedByLine"):
        value = request.get(key, {})
        if not isinstance(value, dict) or any(not isinstance(k, str) or
                (not isinstance(v, str) and not (key == "selectedByLine" and v is None))
                for k, v in value.items()):
            raise RecordingWorkflowError("选择与确认必须是字符串键值对象。")
        maps[key] = dict(value)
    # The existing gap normalizer supplies validated provenance and integer ranges.
    gap_keys = ("schema", "detector", "minimum_ms", "threshold_db", "hysteresis_db",
                "lead_in_ms", "lead_out_ms", "disable_coverage_percent", "disable_remaining_ms",
                "skip_playback", "manual_corrections", "operation_mode", "gaps", "provenance")
    return {**maps, "inputSignature": str(request.get("inputSignature") or ""),
            "sourceConfirmed": request.get("sourceConfirmed") is True,
            "preferLatest": request.get("preferLatest") is True,
            "gapRemove": copy.deepcopy({k: gap_remove[k] for k in gap_keys if k in gap_remove})}


def _candidate_slices(alignment: Mapping[str, Any], selection: Mapping[str, Any],
                      candidate_id: str) -> list[dict[str, Any]]:
    for record in selection.get("keepRanges", []):
        if record.get("id") == candidate_id:
            return copy.deepcopy(record.get("sourceSlices", []))
    return []


def _slice_text(slices: list[dict[str, Any]]) -> str:
    return "".join(str(part.get("sourceText", "")) for part in slices)


def _source_speakers(project: Mapping[str, Any], slices: list[dict[str, Any]]) -> set[str]:
    source = {str(c.get("id") or f"main-{i + 1:03d}"): c
              for i, c in enumerate(project.get("segments", []))}
    labels = set()
    for part in slices:
        cue = source.get(str(part.get("sourceCueId")), {})
        items = (cue.get("items") or [])[part.get("itemStart", 0):part.get("itemEnd")]
        labels.update(str(item.get("speaker") or cue.get("speaker") or "") for item in items)
        if not items:
            labels.add(str(cue.get("speaker") or ""))
    return labels


def recommend_recording(project: Mapping[str, Any], script: str, *,
                        source_confirmed: bool = False, prefer_latest: bool = False,
                        alignment: dict[str, Any] | None = None) -> dict[str, Any]:
    alignment = alignment or align_project_to_script(project, script)
    rows, recommended = [], {}
    for line, candidates in zip(alignment["scriptLines"], alignment["candidatesByLine"]):
        exact = []
        for candidate in candidates:
            if candidate["status"] != "match":
                continue
            manifest = make_selection_manifest(alignment, {line["id"]: candidate["id"]})
            slices = _candidate_slices(alignment, manifest, candidate["id"])
            if normalize_alignment_text(_slice_text(slices)) == normalize_alignment_text(line["text"]):
                exact.append(candidate)
        chosen = None
        reason = "没有逐字对应的完整候选；请试听确认差异。"
        if len(exact) == 1:
            chosen, reason = exact[0], "唯一完整候选与独立 ASR 文字对应。"
        elif exact:
            groups = {item.get("alternativeGroupId") for item in exact}
            if prefer_latest and len(groups) == 1 and None not in groups and "" not in groups:
                chosen = max(exact, key=lambda item: item["start"])
                reason = "按已选规则：局部录制组内优先最后完整念读。"
            else:
                reason = "有多个完整念读；请试听选择，不能以匹配分数判断表现。"
        if chosen:
            recommended[line["id"]] = chosen["id"]
        rows.append({"lineId": line["id"], "text": line["text"],
                     "candidateId": chosen["id"] if chosen else None,
                     "reason": reason, "needsReview": chosen is None})
    return {"lines": rows, "recommendedSelection": recommended,
            "evidenceErrors": evidence_errors(project, source_confirmed),
            "policy": "latest-local" if prefer_latest else "unique-exact",
            "warnings": ["ASR 也可能听错；推荐不是声音读对的保证，请试听。",
                         "额外内容默认保留；最终字幕包含文稿行与保留的额外字幕。"]}


def review_recording(project: Mapping[str, Any], alignment: dict[str, Any],
                     request: Mapping[str, Any], *, gap_remove: Mapping[str, Any] | None = None
                     ) -> tuple[dict[str, Any], dict[str, Any], dict[str, Any]]:
    selected = request.get("selectedByLine", {})
    candidate_actions = request.get("candidateActions", {})
    extra_actions = request.get("extraActions", {})
    confirmed = request.get("confirmedByLine", {})
    if not all(isinstance(value, dict) for value in (selected, candidate_actions, extra_actions, confirmed)):
        raise RecordingWorkflowError("选择、确认与额外内容操作必须是对象。")
    selection = make_selection_manifest(alignment, selected,
                                        candidate_actions=candidate_actions, extra_actions=extra_actions)
    if gap_remove is not None and not isinstance(gap_remove, Mapping):
        raise RecordingWorkflowError("静音切除状态必须是对象。")
    reviewed = apply_alignment_to_project(project, alignment, selection, gap_remove_override=gap_remove)
    snapshot = canonical_review_request(request, reviewed.get("gap_remove", {}))
    chosen = {c["lineId"]: c for c in selection["selected"]}
    blockers = [{"lineId": "", "reason": error}
                for error in evidence_errors(project, request.get("sourceConfirmed") is True)]
    lines = []
    previous_end = -1
    for line in alignment["scriptLines"]:
        entry = chosen.get(line["id"])
        reasons = []
        slices = []
        speaker = ""
        if entry is None:
            reasons.append("没有选择对应的完整念读；不能补出未读文字。")
        else:
            slices = _candidate_slices(alignment, selection, entry["candidateId"])
            if entry.get("status") != "match" or entry.get("manualDisabled") is True:
                reasons.append("未读完整或已禁用；手动启用半句不能补成完整文稿。")
            if not slices:
                reasons.append("所选候选没有有效源切片。")
            else:
                speakers = _source_speakers(project, slices)
                if len(speakers) > 1:
                    reasons.append("本行来源说话人不一致；请按已确认的说话人边界拆分文稿。")
                elif speakers:
                    speaker = next(iter(speakers))
                if slices[0]["start"] < previous_end:
                    reasons.append("选声范围重叠或与文稿顺序冲突。")
                previous_end = slices[-1]["end"]
                if any(type(p.get(k)) is not int for p in slices for k in ("start", "end")):
                    reasons.append("源时间必须是整数毫秒。")
                if sum(p["end"] - p["start"] for p in slices) > MAX_SCRIPT_ALIGNMENT_MS:
                    reasons.append("本行声音超过300秒；请在已确认边界拆分文稿。")
                if normalize_alignment_text(_slice_text(slices)) != normalize_alignment_text(line["text"]):
                    if confirmed.get(line["id"]) != entry["candidateId"]:
                        reasons.append("文稿与 ASR 有差异（包括数字、否定和术语）；请试听后确认此候选。")
                competitors = [c for c in alignment["candidatesByLine"][int(line["id"].split("-")[-1]) - 1]
                               if c["status"] == "match"]
                if len(competitors) > 1 and confirmed.get(line["id"]) != entry["candidateId"]:
                    policy = request.get("preferLatest") is True
                    groups = {c.get("alternativeGroupId") for c in competitors}
                    latest = max(competitors, key=lambda c: c["start"])
                    if not (policy and len(groups) == 1 and None not in groups and "" not in groups
                            and latest["id"] == entry["candidateId"]):
                        reasons.append("多个念读候选，需要确认这一次选择。")
        for reason in reasons:
            blockers.append({"lineId": line["id"], "reason": reason})
        lines.append({"lineId": line["id"], "text": line["text"],
                      "candidateId": entry["candidateId"] if entry else None,
                      "sourceSlices": slices, "sourceText": _slice_text(slices), "speaker": speaker, "reasons": reasons})
    for extra in selection.get("unresolvedExtraIds", []):
        blockers.append({"lineId": "", "reason": f"额外片段 {extra} 仍待复核。"})
    review = {"ready": not blockers, "blockers": blockers, "lines": lines,
              "selectionDigest": _digest(snapshot), "request": snapshot,
              "keptExtraCount": len(selection.get("keptExtras", []))}
    return review, selection, reviewed


def _ranges_without_gaps(slices: list[dict[str, Any]], gaps: list[dict[str, Any]]) -> list[tuple[int, int]]:
    ranges = []
    for part in slices:
        current = [(part["start"], part["end"])]
        for gap in gaps:
            if gap.get("removed") is False:
                continue
            left, right = gap["start"], gap["end"]
            current = [(a, b) for start, end in current
                       for a, b in ((start, min(end, left)), (max(start, right), end)) if a < b]
        ranges.extend(current)
    merged = []
    for start, end in ranges:
        if merged and start == merged[-1][1]:
            merged[-1] = (merged[-1][0], end)
        else:
            if merged and start < merged[-1][1]:
                raise RecordingWorkflowError("源切片重叠。")
            merged.append((start, end))
    if not merged:
        raise RecordingWorkflowError("本行所有声音均被空隙移除。")
    return merged


def map_joined_items(items: list[dict[str, Any]], ranges: list[tuple[int, int]]) -> list[dict[str, Any]]:
    """Map each complete model item to one source run; never interpolate across a cut."""
    offsets, cursor = [], 0
    for start, end in ranges:
        offsets.append((cursor, cursor + end - start, start))
        cursor += end - start
    mapped = []
    for item in items:
        span = next((r for r in offsets if r[0] <= item["start"] < item["end"] <= r[1]), None)
        if span is None:
            raise RecordingWorkflowError("模型字词跨越拼接点；请改选连续完整念读或调整切片，不按字数硬拆。")
        mapped.append({**item, "start": span[2] + item["start"] - span[0],
                       "end": span[2] + item["end"] - span[0]})
    return mapped


def _decode_recording_audio(project: Mapping[str, Any], media: Path, audio: Path, *,
                            cancel_event: Any = None, on_event: Callable[[str], None] | None = None) -> None:
    """Decode the evidence track without changing its source-time origin."""
    from maw.local_runtime import LocalRuntimeCancelled, LocalRuntimeError, _run_process
    from threading import Event
    ffmpeg = resolve_ffmpeg_tool("ffmpeg")
    if not ffmpeg:
        raise RecordingWorkflowError("找不到 FFmpeg，无法准备选中的声音。")
    metadata = project.get("media_metadata") or {}
    track = resolve_default_audio_track(media, metadata.get("selected_audio_track"))
    _run_process([str(ffmpeg), "-v", "error", "-i", str(media), "-map", f"0:a:{track}",
                  "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-y", str(audio)],
                 cancel=cancel_event or Event(), on_line=on_event or (lambda _: None),
                 cwd=str(audio.parent), env=dict(os.environ),
                 error_class=LocalRuntimeError, cancelled_class=LocalRuntimeCancelled,
                 cancelled_message="文稿生成已取消。", message_prefix="声音准备")


def finalize_recording(project: Mapping[str, Any], alignment: dict[str, Any], request: Mapping[str, Any],
                       media: Path, *, backend: AlignmentBackend | None = None,
                       model_path: Path | None = None, device: str = "auto", language: str = "zh",
                       cancel_event: Any = None, on_event: Callable[[str], None] | None = None
                       ) -> tuple[dict[str, Any], dict[str, Any]]:
    review, selection, reviewed = review_recording(project, alignment, request,
                                                    gap_remove=request.get("gapRemove"))
    if not review["ready"]:
        raise RecordingWorkflowError("; ".join(f'{b["lineId"]}: {b["reason"]}' for b in review["blockers"]))
    from maw.language import normalize_language_code
    from maw.alignment_models import QWEN_FORCED_ALIGNER_MODEL_ID, alignment_model_by_id
    language = normalize_language_code(project.get("language") or language)
    if language not in alignment_model_by_id(QWEN_FORCED_ALIGNER_MODEL_ID).languages:
        raise RecordingWorkflowError("请在 ASR 工程中指定对齐器支持的语言。")
    aligner = backend or QwenForcedAlignerBackend(model_path=model_path or "", device=device)
    emit = on_event or (lambda _: None)
    generated = []
    used_ranges = []
    with tempfile.TemporaryDirectory(prefix="maw-recording-align-") as directory:
        root = Path(directory)
        audio = root / "source.wav"
        _decode_recording_audio(project, media, audio, cancel_event=cancel_event, on_event=emit)
        gaps = reviewed.get("gap_remove", {}).get("gaps", [])
        for index, line in enumerate(review["lines"]):
            _check_cancel(cancel_event)
            ranges = _ranges_without_gaps(line["sourceSlices"], gaps)
            used_ranges.extend(ranges)
            emit(f"文稿第 {index + 1}/{len(review['lines'])} 行：对齐 {len(ranges)} 个源片段")
            joined = root / "joined.wav"
            # PCM frame slicing is bounded to one <=300s line, with exact millisecond boundaries.
            with wave.open(str(audio), "rb") as source, wave.open(str(joined), "wb") as target:
                target.setparams(source.getparams())
                rate = source.getframerate()
                for start, end in ranges:
                    source.setpos(round(start * rate / 1000))
                    frames = source.readframes(round((end - start) * rate / 1000))
                    if len(frames) != round((end - start) * rate / 1000) * source.getsampwidth():
                        raise RecordingWorkflowError("源范围超出实际音轨时长。")
                    target.writeframes(frames)
            duration = sum(end - start for start, end in ranges)
            tokens = aligner.align(joined, unicodedata.normalize("NFC", line["text"]), language=language)
            cue = tokens_to_script_segments([line["text"]], tokens, 0, duration)[0]
            cue["items"] = map_joined_items(cue["items"], ranges)
            if line["speaker"]:
                cue["speaker"] = line["speaker"]
                for item in cue["items"]:
                    item["speaker"] = line["speaker"]
            cue["start"], cue["end"] = cue["items"][0]["start"], cue["items"][-1]["end"]
            generated.append(cue)
    _check_cancel(cancel_event)
    # Replace overlapping source cues; preserve full ASR evidence in the original project and report.
    output = copy.deepcopy(reviewed)
    used_ids = {str(c.get("id", "")) for c in output["segments"]}
    retained = []
    replaced_ids = []
    for cue in output["segments"]:
        overlaps = any(cue["start"] < g["end"] and g["start"] < cue["end"] for g in generated)
        selected_source = any(cue["start"] < b and a < cue["end"] for a, b in used_ranges)
        if overlaps:
            if not selected_source and cue.get("disabled") is not True:
                raise RecordingWorkflowError("保留的额外字幕处于一行文稿的跨段范围内；请拆分文稿或改选连续念读。")
            replaced_ids.append(cue.get("id"))
        else:
            retained.append(cue)
    output["segments"] = retained
    for index, cue in enumerate(generated, 1):
        identifier = f"script-recording-{index:03d}"
        while identifier in used_ids:
            identifier += "-new"
        used_ids.add(identifier)
        cue["id"] = identifier
    output["segments"].extend(generated)
    output["segments"].sort(key=lambda cue: (cue["start"], cue["end"]))
    from maw.timestamp_alignment import _project_granularity
    output["timestamp_granularity"] = _project_granularity(output)
    output["preserve_punctuation"] = True
    output["media"] = str(media.resolve())
    output["script_alignment"]["recording"] = {
        "version": 1, "selectionDigest": review["selectionDigest"],
        "sourceEvidence": "asr-confirmed", "generatedCueIds": [cue["id"] for cue in generated],
        "replacedSourceIds": replaced_ids,
        "warnings": ["文稿为字幕真值；ASR与自动推荐仍需听审，不代表实际读对或表现选优。"],
    }
    return normalize_project(output), review


def load_recording_inputs(project_path: Path, script_path: Path, media: Path | None = None
                          ) -> tuple[dict[str, Any], str, Path]:
    from maw.postprocess_io import read_project
    project = read_project(project_path)
    script = "\n".join(read_script_lines(script_path))
    value = media or Path(str(project.get("media", "")))
    if not value.is_absolute():
        value = project_path.parent / value
    value = value.resolve()
    if not value.is_file():
        raise RecordingWorkflowError("ASR 工程媒体不存在。")
    validate_media_binding(project, project_path, value)
    return project, script, value


def _rebase_published_media(staged_project: Path, final_directory: Path, media: Path) -> None:
    """Prepare a staged project's media reference for its final publication path."""
    from maw.project_io import rebase_project_media

    project = json.loads(staged_project.read_text(encoding="utf-8"))
    published = rebase_project_media(project, final_directory / staged_project.name, media_path=media)
    staged_project.write_text(json.dumps(published, ensure_ascii=False, indent=2) + "\n",
                              encoding="utf-8", newline="\n")


def run_recording_job(project_path: Path, script_path: Path, request: Mapping[str, Any], *,
                      media: Path | None = None, backend: AlignmentBackend | None = None,
                      model_path: Path | None = None, device: str = "auto", language: str = "zh",
                      cancel_event: Any = None, on_event: Callable[[str], None] | None = None
                      ) -> dict[str, Any]:
    project, script, media = load_recording_inputs(project_path, script_path, media)
    signature = input_signature(project_path, script_path, media)
    if request.get("inputSignature") != signature:
        raise RecordingWorkflowError("输入已变化；请重新打开审查页，旧选择不再有效。")
    alignment = align_project_to_script(project, script)
    output, review = finalize_recording(project, alignment, request, media, backend=backend,
                                        model_path=model_path, device=device, language=language,
                                        cancel_event=cancel_event, on_event=on_event)
    _check_cancel(cancel_event)
    if input_signature(project_path, script_path, media) != signature:
        raise RecordingWorkflowError("生成期间输入已变化；拒绝写出旧结果。")
    final_directory = project_path.parent / f"{project_path.stem}.script-reviewed-{uuid.uuid4().hex[:8]}"
    # Publish a whole directory only after MOSP, SRT and completion report are ready.
    with tempfile.TemporaryDirectory(prefix=".maw-recording-stage-", dir=project_path.parent) as directory:
        staging = Path(directory) / "result"
        staging.mkdir()
        artifact = write_artifacts(strip_inline_caches(output), source_project_path=project_path,
                                   source_srt_path=None, operation="script-reviewed", write_project=True,
                                   write_srt=True, output_directory=staging)
        _rebase_published_media(artifact.project_path, final_directory, media)
        result = {"projectPath": str(final_directory / artifact.project_path.name),
                  "srtPath": str(final_directory / artifact.srt_path.name),
                  "reportPath": str(final_directory / "report.json"),
                  "warnings": output["script_alignment"]["recording"]["warnings"]}
        report = {"version": 1, "status": "complete", "inputSignature": signature,
                  "sourceProjectPath": str(project_path.resolve()), "scriptPath": str(script_path.resolve()),
                  "request": review.get("request", {}), "review": review, "artifact": result}
        (staging / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n",
                                           encoding="utf-8", newline="\n")
        _check_cancel(cancel_event)
        if input_signature(project_path, script_path, media) != signature:
            raise RecordingWorkflowError("写出前输入已变化；请重新审查。")
        os.replace(staging, final_directory)
    return result


def run_source_items_job(project_path: Path, script_path: Path, request: Mapping[str, Any], *,
                         media: Path | None = None, model_path: Path | None = None,
                         device: str = "auto", cancel_event: Any = None,
                         on_event: Callable[[str], None] | None = None) -> dict[str, Any]:
    """Fill original ASR items using the existing aligner; publish only a complete result."""
    from maw.alignment_models import QWEN_FORCED_ALIGNER_MODEL_ID
    from maw.timestamp_alignment import align_project
    project, _, media = load_recording_inputs(project_path, script_path, media)
    errors = evidence_errors(project, request.get("sourceConfirmed") is True)
    if errors:
        raise RecordingWorkflowError("; ".join(errors))
    signature = input_signature(project_path, script_path, media)
    if request.get("inputSignature") != signature:
        raise RecordingWorkflowError("输入已变化；请重新打开审查页。")
    _check_cancel(cancel_event)
    emit = on_event or (lambda _: None)
    emit("正在补充原始 ASR 字词码；保留识别文字。")
    final_directory = project_path.parent / f"{project_path.stem}.asr-items-reviewed-{uuid.uuid4().hex[:8]}"
    with tempfile.TemporaryDirectory(prefix=".maw-recording-stage-", dir=project_path.parent) as directory:
        staging = Path(directory) / "result"
        staging.mkdir()
        audio = Path(directory) / "source.wav"
        _decode_recording_audio(project, media, audio, cancel_event=cancel_event, on_event=emit)
        report = align_project(project, media_path=audio, model_id=QWEN_FORCED_ALIGNER_MODEL_ID,
                               mode="fill", model_path=model_path or "", device=device,
                               cancel_event=cancel_event, on_event=emit)
        _check_cancel(cancel_event)
        if report.failed_segments:
            raise RecordingWorkflowError("部分 ASR 源段补码失败；不发布部分工程，请保留原始 ASR 后重试。")
        if input_signature(project_path, script_path, media) != signature:
            raise RecordingWorkflowError("补码期间输入已变化；拒绝发布旧结果。")
        # Preserve the selected source while artifacts are written to staging;
        # rebase to the published location before moving the whole directory.
        project["media"] = str(media.resolve())
        artifact = write_artifacts(strip_inline_caches(project), source_project_path=project_path,
                                   source_srt_path=None, operation="timestamps", write_project=True,
                                   write_srt=False, output_directory=staging, media_path=media,
                                   warnings=report.warnings)
        _rebase_published_media(artifact.project_path, final_directory, media)
        result = {"projectPath": str(final_directory / artifact.project_path.name),
                  "reportPath": str(final_directory / "report.json"), "warnings": list(report.warnings)}
        payload = {"version": 1, "status": "complete", "operation": "source-items",
                   "inputSignature": signature, "report": report.to_payload(), "artifact": result}
        (staging / "report.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
                                           encoding="utf-8", newline="\n")
        _check_cancel(cancel_event)
        if input_signature(project_path, script_path, media) != signature:
            raise RecordingWorkflowError("写出前输入已变化；请重新审查。")
        os.replace(staging, final_directory)
    return result
