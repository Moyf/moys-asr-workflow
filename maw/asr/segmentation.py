"""Shared subtitle segmentation and timestamp repair for ASR providers."""

from __future__ import annotations

import re as _re
from maw.speaker import split_items_by_speaker
from maw.language import (
    DEFAULT_MAX_WORDS,
    DEFAULT_MIN_WORDS,
    normalize_timestamp_range,
    timestamp_items_cover_text,
)
from maw.subtitle_segmentation import (
    protected_offsets,
    punctuation_item_ends,
    rebalance_short_groups,
    split_long_items,
)


# ===== 共享切句逻辑 =====

# 共享断句配置里的「需要断句符号」：转写侧强断句符号的唯一来源。
# 模块默认值与 CLI 参数默认值、Launcher 默认计划保持一致（无隐式内置
# 强标点）；configure_extra_strong_punct 按运行时配置整体覆盖，空集合 =
# 仅按换行断句。
_DEFAULT_EXTRA_STRONG_PUNCT = "，。？！；,.;"
_DEFAULT_STRIP_TAIL_PUNCT = ""
_EXTRA_STRONG_PUNCT: set[str] = {ch for ch in _DEFAULT_EXTRA_STRONG_PUNCT if not ch.isspace()}


def configure_extra_strong_punct(chars: object) -> None:
    """按共享断句配置整体设置转写强断句符号（换行始终生效）。"""
    global _EXTRA_STRONG_PUNCT
    _EXTRA_STRONG_PUNCT = {ch for ch in str(chars or "") if not ch.isspace()}


def _strong_punct_set(defaults: str) -> set[str]:
    """默认强断句符号并上额外断句符号后的有效集合。"""
    return set(defaults) | _EXTRA_STRONG_PUNCT


def _weak_punct_set() -> set[str]:
    """超长补拆也只读取共享断句符号，不另藏顿号、冒号或破折号清单。"""
    return set(_EXTRA_STRONG_PUNCT)


def split_by_silence(items: list[dict], min_gap_ms: int) -> list[list[dict]]:
    """按相邻 item 之间的静音间隔切分。"""
    if not items or min_gap_ms <= 0:
        return [items] if items else []
    groups: list[list[dict]] = []
    cur: list[dict] = [items[0]]
    for prev, nxt in zip(items, items[1:]):
        gap = nxt["start"] - prev["end"]
        if gap >= min_gap_ms:
            groups.append(cur)
            cur = []
        cur.append(nxt)
    if cur:
        groups.append(cur)
    return groups


# 兼容旧私有名（maw/soniox.py 等复用方请用 split_by_silence）
_split_by_silence = split_by_silence


def _split_long_group(items: list[dict], max_len: int, weak_punct: set) -> list[list[dict]]:
    """兼容已有调用方；本地数字保护、完整词边界与相邻句平衡由领域模块负责。"""
    return split_long_items(items, max_len, weak_punct)


QWEN_AUDIO_NATURAL_TARGET_LEN = 13
QWEN_AUDIO_NATURAL_MAX_LEN = 18
QWEN_AUDIO_NATURAL_MIN_LEN = 7


