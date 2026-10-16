"""Normalize transport-only wrappers without changing source text in a draft."""

from __future__ import annotations


def draft_lines(content: str) -> list[str]:
    value = content.strip().lstrip("\ufeff")
    # Some local providers place reasoning in content instead of a separate
    # stream. Only a leading, explicitly closed block is transport metadata;
    # literal <think> text inside a source row must remain untouched.
    while value.lower().startswith("<think>"):
        end = value.lower().find("</think>")
        if end < 0:
            raise ValueError("模型只返回未完成的思考内容，尚未生成可用编辑稿。")
        value = value[end + len("</think>"):].lstrip()
    lines = value.splitlines()
    if lines and lines[0].startswith("```") and lines[-1].strip() == "```":
        lines = lines[1:-1]
    return [line for line in lines if line.strip()]
