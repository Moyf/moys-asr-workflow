"""MAW 公共工具函数 — 供 CLI（generate_subtitle_qwen_api.py）和 Web 控制台共享。"""

from __future__ import annotations

import argparse
import json
import os
import re as _re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


# ===== 字幕切分默认参数 =====

SPLIT_MAX_CHARS = 21       # 每条字幕最大字符数
SPLIT_MIN_CHARS = 5        # 最短字符数，不足则合并到上一句
SPLIT_GAP_MS = 1500        # 静音切句阈值（毫秒）


# ===== ffmpeg 工具函数 =====

def extract_audio(video_path: str, output_path: str) -> None:
    """从视频中提取 16kHz 单声道 WAV 音频。"""
    cmd = [
        "ffmpeg", "-i", video_path,
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
        "-y", output_path,
    ]
    print(f"[ffmpeg] 正在提取音频: {video_path}")
    subprocess.run(cmd, check=True, capture_output=True)
    print("[ffmpeg] 音频提取完成")


def get_duration_sec(filepath: str) -> float:
    """用 ffprobe 获取媒体文件时长（秒）。"""
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "csv=p=0", filepath,
    ]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return float(out.stdout.strip())


def parse_duration(value: str) -> float:
    """解析时长字符串，支持 h/m/s 后缀。
    
    示例: 10m, 20s, 1h, 90（裸数字视为秒）
    """
    value = value.strip().lower()
    m = _re.fullmatch(r'([\d.]+)\s*(h|m|s)?', value)
    if not m:
        raise argparse.ArgumentTypeError(
            f"无法解析时长: '{value}'，示例: 10m, 20s, 1h, 90"
        )
    num = float(m.group(1))
    unit = m.group(2)
    if unit == 'h':
        return num * 3600
    elif unit == 'm':
        return num * 60
    return num


# ===== SRT / 时间戳工具 =====

def format_timestamp(ms: int) -> str:
    """毫秒 → SRT 时间戳格式 (HH:MM:SS,mmm)。"""
    h = ms // 3_600_000
    ms %= 3_600_000
    m = ms // 60_000
    ms %= 60_000
    s = ms // 1_000
    ms %= 1_000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(segments: list[dict]) -> str:
    """segments 列表 → SRT 格式字符串。"""
    lines = []
    for i, seg in enumerate(segments, 1):
        start = format_timestamp(seg["start"])
        end = format_timestamp(seg["end"])
        text = seg["text"].strip()
        lines.append(f"{i}\n{start} --> {end}\n{text}\n")
    return "\n".join(lines)


# ===== 切句逻辑 =====

def _split_by_silence(items: list[dict], min_gap_ms: int) -> list[list[dict]]:
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


def _split_long_group(items: list[dict], max_len: int, weak_punct: set) -> list[list[dict]]:
    """递归拆分超长词组。"""
    text_total = "".join(it["text"] for it in items)
    if len(text_total) <= max_len:
        return [items]

    # 优先按弱标点拆
    cum_len = 0
    punct_idx = None
    for i, it in enumerate(items):
        cum_len += len(it["text"])
        if cum_len > max_len:
            break
        if any(c in weak_punct for c in it["text"]):
            punct_idx = i + 1

    if punct_idx is not None and punct_idx < len(items):
        return _split_long_group(items[:punct_idx], max_len, weak_punct) + \
               _split_long_group(items[punct_idx:], max_len, weak_punct)

    # 用 jieba 分词找最佳断点
    try:
        import jieba
        words = list(jieba.cut(text_total))
    except ImportError:
        words = list(text_total)  # 无 jieba 则按字硬切
    boundaries = []
    pos = 0
    for w in words:
        pos += len(w)
        boundaries.append(pos)

    best_char_pos = None
    for b in boundaries:
        if 0 < b <= max_len:
            if best_char_pos is None or abs(b - max_len) < abs(best_char_pos - max_len):
                best_char_pos = b

    if best_char_pos is not None and best_char_pos < len(text_total):
        cum_len = 0
        split_idx = None
        for i, it in enumerate(items):
            cum_len += len(it["text"])
            if cum_len >= best_char_pos:
                split_idx = i + 1
                break
        if split_idx is not None and 0 < split_idx < len(items):
            return _split_long_group(items[:split_idx], max_len, weak_punct) + \
                   _split_long_group(items[split_idx:], max_len, weak_punct)

    # 兜底：按 max_len 字符硬切
    cum_len = 0
    for i, it in enumerate(items):
        cum_len += len(it["text"])
        if cum_len >= max_len:
            return [items[:i + 1]] + _split_long_group(items[i + 1:], max_len, weak_punct)
    return [items]


def split_words_to_segments(items: list[dict], max_len: int = SPLIT_MAX_CHARS,
                            min_len: int = SPLIT_MIN_CHARS,
                            gap_split_ms: int = SPLIT_GAP_MS) -> list[dict]:
    """把字/词级 timestamps 合并成句子级字幕。

    切分策略：
    0. 按静音间隔（>= gap_split_ms）预切
    1. 每个静音组内按强标点（。！？；\\n）继续切句
    2. 合并过短片段（< min_len 字符）
    3. 对超长片段，按弱标点（，、：,;）拆分
    4. 没有弱标点时，用 jieba 分词找最佳断点
    """
    STRONG_PUNCT = set("。！？；\n")
    WEAK_PUNCT = set("，、：,;")

    def to_seg(group):
        text = "".join(it["text"] for it in group)
        start = group[0]["start"]
        end = group[-1]["end"]
        if end <= start:
            end = start + 1
        return {
            "start": start,
            "end": end,
            "text": text,
            "items": [dict(it) for it in group],
        }

    final: list[list[dict]] = []
    silence_groups = _split_by_silence(items, gap_split_ms)

    for sg in silence_groups:
        raw_groups: list[list[dict]] = []
        buf: list[dict] = []
        for it in sg:
            buf.append(it)
            if any(c in STRONG_PUNCT for c in it["text"]):
                raw_groups.append(buf)
                buf = []
        if buf:
            raw_groups.append(buf)

        merged: list[list[dict]] = []
        for grp in raw_groups:
            seg_text = "".join(it["text"] for it in grp)
            if merged and len(seg_text) < min_len:
                merged[-1].extend(grp)
            else:
                merged.append(list(grp))
        if len(merged) >= 2:
            last_text = "".join(it["text"] for it in merged[-1])
            if len(last_text) < min_len:
                merged[-2].extend(merged.pop())

        for grp in merged:
            final.extend(_split_long_group(grp, max_len, WEAK_PUNCT))

    result = [to_seg(g) for g in final if g]
    # 保证相邻 segment 不重叠 + 钳制 items 时间在 segment bounds 内
    for i in range(1, len(result)):
        prev_end = result[i - 1]["end"]
        if result[i]["start"] < prev_end:
            result[i]["start"] = prev_end
            if result[i]["end"] <= result[i]["start"]:
                result[i]["end"] = result[i]["start"] + 1
            for item in result[i].get("items", []):
                if item["start"] < result[i]["start"]:
                    item["start"] = result[i]["start"]
                if item["end"] < item["start"]:
                    item["end"] = item["start"]
                if item["end"] > result[i]["end"]:
                    item["end"] = result[i]["end"]
    return result