def _split_cjk_group_naturally(
    items: list[dict],
    *,
    target_len: int,
    max_len: int,
    min_len: int,
) -> list[list[dict]]:
    """用词性和 API 字词边界切分无内部标点的长中文片段。

    Qwen-Audio 可能把数十秒的中文内容作为一个 sentence 返回，且只在末尾
    给出句号。此时按 21 字硬切会把短语截断；这里在 API word 边界内，优先
    选择接近目标长度且位于名词/动词短语末尾的边界。它只处理没有可靠
    内部标点的 Qwen-Audio 兜底片段，普通标点切句和其他模型保持不变。
    """
    text_total = "".join(item.get("text", "") for item in items)
    if len(text_total) <= max_len:
        return [items]

    try:
        import jieba.posseg as pseg
    except ImportError:
        return _split_long_group(items, max_len, _weak_punct_set())

    tokens: list[tuple[int, int, str, str]] = []
    position = 0
    for word, flag in pseg.cut(text_total):
        value = str(word)
        if not value:
            continue
        end = position + len(value)
        tokens.append((position, end, value, str(flag)))
        position = end

    item_ends: list[int] = []
    position = 0
    for item in items:
        position += len(item.get("text", ""))
        item_ends.append(position)
    protected = protected_offsets(text_total)

    by_end: dict[int, tuple[int, int, str, str]] = {}
    by_start: dict[int, tuple[int, int, str, str]] = {}
    for token in tokens:
        by_start[token[0]] = token
        by_end[token[1]] = token
    favorable_flags = {"n", "nr", "ns", "nt", "nz", "vn", "l", "y", "o"}
    acceptable_flags = {"v", "m", "q", "a", "i", "eng"}
    weak_flags = {"d", "p", "r", "uj", "c", "u", "f", "xc", "ul"}
    weak_punctuation = _weak_punct_set()
    measure_words = {
        "个", "分钟", "秒", "倍", "次", "岁", "年", "月", "天", "元",
    }
    continuation_endings = {
        "的", "又", "不", "想", "给", "在", "是", "就", "能", "由", "和",
        "或者", "然后", "如果", "更", "很", "只", "需要", "打开", "填写",
        "点击", "交给", "全都",
    }
    clause_endings = {
        "吧", "要求", "速度", "秒", "字幕", "难题", "力气", "会员", "一遍", "图标",
        "音频", "工程", "时间码", "文字", "老师", "喽",
    }
    clause_starters = {
        "又", "想", "给", "来", "你", "拖入", "填写", "然后", "剩下", "就能",
        "相当", "于是", "拿走", "如果", "想要", "接下来", "但是", "鼠标", "比如",
        "这么", "左键", "顶上", "好啦", "还", "不支持", "支持", "根本",
    }

    def is_valid_boundary(end_index: int) -> bool:
        """只允许在完整 jieba 词之间断开，避免切开 APIK、ASR、交给等词。"""
        if end_index >= len(items):
            return True
        boundary = item_ends[end_index - 1]
        return boundary not in protected and not any(start < boundary < end for start, end, _word, _flag in tokens)

    def boundary_score(end_index: int) -> float:
        boundary = item_ends[end_index - 1]
        current = by_end.get(boundary)
        following = by_start.get(boundary)
        if current is None:
            score = -3.0
        elif current[3] in favorable_flags:
            score = 3.0
        elif current[3] in acceptable_flags:
            score = 1.0
        else:
            score = -2.0
        if current and current[3] == "m" and len(current[2]) >= 2:
            score += 2.0
        if current and following:
            if current[3] in {"n", "m", "q", "vn"} and following[3] in {
                "v", "d", "p", "r", "c", "uj",
            }:
                score += 2.0
            if current[3] == "v" and following[3] == "v":
                score -= 3.0
            if current[3] in weak_flags:
                score -= 2.0
            if current[3] == "m" and following[2] in measure_words | {"的"}:
                score -= 8.0
            if current[2] in measure_words and following[2] == "的":
                score -= 8.0
            if current[3] != "eng" and following[3] == "eng":
                score -= 8.0
            if following[2] in clause_starters:
                score += 2.0
            if (
                current[3] == "m"
                and len(current[2]) == 1
                and len(following[2]) == 1
                and following[3] in {"n", "v"}
            ):
                score -= 8.0
            if following[2] in {"如果", "但是", "不过", "接下来", "此外", "除此之外", "比如", "左键", "顶上"}:
                score += 5.0
        if current and current[2] in continuation_endings:
            score -= 12.0
        if current and current[2] in clause_endings:
            score += 3.0
        if any(char in weak_punctuation for char in items[end_index - 1].get("text", "")):
            score += 4.0
        return score

    paths: list[tuple[float, list[int]] | None] = [None] * (len(items) + 1)
    paths[0] = (0.0, [])
    for end_index in range(1, len(items) + 1):
        end_position = item_ends[end_index - 1]
        best: tuple[float, list[int]] | None = None
        for start_index in range(end_index):
            previous = paths[start_index]
            if previous is None:
                continue
            if not is_valid_boundary(end_index):
                continue
            start_position = item_ends[start_index - 1] if start_index else 0
            length = end_position - start_position
            if length > max_len:
                continue
            if length < min_len and end_index != len(items):
                continue
            score = (
                previous[0]
                + boundary_score(end_index)
                - abs(length - target_len) * 0.35
            )
            candidate = (score, previous[1] + [end_index])
            if best is None or candidate[0] > best[0]:
                best = candidate
        paths[end_index] = best

    final_path = paths[-1]
    if final_path is None or len(final_path[1]) <= 1:
        return _split_long_group(items, max_len, weak_punctuation)
    groups: list[list[dict]] = []
    start_index = 0
    for end_index in final_path[1]:
        groups.append(items[start_index:end_index])
        start_index = end_index
    if len(groups) >= 2:
        tail_length = sum(len(item.get("text", "")) for item in groups[-1])
        previous_length = sum(len(item.get("text", "")) for item in groups[-2])
        if tail_length < min_len and previous_length + tail_length <= max_len:
            groups[-2].extend(groups.pop())
    return rebalance_short_groups(groups, max_len, weak_punctuation)


