"""Prepare independent ASR evidence for recording review using the existing runner."""
from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from threading import Event, Lock, Thread
from typing import Any

from maw.asr_errors import redact_asr_text
from maw.gui_workflow import TranscriptionRequest, run_transcription, unique_output_path


class RecordingPreparation:
    def __init__(self, request: TranscriptionRequest, script: Path):
        self.request = replace(request, srt_path=unique_output_path(request.srt_path, request.media_path),
                               generate_html=False, srt_only=False, postprocess_plan=None,
                               length_limit="", alignment_model="", alignment_model_path="")
        self.script = script
        self.cancel = Event()
        self.lock = Lock()
        self.status: dict[str, Any] = {"status": "running", "message": "正在运行所选 ASR；保留原始文字。"}
        self.thread = Thread(target=self._run, daemon=True)

    def _progress(self, message: str) -> None:
        with self.lock:
            self.status["message"] = redact_asr_text(message, self.request.api_key)[-1000:]

    def _run(self) -> None:
        try:
            result = run_transcription(self.request, on_event=self._progress, cancel_event=self.cancel)
            if self.cancel.is_set():
                raise RuntimeError("ASR 准备已取消。")
            with self.lock:
                self.status.update(status="ready", message="ASR 证据已保存，可进入口播审查。",
                                   projectPath=str(result.json_path), scriptPath=str(self.script),
                                   mediaPath=str(self.request.media_path), srtPath=str(result.srt_path))
        except Exception as error:
            with self.lock:
                self.status.update(status="cancelled" if self.cancel.is_set() else "error",
                                   message=redact_asr_text(error, self.request.api_key))

    def snapshot(self) -> dict[str, Any]:
        with self.lock:
            return dict(self.status)
