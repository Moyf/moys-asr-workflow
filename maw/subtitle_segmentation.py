"""Local character-limit cuts on original timestamp items, without retiming."""

from __future__ import annotations

import re


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


def punctuation_item_ends(items: list[dict], punctuation: set[str]) -> set[int]:
    """Keep decimal / version / numeric separators out of punctuation pre-cuts."""
    protected = protected_offsets("".join(item["text"] for item in items))
    result, offset = set(), 0
    for index, item in enumerate(items):
        text = item["text"]
        # The caller cuts after the whole item, even when punctuation is inside it.
        item_end = offset + len(text)
        if item_end not in protected and any(
            char in punctuation and offset + pos + 1 not in protected
            for pos, char in enumerate(text)
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


def split_long_items(items: list[dict], maximum: int, weak_punct: set[str]) -> list[list[dict]]:
    """Balance legal item boundaries, allowing only indivisible blocks to overflow."""
    if not items:
        return []
    text = "".join(item["text"] for item in items)
    if len(text) <= maximum:
        return [items]
    offsets = [0]
    for item in items:
        offsets.append(offsets[-1] + len(item["text"]))
    protected = protected_offsets(text)
    # A protected expression can span several items, and an item can overlap
    # two expressions. Only their shared legal boundaries form atomic blocks.
    ends = [0] + [index for index in range(1, len(items) + 1) if offsets[index] not in protected]
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
            if offsets[ends[end]] - offsets[ends[cursor]] > maximum:
                break
            fitting.append(end)
        if not fitting:
            cut = cursor + 1
        elif fitting[-1] == len(ends) - 1:
            cut = fitting[-1]
        else:
            cut = next((end for end in reversed(fitting) if ends[end] in weak_ends), None)
            if cut is None:
                cut = next((end for end in reversed(fitting) if offsets[ends[end]] in word_ends), fitting[-1])
        preferred.add(ends[cut])
        cursor = cut

    costs = [0.0] + [float("inf")] * (len(ends) - 1)
    previous = [0] * len(ends)
    threshold = short_length(maximum)
    for end in range(1, len(ends)):
        end_offset = offsets[ends[end]]
        for start in range(end - 1, -1, -1):
            start_offset = offsets[ends[start]]
            length = end_offset - start_offset
            if length > maximum and start < end - 1:
                break
            is_final = end == len(ends) - 1
            is_punct = ends[end] in weak_ends
            boundary = 0 if is_final or is_punct else 8
            if not is_final and end_offset not in word_ends:
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
            if len(right) < short_length(maximum) or dangling_cost(left, right):
                result[-1:] = split_long_items(result[-1] + group, maximum, weak_punct)
                continue
        result.append(group)
    return result