def split_words_to_segments(items: list[dict], max_len: int, min_len: int = 5,
                             gap_split_ms: int = 1000,
                             natural_target_len: int | None = None,
                             natural_max_len: int | None = None) -> list[dict]:
    """把字/词级 timestamps 合并成句子级字幕。

    切分策略（与本地版一致）：
    0. 按静音间隔（>= gap_split_ms）预切
    1. 每个静音组内按强标点（共享断句配置 + 换行）继续切句
    2. 合并过短片段（< min_len 字符），但合并后不得超过 max_len
    3. 对本身超长的片段，按共享配置中的标点优先拆分
    4. 没有弱标点时，用 jieba 分词找最佳断点
    """
    STRONG_PUNCT = _strong_punct_set("\n")
    WEAK_PUNCT = _weak_punct_set()

    def to_seg(group):
        text = "".join(it["text"] for it in group)
        return {
            "start": group[0]["start"],
            "end": group[-1]["end"],
            "text": text,
            "items": [dict(it) for it in group],
        }

    final: list[list[dict]] = []
    silence_groups = split_by_silence(items, gap_split_ms)

    for sg in silence_groups:
        strong_ends = punctuation_item_ends(sg, STRONG_PUNCT)
        raw_groups: list[list[dict]] = []
        buf: list[dict] = []
        for index, it in enumerate(sg):
            buf.append(it)
            if index + 1 in strong_ends:
                raw_groups.append(buf)
                buf = []
        if buf:
            raw_groups.append(buf)

        merged: list[list[dict]] = []
        for grp in raw_groups:
            seg_text = "".join(it["text"] for it in grp)
            if merged and len(seg_text) < min_len:
                previous_length = sum(len(item.get("text", "")) for item in merged[-1])
                if previous_length + len(seg_text) <= max_len:
                    merged[-1].extend(grp)
                else:
                    merged.append(list(grp))
            else:
                merged.append(list(grp))
        if len(merged) >= 2:
            last_text = "".join(it["text"] for it in merged[-1])
            previous_text = "".join(it["text"] for it in merged[-2])
            if len(last_text) < min_len and len(previous_text) + len(last_text) <= max_len:
                merged[-2].extend(merged.pop())

        for grp in merged:
            if natural_target_len is None:
                final.extend(_split_long_group(grp, max_len, WEAK_PUNCT))
            else:
                final.extend(_split_cjk_group_naturally(
                    grp,
                    target_len=natural_target_len,
                    max_len=natural_max_len or max_len,
                    min_len=min_len,
                ))

    segments = [to_seg(g) for g in final if g]
    overlong = sum(len(segment["text"]) > max_len for segment in segments)
    if overlong:
        print(f"[断句] {overlong} 条字幕含不可拆的字词或数字单位，保留完整内容，超过单句上限 {max_len} 字。")
    return segments


# ===== 双轨切句：CJK 检测 + 空格语言（英文等）切句 =====

# 默认按词数计量：英文每条字幕 3–13 词（Netflix 风格上限约 14 词）。
# Keep the old provider-module names as compatibility aliases while the
# actual defaults live in the shared language contract.
WESTERN_MAX_WORDS = DEFAULT_MAX_WORDS
WESTERN_MIN_WORDS = DEFAULT_MIN_WORDS

# 英文句末强标点保留现行句子识别策略；超长补拆标点只读共享配置。
WESTERN_STRONG_END = ".!?。！？；"
# 判定时剥掉的尾部引号/括号（如 word." 仍视为句号结尾）
_TRAILING_QUOTES = "\"'”’)]}』」"


def _western_strong_end() -> str:
    """西文句末强标点。

    西文按「词尾字符」判句末。共享配置中的逗号不注入西文句末，避免
    英文口语的每个逗号都成为句末、破坏短句合并；其余配置符号仍生效，
    包括已有设置中的英文分号与用户新增符号（如 ~）。
    """
    extra = _EXTRA_STRONG_PUNCT - {",", "，"}
    return WESTERN_STRONG_END + "".join(sorted(extra))


def is_cjk_char(char: str) -> bool:
    code = ord(char)
    return (
        0x3000 <= code <= 0x303F    # CJK 标点
        or 0x3040 <= code <= 0x30FF  # 日文假名
        or 0x3400 <= code <= 0x4DBF  # CJK 扩展 A
        or 0x4E00 <= code <= 0x9FFF  # CJK 统一表意文字
        or 0xF900 <= code <= 0xFAFF  # CJK 兼容表意
        or 0xFF00 <= code <= 0xFFEF  # 全角字符
    )


