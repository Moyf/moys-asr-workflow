"""MAW 输出文件命名与目录布局的唯一决策点。

所有自动生成的文件 / 目录路径都应经由本模块函数拼出：

- 最终产物（srt / mosp / ass）默认留在媒体旁，可选统一放入 ``_maw``；
- 其余文件（波形、reapeaks、asr-response、后处理中间产物等）默认进入 ``_maw``；
- 子目录名与操作后缀按 UI 语言（zh / en）本地化，读取时兼容两套命名；
- 旧版媒体同目录的缓存保持兼容读取，不做自动迁移。
"""

from __future__ import annotations

import math
import re
import os
from pathlib import Path
from typing import Final

MAW_DIR_NAME: Final[str] = "_maw"
MAW_STAT_PREFIX: Final[str] = "MAW_STAT"
DEFAULT_LANG: Final[str] = "zh"

# 阿里云百炼录音文件识别单价（元/秒），fun-asr / qwen-audio / qwen3-asr 均适用。
DASHSCOPE_PRICE_PER_SECOND: Final[float] = 0.00022

POSTPROCESS_DIR_NAMES: Final[dict[str, str]] = {"zh": "后处理", "en": "postprocess"}

# 操作显示名（per-language）；未列出的 operation 原样使用，不本地化。
OPERATION_NAMES: Final[dict[str, dict[str, str]]] = {
    "postprocess": {"zh": "后处理", "en": "postprocess"},
    "ocr-dedup": {"zh": "OCR去重", "en": "ocr-dedup"},
    "match": {"zh": "匹配", "en": "match"},
}

# 媒体工具产物后缀（压制字幕/提取音频/媒体重组）；未列出的后缀原样使用。
MEDIA_SUFFIX_NAMES: Final[dict[str, dict[str, str]]] = {
    "gap-removed": {"zh": "去空隙", "en": "gap-removed"},
    "subtitled": {"zh": "压字幕", "en": "subtitled"},
    "audio": {"zh": "音频", "en": "audio"},
}

# 翻译目标语言显示名（按 UI 语言索引的目标名）：zh 界面显示「中文/英文」，
# en 界面保持代码目标名本身（zh/en）。
TRANSLATION_TARGET_NAMES: Final[dict[str, dict[str, str]]] = {
    "zh": {"zh": "中文", "en": "英文"},
    "en": {"zh": "zh", "en": "en"},
}

# 翻译产物 operation 形态：translate-{target} 与带 bilingual/combined 标记的变体。
# 基础段分隔符连字符与下划线都识别（工具箱用下划线 base translate_zh，管线用
# 连字符 translate-zh；merge_bilingual 在工具箱 base 后追加连字符标记
# translate_zh-bilingual，故标记分隔符同样两种都接受）。
# target / marker 不做白名单之外的限定——未知 target 命中模式后由显示层决定回退原文。
_TRANSLATION_OPERATION_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^translate[-_]([a-z]+)(?:[-_](bilingual|combined))?$"
)

# 翻译产物的组合标记显示名（per-language）：zh 界面「双语合一 / 整合」，
# en 界面保持内部 ID（bilingual / combined，用于后缀与回显，文件名 en 输出不经过它）。
TRANSLATION_MARKER_NAMES: Final[dict[str, dict[str, str]]] = {
    "bilingual": {"zh": "双语合一", "en": "bilingual"},
    "combined": {"zh": "整合", "en": "combined"},
}

_INVALID_COMPONENT_CHARS: Final[re.Pattern[str]] = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_WINDOWS_RESERVED_STEMS: Final[set[str]] = {
    "CON", "PRN", "AUX", "NUL",
    *(f"COM{index}" for index in range(1, 10)),
    *(f"LPT{index}" for index in range(1, 10)),
}
_MAW_STAT_PATTERN: Final[re.Pattern[str]] = re.compile(
    rf"^{re.escape(MAW_STAT_PREFIX)}\s+([A-Za-z_]+)=([^\s]+)\s*$"
)


def resolve_lang(explicit: str | None = None) -> str:
    """解析 UI 语言：显式参数优先，其次用户配置，兜底 zh。"""
    if explicit in ("zh", "en"):
        return explicit
    try:
        from maw.gui_config import effective_config

        lang = effective_config().gui_lang
    except Exception:
        lang = None
    return lang if lang in ("zh", "en") else DEFAULT_LANG


def subfolder_prefs() -> tuple[bool, bool]:
    """返回（全部输出放入子文件夹, 每个视频单独子文件夹）两个开关。"""
    try:
        from maw.gui_config import effective_config

        config = effective_config()
        return (bool(config.output_subfolder), bool(config.per_video_subfolder))
    except Exception:
        return (False, False)


