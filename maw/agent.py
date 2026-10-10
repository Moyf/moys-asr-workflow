"""File-based Agent contract. Never writes the source project or starts a service."""
from __future__ import annotations

import argparse
import contextlib
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import tempfile
import uuid

from maw.project import normalize_project
from maw.console import configure_utf8_stdio

SNAPSHOT = "moy.asr.agent.snapshot.v1"
PROPOSAL = "moy.asr.agent.proposal.v1"
JOB = "moy.asr.agent.job.v1"
MAX_BYTES = 64 * 1024 * 1024
BASIC = {"id", "start", "end", "text", "items", "speaker", "_dirty"}
SOURCE_FIELDS = BASIC | {"start_frame", "end_frame"}


class AgentError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def read_json(path):
    with Path(path).open("rb") as stream:
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise AgentError("too_large", "JSON exceeds 64 MiB")
    def reject_constant(value):
        raise AgentError("invalid_request", "Non-finite numbers are not valid JSON")
    return json.loads(raw.decode("utf-8-sig"), parse_constant=reject_constant)


def read_project(path):
    value = read_json(path)
    context = {}
    if isinstance(value, dict) and value.get("schema") == SNAPSHOT:
        context = value.get("context", {})
        value = value.get("project")
    normalize_project(value)  # validate without changing the review baseline
    return value, context


def write_new(path, value):
    """Exclusive creation prevents accidental replacement of projects or proposals."""
    content = json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"
    with Path(path).open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(content)


def write_status(path, value):
    target = Path(path)
    descriptor, temporary = tempfile.mkstemp(prefix=target.name + ".", dir=target.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, allow_nan=False)
            stream.write("\n")
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def bounds(start, end):
    if type(start) is not int or type(end) is not int or not 0 <= start < end:
        raise AgentError("invalid_range", "Expected integer milliseconds: 0 <= start < end")


def query(project, start=None, end=None, context_ms=0):
    if type(context_ms) is not int or context_ms < 0:
        raise AgentError("invalid_range", "context-ms must be non-negative integer milliseconds")
    if start is None and end is None:
        indices = list(range(len(project["segments"])))
    else:
        bounds(start, end)
        indices = [i for i, s in enumerate(project["segments"])
                   if s["end"] > max(0, start - context_ms) and s["start"] < end + context_ms]
    return [{"index": i, "segment": project["segments"][i],
             "in_range": start is None or (project["segments"][i]["end"] > start
                                          and project["segments"][i]["start"] < end)} for i in indices]


def structural_indices(project, start, end):
    bounds(start, end)
    if project.get("timebase", {}).get("unit") == "frames":
        raise AgentError("unsupported_structure", "Range replacement currently requires millisecond mode")
    if project.get("multi_subtitle", {}).get("tracks"):
        raise AgentError("unsupported_structure", "Range replacement cannot invalidate extension-track bindings")
    indices = [row["index"] for row in query(project, start, end)]
    for i in indices:
        s = project["segments"][i]
        if s["start"] < start or s["end"] > end:
            raise AgentError("boundary_conflict", f"Range cuts segment {i}; include [{s['start']},{s['end']}) explicitly")
    # Index references anywhere in the main track would be shifted by a splice.
    for s in project["segments"]:
        if s.get("sticker_ref") or s.get("color_ref"):
            raise AgentError("unsupported_structure", "Resolve grouped sticker/color references before range replacement")
    for i in indices:
        if any(k not in SOURCE_FIELDS and v is not None for k, v in project["segments"][i].items()):
            raise AgentError("unsupported_structure", "Range contains decorated, disabled, frame-based or unknown segment metadata")
    return indices


def proposal(project, operation, reason):
    if not isinstance(reason, str) or not reason.strip():
        raise AgentError("invalid_request", "A review reason is required")
    return {"schema": PROPOSAL, "id": str(uuid.uuid4()), "reason": reason,
            "base": copy.deepcopy(project), "operation": operation}


def text_proposal(project, edits, reason):
    if not isinstance(edits, list) or not edits:
        raise AgentError("invalid_request", "edits must be a nonempty array of {id,text}")
    ids = {s.get("id") for s in project["segments"]}
    seen = set()
    for edit in edits:
        if not isinstance(edit, dict) or set(edit) != {"id", "text"}:
            raise AgentError("invalid_request", "Each edit must contain only id and text")
        if not isinstance(edit["id"], str) or edit["id"] not in ids or edit["id"] in seen:
            raise AgentError("unknown_segment", "Use unique segment IDs from a fresh editor snapshot")
        if not isinstance(edit["text"], str) or not edit["text"].strip():
            raise AgentError("invalid_request", "Text must be a nonempty string; use range replacement to delete")
        seen.add(edit["id"])
    return proposal(project, {"type": "text", "edits": edits}, reason)