def is_cjk_dominant(items: list[dict]) -> bool:
    """item 序列内 CJK 占比 >= 50% 判定为中文主导（走中文切句逻辑）。"""
    if not items:
        return True
    cjk = sum(
        1 for it in items
        if any(is_cjk_char(c) for c in it["text"] if not c.isspace())
    )
    return cjk * 2 >= len(items)


def _ends_with_punct(text: str, punct: str) -> bool:
    stripped = text.rstrip().rstrip(_TRAILING_QUOTES)
    return bool(stripped) and stripped[-1] in punct


def _split_long_western(group: list[dict], max_words: int) -> list[list[dict]]:
    """超过 max_words 词的组：优先在 max_words 内最后一个弱标点处断开，
    没有弱标点则按 max_words 硬切。"""
    if len(group) <= max_words:
        return [group]
    cut = None
    for i in range(1, min(max_words, len(group) - 1) + 1):
        if _ends_with_punct(group[i - 1]["text"], "".join(_weak_punct_set())):
            cut = i
    if cut is None:
        cut = max_words
    return [group[:cut]] + _split_long_western(group[cut:], max_words)


def split_words_to_segments_western(items: list[dict], max_words: int = WESTERN_MAX_WORDS,
                                    min_words: int = WESTERN_MIN_WORDS,
                                    gap_split_ms: int = 1000) -> list[dict]:
    """空格分词语言（英文等）的切句：尽量保住完整句子。

    0. 按静音间隔（>= gap_split_ms）预切
    1. 按句末强标点（. ! ? 及全角）切出完整句子
    2. 合并过短句子（< min_words 词），但合并后不得超过 max_words
    3. 本身超长的句子（> max_words 词）优先按弱标点断，兜底硬切
    """
    def to_seg(group: list[dict]) -> dict:
        return {
            "start": group[0]["start"],
            "end": group[-1]["end"],
            "text": "".join(it["text"] for it in group),
            "items": [dict(it) for it in group],
        }

    final: list[list[dict]] = []
    for sg in split_by_silence(items, gap_split_ms):
        raw_groups: list[list[dict]] = []
        buf: list[dict] = []
        for it in sg:
            buf.append(it)
            if _ends_with_punct(it["text"], _western_strong_end()):
                raw_groups.append(buf)
                buf = []
        if buf:
            raw_groups.append(buf)

        merged: list[list[dict]] = []
        for grp in raw_groups:
            if merged and len(grp) < min_words:
                if len(merged[-1]) + len(grp) <= max_words:
                    merged[-1].extend(grp)
                else:
                    merged.append(list(grp))
            else:
                merged.append(list(grp))
        if (
            len(merged) >= 2
            and len(merged[-1]) < min_words
            and len(merged[-2]) + len(merged[-1]) <= max_words
        ):
            merged[-2].extend(merged.pop())

        for grp in merged:
            final.extend(_split_long_western(grp, max_words))

    return [to_seg(g) for g in final if g]


def split_segments_auto(items: list[dict], *, max_len: int, min_len: int,
                        gap_split_ms: int,
                        max_words: int = WESTERN_MAX_WORDS,
                        min_words: int = WESTERN_MIN_WORDS,
                        natural_cjk: bool = False,
                        split_mode: str | None = None) -> list[dict]:
    """按静音组自动选择切句逻辑（双轨）。

    先按静音间隔预切；未指定 ``split_mode`` 时，每个静音组内 CJK
    主导则走中文逻辑，否则走空格语言逻辑——中英混排的播客也能逐段
    正确归类。已知单一语言时，调用方可传 ``continuous`` 或 ``word``
    固定计量方式。
    """
    segments: list[dict] = []
    for group in split_by_silence(items, gap_split_ms):
        use_cjk = (
            split_mode == "continuous"
            if split_mode in {"continuous", "word"}
            else is_cjk_dominant(group)
        )
        if use_cjk:
            natural_min_len = (
                max(QWEN_AUDIO_NATURAL_MIN_LEN, min_len)
                if natural_cjk else min_len
            )
            segments.extend(split_words_to_segments(
                group,
                max_len,
                natural_min_len,
                0,
                natural_target_len=(
                    min(QWEN_AUDIO_NATURAL_TARGET_LEN, max_len)
                    if natural_cjk else None
                ),
                natural_max_len=(
                    min(QWEN_AUDIO_NATURAL_MAX_LEN, max_len)
                    if natural_cjk else None
                ),
            ))
        else:
            segments.extend(split_words_to_segments_western(group, max_words, min_words, 0))
    return segments


