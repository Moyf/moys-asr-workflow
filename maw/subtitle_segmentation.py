"""Local character-limit cuts on original timestamp items, without retiming."""

from __future__ import annotations

import re
import unicodedata
from bisect import bisect_left, bisect_right
from itertools import accumulate


_UNITS = (
    r"百分比|千米|公里|公斤|千克|厘米|毫米|毫秒|分钟|小时|万元|亿元|像素|"
    r"秒钟|帧(?!率)|元|秒|米|岁|个|年|月|日|天|倍|度|[％%℃°]|"
    r"(?:GiB|MiB|KiB|GB|MB|KB|TB|GHz|MHz|kHz|Hz|fps|kbps|Mbps|kg|ms|cm|mm|px)(?![A-Za-z])"
)
_NUMBER = re.compile(
    r"[+-]?\d+(?:,\d{3})*(?:[.:：/／×xX-]\d+)*(?:[ \t]*(?:" + _UNITS + r"))?",
    re.IGNORECASE,
)
_LATIN_WORD = re.compile(r"[A-Za-z][A-Za-z0-9]*(?:[-_.][A-Za-z0-9]+)*")


def protected_offsets(text: str) -> set[int]:
    """Offsets inside numbers / units or Latin words cannot become cue cuts."""
    return {
        position
        for pattern in (_NUMBER, _LATIN_WORD)
        for match in pattern.finditer(text)
        for position in range(match.start() + 1, match.end())
    }


_QUOTE_PAIRS = {"“": "”", "‘": "’", "「": "」", "『": "』", '"': '"', "'": "'"}


def _is_body_character(char: str) -> bool:
    return not char.isspace() and not unicodedata.category(char).startswith("P")


def body_character_count(text: str) -> int:
    """Count subtitle content, excluding Unicode punctuation and whitespace."""
    return sum(map(_is_body_character, text))


def body_character_offsets(text: str) -> list[int]:
    """Map original text offsets to counts without changing text or timing."""
    return list(accumulate(map(_is_body_character, text), initial=0))


def _paired_quote_spans(text: str) -> list[tuple[int, int]]:
    stack: list[tuple[str, int]] = []
    spans = []
    for index, char in enumerate(text):
        if char in {"'", "’"} and index:
            left, right = text[index - 1], text[index + 1:index + 2]
            ascii_word_end = left.isascii() and left.isalnum()
            in_ascii_word = right.isascii() and right.isalnum()
            can_close = bool(stack and stack[-1][0] == char)
            if ascii_word_end and (in_ascii_word or not can_close):
                continue  # Don't open quotes on contractions or trailing possessives.
        if char == "\n":
            stack.clear()
        elif stack and char == stack[-1][0]:
            _, start = stack.pop()
            spans.append((start, index + 1))
        elif char in _QUOTE_PAIRS:
            stack.append((_QUOTE_PAIRS[char], index))
    return spans


def straight_quote_closing_offsets(text: str) -> set[int]:
    """Return the source offsets immediately after paired straight closing quotes."""
    if '"' not in text and "'" not in text:
        return set()
    return {end for start, end in _paired_quote_spans(text) if text[start] in {'"', "'"}}


def fitting_quote_offsets(
    items: list[dict], maximum: int, *, by_word: bool = False,
) -> tuple[set[int], set[int]]:
    """Return interior cuts to avoid and closing cuts for complete, fitting quotes."""
    text = "".join(item["text"] for item in items)
    offsets = [0]
    body_offsets = None
    if by_word:
        for item in items:
            offsets.append(offsets[-1] + len(item["text"]))
    else:
        body_offsets = body_character_offsets(text)
    inside, closings = set(), set()
    for start, end in _paired_quote_spans(text):
        if body_offsets is not None:
            length = body_offsets[end] - body_offsets[start]
        else:
            length = bisect_left(offsets, end) - (bisect_right(offsets, start) - 1)
        if length <= maximum:
            inside.update(range(start + 1, end))
            closings.add(end)
    return inside, closings