def range_proposal(project, start, end, segments, reason):
    indices = structural_indices(project, start, end)
    if not isinstance(segments, list):
        raise AgentError("invalid_request", "replacement segments must be an array")
    replacement = copy.deepcopy(segments)
    for s in replacement:
        if not isinstance(s, dict) or set(s) - BASIC:
            raise AgentError("unsupported_structure", "Replacement supports text, timings, items and speaker only")
        if type(s.get("start")) is not int or type(s.get("end")) is not int or not start <= s["start"] < s["end"] <= end:
            raise AgentError("invalid_range", "Replacement segment lies outside the requested range")
        s["id"] = "agent-" + uuid.uuid4().hex
        s.pop("_dirty", None)
    insertion = indices[0] if indices else next((i for i, s in enumerate(project["segments"]) if s["start"] >= end), len(project["segments"]))
    candidate = copy.deepcopy(project)
    candidate["segments"][insertion:insertion + len(indices)] = replacement
    normalize_project(candidate)
    return proposal(project, {"type": "replace_range", "start": start, "end": end,
                              "segments": replacement}, reason)


def offset_result(segments, start, end):
    """Clip minor provider overshoot, discard wholly outside cues, then offset once."""
    duration = end - start
    result = copy.deepcopy(segments)
    kept = []
    for s in result:
        if type(s.get("start")) is not int or type(s.get("end")) is not int:
            raise AgentError("invalid_asr_result", "ASR times must be integer milliseconds")
        left, right = max(0, s["start"]), min(duration, s["end"])
        if right <= left:
            continue
        items = s.get("items")
        if items:
            # Dropping timed words without rebuilding text would leave a false transcript.
            if any(type(it.get("start")) is not int or type(it.get("end")) is not int
                   or it["start"] < left or it["end"] > right or it["end"] <= it["start"] for it in items):
                raise AgentError("invalid_asr_result", "ASR words cross clip boundaries; review the result without automatic replacement")
            for item in items:
                item["start"] += start
                item["end"] += start
        s["start"], s["end"] = left + start, right + start
        kept.append(s)
    if not kept:
        raise AgentError("empty_asr_result", "No timed speech returned; no deletion proposal was created")
    normalize_project({"segments": kept})
    return kept


def transcribe_range(project, media, start, end, *, model, context_text="", language=None, adapter=None):
    indices = structural_indices(project, start, end)
    speakers = {project["segments"][i].get("speaker") for i in indices}
    if len(speakers) > 1:
        raise AgentError("unsupported_structure", "Select one speaker at a time; ASR-local speaker IDs cannot identify project speakers")
    # Runtime import keeps read/query/propose dependency-free and never loads credentials.
    if adapter is None:
        import generate_subtitle_qwen_api as adapter
    from maw.ffmpeg import resolve_ffmpeg_tool
    config = adapter._get_config()
    if not config.get("api_key"):
        raise AgentError("missing_credentials", "Configure DASHSCOPE_API_KEY locally before requesting Qwen transcription")
    with tempfile.TemporaryDirectory(prefix="maw-agent-") as temporary:
        audio = str(Path(temporary) / "range.wav")
        ffmpeg = resolve_ffmpeg_tool("ffmpeg", config.get("ffmpeg_path"))
        if ffmpeg is None:
            raise AgentError("missing_ffmpeg", "Install FFmpeg or configure FFMPEG_PATH")
        track = project.get("media_metadata", {}).get("selected_audio_track", 0)
        adapter._run_media_tool([str(ffmpeg), "-nostdin", "-i", str(media), "-ss", f"{start / 1000:.3f}",
                                 "-t", f"{(end - start) / 1000:.3f}", "-map", f"0:a:{track}",
                                 "-vn", "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1", "-y", audio],
                                check=True, capture_output=True, timeout=300)
        result = adapter.transcribe(audio, language or project.get("language"), [], config,
                                    model=model, context_text=context_text, enable_speaker=False)
        options = dict(max_len=24, min_len=5, gap_split_ms=800, split_mode=result.get("split_mode"))
        if result.get("sentences"):
            segments = adapter.build_segments_from_api_sentences(result["sentences"], **options)
        elif result.get("items"):
            segments = adapter.build_segments_preserving_speakers(result["items"], **options)
        elif result.get("segments"):
            segments = adapter.split_coarse_segments(result["segments"], **options)
        else:
            raise AgentError("empty_asr_result", "ASR returned no timed speech")
    segments = offset_result(segments, start, end)
    speaker = next(iter(speakers), None)
    for s in segments:
        if speaker is not None:
            s["speaker"] = speaker
        else:
            s.pop("speaker", None)
        for item in s.get("items", []):
            if speaker is not None:
                item["speaker"] = speaker
            else:
                item.pop("speaker", None)
    return range_proposal(project, start, end, segments, f"Qwen {model}: re-transcribe [{start},{end}) ms")