def repair_nonpositive_duration_segments(segments: list[dict]) -> list[dict]:
    """Merge zero/negative-duration API fragments into a neighboring subtitle.

    Qwen filetrans occasionally returns a word or sentence whose begin_time and
    end_time are identical. If punctuation/silence splitting isolates that item,
    it becomes an invalid zero-duration segment. Keep its text, but attach it to
    the next valid subtitle (or the previous one when it is trailing). If a
    merged part contains an invalid item, omit the whole item list: the text is
    still available as a sentence-level cue, but a partial item list would claim
    precision for text whose boundary is unknown.
    """
    repaired: list[dict] = []
    pending: list[dict] = []

    def merge(parts: list[dict]) -> dict:
        starts = [part["start"] for part in parts]
        bounds = [value for part in parts for value in (part["start"], part["end"])]
        start = min(starts)
        end = max(bounds)
        if end <= start:
            end = start + 1
        merged = {
            "start": start,
            "end": end,
            "text": "".join(str(part.get("text", "")) for part in parts),
        }
        item_parts: list[list[dict]] = []
        items_complete = True
        for part in parts:
            raw_items = part.get("items")
            if not isinstance(raw_items, list):
                items_complete = False
                break
            normalized_items: list[dict] = []
            for item in raw_items:
                if not isinstance(item, dict) or not str(item.get("text") or ""):
                    items_complete = False
                    break
                timestamp = normalize_timestamp_range(item.get("start"), item.get("end"))
                if timestamp is None:
                    # 零宽词（begin == end）是确定时间点而非损坏数据，保留
                    # 给 repair_segment_durations 拉宽；否则合并段会整段
                    # 丢弃词级时间码。
                    timestamp = _zero_duration_range(item.get("start"), item.get("end"))
                if timestamp is None:
                    items_complete = False
                    break
                normalized = dict(item)
                normalized["start"], normalized["end"] = timestamp
                normalized_items.append(normalized)
            if not items_complete or not normalized_items:
                items_complete = False
                break
            item_parts.append(normalized_items)
        if items_complete and item_parts:
            merged["items"] = [
                item
                for part_items in item_parts
                for item in part_items
            ]

        # Keep a segment-level speaker only when the merged subtitle still
        # represents one speaker.  This also covers item-level speaker data,
        # which is the only speaker source for some provider fallbacks.
        speakers = {
            str(part["speaker"]).strip()
            for part in parts
            if part.get("speaker") is not None and str(part["speaker"]).strip()
        }
        speakers.update(
            str(item["speaker"]).strip()
            for part in parts
            for item in part.get("items", [])
            if isinstance(item, dict)
            if item.get("speaker") is not None and str(item["speaker"]).strip()
        )
        if len(speakers) == 1:
            merged["speaker"] = next(iter(speakers))
        return merged

    for raw_segment in segments:
        segment = dict(raw_segment)
        # A valid enclosing segment can safely keep its items only when every
        # item has a strictly positive, non-negative range. A single malformed
        # token downgrades the complete segment to sentence precision.
        if "items" in segment:
            raw_items = segment.get("items")
            normalized_items: list[dict] = []
            if isinstance(raw_items, list):
                for item in raw_items:
                    if not isinstance(item, dict) or not str(item.get("text") or ""):
                        normalized_items = []
                        break
                    timestamp = normalize_timestamp_range(item.get("start"), item.get("end"))
                    if timestamp is None:
                        # 零宽词保留（确定时间点），交给 repair_segment_durations
                        # 拉宽；否则含零宽词的段会整段丢失词级时间码。
                        timestamp = _zero_duration_range(item.get("start"), item.get("end"))
                    if timestamp is None:
                        normalized_items = []
                        break
                    normalized = dict(item)
                    normalized["start"], normalized["end"] = timestamp
                    normalized_items.append(normalized)
            if normalized_items:
                segment["items"] = normalized_items
            else:
                segment.pop("items", None)
        if segment["end"] <= segment["start"]:
            pending.append(segment)
            continue
        if pending:
            segment = merge([*pending, segment])
            pending = []
        repaired.append(segment)

    if pending:
        if repaired:
            repaired[-1] = merge([repaired[-1], *pending])
        else:
            repaired.append(merge(pending))
    return repaired


# 无词级时间码时的文本切块断点：强/弱标点与西文常用标点，并上额外断句符号。
_COARSE_PIECE_BREAK_PUNCT = "。！？；，、：,.!?;:"