def is_punctuation_continuation(
    char: str, punctuation: set[str], *, following: str = "", closes_quote: bool = False,
) -> bool:
    """Marks/closing quotes that belong to the same terminal punctuation run."""
    category = unicodedata.category(char)
    if char in {'"', "'"} and following.isalnum() and not closes_quote:
        return False  # A straight quote before a word opens the next clause.
    # Dashes and signs can start the next clause or number; they do not
    # run on from a preceding sentence mark.
    return char not in "\n+−" and category not in {"Ps", "Pi", "Pd"} and (
        category.startswith("P") or char in punctuation
    )


def punctuation_item_ends(
    items: list[dict], punctuation: set[str], *, quote_limit: int | None = None, by_word: bool = False,
) -> set[int]:
    """Keep decimal / version / numeric separators out of punctuation pre-cuts."""
    joined = "".join(item["text"] for item in items)
    protected = protected_offsets(joined)
    closing_quotes = straight_quote_closing_offsets(joined)
    quoted, _ = fitting_quote_offsets(items, quote_limit, by_word=by_word) if quote_limit is not None else (set(), set())
    result, offset = set(), 0
    for index, item in enumerate(items):
        text = item["text"]
        item_end = offset + len(text)
        tail = text.rstrip()
        content = text.lstrip()
        if "\n" in punctuation and index and content and "\n" in text[:len(text) - len(content)]:
            result.add(index)
        newline_end = "\n" in punctuation and ("\n" in content or (not content and "\n" in text))
        # A mark in the middle of an item is not a cut at the item's end.
        # A sequence such as ?! or 。” receives one cut after the whole run.
        mark_end = offset + len(tail)
        exact = False
        while tail and mark_end:
            char = joined[mark_end - 1]
            if char != "\n" and char in punctuation and mark_end not in protected:
                exact = True
                break
            if not is_punctuation_continuation(char, punctuation):
                break
            mark_end -= 1
        next_offset = item_end
        while next_offset < len(joined) and joined[next_offset] in " \t\r":
            next_offset += 1
        continues = next_offset < len(joined) and is_punctuation_continuation(
            joined[next_offset], punctuation, following=joined[next_offset + 1:next_offset + 2],
            closes_quote=next_offset + 1 in closing_quotes,
        )
        if newline_end or (
            exact and not continues and item_end not in protected and item_end not in quoted
        ):
            result.add(index + 1)
        offset = item_end
    return result