def sanitize_component(value: object, fallback: str = "视频") -> str:
    """生成可在 macOS、Windows 与 Linux 使用的目录或文件主名。"""
    raw = str(value or "").strip()
    sanitized = _INVALID_COMPONENT_CHARS.sub("_", raw).strip(" .")
    if sanitized in {"", ".", ".."}:
        sanitized = _INVALID_COMPONENT_CHARS.sub("_", fallback).strip(" .") or "视频"
    if sanitized.split(".", 1)[0].upper() in _WINDOWS_RESERVED_STEMS:
        sanitized += "_"
    return sanitized[:160]


def maw_root(media_path: Path | str, *, per_video: bool | None = None) -> Path:
    """返回媒体对应的 MAW 子目录：共享 ``_maw`` 或每视频 ``<名称>_maw``。"""
    media = Path(media_path).expanduser().resolve(strict=False)
    if per_video is None:
        per_video = subfolder_prefs()[1]
    if per_video:
        return media.parent / f"{sanitize_component(media.stem, '视频')}{MAW_DIR_NAME}"
    return media.parent / MAW_DIR_NAME


def waveform_dirs(media_path: Path | str) -> list[Path]:
    """波形缓存的目录表：**第 0 项是写入点，其余是读取回退**，顺序即优先级。

    契约（维护者定的）：默认跟随媒体；只有用户明确勾了「将所有输出放入子
    文件夹」时，波形才进对应的 `_maw`。读取端两种位置都要找得到，否则用户
    改一次设置就把全部已有缓存判成过期、整批重抽 ffmpeg。

    ``.ReaPeaks`` 不走这里 —— 那是 REAPER 写的，永远只在媒体旁。
    """
    media_path = Path(media_path).expanduser()
    dirs: list[Path] = []
    if subfolder_prefs()[0]:
        dirs.append(maw_root(media_path))
    dirs.append(media_path.parent)
    dirs.extend(maw_root_candidates(media_path))
    out: list[Path] = []
    seen: set[str] = set()
    for directory in dirs:
        key = os.path.normcase(str(directory))
        if key not in seen:
            seen.add(key)
            out.append(directory)
    return out


def maw_root_candidates(media_path: Path | str) -> list[Path]:
    """兼容查找用的全部 _maw 根候选（共享与每视频两种命名）。"""
    media = Path(media_path).expanduser().resolve(strict=False)
    return [
        media.parent / MAW_DIR_NAME,
        media.parent / f"{sanitize_component(media.stem, '视频')}{MAW_DIR_NAME}",
    ]


def postprocess_workspace(
    media_path: Path | str, lang: str | None = None, *, per_video: bool | None = None
) -> Path:
    """返回后处理中间产物的 run 目录父级：_maw/(后处理|postprocess)。"""
    language = resolve_lang(lang)
    return maw_root(media_path, per_video=per_video) / POSTPROCESS_DIR_NAMES[language]


def postprocess_workspace_candidates(media_path: Path | str, lang: str | None = None) -> list[Path]:
    """兼容查找：两种 _maw 根 × 两套目录语言名的去重组合。

    每个根下先列当前 UI 语言命名的目录，再列另一种语言命名，保证读取时
    「当前写入位置」排在前；顺序固定，不依赖 set 迭代的随机性。
    """
    language = resolve_lang(lang)
    current_name = POSTPROCESS_DIR_NAMES[language]
    names = [
        current_name,
        *(name for name in POSTPROCESS_DIR_NAMES.values() if name != current_name),
    ]
    candidates: list[Path] = []
    for root in maw_root_candidates(media_path):
        for name in names:
            candidate = root / name
            if candidate not in candidates:
                candidates.append(candidate)
    return candidates


def is_translation_operation(operation: str) -> bool:
    """判断 operation 是否为翻译产物命名（translate-{target}[-bilingual|-combined]）。

    连字符与下划线两种分隔符都识别（``translate-zh``、``translate_zh`` 及其带
    bilingual/combined 标记的变体）。只做形态判断，不校验 target 取值：未知 target
    （如 ``translate-ja``）也返回 True，由显示层决定是否回退原文。
    """
    return _TRANSLATION_OPERATION_PATTERN.fullmatch(operation) is not None


def translation_marker_name(marker: str, lang: str | None = None) -> str:
    """返回组合标记按 UI 语言的显示名（zh「双语合一」/ en「bilingual」等）。

    未登记的 marker 原样返回，用于未知组合后缀的回退显示。
    """
    language = resolve_lang(lang)
    return TRANSLATION_MARKER_NAMES.get(marker, {}).get(language, marker)