def build_interpolated_items(
    text: str,
    start_ms: int,
    end_ms: int,
    *,
    max_piece_len: int,
) -> list[dict]:
    """把无词级时间码的文本按标点切块，并在句段范围内按字数占比插值时间。

    用于句子级兜底段：服务端只给了整句时间范围时，按标点把文本切成
    小块，下游即可继续用标点/最大字数逻辑拆分；时间点是线性插值的
    近似值，因此结果不得再携带 ``items`` 冒充词级精度。
    """
    clean = str(text or "").strip()
    if not clean:
        return []
    if end_ms <= start_ms:
        return [{"text": clean, "start": start_ms, "end": max(end_ms, start_ms + 1)}]

    breaks = set(_COARSE_PIECE_BREAK_PUNCT) | _EXTRA_STRONG_PUNCT
    pieces: list[str] = []
    buf = ""
    for ch in clean:
        buf += ch
        if ch in breaks:
            pieces.append(buf)
            buf = ""
    if buf:
        if buf.strip() or not pieces:
            pieces.append(buf)
        else:
            # 尾部纯空白并回上一块，避免丢字符。
            pieces[-1] += buf

    step = max(1, int(max_piece_len))
    bounded: list[str] = []
    for piece in pieces:
        while len(piece) > step:
            bounded.append(piece[:step])
            piece = piece[step:]
        if piece:
            bounded.append(piece)

    total = sum(len(piece) for piece in bounded)
    span = end_ms - start_ms
    items: list[dict] = []
    cursor = start_ms
    cum = 0
    for index, piece in enumerate(bounded):
        cum += len(piece)
        if index == len(bounded) - 1:
            boundary = end_ms
        else:
            boundary = start_ms + int(round(span * cum / total))
            boundary = max(boundary, cursor + 1)
        items.append({"text": piece, "start": cursor, "end": boundary})
        cursor = boundary
    return items


def build_interpolated_word_items(
    text: str,
    start_ms: int,
    end_ms: int,
) -> list[dict]:
    """把无词级时间码的西文文本按空白分词，并在段范围内按字符占比插值时间。

    与 ``build_interpolated_items`` 的标点切块不同，单词型文本的插值单位
    必须是完整单词：按字符硬切会把西文单词劈开，下游按词计数的切句器
    会把半个单词当成一个词。item 文本沿用「前导空格挂在后一个词」的
    约定，拼接后与原文一致；时间点是线性插值的近似值，结果不得携带
    ``items`` 冒充词级精度。
    """
    clean = str(text or "")
    if not clean.strip():
        return []
    if end_ms <= start_ms:
        return [{"text": clean.strip(), "start": start_ms, "end": max(end_ms, start_ms + 1)}]

    tokens = _re.findall(r"\s*\S+", clean)
    total = sum(len(token) for token in tokens)
    span = end_ms - start_ms
    items: list[dict] = []
    cursor = start_ms
    cum = 0
    for index, token in enumerate(tokens):
        cum += len(token)
        if index == len(tokens) - 1:
            boundary = end_ms
        else:
            boundary = start_ms + int(round(span * cum / total))
            boundary = max(boundary, cursor + 1)
        items.append({"text": token, "start": cursor, "end": boundary})
        cursor = boundary
    return items


def split_coarse_segment(
    segment: dict,
    *,
    max_len: int,
    min_len: int,
    gap_split_ms: int,
    max_words: int = WESTERN_MAX_WORDS,
    min_words: int = WESTERN_MIN_WORDS,
    split_mode: str | None = None,
) -> list[dict]:
    """对句级兜底段做超长二次拆分，保留原句边界。

    - 不超长的段原样返回（包括其 items）。
    - 超长且带有效 items 的段用词级时间精确拆分。
    - 超长且无 items 的段插值时间拆分（连续语言按标点切块，单词型按
      空白分词），结果不携带 items。
    """
    text = str(segment.get("text") or "")
    if split_mode == "word":
        overlong = len(text.split()) > max_words
    else:
        overlong = len(text) > max_len
    if not overlong:
        return [segment]

    raw_items = segment.get("items")
    raw_items = raw_items if isinstance(raw_items, list) and raw_items else []
    if raw_items:
        pieces = split_segments_auto(
            [dict(item) for item in raw_items],
            max_len=max_len,
            min_len=min_len,
            gap_split_ms=gap_split_ms,
            max_words=max_words,
            min_words=min_words,
            split_mode=split_mode,
        )
    else:
        if split_mode == "word":
            pseudo_items = build_interpolated_word_items(text, segment["start"], segment["end"])
        else:
            pseudo_items = build_interpolated_items(
                text, segment["start"], segment["end"], max_piece_len=max_len
            )
        if not pseudo_items:
            return [segment]
        pieces = split_segments_auto(
            pseudo_items,
            max_len=max_len,
            min_len=min_len,
            gap_split_ms=0,
            max_words=max_words,
            min_words=min_words,
            split_mode=split_mode,
        )
        # 插值时间是近似值，不得伪装成词级精度写进工程。
        pieces = [
            {key: value for key, value in piece.items() if key != "items"}
            for piece in pieces
        ]
    if not pieces:
        return [segment]

    # 外缘对齐原段范围（与 build_segments_from_api_sentences 的包络做法一致），
    # 防止服务端句级范围与词级范围的圆整差异造成越界。
    pieces[0]["start"] = min(pieces[0]["start"], segment["start"])
    pieces[-1]["end"] = max(pieces[-1]["end"], segment["end"])
    speaker = segment.get("speaker")
    if speaker is not None:
        for piece in pieces:
            piece["speaker"] = speaker
    return pieces