def short_length(maximum: int) -> int:
    return min(5, max(2, maximum // 3))


def dangling_cost(left: str, right: str) -> int:
    """Small grammar preferences, subordinate to source and numeric integrity."""
    left, right = left.rstrip(), right.lstrip()
    if not left or not right or left[-1] in "。！？.!?；;，,、：:":
        return 0
    cost = 0
    if re.search(
        r"(?:没有|不要|不能|不会|可以|能够|需要|继续|开始|觉得|认为|比如|包括|"
        r"因为|所以|如果|然后|但是|为了|以及|而是|只要|把|被|的|地|得|与|及|或|和|将|是|在|就|先|再|不|没|未)$",
        left,
    ):
        cost += 24
    if right[0] in "的地得了着过" or right.startswith(("起来", "下来", "下去", "出来", "上去")):
        cost += 20
    if left.endswith("帧") and right.startswith("率"):
        cost += 24
    if re.fullmatch(r"(?:那么|因此|所以|同时|另外|例如|因为|如果|但是|不过|而且)(?:这一次|后来)?", left):
        cost += 40
    return cost


def split_long_items(
    items: list[dict], maximum: int, weak_punct: set[str], *, minimum: int | None = None,
) -> list[list[dict]]:
    """Balance legal item boundaries, allowing only indivisible blocks to overflow."""
    if not items:
        return []
    text = "".join(item["text"] for item in items)
    body_offsets = body_character_offsets(text)
    if body_offsets[-1] <= maximum:
        return [items]
    offsets = [0]
    for item in items:
        offsets.append(offsets[-1] + len(item["text"]))
    protected = protected_offsets(text)
    # A protected expression can span several items, and an item can overlap
    # two expressions. Only their shared legal boundaries form atomic blocks.
    ends = [0] + [index for index in range(1, len(items) + 1) if offsets[index] not in protected]
    quoted, _ = fitting_quote_offsets(items, maximum)
    # Once a quote must split, its real punctuation is useful as a fallback.
    # The separate quote penalty still prefers legal cuts outside it.
    weak_ends = punctuation_item_ends(items, weak_punct)
    try:
        import jieba
        words = jieba.cut(text)
    except ImportError:
        words = iter(text)
    word_ends, position = set(), 0
    for word in words:
        position += len(word)
        word_ends.add(position)

    # Keep the existing greedy reading boundaries as soft preferences. Length
    # balancing should repair a bad tail, not move every otherwise sound cut.
    preferred: set[int] = set()
    cursor = 0
    while cursor < len(ends) - 1:
        fitting = []
        for end in range(cursor + 1, len(ends)):
            if body_offsets[offsets[ends[end]]] - body_offsets[offsets[ends[cursor]]] > maximum:
                break
            fitting.append(end)
        if not fitting:
            cut = cursor + 1
        elif fitting[-1] == len(ends) - 1:
            cut = fitting[-1]
        else:
            options = [end for end in fitting if offsets[ends[end]] not in quoted] or fitting
            cut = next((end for end in reversed(options) if ends[end] in weak_ends), None)
            if cut is None:
                cut = next((end for end in reversed(options) if offsets[ends[end]] in word_ends), options[-1])
        preferred.add(ends[cut])
        cursor = cut

    costs = [0.0] + [float("inf")] * (len(ends) - 1)
    previous = [0] * len(ends)
    threshold = short_length(maximum) if minimum is None else min(minimum, max(2, maximum // 3))
    for end in range(1, len(ends)):
        end_offset = offsets[ends[end]]
        for start in range(end - 1, -1, -1):
            start_offset = offsets[ends[start]]
            length = body_offsets[end_offset] - body_offsets[start_offset]
            if length > maximum and start < end - 1:
                break
            is_final = end == len(ends) - 1
            is_punct = ends[end] in weak_ends
            boundary = 0 if is_final or is_punct else (28 if weak_ends else 8)
            if not is_final and end_offset in quoted:
                boundary += 250
            if not is_final and not is_punct and end_offset not in word_ends:
                boundary += 120
            if not is_final and ends[end] not in preferred:
                boundary += 6
            boundary += dangling_cost(text[start_offset:end_offset], text[end_offset:end_offset + 20])
            short = 0 if is_punct else max(0, threshold - length) ** 2 * 5
            slack = ((maximum - min(length, maximum)) / maximum) ** 2 * 8
            cost = costs[start] + 25 + boundary + short + slack
            if cost < costs[end]:
                costs[end], previous[end] = cost, start
    result, end = [], len(ends) - 1
    while end:
        start = previous[end]
        result.append(items[ends[start]:ends[end]])
        end = start
    return result[::-1]


def rebalance_short_groups(groups: list[list[dict]], maximum: int, weak_punct: set[str]) -> list[list[dict]]:
    """Repair adjacent natural-mode groups only when a cut hangs or leaves a tiny tail."""
    result: list[list[dict]] = []
    for group in groups:
        if result:
            left = "".join(i["text"] for i in result[-1])
            right = "".join(i["text"] for i in group)
            if body_character_count(right) < short_length(maximum) or dangling_cost(left, right):
                result[-1:] = split_long_items(result[-1] + group, maximum, weak_punct)
                continue
        result.append(group)
    return result
