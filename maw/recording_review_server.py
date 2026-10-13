"""Token-protected recording review actions for the existing alignment server."""
from __future__ import annotations

import json
import tempfile
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any

from maw.script_recording_workflow import (
    input_signature, recommend_recording, review_recording, evidence_errors, validate_media_binding, RecordingWorkflowError,
)


class RecordingReviewJob:
    def __init__(self, state: Any):
        self.state = state
        self.signature = input_signature(state.project_path, state.script_path, state.media_path) if state.media_path else ""
        self.lock = Lock()
        self.cancel = Event()
        self.thread: Thread | None = None
        self.status: dict[str, Any] = {"status": "idle", "message": ""}
        self.current_digest = ""

    def check_inputs(self) -> None:
        if not self.state.media_path:
            raise RecordingWorkflowError("没有可用媒体，无法生成文稿时间码。")
        validate_media_binding(self.state.project, self.state.project_path, self.state.media_path)
        if input_signature(self.state.project_path, self.state.script_path, self.state.media_path) != self.signature:
            raise RecordingWorkflowError("输入文件已变化；请重新打开口播审查，旧选择无效。")

    def review(self, request: dict[str, Any]) -> dict[str, Any]:
        self.check_inputs()
        if request.get("inputSignature") != self.signature:
            raise RecordingWorkflowError("审查输入版本已失效。")
        gap = request.get("gapRemove", self.state.gap_remove_override)
        review, selection, project = review_recording(self.state.project, self.state.alignment,
                                                       request, gap_remove=gap)
        digest = review["selectionDigest"]
        with self.lock:
            if self.current_digest and digest != self.current_digest:
                self.cancel.set()
            self.current_digest = digest
        recommendations = recommend_recording(self.state.project, "", alignment=self.state.alignment,
                                               source_confirmed=request.get("sourceConfirmed") is True,
                                               prefer_latest=request.get("preferLatest") is True)
        return {"review": review, "recommendations": recommendations, "selection": selection,
                "gapRemove": project.get("gap_remove", {}), "inputSignature": self.signature}

    def start(self, request: dict[str, Any], *, source_items: bool = False) -> dict[str, Any]:
        result = self.review(request)
        errors = evidence_errors(self.state.project, request.get("sourceConfirmed") is True)
        if errors:
            raise RecordingWorkflowError("; ".join(errors))
        if not source_items and not result["review"]["ready"]:
            raise RecordingWorkflowError("; ".join(b["reason"] for b in result["review"]["blockers"]))
        with self.lock:
            if self.thread and self.thread.is_alive():
                raise RecordingWorkflowError("文稿生成正在运行，请先停止。")
            self.cancel = Event()
            self.status = {"status": "running", "message": "正在准备文稿时间码。",
                           "selectionDigest": self.current_digest, "operation": "fill" if source_items else "start"}
            self.thread = Thread(target=self._run, args=(result["review"]["request"], self.cancel, source_items), daemon=True)
            self.thread.start()
        return self.snapshot()

    def _run(self, request: dict[str, Any], cancel: Event, source_items: bool = False) -> None:
        try:
            from maw.alignment_models import QWEN_FORCED_ALIGNER_MODEL_ID
            from maw.local_runtime import run_timestamp_alignment_in_runtime
            with tempfile.TemporaryDirectory(prefix="maw-recording-request-") as directory:
                path = Path(directory) / "selection.json"
                path.write_text(json.dumps(request, ensure_ascii=False), encoding="utf-8")
                result = run_timestamp_alignment_in_runtime(
                    model_id=QWEN_FORCED_ALIGNER_MODEL_ID, project_path=self.state.project_path,
                    script_path=self.state.script_path, media_path=self.state.media_path,
                    recording_request_path=path, recording_operation="fill" if source_items else "align", output_mode="json",
                    cancel_event=cancel, on_event=self._progress,
                )
            self.check_inputs()
            if source_items and result.get("report", {}).get("failedSegments", 0):
                raise RecordingWorkflowError("部分 ASR 源段补码失败；保留原工程，不能把它当作完整字词码。")
            with self.lock:
                if cancel.is_set() or self.status["selectionDigest"] != self.current_digest:
                    self.status.update(status="cancelled", message="选择已变化或任务已取消；不应用旧结果。")
                else:
                    self.status.update(status="complete", message="ASR 字词码已补充；请用新工程重新打开审查。" if source_items else "文稿时间码已生成，请听审。",
                                       artifact=result["artifact"])
        except Exception as error:
            with self.lock:
                self.status.update(status="cancelled" if cancel.is_set() else "error", message=str(error))

    def _progress(self, message: str) -> None:
        with self.lock:
            self.status["message"] = message[-1000:]

    def stop(self) -> dict[str, Any]:
        self.cancel.set()
        return self.snapshot()

    def close(self) -> None:
        self.cancel.set()
        if self.thread:
            self.thread.join(timeout=5)

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.status)


def handle_recording_post(handler: Any, path: str) -> bool:
    if path not in {"/api/recording/review", "/api/recording/start", "/api/recording/fill", "/api/recording/cancel"}:
        return False
    from http import HTTPStatus
    try:
        request = handler.read_json()
        handler.check_request_token(request)
        job = handler.server.recording_job
        if path.endswith("/cancel"):
            result = job.stop()
        elif path.endswith("/start") or path.endswith("/fill"):
            result = job.start(request, source_items=path.endswith("/fill"))
        else:
            result = job.review(request)
        handler.send_json(HTTPStatus.OK, {"ok": True, **result})
    except PermissionError as error:
        handler.send_json(HTTPStatus.FORBIDDEN, {"ok": False, "error": str(error)})
    except (OSError, ValueError) as error:
        handler.send_json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(error)})
    return True