def parser():
    p = argparse.ArgumentParser(description="MAW Agent JSON interface; source projects are never overwritten")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("capabilities")
    for name in ("read", "query", "propose-text", "propose-range", "retranscribe"):
        command = sub.add_parser(name)
        command.add_argument("project")
        if name in ("query", "propose-range", "retranscribe"):
            command.add_argument("--start", type=int, required=True)
            command.add_argument("--end", type=int, required=True)
        if name == "query":
            command.add_argument("--context-ms", type=int, default=0)
        if name.startswith("propose") or name == "retranscribe":
            command.add_argument("--output", required=True)
        if name.startswith("propose"):
            command.add_argument("--reason", required=True)
            command.add_argument("--edits" if name == "propose-text" else "--replacement", required=True)
        if name == "retranscribe":
            command.add_argument("--media", required=True, help="Explicit local media file; never resolved from untrusted project content")
            command.add_argument("--allow-cloud", action="store_true", help="Authorize uploading only the requested audio range to Qwen")
            command.add_argument("--model", default="qwen-audio-3.0-asr-flash-filetrans")
            command.add_argument("--context", default="", help="Explicit Qwen context, at most 400 characters")
            command.add_argument("--language")
            command.add_argument("--job", required=True, help="New status JSON path, queryable by another process")
    status = sub.add_parser("job")
    status.add_argument("path")
    return p


def main(argv=None):
    args = parser().parse_args(argv)
    job = None
    try:
        if args.command == "capabilities":
            result = {"schema": "moy.asr.agent.capabilities.v1", "time_unit": "integer_milliseconds",
                      "commands": ["read", "query", "propose-text", "propose-range", "retranscribe", "job"],
                      "apply": "Editor review with baseline conflict check and undo; CLI never overwrites projects",
                      "asr": "Qwen; explicit --allow-cloud and --media required"}
        elif args.command == "job":
            result = read_json(args.path)
            if not isinstance(result, dict) or result.get("schema") != JOB:
                raise AgentError("invalid_job", "Not a MAW Agent job status")
        else:
            project, context = read_project(args.project)
            if args.command == "read":
                result = {"project": project, "context": context,
                          "revision": hashlib.sha256(json.dumps(project, sort_keys=True, ensure_ascii=False).encode()).hexdigest()}
            elif args.command == "query":
                result = {"range": [args.start, args.end], "context": context,
                          "segments": query(project, args.start, args.end, args.context_ms)}
            else:
                if Path(args.output).exists():
                    raise AgentError("output_exists", "Choose a new proposal path")
                if args.command == "propose-text":
                    result = text_proposal(project, read_json(args.edits), args.reason)
                elif args.command == "propose-range":
                    replacement, _ = read_project(args.replacement)
                    result = range_proposal(project, args.start, args.end, replacement["segments"], args.reason)
                else:
                    if not args.allow_cloud:
                        raise AgentError("cloud_not_authorized", "Explicit --allow-cloud is required for paid upload")
                    if len(args.context) > 400:
                        raise AgentError("invalid_request", "context is limited to 400 characters")
                    if args.model not in {"qwen-audio-3.0-asr-flash-filetrans", "qwen-audio-3.1-asr-flash-filetrans", "qwen3-asr-flash-filetrans"}:
                        raise AgentError("invalid_request", "Unsupported Qwen filetrans model")
                    media = Path(args.media).resolve(strict=True)
                    if not media.is_file():
                        raise AgentError("invalid_media", "media must be a local file")
                    structural_indices(project, args.start, args.end)
                    if Path(args.output).resolve() == Path(args.job).resolve():
                        raise AgentError("invalid_request", "job and output must be different paths")
                    initial_job = {"schema": JOB, "state": "running", "pid": os.getpid(),
                           "started_at": datetime.now(timezone.utc).isoformat(),
                           "range": [args.start, args.end], "model": args.model, "output": str(Path(args.output).resolve())}
                    write_new(args.job, initial_job)
                    job = initial_job
                    # Provider logs may contain signed URLs: suppress, never expose in protocol output.
                    with open(os.devnull, "w") as sink, contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                        result = transcribe_range(project, media, args.start, args.end, model=args.model,
                                                  context_text=args.context, language=args.language)
                write_new(args.output, result)
                result = {"proposal": str(Path(args.output).resolve()), "id": result["id"]}
                if job:
                    job.update(state="succeeded", result=result, finished_at=datetime.now(timezone.utc).isoformat())
                    write_status(args.job, job)
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False, allow_nan=False))
        return 0
    except (Exception, KeyboardInterrupt, SystemExit) as exc:
        code = getattr(exc, "code", "transcription_failed" if job else "invalid_request")
        code = code if isinstance(code, str) else "transcription_failed"
        # Provider exceptions can embed keys/URLs. Return a bounded generic runtime error.
        message = str(exc) if isinstance(exc, AgentError) or job is None else "Transcription failed or was interrupted; check local configuration/media and retry with a new job path"
        error = {"code": code, "message": message}
        if job:
            job.update(state="failed", error=error, finished_at=datetime.now(timezone.utc).isoformat())
            try:
                write_status(args.job, job)
            except OSError:
                error["status_error"] = "Could not persist final job status; use this command result instead"
        print(json.dumps({"ok": False, "error": error}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    configure_utf8_stdio()
    raise SystemExit(main())