def _ascii_legacy_token(operation: str) -> str:
    """legacy ASCII 清洗：translate_zh-bilingual -> translate-zh-bilingual。

    与改动前 postprocess_io 对未知 operation 的清洗一致，保证 en 界面下划线变体
    的输出逐字节等于历史产物。
    """
    return re.sub(r"[^a-z0-9-]+", "-", operation.lower()).strip("-") or operation


def operation_suffix(operation: str, lang: str | None = None) -> str:
    """返回带前导点的操作后缀，按界面语言本地化。

    - 已知 operation（``OPERATION_NAMES``）与翻译产物（``translate-{target}``
      及 bilingual/combined 变体，连字符 / 下划线 base 都识别）：
      zh 界面产出 ``.后处理`` / ``.翻译为中文`` / ``.翻译为中文.双语合一``；
    - en 界面翻译产物保持 operation 原文（``.translate-zh-bilingual`` 等）；下划线
      变体（工具箱 ``translate_zh`` / ``translate_zh-bilingual``）沿用 legacy ASCII
      清洗（``.translate-zh`` / ``.translate-zh-bilingual``），与改动前逐字节一致；
    - 未知 target（非 zh/en）在 zh 界面也原样保留英文段（同样经 ASCII 清洗）；
    - 其余未知 operation 原样使用。
    """
    language = resolve_lang(lang)
    match = _TRANSLATION_OPERATION_PATTERN.fullmatch(operation)
    if match is not None:
        if language == "zh":
            target_name = TRANSLATION_TARGET_NAMES["zh"].get(match.group(1))
            if target_name is not None:
                display = f"翻译为{target_name}"
                marker = match.group(2)
                if marker is not None:
                    display = f"{display}.{translation_marker_name(marker, lang='zh')}"
                return f".{display}"
        return f".{_ascii_legacy_token(operation)}"
    display = OPERATION_NAMES.get(operation, {}).get(language) or operation
    return f".{display}"


def media_suffix(suffix: str, lang: str | None = None) -> str:
    """媒体工具产物后缀的本地化显示名；未列出的后缀原样返回。"""
    language = resolve_lang(lang)
    return MEDIA_SUFFIX_NAMES.get(suffix, {}).get(language) or suffix


def format_maw_stat(rtf: float | None) -> str | None:
    """生成机器可读状态行；rtf 无效时返回 None。"""
    if rtf is None or rtf <= 0:
        return None
    return f"{MAW_STAT_PREFIX} rtf={rtf:.3f}"


def format_elapsed(seconds: float | None) -> str:
    """耗时自适应单位：不足 1 分钟用秒，不足 1 小时用分+秒，以上用小时+分钟（忽略秒）。

    4529 -> '75 分 29 秒'；4530 -> '1 小时 15 分'；3661 -> '1 小时 1 分'；
    None / 负数 / 非有限值返回 '未知'。
    """
    if seconds is None or seconds < 0 or not math.isfinite(seconds):
        return "未知"
    total = int(seconds + 0.5)
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    if hours > 0:
        return f"{hours} 小时 {minutes} 分"
    if minutes > 0:
        return f"{minutes} 分 {secs} 秒"
    return f"{secs} 秒"


def estimate_dashscope_cost(duration_seconds: float | None) -> float | None:
    """按阿里云百炼录音文件识别单价（0.00022 元/秒）估算费用；时长无效返回 None。"""
    if duration_seconds is None or duration_seconds <= 0:
        return None
    return duration_seconds * DASHSCOPE_PRICE_PER_SECOND


def parse_maw_stat(line: str) -> dict[str, str] | None:
    """解析 'MAW_STAT rtf=0.123' 形式的机器可读行；不匹配返回 None。"""
    match = _MAW_STAT_PATTERN.match(line.strip())
    if match is None:
        return None
    return {match.group(1): match.group(2)}


__all__ = [
    "DASHSCOPE_PRICE_PER_SECOND",
    "DEFAULT_LANG",
    "MAW_DIR_NAME",
    "MAW_STAT_PREFIX",
    "MEDIA_SUFFIX_NAMES",
    "OPERATION_NAMES",
    "POSTPROCESS_DIR_NAMES",
    "TRANSLATION_MARKER_NAMES",
    "TRANSLATION_TARGET_NAMES",
    "estimate_dashscope_cost",
    "format_elapsed",
    "format_maw_stat",
    "is_translation_operation",
    "maw_root",
    "maw_root_candidates",
    "media_suffix",
    "operation_suffix",
    "parse_maw_stat",
    "postprocess_workspace",
    "postprocess_workspace_candidates",
    "resolve_lang",
    "sanitize_component",
    "subfolder_prefs",
    "translation_marker_name",
]
