"""Incremental local evidence for subtitle boundary requests and validation."""

from __future__ import annotations

import copy
import json
import re
from collections.abc import Mapping, Sequence
from pathlib import Path

from maw.diagnostics import error_context
from maw.local_log import redact_sensitive_text
from maw.postprocess_io import _atomic_write, _available_output


class ResegmentTrace:
    def __init__(self, base: Path | None, directory: Path | None) -> None:
        self.base = base
        self.directory = directory
        self.path: Path | None = None
        self.calls: list[dict[str, object]] = []
        self.context = error_context()
        self.status = "进行中"
        self.results: dict[str, object] = {}
        self.save_error = ""

    def start(self, batch: int, attempt: int, prompt: str, rows: Sequence[Mapping[str, object]]) -> None:
        if self.path is None and self.base is not None:
            self.path = _available_output(self.base, "resegment-record", ".md", output_directory=self.directory)
        self.calls.append({"batch": batch, "attempt": attempt, "prompt": prompt, "input": copy.deepcopy(rows)})
        self.save()

    def update(self, **fields: object) -> None:
        if self.calls:
            self.calls[-1].update(copy.deepcopy(fields))
            self.save()

    def finish(self, status: str, **results: object) -> None:
        self.status = status
        self.results.update(results)
        self.save()

    def hint(self) -> str:
        if self.save_error:
            return f"重新断句阶段记录保存失败：{self.save_error}"
        return f"重新断句阶段记录：{self.path}" if self.path is not None else ""

    def save(self) -> None:
        if self.path is None or self.status in {"进行中", "成功"}:
            return
        sections = [
            "# 重新断句阶段记录",
            f"版本：{self.context['version']}\n发生时间：{self.context['occurredAt']}\n状态：{self.status}",
            "包含字幕、补充要求和模型回复，分享前请检查。失败或取消时不写出本次处理结果，原始输入保留。",
        ]
        for call in self.calls:
            sections.append(f"## 第 {call['batch']} 批 · 第 {call['attempt']} 次请求")
            sections.append("```json\n" + self._json(call) + "\n```")
        sections.extend(["## 本地重建与最终结果", "```json\n" + self._json(self.results) + "\n```"])
        text = redact_sensitive_text("\n\n".join(sections) + "\n")
        text = re.sub(r"(?i)([A-Z]:[\\/]+Users[\\/]+)[^\\/\s]+", r"\1<用户>", text)
        try:
            _atomic_write(self.path, text)
        except (OSError, ValueError, UnicodeError) as error:
            self.save_error = redact_sensitive_text(error)
        else:
            self.save_error = ""

    @staticmethod
    def _json(value: object) -> str:
        return json.dumps(value, ensure_ascii=False, indent=2, default=str).replace("`", "\\u0060")
