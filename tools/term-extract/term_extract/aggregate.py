"""OCR 识别块 → 显示事件 → 变体分组 → 术语候选。

设计要点（继承外部设计文档）：
- 区分「原始命中次数」与「独立显示事件次数」，固定 UI 不因重复采样刷分；
- 近似写法只分组展示、不自动合并（「LJ-8」与「LJ-84」可能是两个真实物品）；
- 候选保留时间点与证据帧引用，误判可回查。
"""

from __future__ import annotations

import re
from collections import Counter
from collections.abc import Iterable, Mapping, Sequence
from typing import Final

from maw.postprocess_ocr import _levenshtein_similarity, normalize

# 上下文模板：v1 内置中文游戏 UI 常见句式（SPEC §3.4）。
CONTEXT_TEMPLATES: Final[tuple[tuple[str, str, re.Pattern[str]], ...]] = (
    ("goto", "地点", re.compile(r"前往(.{1,12}?)(?=[，。,！？!?\s]|$)")),
    ("talk", "人物", re.compile(r"与(.{1,8}?)(?:交谈|对话|谈话)")),
    ("obtain", "道具", re.compile(r"(?:获得|取得|拾取)(.{1,12}?)(?=[，。,！？!?\s]|$)")),
    ("unlock-skill", "技能", re.compile(r"解锁技能[「『“]?(.{1,12}?)(?:[」』”]|$)")),
    ("quoted", "其他专名", re.compile(r"[「『《]([^」』》\n]{1,12}?)[」』》]")),
)
# 型号词形：字母 + 可选连字符 + 数字（如 LJ-84）。
MODEL_SHAPE: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z]{1,6}[-–]?\d{1,5}$")

VARIANT_SIMILARITY: Final[float] = 0.85
MIN_WORD_CHARS: Final[int] = 2


def event_gap_ms(fps: float) -> int:
    """同文本两帧之间超过该间隔即视为新的独立显示事件。"""

    return int(2000.0 / max(fps, 0.2) + 500)


def aggregate_events(blocks: Sequence[Mapping[str, object]], fps: float) -> list[dict[str, object]]:
    """把 OCR 命中按「同文本 + 时间连续」聚合为显示事件。

    只按时间窗合并、不看位置框：弹幕滚动、同屏双框、画面轻微变化都属于
    同一连续显示时段，位置门槛会把它们误拆成多个事件、虚增独立事件数。
    事件内部仍保留各帧的文字框证据（evidence）。
    """

    grouped: dict[str, list[dict[str, object]]] = {}
    for block in blocks:
        text = str(block.get("text") or "").strip()
        key = normalize(text)
        if not text or len(key) < MIN_WORD_CHARS:
            continue
        grouped.setdefault(key, []).append(
            {
                "text": text,
                "score": float(block.get("score") or 0.0),
                "box": list(block.get("box") or []),
                "tMs": int(block.get("tMs") or 0),
                "frame": block.get("frame"),
            }
        )

    gap = event_gap_ms(fps)
    events: list[dict[str, object]] = []
    for key in sorted(grouped):
        events.extend(_build_event(key, cluster) for cluster in _cluster_by_time(grouped[key], gap))
    events.sort(key=lambda event: (event["startMs"], str(event["key"])))
    return events


def _cluster_by_time(
    hits: Sequence[Mapping[str, object]], gap: int
) -> list[list[dict[str, object]]]:
    """按时间间隔把命中聚成簇：相邻命中间隔 ≤ gap 即同一连续显示时段。"""

    clusters: list[list[dict[str, object]]] = []
    for hit in sorted(hits, key=lambda item: int(item["tMs"])):
        if clusters and int(hit["tMs"]) - int(clusters[-1][-1]["tMs"]) <= gap:
            clusters[-1].append(dict(hit))
            continue
        clusters.append([dict(hit)])
    return clusters


def _build_event(key: str, cluster: list[dict[str, object]]) -> dict[str, object]:
    text_counter = Counter(str(hit["text"]) for hit in cluster)
    frames = [hit["frame"] for hit in cluster if hit.get("frame")]
    evidence = [
        {"frame": str(hit["frame"]), "box": list(hit["box"] or [])}
        for hit in cluster[:3]
        if hit.get("frame") and len(list(hit.get("box") or [])) == 4
    ]
    return {
        "key": key,
        "text": text_counter.most_common(1)[0][0],
        "startMs": cluster[0]["tMs"],
        "endMs": cluster[-1]["tMs"],
        "hits": len(cluster),
        "avgConf": round(sum(float(hit["score"]) for hit in cluster) / len(cluster), 4),
        "frames": sorted(set(str(frame) for frame in frames)),
        "evidence": evidence,
    }


