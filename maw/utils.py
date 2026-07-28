"""MAW 公共工具函数转接层 —— 供本地转写模块等复用。

所有函数定义在 generate_subtitle_qwen_api.py 中，
本模块仅做 re-export，避免直接依赖 CLI 模块的内部符号。
"""

from __future__ import annotations

from generate_subtitle_qwen_api import (
    WESTERN_MAX_WORDS as WESTERN_MAX_WORDS,
    WESTERN_MIN_WORDS as WESTERN_MIN_WORDS,
    extract_audio as extract_audio,
    format_timestamp as format_timestamp,
    generate_srt as generate_srt,
    get_duration_sec as get_duration_sec,
    is_cjk_char as is_cjk_char,
    is_cjk_dominant as is_cjk_dominant,
    load_hotwords as load_hotwords,
    parse_duration as parse_duration,
    repair_nonpositive_duration_segments as repair_nonpositive_duration_segments,
    split_by_silence as split_by_silence,
    split_segments_auto as split_segments_auto,
    split_words_to_segments as split_words_to_segments,
    split_words_to_segments_western as split_words_to_segments_western,
)

# 与旧版 maw/utils.py 保持一致，供本地转写模块使用
# 这些常量原为函数默认参数值，此处显式化方便引用
SPLIT_MAX_CHARS: int = 21
SPLIT_MIN_CHARS: int = 5
SPLIT_GAP_MS: int = 1000  # 与上游 generate_subtitle_qwen_api.py 默认值一致
