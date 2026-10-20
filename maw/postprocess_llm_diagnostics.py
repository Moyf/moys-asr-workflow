"""Keep model evidence in memory; persist it only when the task fails."""

from __future__ import annotations

import copy
import json
from contextvars import ContextVar
from pathlib import Path

from maw.local_log import redact_sensitive_text
from maw.postprocess_io import _atomic_write, _available_output


_active_call: ContextVar[dict | None] = ContextVar("llm_diagnostic_call", default=None)


def record_raw_response(prompt: str, content: str) -> None:
    call = _active_call.get()
    if call is not None:
        call.setdefault("rawResponses", []).append({"prompt": prompt, "content": content})


class LlmFailureTrace:
    def __init__(self, complete, base: Path | None, directory: Path | None, operation: str):
        self.complete = complete
        self.base = base
        self.directory = directory
        self.operation = operation
        self.calls: list[dict] = []

    def __call__(self, prompt, rows):
        call = {"prompt": prompt, "input": copy.deepcopy(rows)}
        self.calls.append(call)
        token = _active_call.set(call)
        try:
            response = self.complete(prompt, rows)
            call["response"] = copy.deepcopy(response)
            return response
        except Exception as error:
            call["error"] = str(error)
            raise
        finally:
            _active_call.reset(token)

    def failure(self, error: BaseException) -> str:
        if self.base is None or not self.calls:
            return ""
        try:
            path = _available_output(self.base, "ai-failure-record", ".md", output_directory=self.directory)
            payload = {"operation": self.operation, "error": str(error), "calls": self.calls}
            body = json.dumps(payload, ensure_ascii=False, indent=2, default=str).replace("`", "\\u0060")
            _atomic_write(path, redact_sensitive_text(
                "# AI 处理失败记录\n\n本次结果未应用。包含字幕、提示词和模型回复，分享前请检查。\n\n```json\n" + body + "\n```\n"
            ))
        except (OSError, ValueError, UnicodeError) as write_error:
            return f"AI 失败记录保存失败：{redact_sensitive_text(write_error)}"
        return f"AI 失败记录：{path}"