def group_variants(
    events: Sequence[Mapping[str, object]], threshold: float = VARIANT_SIMILARITY
) -> list[dict[str, object]]:
    """按编辑距离把近似写法归组；每组取命中最多者为标准候选，其余列为变体。

    短词（归一化 ≤ 3 字符，如「星核/星孩」）整体相似度天然偏低，补充规则：
    首字相同且编辑距离为 1 时也视为同一写法的近似变体。「LJ-84/LJ-85」这类
    4 字符以上型号不受短词规则影响，仍按 0.85 相似度判定，避免错误合并。
    """

    ordered = sorted(events, key=lambda event: event["hits"], reverse=True)  # type: ignore[arg-type]
    groups: list[dict[str, object]] = []
    for event in ordered:
        key = str(event.get("key") or "")
        joined = False
        for group in groups:
            canonical = str(group["canonical"].get("key") or "")
            if _keys_similar(canonical, key, threshold):
                group["members"].append(event)
                joined = True
                break
        if not joined:
            groups.append({"canonical": event, "members": [event]})
    return groups


def _keys_similar(left: str, right: str, threshold: float) -> bool:
    if not left or not right:
        return False
    similarity = _levenshtein_similarity(left, right)
    if similarity >= threshold:
        return True
    if len(left) <= 3 and len(right) <= 3 and left[0] == right[0]:
        distance = round((1.0 - similarity) * max(len(left), len(right)))
        return distance <= 1
    return False


def extract_candidates(blocks: Sequence[Mapping[str, object]], fps: float) -> list[dict[str, object]]:
    """从识别块生成完整候选列表（含变体、事件证据、类型猜测、上下文样例）。

    候选来源有两类：显示事件本身的标准写法，以及上下文模板从整行文字中
    抽出的词（如「前往星核」抽出「星核」）——后者即使从未单独成块，也以
    来源块的命中构造伪事件，保留时间点证据。
    """

    events = aggregate_events(blocks, fps)
    groups = group_variants(events)
    template_hits = _template_hits(blocks)
    candidates: list[dict[str, object]] = []
    seen_keys: set[str] = set()
    for group in groups:
        canonical = group["canonical"]
        members: list[Mapping[str, object]] = group["members"]
        word = str(canonical["text"])
        word_key = str(canonical["key"])
        seen_keys.add(word_key)
        merged_events = sorted(members, key=lambda member: member["startMs"])  # type: ignore[type-var]
        variants = [
            {"text": str(member["text"]), "count": member["hits"]}
            for member in merged_events
            if str(member["key"]) != word_key
        ]
        templates = [
            {"name": name, "type": type_guess, "term": term, "source": str(source.get("text") or "")}
            for name, type_guess, term, source in template_hits.get(word_key, [])
        ]
        candidate = {
            "word": word,
            "typeGuess": _guess_type(word, templates),
            "variants": variants,
            "events": [_event_payload(event) for event in merged_events],
            "eventCount": len(merged_events),
            "hitCount": sum(int(member["hits"]) for member in members),  # type: ignore[arg-type]
            "avgConf": _weighted_confidence(members),
            "contexts": _context_samples(word_key, members, blocks),
            "templates": templates,
        }
        candidates.append(candidate)
    candidates.extend(_template_only_candidates(template_hits, seen_keys, blocks, fps))
    candidates.sort(key=lambda candidate: (-candidate["hitCount"], candidate["word"]))  # type: ignore[arg-type, return-value]
    return candidates