def split_coarse_segments(
    segments: list[dict],
    *,
    max_len: int,
    min_len: int,
    gap_split_ms: int,
    max_words: int = WESTERN_MAX_WORDS,
    min_words: int = WESTERN_MIN_WORDS,
    split_mode: str | None = None,
    interpolated_boundary_indices: set[int] | None = None,
) -> list[dict]:
    """逐段调用 split_coarse_segment（见其 docstring）。"""
    result: list[dict] = []
    for segment in segments:
        pieces = split_coarse_segment(
            segment,
            max_len=max_len,
            min_len=min_len,
            gap_split_ms=gap_split_ms,
            max_words=max_words,
            min_words=min_words,
            split_mode=split_mode,
        )
        if interpolated_boundary_indices is not None and not segment.get("items"):
            interpolated_boundary_indices.update(range(len(result) + 1, len(result) + len(pieces)))
        result.extend(pieces)
    return result


def _zero_duration_range(begin_time: object, end_time: object) -> tuple[int, int] | None:
    """把云端偶发的零时长句子/词（begin == end）保留为一个确定时间点。

    qwen3-asr-flash-filetrans 会为语气词等占位句返回 begin_time == end_time
    （实测"啊。"600640→600640），也会对部分正常词给出零宽时间码（实测
    "玩"2000→2000，紧贴前词结束点）。范围虽然零宽但时间点真实：句子保留
    为零长段、词保留为零宽 item，交给下游修复/插值；1.6.x 曾因这类数据
    触发保险把整份时间码废弃成整段单条字幕，2 句废掉全片。
    """
    if (
        isinstance(begin_time, int)
        and isinstance(end_time, int)
        and begin_time == end_time
        and begin_time >= 0
    ):
        return (begin_time, end_time)
    return None


def build_segments_preserving_speakers(
    items: list[dict],
    *,
    max_len: int,
    min_len: int,
    gap_split_ms: int,
    max_words: int = WESTERN_MAX_WORDS,
    min_words: int = WESTERN_MIN_WORDS,
    split_mode: str | None = None,
) -> list[dict]:
    """在每个 speaker run 内切句和修复零时长，避免跨说话人合并。"""
    segments: list[dict] = []
    for run in split_items_by_speaker(items):
        speaker = next(
            (str(item["speaker"]) for item in run if item.get("speaker") is not None),
            None,
        )
        run_segments = split_segments_auto(
            run,
            max_len=max_len,
            min_len=min_len,
            gap_split_ms=gap_split_ms,
            max_words=max_words,
            min_words=min_words,
            split_mode=split_mode,
        )
        run_segments = repair_nonpositive_duration_segments(run_segments)
        if speaker is not None:
            for segment in run_segments:
                segment["speaker"] = speaker
        segments.extend(run_segments)
    return segments


