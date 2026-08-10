# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""使用阿里云百炼 Qwen / Qwen-Audio / Fun-ASR 文件转写 API 生成视频字幕（云端版）。

特点：
- 无需 GPU、模型权重，只调 API（DASHSCOPE_API_KEY）
- 走 filetrans 异步模式，原生支持字/词级时间戳，最长 12 小时音频
- Qwen-Audio / Fun-ASR 可选说话人分离，speaker 标签写入 MAW 工程
- Qwen-Audio 支持即时热词、预编译 vocabulary_id 和 context 上下文
- 文件自动上传到 DashScope 临时 OSS（oss:// URL，48 小时有效）
- 全程 RESTful API（不用 SDK，因为 SDK 不支持 oss:// 给 filetrans）
- 标点由 API 的 words[].punctuation 字段直接给出，跳过本地 LCS 对齐算法

输出为通用的 UTF-8 JSON 工程格式（默认保存为 `.mosp`，包含 items/text/language），可直接交给 edit.py 编辑。
配置读取 .env 文件（DASHSCOPE_API_KEY 等）。
"""

import argparse
import json
import os
import re as _re
import shutil
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import requests

from edit import get_default_sticker_dir
from maw.project import repair_segment_durations
from maw.qwen_audio import parse_qwen_audio_hotwords
from maw.speaker import apply_speaker_colors, split_items_by_speaker
from waveform import embed_waveform


# ===== 路径与常量 =====

HOTWORDS_FILE = Path(__file__).parent / "hotwords.txt"
ENV_FILE = Path(__file__).parent / ".env"

QWEN_AUDIO_FILETRANS_MODEL = "qwen-audio-3.0-asr-flash-filetrans"
FILETRANS_MODEL = QWEN_AUDIO_FILETRANS_MODEL
FUNASR_MODEL = "fun-asr"
POLL_HEARTBEAT_SECONDS = 15


def configure_console_output() -> None:
    """让直接 CLI 和 GUI 子进程都按行把进度消息交给父进程。"""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(line_buffering=True, write_through=True)
        except (OSError, TypeError, ValueError):
            # 某些嵌入式/测试流只接受 line_buffering，或不支持 reconfigure。
            try:
                reconfigure(line_buffering=True)
            except (OSError, TypeError, ValueError):
                pass

# 本地 language 名 → DashScope language code
LANGUAGE_MAP = {
    "chinese": "zh", "zh": "zh", "zhongwen": "zh", "中文": "zh", "普通话": "zh",
    "cantonese": "yue", "yue": "yue", "粤语": "yue", "广东话": "yue",
    "english": "en", "en": "en",
    "japanese": "ja", "ja": "ja", "日语": "ja",
    "korean": "ko", "ko": "ko", "韩语": "ko",
    "german": "de", "de": "de",
    "french": "fr", "fr": "fr",
    "russian": "ru", "ru": "ru",
    "spanish": "es", "es": "es",
}


# ===== .env 读取（零依赖，不引入 python-dotenv） =====

def _load_env_file() -> dict[str, str]:
    """读取 .env 文件，返回 key=value 字典。"""
    if not ENV_FILE.exists():
        return {}
    config: dict[str, str] = {}
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        config[k.strip()] = v.strip()
    return config


def _get_config() -> dict:
    """合并 .env 文件和系统环境变量（系统环境变量优先）。"""
    env = _load_env_file()

    def pick(key: str, default: str = "") -> str:
        return os.getenv(key) or env.get(key, default)

    region = pick("DASHSCOPE_REGION", "beijing").lower()
    workspace_id = pick("DASHSCOPE_WORKSPACE_ID")

    return {
        "api_key": pick("DASHSCOPE_API_KEY"),
        "region": region,
        "workspace_id": workspace_id,
        "default_language": pick("DASHSCOPE_DEFAULT_LANGUAGE"),
        "enable_words": pick("DASHSCOPE_ENABLE_WORDS", "true").lower() == "true",
        "enable_itn": pick("DASHSCOPE_ENABLE_ITN", "false").lower() == "true",
        "qwen_audio_vocabulary_id": pick("DASHSCOPE_QWEN_AUDIO_VOCABULARY_ID"),
        "funasr_vocabulary_id": pick("DASHSCOPE_FUNASR_VOCABULARY_ID"),
        "qwen_audio_hotword_weight": _validate_hotword_weight(
            pick("DASHSCOPE_QWEN_AUDIO_HOTWORD_WEIGHT", "5")
        ),
        "qwen_audio_context_file": pick("DASHSCOPE_QWEN_AUDIO_CONTEXT_FILE"),
        "poll_interval": int(pick("DASHSCOPE_POLL_INTERVAL", "5") or "5"),
        "poll_timeout": int(pick("DASHSCOPE_POLL_TIMEOUT", "1800") or "1800"),
        "base_url": _compute_base_url(region, workspace_id),
    }


def _compute_base_url(region: str, workspace_id: str) -> str:
    if region == "singapore":
        if not workspace_id:
            raise ValueError(
                "DASHSCOPE_REGION=singapore 时必须在 .env 配置 DASHSCOPE_WORKSPACE_ID"
            )
        return f"https://{workspace_id}.ap-southeast-1.maas.aliyuncs.com"
    if region != "beijing":
        print(f"[警告] 未知地域 '{region}'，按北京（华北2）处理")
    if workspace_id:
        return f"https://{workspace_id}.cn-beijing.maas.aliyuncs.com"
    return "https://dashscope.aliyuncs.com"


def _normalize_language(lang: str | None) -> str | None:
    """把 'Chinese'/'中文' 等友好名映射成 DashScope 的 'zh' 代码。"""
    if not lang:
        return None
    key = lang.strip().lower()
    return LANGUAGE_MAP.get(key, key)


def _validate_hotword_weight(value: str | int) -> int:
    """验证 Qwen-Audio 即时热词的权重。"""
    try:
        weight = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Qwen-Audio 热词权重必须是 1-5 或 50") from exc
    if weight not in (*range(1, 6), 50):
        raise ValueError("Qwen-Audio 热词权重必须是 1-5 或 50")
    return weight


def parse_hotword_weight(value: str) -> int:
    """argparse 用的 Qwen-Audio 即时热词权重解析器。"""
    try:
        return _validate_hotword_weight(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError(str(exc)) from exc


def is_funasr_model(model: str) -> bool:
    return model == FUNASR_MODEL or model.startswith("fun-asr-") or model.startswith("fun-asr-mtl")


def is_qwen_audio_model(model: str) -> bool:
    return model == QWEN_AUDIO_FILETRANS_MODEL


def supports_speaker_diarization(model: str) -> bool:
    return is_funasr_model(model) or is_qwen_audio_model(model)


def uses_file_urls(model: str) -> bool:
    return is_funasr_model(model) or is_qwen_audio_model(model)


def _dashscope_error_detail(response: requests.Response) -> str:
    """提取 DashScope 错误码与消息，不输出请求头或 API Key。"""
    try:
        body = response.json()
    except (ValueError, requests.exceptions.JSONDecodeError):
        text = response.text.strip()
        return text[:1000] if text else "服务端未返回错误正文"

    if not isinstance(body, dict):
        return str(body)[:1000]
    output = body.get("output")
    output = output if isinstance(output, dict) else {}
    code = body.get("code") or output.get("code") or ""
    message = body.get("message") or output.get("message") or ""
    request_id = body.get("request_id") or output.get("request_id") or ""
    parts = [
        f"code={code}" if code else "",
        f"message={message}" if message else "",
        f"request_id={request_id}" if request_id else "",
    ]
    detail = " | ".join(part for part in parts if part)
    return detail or json.dumps(body, ensure_ascii=False)[:1000]


def _dashscope_error_hint(status_code: int, detail: str) -> str:
    if "API-Key restrictions" in detail:
        return (
            "这枚 API Key 的自定义权限拒绝了本次调用。请在百炼 API Key 页面把权限改为“全部”，"
            "或在“自定义”的可访问模型中加入 fun-asr，并确认 IP 白名单允许当前网络；"
            "子业务空间还需先开放 Fun-ASR 模型调用权限。"
        )
    if "AllocationQuota.FreeTierOnly" in detail:
        return "请在百炼控制台关闭“仅使用免费额度”或为账户开通按量付费后重试。"
    if any(code in detail for code in ("Workspace.AccessDenied", "WorkSpaceNotFound", "WorkspaceNotFound")):
        return "请确认 API Key、地域和 Workspace ID 属于同一业务空间；北京地域也可填写 Workspace ID 使用专属域名。"
    if status_code == 403:
        return "请检查 Fun-ASR 模型权限、账户额度/付费开关，以及 API Key 与地域是否匹配。"
    return ""


def _raise_for_dashscope_status(response: requests.Response, action: str) -> None:
    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        detail = _dashscope_error_detail(response)
        hint = _dashscope_error_hint(response.status_code, detail)
        suffix = f"\n建议：{hint}" if hint else ""
        raise RuntimeError(
            f"{action}失败 (HTTP {response.status_code}): {detail}{suffix}"
        ) from exc


# ===== ffmpeg 工具函数（与本地版一致） =====

def extract_audio(video_path: str, output_path: str, duration_limit: float | None = None) -> None:
    cmd = ["ffmpeg", "-i", video_path]
    if duration_limit is not None:
        cmd.extend(["-t", str(duration_limit)])
    cmd.extend([
        "-vn", "-acodec", "pcm_s16le",
        "-ar", "16000", "-ac", "1",
        "-y", output_path,
    ])
    print(f"[ffmpeg] 正在提取音频: {video_path}")
    subprocess.run(cmd, check=True, capture_output=True)
    print("[ffmpeg] 音频提取完成")


def get_duration_sec(filepath: str) -> float:
    cmd = [
        "ffprobe", "-v", "quiet",
        "-show_entries", "format=duration",
        "-of", "csv=p=0", filepath,
    ]
    out = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return float(out.stdout.strip())


def parse_duration(value: str) -> float:
    """解析时长字符串，支持 h/m/s 后缀。"""
    value = value.strip().lower()
    m = _re.fullmatch(r'([\d.]+)\s*(h|m|s)?', value)
    if not m:
        raise argparse.ArgumentTypeError(f"无法解析时长: '{value}'，示例: 10m, 20s, 1h, 90")
    num = float(m.group(1))
    unit = m.group(2)
    if unit == 'h':
        return num * 3600
    elif unit == 'm':
        return num * 60
    return num


# 兼容旧私有名（generate_subtitle_soniox_api.py 等复用方请用 parse_duration）
_parse_duration = parse_duration


def load_hotwords(path: str | os.PathLike[str] | None = None) -> list[str]:
    """从 UTF-8 热词文件读取列表，忽略注释行和空行。"""
    source = Path(path).expanduser() if path else HOTWORDS_FILE
    if not source.exists():
        if path:
            raise FileNotFoundError(f"即时热词文件不存在: {source}")
        return []
    words = []
    for line in source.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            words.append(line)
    return words


def load_context_file(path: str | os.PathLike[str] | None) -> str:
    """读取 Qwen-Audio 上下文文件；空路径表示不启用上下文。"""
    if not path:
        return ""
    context_path = Path(path).expanduser()
    if not context_path.exists():
        raise FileNotFoundError(f"Qwen-Audio 上下文文件不存在: {context_path}")
    return context_path.read_text(encoding="utf-8").strip()


def build_qwen_audio_context(context_text: str | None) -> list[dict] | None:
    """把领域词表/前文整理成官方 REST API 的 input.messages 形状。"""
    text = (context_text or "").strip()
    if not text:
        return None
    # 官方限制每轮上下文总长 400 字符；单条 user input_text 足够表达领域词表。
    return [{
        "role": "user",
        "content": [{"type": "input_text", "text": text[:400]}],
    }]


# ===== SRT / 时间戳工具（与本地版一致） =====

def format_timestamp(ms: int) -> str:
    h = ms // 3_600_000
    ms %= 3_600_000
    m = ms // 60_000
    ms %= 60_000
    s = ms // 1_000
    ms %= 1_000
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(segments: list[dict]) -> str:
    lines = []
    for i, seg in enumerate(segments, 1):
        start = format_timestamp(seg["start"])
        end = format_timestamp(seg["end"])
        text = seg["text"].strip()
        lines.append(f"{i}\n{start} --> {end}\n{text}\n")
    return "\n".join(lines)


# ===== 切句逻辑（与本地版 _split_words_to_segments 一致，纯 Python 复制） =====

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

    # 用 jieba 分词找断点
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


def split_words_to_segments(items: list[dict], max_len: int, min_len: int = 5,
                             gap_split_ms: int = 1000) -> list[dict]:
    """把字/词级 timestamps 合并成句子级字幕。

    切分策略（与本地版一致）：
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
        return {
            "start": group[0]["start"],
            "end": group[-1]["end"],
            "text": text,
            "items": [dict(it) for it in group],
        }

    final: list[list[dict]] = []
    silence_groups = split_by_silence(items, gap_split_ms)

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

    return [to_seg(g) for g in final if g]