def _template_only_candidates(
    template_hits: Mapping[str, list[tuple[str, str, str, Mapping[str, object]]]],
    seen_keys: set[str],
    blocks: Sequence[Mapping[str, object]],
    fps: float,
) -> list[dict[str, object]]:
    """模板抽出但从未单独成块的词，以来源块命中构造伪事件候选。

    同一来源块会被多个模板命中（如「解锁技能「热情似火」」同时命中
    unlock-skill 与 quoted），先按 (文本, 时间) 去重再按时间窗聚合，
    避免同一出现被计成多个伪事件。
    """

    from collections import Counter

    candidates: list[dict[str, object]] = []
    gap = event_gap_ms(fps)
    for key, hits in template_hits.items():
        if key in seen_keys or not hits:
            continue
        term_counter = Counter(term for _name, _type, term, _block in hits)
        word = term_counter.most_common(1)[0][0]
        unique_blocks: dict[tuple[str, int], Mapping[str, object]] = {}
        for _name, _type, _term, block in hits:
            block_key = (str(block.get("text") or ""), int(block.get("tMs") or 0))
            unique_blocks.setdefault(block_key, block)
        cluster_hits = [
            {
                "text": str(block.get("text") or ""),
                "score": float(block.get("score") or 0.0),
                "box": list(block.get("box") or []),
                "tMs": int(block.get("tMs") or 0),
                "frame": block.get("frame"),
            }
            for block in unique_blocks.values()
        ]
        pseudo_events = [_build_event(key, cluster) for cluster in _cluster_by_time(cluster_hits, gap)]
        candidates.append(
            {
                "word": word,
                "typeGuess": _guess_type(word, [{"type": hits[0][1]}]),
                "variants": [
                    {"text": term, "count": count}
                    for term, count in term_counter.most_common()
                    if term != word
                ],
                "events": [_event_payload(event) for event in pseudo_events],
                "eventCount": len(pseudo_events),
                "hitCount": sum(int(event["hits"]) for event in pseudo_events),
                "avgConf": _weighted_confidence(pseudo_events),
                "contexts": _context_samples(key, [], blocks),
                "templates": [
                    {"name": name, "type": type_guess, "term": term, "source": str(block.get("text") or "")}
                    for name, type_guess, term, block in hits[:5]
                ],
            }
        )
    return candidates


def _template_hits(
    blocks: Sequence[Mapping[str, object]]
) -> dict[str, list[tuple[str, str, str, Mapping[str, object]]]]:
    """扫描全部识别行，收集模板命中的词 → (模板名, 类型, 提取词, 来源块)。"""

    hits: dict[str, list[tuple[str, str, str, Mapping[str, object]]]] = {}
    for block in blocks:
        text = str(block.get("text") or "")
        if len(text) < 3:
            continue
        for name, type_guess, pattern in CONTEXT_TEMPLATES:
            for match in pattern.finditer(text):
                term = match.group(1).strip()
                key = normalize(term)
                if len(key) >= MIN_WORD_CHARS:
                    hits.setdefault(key, []).append((name, type_guess, term, block))
    return hits


def _guess_type(word: str, templates: Sequence[Mapping[str, object]]) -> str:
    if MODEL_SHAPE.match(word):
        return "型号"
    if templates:
        return str(templates[0]["type"])
    return ""


def _weighted_confidence(members: Sequence[Mapping[str, object]]) -> float:
    total_weight = 0
    weighted = 0.0
    for member in members:
        weight = int(member["hits"])  # type: ignore[arg-type]
        total_weight += weight
        weighted += float(member["avgConf"]) * weight  # type: ignore[arg-type]
    return round(weighted / total_weight, 4) if total_weight else 0.0


def _context_samples(
    word_key: str,
    members: Iterable[Mapping[str, object]],
    blocks: Sequence[Mapping[str, object]],
) -> list[str]:
    variant_keys = {str(member["key"]) for member in members} | {word_key}
    contexts: list[str] = []
    seen: set[str] = set()
    for block in blocks:
        text = str(block.get("text") or "").strip()
        key = normalize(text)
        if not text or key in seen or len(text) > 40:
            continue
        if any(variant in key for variant in variant_keys):
            seen.add(key)
            contexts.append(text)
    return contexts[:3]


def _event_payload(event: Mapping[str, object]) -> dict[str, object]:
    return {
        "text": str(event["text"]),
        "startMs": event["startMs"],
        "endMs": event["endMs"],
        "hits": event["hits"],
        "avgConf": event["avgConf"],
        "frames": list(event["frames"]),  # type: ignore[arg-type]
        "evidence": list(event["evidence"]),  # type: ignore[arg-type]
    }