def build_segments_from_api_sentences(
    sentences: list[dict],
    *,
    max_len: int,
    min_len: int,
    gap_split_ms: int,
    max_words: int = WESTERN_MAX_WORDS,
    min_words: int = WESTERN_MIN_WORDS,
    split_mode: str | None = None,
) -> list[dict]:
    """优先保留云端句子边界，只在单句内部进行必要的切分。

    Qwen-Audio 的 filetrans 可能把几十秒中文作为一个无内部标点的
    sentence 返回。这里把每个 API sentence 当作硬边界；有标点的句子
    沿用现有标点/词边界逻辑，只有超长且内部没有标点的句子才使用中文
    词性启发式自然切句，避免退化为固定字数硬切。
    """
    segments: list[dict] = []
    for sentence in sentences:
        if not isinstance(sentence, dict):
            continue
        raw_items = sentence.get("items", [])
        raw_items = raw_items if isinstance(raw_items, list) else []
        items: list[dict] = []
        raw_item_texts: list[str] = []
        invalid_item = False
        for raw_item in raw_items:
            if not isinstance(raw_item, dict):
                invalid_item = True
                continue
            item_text = str(raw_item.get("text") or "")
            if not item_text.strip():
                continue
            raw_item_texts.append(item_text)
            timestamp = normalize_timestamp_range(
                raw_item.get("start"), raw_item.get("end")
            )
            if timestamp is None:
                timestamp = _zero_duration_range(
                    raw_item.get("start"), raw_item.get("end")
                )
            if timestamp is None:
                invalid_item = True
                continue
            item = dict(raw_item)
            item["start"], item["end"] = timestamp
            item["text"] = item_text
            items.append(item)
        item_range = (
            min((item["start"] for item in items), default=0),
            max((item["end"] for item in items), default=0),
        ) if items else None
        if invalid_item:
            # Do not keep a partial list: the item that failed may be in the
            # middle of the sentence. The enclosing sentence range is still
            # useful when it is valid.
            items = []
        sentence_text = str(sentence.get("text") or "").strip()
        if not sentence_text:
            sentence_text = "".join(raw_item_texts).strip()
        sentence_speaker = sentence.get("speaker")

        if items and not timestamp_items_cover_text(sentence_text, items):
            items = []
        if not items:
            sentence_text = sentence_text.strip()
            if not sentence_text:
                continue
            sentence_range = normalize_timestamp_range(
                sentence.get("start"), sentence.get("end")
            )
            if sentence_range is None:
                if item_range is None:
                    continue
                sentence_range = item_range
            elif item_range is not None:
                sentence_range = (
                    min(sentence_range[0], item_range[0]),
                    max(sentence_range[1], item_range[1]),
                )
            segment = {
                "start": sentence_range[0],
                "end": sentence_range[1],
                "text": sentence_text,
            }
            if sentence_speaker is not None:
                segment["speaker"] = str(sentence_speaker)
            # 无词级时间码的句子不再整句落盘：保留句边界，
            # 超长时按标点/最大字数做兜底二次拆分。
            segments.extend(split_coarse_segment(
                segment,
                max_len=max_len,
                min_len=min_len,
                gap_split_ms=gap_split_ms,
                max_words=max_words,
                min_words=min_words,
                split_mode=split_mode,
            ))
            continue

        sentence_segments: list[dict] = []
        for run in split_items_by_speaker(items):
            run_text = "".join(item.get("text", "") for item in run)
            has_internal_punctuation = any(
                any(char in (set(_COARSE_PIECE_BREAK_PUNCT) | _EXTRA_STRONG_PUNCT) for char in item.get("text", ""))
                for item in run[:-1]
            )
            run_segments = split_segments_auto(
                run,
                max_len=max_len,
                min_len=min_len,
                gap_split_ms=gap_split_ms,
                max_words=max_words,
                min_words=min_words,
                split_mode=split_mode,
                natural_cjk=(
                    len(run_text) > max_len
                    and is_cjk_dominant(run)
                    and not has_internal_punctuation
                ),
            )
            run_segments = repair_nonpositive_duration_segments(run_segments)
            run_speaker = next(
                (str(item["speaker"]) for item in run if item.get("speaker") is not None),
                str(sentence_speaker) if sentence_speaker is not None else None,
            )
            if run_speaker is not None:
                for segment in run_segments:
                    segment["speaker"] = run_speaker
            sentence_segments.extend(run_segments)

        if not sentence_segments:
            continue

        # 用 API 句级时间范围覆盖未拆分句子的首尾；拆分时只把首尾
        # 扩展到句级范围，内部边界仍使用词级时间戳。若 API 句级范围
        # 缺失或没有包住词级范围，则扩大到两者的包络，避免生成越界 item。
        sentence_range = normalize_timestamp_range(
            sentence.get("start"), sentence.get("end")
        )
        if sentence_range is None:
            sentence_range = (
                sentence_segments[0]["start"],
                sentence_segments[-1]["end"],
            )
        sentence_start = min(sentence_range[0], sentence_segments[0]["start"])
        sentence_end = max(sentence_range[1], sentence_segments[-1]["end"])
        if len(sentence_segments) == 1:
            sentence_segments[0]["start"] = sentence_start
            sentence_segments[0]["end"] = sentence_end
        else:
            sentence_segments[0]["start"] = sentence_start
            sentence_segments[-1]["end"] = sentence_end
        segments.extend(sentence_segments)

    return segments