# ===== 双轨切句：CJK 检测 + 空格语言（英文等）切句 =====

# 默认按词数计量：英文每条字幕 3–13 词（Netflix 风格上限约 14 词）
WESTERN_MAX_WORDS = 13
WESTERN_MIN_WORDS = 3

# 句末强标点（完整句子边界）与弱标点（超长时的断点），兼容 CJK 全角
WESTERN_STRONG_END = ".!?。！？；"
WESTERN_WEAK_END = ",;:，、：,;—–"
# 判定时剥掉的尾部引号/括号（如 word." 仍视为句号结尾）
_TRAILING_QUOTES = "\"'”’)]}』」"


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
        if _ends_with_punct(group[i - 1]["text"], WESTERN_WEAK_END):
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
    2. 合并过短句子（< min_words 词），避免单词成条
    3. 超长句子（> max_words 词）优先按弱标点断，兜底硬切
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
            if _ends_with_punct(it["text"], WESTERN_STRONG_END):
                raw_groups.append(buf)
                buf = []
        if buf:
            raw_groups.append(buf)

        merged: list[list[dict]] = []
        for grp in raw_groups:
            if merged and len(grp) < min_words:
                merged[-1].extend(grp)
            else:
                merged.append(list(grp))
        if len(merged) >= 2 and len(merged[-1]) < min_words:
            merged[-2].extend(merged.pop())

        for grp in merged:
            final.extend(_split_long_western(grp, max_words))

    return [to_seg(g) for g in final if g]


