"""Shared text punctuation and timed-token mapping helpers.

The punctuation model receives text only.  When an upstream recognizer already
has word/character timings, this module attaches the returned punctuation to
the nearest existing item and keeps every original time range unchanged.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Callable, Mapping, Sequence
from typing import Any


CT_PUNC_MODEL_ID = "ct-punc"
CT_PUNC_MODEL_REF = "iic/punc_ct-transformer_cn-en-common-vocab471067-large"


class PunctuationError(RuntimeError):
    """Raised when punctuation inference or timed-token mapping fails."""


PunctuationRunner = Callable[..., object]


def punctuate_text(
    text: str,
    *,
    model_cache_root: str | None = None,
    device: str = "auto",
    on_event: Callable[[str], None] | None = None,
    cancel_event: Any = None,
    runner: PunctuationRunner | None = None,
) -> str:
    """Run the shared ``ct-punc`` capability and return punctuated text."""
    source = str(text or "")
    if not source.strip():
        return ""
    if runner is None:
        from maw.punctuation_runtime import punctuate_text_in_runtime

        runner = punctuate_text_in_runtime
    try:
        raw_result = runner(
            source,
            model_cache_root=model_cache_root,
            device=device,
            on_event=on_event,
            cancel_event=cancel_event,
        )
    except PunctuationError:
        raise
    except Exception as error:  # noqa: BLE001 - provider/runtime boundary
        raise PunctuationError(f"ct-punc 加载或推理失败：{error}") from error
    result = _extract_punctuated_text(raw_result)
    if not result.strip():
        raise PunctuationError("ct-punc 未返回可用的标点文本。")
    if _content_key(result) != _content_key(source):
        raise PunctuationError("ct-punc 改变了原始文字，无法安全保留已有时间码。")
    return result


def punctuate_timed_tokens(
    tokens: Sequence[Mapping[str, object]],
    *,
    model_cache_root: str | None = None,
    device: str = "auto",
    on_event: Callable[[str], None] | None = None,
    cancel_event: Any = None,
    runner: PunctuationRunner | None = None,
) -> list[dict[str, Any]]:
    """Punctuate timed tokens and split them at sentence-ending punctuation."""
    source = _normalise_tokens(tokens)
    if not source:
        return []
    punctuated_text = punctuate_text(
        "".join(str(item.get("text") or "") for item in source),
        model_cache_root=model_cache_root,
        device=device,
        on_event=on_event,
        cancel_event=cancel_event,
        runner=runner,
    )
    attached = _attach_punctuation(source, punctuated_text)
    return _split_segments(attached)


def _extract_punctuated_text(result: object) -> str:
    if isinstance(result, str):
        return result
    if isinstance(result, Mapping):
        for key in ("text", "punc_text", "punctuated_text"):
            value = result.get(key)
            if isinstance(value, str):
                return value
    raise PunctuationError(f"ct-punc 返回了无效结果：{result!r}")


def _normalise_tokens(tokens: Sequence[Mapping[str, object]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for token in tokens:
        if not isinstance(token, Mapping):
            continue
        text = str(token.get("text") or "")
        if not text:
            continue
        try:
            start = int(token.get("start") or 0)
            end = int(token.get("end") or 0)
        except (TypeError, ValueError) as error:
            raise PunctuationError(f"字词时间码不是整数：{token!r}") from error
        if end < start:
            raise PunctuationError(f"字词时间范围无效：{token!r}")
        copied = dict(token)
        copied["text"] = text
        copied["start"] = start
        copied["end"] = end
        result.append(copied)
    return result


def _attach_punctuation(
    items: Sequence[Mapping[str, object]],
    punctuated_text: str,
) -> list[dict[str, Any]]:
    """Attach inserted punctuation to the preceding timed item."""
    punc_content = [
        (index, _match_key(char))
        for index, char in enumerate(punctuated_text)
        if _match_key(char)
    ]
    matches: list[tuple[int, int] | None] = []
    content_cursor = 0
    for item in items:
        key = _content_key(str(item.get("text") or ""))
        if not key:
            matches.append(None)
            continue
        match = _find_content_run(punc_content, key, content_cursor)
        if match is None:
            raise PunctuationError(
                f"ct-punc 文字与原始字词不一致：{punctuated_text!r} / {item!r}"
            )
        matches.append(match)
        # ``match`` contains character offsets for slicing punctuation gaps,
        # while the next search cursor is an offset in the filtered content
        # list.  They differ as soon as the model output contains spaces or
        # punctuation between two tokens.
        content_cursor = next(
            (
                position + 1
                for position, (char_index, _value) in enumerate(punc_content)
                if position >= content_cursor and char_index == match[1]
            ),
            len(punc_content),
        )

    output: list[dict[str, Any]] = []
    for index, item in enumerate(items):
        copied = dict(item)
        base_text = str(copied.get("text") or "")
        match = matches[index]
        if match is not None:
            gap_start = match[1] + 1
            next_match = next((candidate for candidate in matches[index + 1 :] if candidate), None)
            gap_end = next_match[0] if next_match is not None else len(punctuated_text)
            candidate = punctuated_text[gap_start:gap_end]
        elif index == 0:
            candidate = punctuated_text[: matches[0][0]] if matches and matches[0] else ""
        else:
            candidate = ""
        future_source_punct = {
            char
            for future in items[index + 1 :]
            if not _content_key(str(future.get("text") or ""))
            for char in str(future.get("text") or "")
            if _is_punctuation(char)
        }
        added = "".join(
            char
            for char in candidate
            if _is_punctuation(char)
            and char not in base_text
            and char not in future_source_punct
        )
        copied["text"] = base_text + added
        output.append(copied)
    return output


def _split_segments(items: Sequence[Mapping[str, object]]) -> list[dict[str, Any]]:
    segments: list[dict[str, Any]] = []
    start_index = 0
    for index, item in enumerate(items):
        text = str(item.get("text") or "")
        if any(char in _SENTENCE_ENDINGS for char in text):
            segments.append(_segment(items[start_index : index + 1]))
            start_index = index + 1
    if start_index < len(items):
        segments.append(_segment(items[start_index:]))
    return segments


def _segment(items: Sequence[Mapping[str, object]]) -> dict[str, Any]:
    if not items:
        raise PunctuationError("ct-punc 分句为空，无法保留原始时间码。")
    copied_items = [dict(item) for item in items]
    return {
        "start": int(copied_items[0].get("start") or 0),
        "end": int(copied_items[-1].get("end") or 0),
        "text": "".join(str(item.get("text") or "") for item in copied_items),
        "items": copied_items,
    }


def _find_content_run(
    punc_content: Sequence[tuple[int, str]],
    key: str,
    cursor: int,
) -> tuple[int, int] | None:
    wanted = list(key)
    if not wanted:
        return None
    keys = [value for _index, value in punc_content]
    for start in range(cursor, len(keys) - len(wanted) + 1):
        if keys[start : start + len(wanted)] == wanted:
            return punc_content[start][0], punc_content[start + len(wanted) - 1][0]
    return None


def _content_key(text: str) -> str:
    return "".join(_match_key(char) for char in text)


def _match_key(char: str) -> str:
    normalised = unicodedata.normalize("NFKC", char).casefold()
    return normalised if normalised.isalnum() else ""


def _is_punctuation(char: str) -> bool:
    return unicodedata.category(char).startswith("P")


_SENTENCE_ENDINGS = frozenset("。！？!?")


__all__ = [
    "CT_PUNC_MODEL_ID",
    "CT_PUNC_MODEL_REF",
    "PunctuationError",
    "punctuate_text",
    "punctuate_timed_tokens",
]
