"""Incremental local evidence for every AI cleanup stage."""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Callable, Mapping
from contextvars import ContextVar
from dataclasses import replace
from pathlib import Path

from maw.diagnostics import error_context
from maw.local_log import redact_sensitive_text
from maw.postprocess_io import _atomic_write, _available_output
from maw.postprocess_llm import LlmClientError


_active_trace: ContextVar[CleanupTrace | None] = ContextVar("cleanup_trace", default=None)


def record_raw_response(prompt: str, content: str) -> None:
    """Keep syntax-invalid audit replies too, before transport-level retries."""
    trace = _active_trace.get()
    if trace is not None and trace.calls:
        trace.calls[-1].setdefault("rawResponses", []).append({"prompt": prompt, "content": content})
        trace.save()


class CleanupTrace:
    def __init__(self, complete: Callable[[str, list[dict[str, str]]], Mapping[str, object]], *, base: Path, directory: Path | None) -> None:
        self.complete = complete
        self.calls: list[dict[str, object]] = []
        self.context = error_context()
        self.path = _available_output(base, "ai-cleanup-record", ".md", output_directory=directory)
        self.checkpoints: list[dict[str, object]] = []
        self.status = "进行中"
        self.save_error = ""

    def __call__(self, prompt: str, rows: list[dict[str, str]]) -> Mapping[str, object]:
        stage = "剪后安全审计" if rows and "proposed" in rows[0] else "漏清扫描" if rows and "currentTimeline" in rows[0] else "首次整理"
        call: dict[str, object] = {
            "stage": stage,
            "targetIds": [row["id"] for row in rows if row.get("contextOnly") != "true"],
            "prompt": prompt,
            "input": copy.deepcopy(rows),
        }
        self.calls.append(call)
        self.save()
        token = _active_trace.set(self)
        try:
            response = self.complete(prompt, rows)
        except Exception as error:
            call["error"] = str(error)
            self.save()
            raise
        finally:
            _active_trace.reset(token)
        call["response"] = copy.deepcopy(response)
        self.save()
        return response

    def reject(self, reason: str) -> None:
        if self.calls:
            self.calls[-1]["validationError"] = reason
            self.save()

    def checkpoint(self, stage: str, **result: object) -> None:
        self.checkpoints.append({"stage": stage, **copy.deepcopy(result)})
        self.save()

    def failure(self, error: LlmClientError) -> LlmClientError:
        self.status = "已取消" if error.category == "cancelled" else "失败"
        self.checkpoint(self.status, error=str(error))
        if self.save_error:
            return replace(error, message=f"{error}\nAI 整理记录保存失败：{self.save_error}")
        return replace(error, message=f"{error}\nAI 整理记录：{self.path}")

    def save(self) -> None:
        if self.status in {"进行中", "成功"}:
            return
        sections = [
            "# AI 整理阶段记录",
            f"版本：{self.context['version']}\n发生时间：{self.context['occurredAt']}\n状态：{self.status}",
            "原始输入保留。模型请求或协议失败时不应用本次整理。以下包含字幕、可选文稿与模型回复，分享前请检查内容。",
        ]
        for index, call in enumerate(self.calls, 1):
            sections.append(f"## 请求 {index}：{call['stage']}")
            sections.append("目标行：" + "、".join(call["targetIds"]))
            # A JSON string keeps model fences and HTML inert in the report.
            data = json.dumps(call, ensure_ascii=False, indent=2, default=str).replace("`", "\\u0060")
            sections.append("```json\n" + data + "\n```")
        sections.append("## 本地处理结果")
        sections.append("```json\n" + json.dumps(self.checkpoints, ensure_ascii=False, indent=2, default=str).replace("`", "\\u0060") + "\n```")
        text = redact_sensitive_text("\n\n".join(sections) + "\n")
        text = re.sub(r"(?i)([A-Z]:[\\/]+Users[\\/]+)[^\\/\s]+", r"\1<用户>", text)
        try:
            _atomic_write(self.path, text)
        except (OSError, ValueError, UnicodeError) as write_error:
            self.save_error = redact_sensitive_text(write_error)
        else:
            self.save_error = ""