def split_segments_auto(items: list[dict], *, max_len: int, min_len: int,
                        gap_split_ms: int,
                        max_words: int = WESTERN_MAX_WORDS,
                        min_words: int = WESTERN_MIN_WORDS) -> list[dict]:
    """按静音组自动选择切句逻辑（双轨）。

    先按静音间隔预切；每个静音组内 CJK 主导则走中文逻辑，
    否则走空格语言逻辑——中英混排的播客也能逐段正确归类。
    """
    segments: list[dict] = []
    for group in split_by_silence(items, gap_split_ms):
        if is_cjk_dominant(group):
            segments.extend(split_words_to_segments(group, max_len, min_len, 0))
        else:
            segments.extend(split_words_to_segments_western(group, max_words, min_words, 0))
    return segments


def repair_nonpositive_duration_segments(segments: list[dict]) -> list[dict]:
    """Merge zero/negative-duration API fragments into a neighboring subtitle.

    Qwen filetrans occasionally returns a word or sentence whose begin_time and
    end_time are identical. If punctuation/silence splitting isolates that item,
    it becomes an invalid zero-duration segment. Keep its text/items, but attach
    it to the next valid subtitle (or the previous one when it is trailing).
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
        return {
            "start": start,
            "end": end,
            "text": "".join(part.get("text", "") for part in parts),
            "items": [
                dict(item)
                for part in parts
                for item in part.get("items", [])
            ],
        }

    for segment in segments:
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


# ===== DashScope filetrans API 调用 =====

def get_upload_policy(base_url: str, api_key: str, model: str) -> dict:
    """获取 DashScope 临时 OSS 上传凭证。"""
    resp = requests.get(
        f"{base_url}/api/v1/uploads",
        params={"action": "getPolicy", "model": model},
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=30,
    )
    _raise_for_dashscope_status(resp, "获取上传凭证")
    body = resp.json()
    # DashScope 返回结构：{ "request_id": "...", "data": {...} } 或 { "output": {...} }
    if body.get("code") and body.get("code") != 200 and body.get("code") != "200":
        raise RuntimeError(f"获取上传凭证失败: {body}")
    data = body.get("data") or body.get("output") or body
    if not data:
        raise RuntimeError(f"上传凭证响应为空: {body}")
    return data


def upload_to_oss(policy: dict, file_path: str) -> str:
    """用 OSS Post Object 协议上传文件，返回 oss:// URL。

    DashScope 上传凭证实测字段（2026 北京地域）：
        policy: base64 编码的 OSS policy（conditions 含 bucket/x-oss-object-acl 等）
        signature: HMAC-SHA1 签名
        upload_dir: 文件在 OSS 的目录前缀（如 "dashscope-instant/<uid>/<date>/<uuid>"）
        upload_host: 完整的 OSS 上传地址（如 "https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com"）
        oss_access_key_id: AccessKeyId
        x_oss_object_acl: "private"（policy conditions 强制要求）
        x_oss_forbid_overwrite: "true"（policy conditions 强制要求）
        max_file_size_mb: 单文件上限（实测 1024MB）

    OSS Post Object 协议要求：form fields 必须包含 policy conditions 里声明的所有字段，
    否则 OSS 返回 403。所以 x_oss_object_acl / x_oss_forbid_overwrite 必须回传。
    """
    upload_host = policy.get("upload_host") or policy.get("host")
    if not upload_host:
        raise RuntimeError(
            f"上传凭证缺少 upload_host 字段。请把以下内容反馈给开发者：\n"
            f"{json.dumps(policy, ensure_ascii=False, indent=2)}"
        )

    # upload_host 形如 https://dashscope-file-mgr.oss-cn-beijing.aliyuncs.com
    # 解析出 bucket 和 endpoint
    host_clean = upload_host.replace("https://", "").replace("http://", "").rstrip("/")
    parts = host_clean.split(".", 2)
    if len(parts) < 3:
        raise RuntimeError(f"无法从 upload_host 解析 bucket: {upload_host}")
    bucket = parts[0]
    endpoint = parts[1] + "." + parts[2]

    upload_dir = policy.get("upload_dir") or policy.get("key_prefix") or policy.get("object_prefix")
    if not upload_dir:
        raise RuntimeError(
            f"上传凭证缺少 upload_dir 字段。请把以下内容反馈给开发者：\n"
            f"{json.dumps(policy, ensure_ascii=False, indent=2)}"
        )

    policy_str = policy.get("policy")
    signature = policy.get("signature")
    access_key_id = policy.get("oss_access_key_id") or policy.get("access_key_id")
    if not all([policy_str, signature, access_key_id]):
        raise RuntimeError(
            f"上传凭证缺少 policy/signature/access_key_id。请把以下内容反馈给开发者：\n"
            f"{json.dumps(policy, ensure_ascii=False, indent=2)}"
        )

    safe_name = Path(file_path).name.replace(" ", "_").replace("\\", "/").split("/")[-1]
    final_key = f"{upload_dir}/{safe_name}"

    # OSS Post Object form fields
    form_fields = {
        "key": final_key,
        "OSSAccessKeyId": access_key_id,
        "policy": policy_str,
        "signature": signature,
        "success_action_status": "200",
    }
    # policy conditions 强制要求的字段（实测必须回传，否则 OSS 返回 AccessDenied）
    if policy.get("x_oss_object_acl"):
        form_fields["x-oss-object-acl"] = policy["x_oss_object_acl"]
    if policy.get("x_oss_forbid_overwrite"):
        form_fields["x-oss-forbid-overwrite"] = policy["x_oss_forbid_overwrite"]

    file_size = Path(file_path).stat().st_size
    max_mb = policy.get("max_file_size_mb", 0)
    if max_mb and file_size > max_mb * 1024 * 1024:
        raise RuntimeError(
            f"文件过大: {file_size/1024/1024:.1f}MB > 上限 {max_mb}MB。"
            f"请缩短音频或自行上传到 OSS 后用 --file-url 传入"
        )

    print(f"[upload] bucket={bucket}, key={final_key}, size={file_size/1024/1024:.1f}MB")

    with open(file_path, "rb") as f:
        files = {"file": (safe_name, f)}
        resp = requests.post(upload_host, data=form_fields, files=files, timeout=600)

    if resp.status_code != 200:
        raise RuntimeError(f"OSS 上传失败 (HTTP {resp.status_code}): {resp.text[:500]}")

    # oss:// URL 不含 bucket 前缀（文档示例：f"oss://{key}"）
    # filetrans 配合 X-DashScope-OssResourceResolve Header 能解析这个格式
    return f"oss://{final_key}"


def submit_filetrans(base_url: str, api_key: str, file_url: str,
                     language: str | None, enable_words: bool,
                     enable_itn: bool, model: str = FILETRANS_MODEL,
                     enable_speaker: bool = False,
                     vocabulary_id: str | None = None,
                     hotwords: list[str] | None = None,
                     hotword_weight: int = 5,
                     context: list[dict] | None = None) -> str:
    """提交异步 ASR 任务，返回 task_id。"""
    if is_qwen_audio_model(model):
        params: dict = {
            "channel_id": [0],
            "diarization_enabled": enable_speaker,
        }
        if language:
            params["language_hints"] = [language]
        if vocabulary_id:
            params["vocabulary_id"] = vocabulary_id
        if hotwords:
            weight = _validate_hotword_weight(hotword_weight)
            entries, _issues = parse_qwen_audio_hotwords(hotwords, weight)
            params["vocabulary"] = {entry.text: entry.weight for entry in entries}
            if not params["vocabulary"]:
                params.pop("vocabulary")
        input_payload = {"file_urls": [file_url]}
        if context:
            input_payload["messages"] = context
    elif is_funasr_model(model):
        params: dict = {
            "channel_id": [0],
            "diarization_enabled": enable_speaker,
        }
        if language:
            params["language_hints"] = [language]
        if vocabulary_id:
            params["vocabulary_id"] = vocabulary_id
        input_payload = {"file_urls": [file_url]}
    else:
        params = {
            "channel_id": [0],
            "enable_words": enable_words,
            "enable_itn": enable_itn,
        }
        if language:
            params["language"] = language
        input_payload = {"file_url": file_url}

    resp = requests.post(
        f"{base_url}/api/v1/services/audio/asr/transcription",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
            # SDK 不支持 oss://，但 RESTful 加这个 Header 后支持
            "X-DashScope-OssResourceResolve": "enable",
        },
        json={
            "model": model,
            "input": input_payload,
            "parameters": params,
        },
        timeout=30,
    )
    _raise_for_dashscope_status(resp, "提交 ASR 任务")
    body = resp.json()
    output = body.get("output", {})
    task_id = output.get("task_id")
    if not task_id:
        raise RuntimeError(f"提交任务失败: {body}")
    return task_id


def poll_task(base_url: str, api_key: str, task_id: str,
              interval: int, timeout: int,
              model: str = FILETRANS_MODEL,
              on_status=print) -> tuple[str, dict]:
    """轮询任务状态，返回 transcription_url。"""
    url = f"{base_url}/api/v1/tasks/{task_id}"
    deadline = time.time() + timeout
    started_at = time.monotonic()
    last_report_at = started_at
    last_status = ""

    while time.time() < deadline:
        resp = requests.get(url, headers={"Authorization": f"Bearer {api_key}"}, timeout=30)
        _raise_for_dashscope_status(resp, "查询 ASR 任务")
        body = resp.json()
        output = body.get("output", {})
        status = output.get("task_status", "UNKNOWN")
        now = time.monotonic()

        if status != last_status:
            on_status(f"[filetrans] 任务状态: {status}")
            last_status = status
            last_report_at = now
        elif now - last_report_at >= POLL_HEARTBEAT_SECONDS:
            elapsed = int(now - started_at)
            on_status(
                f"[filetrans] 任务仍在处理中（状态: {status}，已等待约 {elapsed}s），"
                f"下一次检查约 {max(interval, 0)}s 后。"
            )
            last_report_at = now

        if status == "SUCCEEDED":
            if uses_file_urls(model):
                results = output.get("results") or []
                result = next(
                    (
                        item for item in results
                        if item.get("subtask_status") == "SUCCEEDED"
                        and item.get("transcription_url")
                    ),
                    None,
                )
                if result is None:
                    failed = results[0] if results else output
                    code = failed.get("code", "UNKNOWN")
                    message = failed.get("message", "任务成功但音频子任务失败")
                    raise RuntimeError(f"ASR 子任务失败 [{code}]: {message}")
                turl = result.get("transcription_url")
            else:
                result = output.get("result", {})
                turl = result.get("transcription_url")
            if not turl:
                raise RuntimeError(f"任务成功但无 transcription_url: {body}")
            usage = body.get("usage", {})
            return turl, usage
        if status == "FAILED":
            code = output.get("code", "UNKNOWN")
            msg = output.get("message", "未知错误")
            raise RuntimeError(f"ASR 任务失败 [{code}]: {msg}")
        if status == "UNKNOWN":
            raise RuntimeError(f"任务不存在或已过期: {body}")

        time.sleep(interval)

    raise TimeoutError(f"ASR 任务超时（{timeout}秒），task_id={task_id}")


def download_transcription(transcription_url: str) -> dict:
    """下载并解析识别结果 JSON。"""
    resp = requests.get(transcription_url, timeout=120)
    resp.raise_for_status()
    return resp.json()


# ===== filetrans 结果 → 本地版 transcribe() 输出格式 =====

def parse_transcription_result(result: dict) -> dict:
    """把 filetrans JSON 转成本地版 transcribe() 的输出格式。

    filetrans:
        transcripts[].sentences[].words[] = {begin_time, end_time, text, punctuation}
        (begin_time/end_time 已是毫秒)
    本地版:
        items[] = {text(含标点), start, end}, text(完整文本), language

    关键简化：filetrans 把标点单独放 punctuation 字段，直接拼到 item.text 末尾即可，
    无需本地版的 _align_punctuation() LCS 对齐。
    """
    transcripts = result.get("transcripts", [])
    if not transcripts:
        return {"text": "", "language": "", "items": []}

    # 只取第一个音轨（channel_id=0）
    t = transcripts[0]
    all_items: list[dict] = []
    detected_language = ""

    for sent in t.get("sentences", []):
        if not detected_language and sent.get("language"):
            detected_language = sent["language"]

        words = sent.get("words") or []
        if not words:
            # 未启用字级时间戳时的兜底：用句子级
            all_items.append({
                "text": sent.get("text", ""),
                "start": sent.get("begin_time", 0),
                "end": sent.get("end_time", 0),
            })
            continue

        for w in words:
            text = w.get("text", "")
            punct = w.get("punctuation", "")
            all_items.append({
                "text": text + punct,
                "start": w.get("begin_time", 0),
                "end": w.get("end_time", 0),
            })

    return {
        "text": t.get("text", ""),
        "language": detected_language,
        "items": all_items,
    }


def parse_funasr_transcription_result(result: dict) -> dict:
    """把 Fun-ASR 的句级 speaker + 词级时间戳映射为 MAW items。"""
    transcripts = result.get("transcripts", [])
    if not transcripts:
        return {"text": "", "language": "", "items": []}

    transcript = transcripts[0]
    all_items: list[dict] = []
    detected_language = ""
    for sentence in transcript.get("sentences", []):
        if not detected_language and sentence.get("language"):
            detected_language = str(sentence["language"])
        speaker_id = sentence.get("speaker_id")
        speaker = str(speaker_id) if speaker_id is not None else None
        words = sentence.get("words") or []
        if not words:
            item = {
                "text": sentence.get("text", ""),
                "start": sentence.get("begin_time", 0),
                "end": sentence.get("end_time", 0),
            }
            if speaker is not None:
                item["speaker"] = speaker
            all_items.append(item)
            continue

        for word in words:
            item = {
                "text": word.get("text", "") + word.get("punctuation", ""),
                "start": word.get("begin_time", 0),
                "end": word.get("end_time", 0),
            }
            if speaker is not None:
                item["speaker"] = speaker
            all_items.append(item)

    return {
        "text": transcript.get("text", ""),
        "language": detected_language,
        "items": all_items,
    }


def build_segments_preserving_speakers(
    items: list[dict],
    *,
    max_len: int,
    min_len: int,
    gap_split_ms: int,
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
        )
        run_segments = repair_nonpositive_duration_segments(run_segments)
        if speaker is not None:
            for segment in run_segments:
                segment["speaker"] = speaker
        segments.extend(run_segments)
    return segments


# ===== 顶层转写入口 =====

def _configured_vocabulary_id(model: str, config: dict) -> str:
    if is_qwen_audio_model(model):
        return str(config.get("qwen_audio_vocabulary_id") or "").strip()
    if is_funasr_model(model):
        return str(config.get("funasr_vocabulary_id") or "").strip()
    return ""


def transcribe(audio_path: str, language: str | None, hotwords: list[str],
               config: dict, file_url_override: str | None = None,
               model: str = FILETRANS_MODEL,
               enable_speaker: bool = False,
               vocabulary_id: str | None = None,
               context_text: str | None = None,
               hotword_weight: int | None = None) -> dict:
    """调 DashScope filetrans API 做转录。

    返回可由本项目编辑器读取的工程数据：
        {"text": str, "language": str, "items": [{"text", "start", "end"}, ...]}
    """
    base_url = config["base_url"]
    api_key = config["api_key"]
    if not api_key:
        raise SystemExit(
            "[错误] 未配置 DASHSCOPE_API_KEY。请在 .env 文件填入（参考 .env.example），\n"
            "       或设置系统环境变量 DASHSCOPE_API_KEY。\n"
            "       API Key 申请：https://help.aliyun.com/zh/model-studio/get-api-key"
        )

    print(f"[准备] 开始云端转写（模型: {model}）")

    resolved_vocabulary_id = (vocabulary_id or _configured_vocabulary_id(model, config)).strip()
    resolved_hotword_weight = hotword_weight
    if resolved_hotword_weight is None:
        resolved_hotword_weight = int(config.get("qwen_audio_hotword_weight", 5))
    context = build_qwen_audio_context(context_text)

    if hotwords:
        if is_qwen_audio_model(model):
            filtered_hotwords, hotword_issues = parse_qwen_audio_hotwords(
                hotwords,
                resolved_hotword_weight,
            )
            for issue in hotword_issues:
                print(
                    f"[热词] 忽略第 {issue.index} 项（{issue.code}）：{issue.text}"
                )
            hotword_count = len(filtered_hotwords)
        else:
            hotword_count = len(hotwords)
        if is_qwen_audio_model(model):
            print(
                f"[热词] 将通过 Qwen-Audio 即时 vocabulary 发送 {hotword_count} 个热词，"
                f"weight={resolved_hotword_weight}。"
            )
        elif is_funasr_model(model):
            print(
                f"[热词] 检测到 {len(hotwords)} 个本地热词。Fun-ASR 仅接受百炼控制台"
                f"预建的 vocabulary_id，当前未发送 hotwords.txt。"
            )
        else:
            print(f"[热词] 检测到 {len(hotwords)} 个热词。注意：filetrans API 暂不支持热词注入，"
                  f"当前模型未发送 hotwords.txt。")
    if context:
        if is_qwen_audio_model(model):
            context_chars = len(context[0]["content"][0]["text"])
            print(f"[上下文] 已启用 Qwen-Audio context（{context_chars} 字符，最多发送 400 字符）。")
        else:
            print("[上下文] 当前模型不支持 Qwen-Audio context，已忽略。")

    # 1) 准备 file_url
    if file_url_override:
        file_url = file_url_override
        print(f"[filetrans] 使用用户提供的 URL: {file_url}")
    else:
        print(f"[upload] 获取上传凭证 ({model})...")
        policy = get_upload_policy(base_url, api_key, model)
        file_url = upload_to_oss(policy, audio_path)
        print(f"[upload] 上传完成: {file_url}")

    # 2) 提交异步任务
    norm_lang = _normalize_language(language) or _normalize_language(config["default_language"])
    if is_qwen_audio_model(model):
        print(
            f"[filetrans] 提交 Qwen-Audio 任务 (language={norm_lang or 'auto'}, "
            f"speaker={'on' if enable_speaker else 'off'})..."
        )
    elif is_funasr_model(model):
        print(
            f"[filetrans] 提交 Fun-ASR 任务 (language={norm_lang or 'auto'}, "
            f"speaker={'on' if enable_speaker else 'off'})..."
        )
    else:
        print(f"[filetrans] 提交 Qwen 任务 (language={norm_lang or 'auto'}, "
              f"enable_words={config['enable_words']})...")
    task_id = submit_filetrans(
        base_url, api_key, file_url,
        language=norm_lang,
        enable_words=config["enable_words"],
        enable_itn=config["enable_itn"],
        model=model,
        enable_speaker=enable_speaker,
        vocabulary_id=resolved_vocabulary_id or None,
        hotwords=hotwords if is_qwen_audio_model(model) else None,
        hotword_weight=resolved_hotword_weight,
        context=context if is_qwen_audio_model(model) else None,
    )
    print(f"[filetrans] 任务已提交: task_id={task_id}")

    # 3) 轮询
    t0 = time.perf_counter()
    transcription_url, task_usage = poll_task(
        base_url, api_key, task_id,
        interval=config["poll_interval"],
        timeout=config["poll_timeout"],
        model=model,
    )
    elapsed_poll = time.perf_counter() - t0
    if uses_file_urls(model):
        audio_secs = task_usage.get("duration", 0)
        print(f"[filetrans] 任务完成，耗时 {elapsed_poll:.1f}s | 计费语音 {audio_secs}s")
    else:
        audio_secs = task_usage.get("seconds", 0)
        est_tokens = audio_secs * 25  # 文档：每秒音频 = 25 tokens
        print(f"[filetrans] 任务完成，耗时 {elapsed_poll:.1f}s | "
              f"计费 {audio_secs}s 音频 ≈ {est_tokens} tokens")

    # 4) 下载 + 解析
    print("[filetrans] 正在下载转写结果...")
    raw = download_transcription(transcription_url)
    print("[解析] 正在解析云端返回的词级时间戳...")
    result = parse_funasr_transcription_result(raw) if uses_file_urls(model) else parse_transcription_result(raw)
    if not result.get("language") and norm_lang:
        result["language"] = norm_lang
    result["usage"] = task_usage
    return result


# ===== main CLI =====

def main():
    parser = argparse.ArgumentParser(
        description="使用阿里云百炼 Qwen / Qwen-Audio / Fun-ASR API 生成视频字幕（云端版）",
    )
    parser.add_argument("input", help="输入视频或音频文件路径")
    parser.add_argument("-o", "--output", help="输出 SRT 路径（默认与输入同目录）")
    parser.add_argument(
        "-l", "--max-len", type=int, default=21,
        help="每条字幕最大字数（默认 21；仅 CJK 内容生效，空格语言按词数自动处理）",
    )
    parser.add_argument(
        "--min-len", type=int, default=5,
        help="句号间最短字数，不足则合并（默认 5；仅 CJK 内容生效）",
    )
    parser.add_argument(
        "--language", default=None,
        help="指定语言（zh/yue/en/ja/ko/de/fr 等，或 Chinese/English，默认自动识别）",
    )
    parser.add_argument(
        "--keep-punct", action="store_true",
        help="保留每条字幕末尾的逗号和句号（默认去除）",
    )
    parser.add_argument(
        "--gap-split", type=int, default=1500,
        help="静音切句阈值（毫秒），相邻字停顿超过此值则切句（默认 1500）",
    )
    parser.add_argument(
        "--speaker", action="store_true",
        help="Qwen-Audio/Fun-ASR 开启说话人分离，speaker 标签写入工程 JSON",
    )
    parser.add_argument(
        "--speaker-colors", action="store_true",
        help="Qwen-Audio/Fun-ASR 在说话人分离基础上，把不同说话人映射成 5 种字幕颜色",
    )
    parser.add_argument(
        "--json", dest="json_out", action="store_true",
        help="同时输出含字级时间戳的工程文件（默认 .mosp，供 edit.py 加载）",
    )
    parser.add_argument(
        "--with-waveform", action="store_true",
        help="将波形峰值数据嵌入工程文件（GUI 转写默认开启）",
    )
    parser.add_argument(
        "-s", "--stickers", default=get_default_sticker_dir(),
        help="表情包文件夹路径，传给 edit.py（默认读 .env 的 STICKER_DIR）",
    )
    parser.add_argument(
        "--no-html", action="store_true",
        help="禁用自动生成 edit HTML（默认 --json 时会一并生成）",
    )
    parser.add_argument(
        "-ll", "--length-limit", type=_parse_duration, default=None,
        help="只处理音频前 N 时长，用于测试（示例: 10m, 20s, 1h, 90）",
    )
    parser.add_argument(
        "--file-url", default=None,
        help="直接提供公网/OSS 可访问的音频 URL，跳过本地上传（用于已上传到 OSS 的场景）",
    )
    parser.add_argument(
        "--region", default=None,
        help="覆盖 .env 的 DASHSCOPE_REGION（beijing / singapore）",
    )
    parser.add_argument(
        "--model", default=FILETRANS_MODEL,
        help=f"覆盖 ASR 模型（默认 {FILETRANS_MODEL}；可选 {QWEN_AUDIO_FILETRANS_MODEL} / {FUNASR_MODEL}）",
    )
    parser.add_argument(
        "--vocabulary-id", default=None,
        help="覆盖当前模型的百炼预编译 vocabulary_id（也可在 .env 配置）",
    )
    parser.add_argument(
        "--hotword", action="append", default=None,
        help="追加一个 Qwen-Audio 即时热词；可重复传入，与 hotwords.txt 合并",
    )
    parser.add_argument(
        "--hotword-file", default=None,
        help="使用指定 UTF-8 文本文件作为 Qwen-Audio 即时热词来源，替代默认 hotwords.txt",
    )
    parser.add_argument(
        "--hotword-weight", type=parse_hotword_weight, default=None,
        help="Qwen-Audio hotwords.txt 的即时热词权重（1-5 或 50；默认读 .env 的 5）",
    )
    parser.add_argument(
        "--context", default=None,
        help="Qwen-Audio context 领域词表/前文；最多发送 400 字符",
    )
    parser.add_argument(
        "--context-file", default=None,
        help="从 UTF-8 文件读取 Qwen-Audio context（与 --context 二选一）",
    )
    parser.add_argument(
        "--debug", action="store_true",
        help="输出 API 原始结果用于调试",
    )
    args = parser.parse_args()
    configure_console_output()
    enable_speaker = args.speaker or args.speaker_colors
    if enable_speaker and not supports_speaker_diarization(args.model):
        parser.error("--speaker / --speaker-colors 仅适用于 Qwen-Audio 或 Fun-ASR 模型")
    if args.context is not None and args.context_file:
        parser.error("--context 与 --context-file 只能二选一")

    input_path = Path(args.input)
    if not input_path.exists() and not args.file_url:
        print(f"错误: 文件不存在 - {input_path}", file=sys.stderr)
        raise SystemExit(1)

    if args.output:
        output_path = Path(args.output)
    else:
        output_path = input_path.with_suffix(".srt")

    # 读配置（CLI args 覆盖 .env）
    config = _get_config()
    print(f"[准备] 已载入转写配置（模型: {args.model}）")
    if args.region:
        config["region"] = args.region.lower()
        config["base_url"] = _compute_base_url(config["region"], config["workspace_id"])

    try:
        print("[准备] 正在读取上下文和热词配置...")
        context_text = args.context
        if context_text is None:
            context_text = load_context_file(args.context_file or config["qwen_audio_context_file"])
    except (OSError, UnicodeError) as exc:
        parser.error(str(exc))

    video_exts = {".mp4", ".mkv", ".avi", ".mov", ".wmv", ".flv", ".webm", ".ts", ".m4v"}
    is_video = input_path.suffix.lower() in video_exts

    try:
        hotwords = load_hotwords(args.hotword_file)
    except (OSError, UnicodeError) as exc:
        parser.error(str(exc))
    for hotword in args.hotword or []:
        normalized = hotword.strip()
        if normalized and normalized not in hotwords:
            hotwords.append(normalized)

    with tempfile.TemporaryDirectory() as tmpdir:
        print(f"[媒体] 正在准备输入媒体: {input_path.name}")
        if args.file_url:
            audio_path = ""  # 不需要本地文件
            duration = 0.0
        else:
            if is_video:
                audio_path = str(Path(tmpdir) / "audio.wav")
                print("[媒体] 正在读取原始视频时长...")
                source_duration = get_duration_sec(str(input_path))
                video_limit = args.length_limit if args.length_limit and args.length_limit < source_duration else None
                extract_audio(str(input_path), audio_path, duration_limit=video_limit)
                print("[媒体] 正在读取提取后音频时长...")
                duration = get_duration_sec(audio_path)
                if video_limit is not None:
                    lm, ls = divmod(int(video_limit), 60)
                    print(f"[info] 测试模式：从视频直接提取前 {lm}分{ls}秒，跳过其余内容")
            else:
                # 复制到 tmpdir 统一处理（避免 length_limit 改原文件）
                audio_path = str(Path(tmpdir) / input_path.name)
                print("[媒体] 正在复制音频到临时工作目录...")
                shutil.copy2(input_path, audio_path)

            if not is_video:
                print("[媒体] 正在读取音频时长...")
                duration = get_duration_sec(audio_path)
            m, s = divmod(int(duration), 60)
            print(f"[info] 音频总时长: {m}分{s}秒")
            if enable_speaker and duration > 2 * 60 * 60:
                print(
                    "[警告] Qwen-Audio/Fun-ASR 官方建议说话人分离音频不超过 2 小时；"
                    "当前任务可能失败或超时。"
                )

            if args.length_limit and args.length_limit < duration:
                limit_sec = args.length_limit
                limited_path = str(Path(tmpdir) / "audio_limited.wav")
                print("[ffmpeg] 正在为测试模式截取并重新采样音频...")
                cmd = [
                    "ffmpeg", "-i", audio_path,
                    "-t", str(limit_sec),
                    "-acodec", "pcm_s16le", "-ar", "16000", "-ac", "1",
                    "-y", limited_path,
                ]
                subprocess.run(cmd, check=True, capture_output=True)
                audio_path = limited_path
                duration = limit_sec
                lm, ls = divmod(int(limit_sec), 60)
                print(f"[info] 已截取前 {lm}分{ls}秒用于测试")

        print("[filetrans] 本地媒体准备完成，开始连接云端...")
        t0 = time.perf_counter()
        result = transcribe(
            audio_path, args.language, hotwords, config,
            file_url_override=args.file_url,
            model=args.model,
            enable_speaker=enable_speaker,
            vocabulary_id=args.vocabulary_id,
            context_text=context_text,
            hotword_weight=args.hotword_weight,
        )
        elapsed = time.perf_counter() - t0

        if not result or not result.get("text"):
            print("错误: 未识别到任何内容", file=sys.stderr)
            raise SystemExit(2)

        print(f"[解析] 云端结果已返回，包含 {len(result.get('items', []))} 个时间戳项。")
        print(f"[info] 检测语言: {result.get('language', 'unknown')}")

        if args.debug:
            print("\n--- debug ---")
            print(f"text: {result['text'][:200]}...")
            print(f"items count: {len(result['items'])}")
            print(f"first 5 items: {result['items'][:5]}")
            print("--- end debug ---\n")

        items = result["items"]
        if not items:
            print("[警告] 未获得时间戳，输出整段为单条字幕")
            segments = repair_nonpositive_duration_segments(
                [{"start": 0, "end": int(duration * 1000), "text": result["text"]}]
            )
        else:
            print("[解析] 正在按停顿和字数整理字幕（中文首次运行可能加载 jieba 词典）...")
            segments = build_segments_preserving_speakers(
                items, max_len=args.max_len, min_len=args.min_len,
                gap_split_ms=args.gap_split,
            )
            print(f"[解析] 字幕整理完成：{len(segments)} 条。")

        # 兜底：上游可能返回 0 长（甚至倒挂）的词/段时间码，
        # 拉齐到至少 100ms，避免拆分后看不见字幕块、工程无法保存。
        print("[解析] 正在校验和修复时间码...")
        repaired_count = repair_segment_durations(segments)
        if repaired_count:
            print(f"[info] 已兜底修复 {repaired_count} 处 0 长/倒挂时间码（保底 100ms）")

    if enable_speaker:
        speakers = sorted({str(seg["speaker"]) for seg in segments if seg.get("speaker") is not None})
        print(f"[speaker] 识别到 {len(speakers)} 个说话人: {', '.join(speakers)}")
        if args.speaker_colors:
            stats = apply_speaker_colors(segments)
            print(f"[speaker] 已为 {stats['colored_segments']} 条字幕写入颜色快照")
            if stats["overflow"]:
                print("[警告] 说话人超过 5 个，颜色已循环复用，请在编辑器中手动调整")

    # 剥句末标点（与本地版一致）
    if not args.keep_punct:
        for seg in segments:
            seg["text"] = seg["text"].rstrip("，。")
            seg_items = seg.get("items")
            if seg_items:
                k = len(seg_items) - 1
                while k >= 0:
                    seg_items[k]["text"] = seg_items[k]["text"].rstrip("，。")
                    if seg_items[k]["text"]:
                        break
                    k -= 1

    print(f"[输出] 正在生成 SRT（{len(segments)} 条字幕）...")
    srt_content = generate_srt(segments)

    em, es = divmod(int(elapsed), 60)
    if duration > 0:
        rtf = elapsed / duration
        speed = (1 / rtf) if rtf > 0 else 0
    else:
        rtf = 0
        speed = 0
    if not args.output:
        speed_tag = f"{speed:.1f}x" if speed else "na"
        ts_prefix = f"[{datetime.now().strftime('%y%m%d%H%M')}]"
        model_tag = (
            "fun-asr" if is_funasr_model(args.model)
            else "qwen-audio-asr-api" if is_qwen_audio_model(args.model)
            else "qwen3-asr-api"
        )
        output_path = output_path.with_name(
            f"{ts_prefix}{output_path.stem}.{model_tag}.{speed_tag}.srt"
        )

    output_path.write_text(srt_content, encoding="utf-8")
    print(f"\n字幕已保存到: {output_path}")
    print(f"共 {len(segments)} 条字幕")
    if duration > 0:
        print(f"处理用时: {em}分{es}秒 | 实际 RTF: {rtf:.3f} ({speed:.1f}x 实时)")
    else:
        print(f"处理用时: {em}分{es}秒")

    if args.json_out:
        json_path = output_path.with_suffix(".mosp")
        json_data = {
            "media": str(input_path),
            "language": result.get("language", ""),
            "model": (
                args.model if is_funasr_model(args.model)
                else "qwen-audio-asr-api" if is_qwen_audio_model(args.model)
                else "qwen3-asr-api"
            ),
            "segments": [
                {
                    "start": seg["start"],
                    "end": seg["end"],
                    "text": seg["text"],
                    "items": seg.get("items", []),
                    **({"speaker": seg["speaker"]} if seg.get("speaker") is not None else {}),
                    **({"color": seg["color"]} if seg.get("color") else {}),
                    **({"color_ref": seg["color_ref"]} if seg.get("color_ref") else {}),
                }
                for seg in segments
            ],
        }
        if args.with_waveform:
            print("[waveform] 正在计算并嵌入波形...")
            waveform_result = embed_waveform(json_data, input_path)
            json_data = waveform_result.project
            if waveform_result.error is None:
                waveform_payload = json_data["waveform"]
                print(
                    f"[waveform] 已嵌入 {waveform_payload['peak_count']} peaks "
                    f"({waveform_payload['peaks_per_second']}/秒)"
                )
            else:
                print(f"[waveform] 警告: {waveform_result.error}；已跳过内嵌波形")
        print("[输出] 正在写入工程文件...")
        json_path.write_text(
            json.dumps(json_data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"工程文件已保存到: {json_path}")

        if not args.no_html:
            edit_script = Path(__file__).parent / "edit.py"
            if not edit_script.exists():
                print("[警告] 找不到 edit.py，跳过 HTML 生成")
            else:
                cmd = [sys.executable, str(edit_script), str(json_path)]
                if args.stickers:
                    sticker_dir = Path(args.stickers)
                    if sticker_dir.exists():
                        cmd += ["-s", str(sticker_dir)]
                    else:
                        print(f"[提示] 表情包目录不存在，跳过：{sticker_dir}")
                print(f"[edit] 生成 HTML: {' '.join(cmd[1:])}")
                try:
                    subprocess.run(cmd, check=True)
                except subprocess.CalledProcessError as e:
                    print(f"[警告] edit.py 失败 (exit {e.returncode})")


if __name__ == "__main__":
    main()
