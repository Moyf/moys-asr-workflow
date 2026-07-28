# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""Soniox 异步 STT 供应商：REST 客户端 + token → MAW 工程映射。

范围（MAW 1.1 已确认）：异步文件转写、token 级毫秒时间戳、可选说话人分离。
不包含实时 WebSocket 与翻译流程。

API 契约（2026-07 官方文档核验，https://soniox.com/docs/api-reference）：
- POST   /v1/files                            multipart 上传，返回 {"id": file_id}
- POST   /v1/transcriptions                   创建转写，返回 {"id", "status", ...}
- GET    /v1/transcriptions/{id}              轮询 status: queued/processing/completed/error
- GET    /v1/transcriptions/{id}/transcript   完成后取 {"id", "text", "tokens"}
- DELETE /v1/transcriptions/{id}              删除转写及其关联上传文件

token 契约：每个识别 token 必有 text/start_ms/end_ms（整数毫秒）；
开启 enable_speaker_diarization 后 token 带 speaker（"1"/"2" 字符串标签，
仅单次任务内有效，不是跨文件稳定身份）；
开启 enable_language_identification 后 token 带 language（ISO 码）。
粒度（2026-07-28 实测）：英文等空格分词语言的 token 是 sub-word 片段
（词首片段带前导空格，续段无空格），本模块先用 merge_word_fragments()
合并成词级再映射 item；CJK token 保持逐字。
"""

from __future__ import annotations

import os
import time
from pathlib import Path

import requests
from requests.exceptions import RequestException

from generate_subtitle_qwen_api import split_by_silence, split_words_to_segments

BASE_URL = "https://api.soniox.com"
DEFAULT_MODEL = "stt-async-v5"

# Soniox 异步转写单文件上限 300 分钟（官方 limits 文档，不可提升）
MAX_AUDIO_SECONDS = 300 * 60

# 轮询时允许的连续网络错误次数（api.soniox.com 在海外，偶发超时属正常）
MAX_CONSECUTIVE_NETWORK_ERRORS = 5

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class TranscriptionFailedError(RuntimeError):
    """Soniox 任务进入终态失败（error/failed）。

    与本地网络错误/超时区分：只有终态任务才可以安全删除云端记录。"""

# 说话人 → 颜色快照的调色板，与 JSON_SCHEMA.md 第四节的 5 色一致
SPEAKER_COLOR_PALETTE: tuple[tuple[str, str], ...] = (
    ("red", "#e74c3c"),
    ("yellow", "#f1c40f"),
    ("blue", "#3498db"),
    ("green", "#2ecc71"),
    ("purple", "#9b59b6"),
)


# ===== 配置（.env，与 Qwen 版同样的零依赖解析） =====

def _load_env_file() -> dict[str, str]:
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


def load_config() -> dict:
    """合并 .env 与系统环境变量（系统环境变量优先）。"""
    env = _load_env_file()

    def pick(key: str, default: str = "") -> str:
        return os.getenv(key) or env.get(key, default)

    return {
        "api_key": pick("SONIOX_API_KEY"),
        "model": pick("SONIOX_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL,
        "base_url": pick("SONIOX_BASE_URL", BASE_URL) or BASE_URL,
        "poll_interval": int(pick("SONIOX_POLL_INTERVAL", "3") or "3"),
        "poll_timeout": int(pick("SONIOX_POLL_TIMEOUT", "1800") or "1800"),
    }


# ===== REST 客户端 =====

def _headers(api_key: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {api_key}"}


def _raise_for_status(resp: requests.Response) -> None:
    """把 Soniox 的结构化错误（error_type/message）转成可读异常。"""
    if resp.ok:
        return
    try:
        body = resp.json()
        detail = f"{body.get('error_type', '?')}: {body.get('message', '')}"
    except ValueError:
        detail = resp.text[:300]
    raise RuntimeError(f"Soniox API 错误 (HTTP {resp.status_code}): {detail}")


def upload_file(base_url: str, api_key: str, file_path: str) -> str:
    """multipart 上传媒体文件，返回 file_id。"""
    path = Path(file_path)
    size_mb = path.stat().st_size / 1024 / 1024
    print(f"[soniox] 上传文件: {path.name} ({size_mb:.1f}MB)")
    with open(path, "rb") as f:
        resp = requests.post(
            f"{base_url}/v1/files",
            headers=_headers(api_key),
            files={"file": (path.name, f)},
            timeout=600,
        )
    _raise_for_status(resp)
    file_id = resp.json().get("id")
    if not file_id:
        raise RuntimeError(f"上传响应缺少 id: {resp.text[:300]}")
    return file_id


def create_transcription(base_url: str, api_key: str, *,
                         model: str, file_id: str,
                         language_hints: list[str] | None = None,
                         enable_speaker_diarization: bool = False,
                         enable_language_identification: bool = True) -> str:
    """创建异步转写任务，返回 transcription_id。

    file_id 与 audio_url 二选一（MAW 始终走本地上传，只用 file_id）。
    """
    payload: dict = {
        "model": model,
        "file_id": file_id,
        "enable_language_identification": enable_language_identification,
    }
    if language_hints:
        payload["language_hints"] = list(language_hints)
    if enable_speaker_diarization:
        payload["enable_speaker_diarization"] = True
    resp = requests.post(
        f"{base_url}/v1/transcriptions",
        headers={**_headers(api_key), "Content-Type": "application/json"},
        json=payload,
        timeout=30,
    )
    _raise_for_status(resp)
    transcription_id = resp.json().get("id")
    if not transcription_id:
        raise RuntimeError(f"创建转写响应缺少 id: {resp.text[:300]}")
    return transcription_id


def poll_transcription(base_url: str, api_key: str, transcription_id: str, *,
                       interval: int, timeout: int, on_status=print) -> None:
    """轮询直到 completed；终态失败抛 TranscriptionFailedError。

    临时网络错误（超时/连接失败）重试，连续 MAX_CONSECUTIVE_NETWORK_ERRORS
    次失败才放弃——任务状态在云端，本地一次超时不代表转写失败。
    """
    url = f"{base_url}/v1/transcriptions/{transcription_id}"
    deadline = time.time() + timeout
    last_status = ""
    network_errors = 0

    while time.time() < deadline:
        try:
            resp = requests.get(url, headers=_headers(api_key), timeout=30)
            _raise_for_status(resp)
        except RequestException as e:
            network_errors += 1
            if network_errors >= MAX_CONSECUTIVE_NETWORK_ERRORS:
                raise RuntimeError(
                    f"Soniox 轮询连续 {network_errors} 次网络失败（跨国网络不稳定？），"
                    f"放弃等待: {e}"
                ) from e
            on_status(f"[soniox] [警告] 轮询网络错误（第 {network_errors}/"
                      f"{MAX_CONSECUTIVE_NETWORK_ERRORS} 次），{interval}s 后重试: {e}")
            time.sleep(interval)
            continue

        network_errors = 0
        body = resp.json()
        status = body.get("status", "")

        if status != last_status:
            on_status(f"[soniox] 任务状态: {status or 'UNKNOWN'}")
            last_status = status

        if status == "completed":
            return
        # API Reference 与 SDK 的终态是 error；通用错误文档出现过 failed，防御兼容
        if status in ("error", "failed"):
            raise TranscriptionFailedError(
                f"Soniox 转写失败 [{body.get('error_type', 'UNKNOWN')}]: "
                f"{body.get('error_message', '未知错误')}"
            )
        if status not in ("queued", "processing"):
            raise RuntimeError(f"Soniox 返回未知任务状态: {body}")

        time.sleep(interval)

    raise TimeoutError(f"Soniox 转写超时（{timeout}秒），transcription_id={transcription_id}")


def get_transcript(base_url: str, api_key: str, transcription_id: str) -> dict:
    """取回完成任务的 {"id", "text", "tokens"}。"""
    resp = requests.get(
        f"{base_url}/v1/transcriptions/{transcription_id}/transcript",
        headers=_headers(api_key),
        timeout=120,
    )
    _raise_for_status(resp)
    return resp.json()


def delete_transcription(base_url: str, api_key: str, transcription_id: str, *,
                         on_status=print) -> None:
    """尽力清理：删除转写会连带删除其关联上传文件。失败只警告不抛错。

    Soniox 的文件与转写记录不会自动删除，且有数量/容量配额，
    所以每次任务结束都应清理；processing 状态不可删除（409），
    本函数只在 completed/error 之后调用。
    """
    try:
        resp = requests.delete(
            f"{base_url}/v1/transcriptions/{transcription_id}",
            headers=_headers(api_key),
            timeout=30,
        )
        if resp.ok:
            on_status("[soniox] 已清理云端文件与转写记录")
        else:
            on_status(f"[soniox] [警告] 云端清理失败 (HTTP {resp.status_code})，"
                      f"请稍后在 https://console.soniox.com 手动删除")
    except RequestException as e:
        on_status(f"[soniox] [警告] 云端清理异常: {e}")


# ===== tokens → MAW 工程映射 =====

def _is_cjk_char(char: str) -> bool:
    code = ord(char)
    return (
        0x3000 <= code <= 0x303F    # CJK 标点
        or 0x3040 <= code <= 0x30FF  # 日文假名
        or 0x3400 <= code <= 0x4DBF  # CJK 扩展 A
        or 0x4E00 <= code <= 0x9FFF  # CJK 统一表意文字
        or 0xF900 <= code <= 0xFAFF  # CJK 兼容表意
        or 0xFF00 <= code <= 0xFFEF  # 全角字符
    )


def merge_word_fragments(tokens: list[dict]) -> list[dict]:
    """把 Soniox 的 sub-word 片段合并成「英文按词」的 token 序列。

    实测契约（2026-07-28，stt-async-v5）：词首片段带前导空格（" edit"），
    词内续段没有前导空格（"ing"、"'t"、"ong,"）；标点通常无前导空格，
    自然并入前词（"process."）。
    规则：无前导空格且非 CJK 开头 → 并入前一个 token；CJK 开头
    （中/日文逐字粒度）始终独立。合并后 start 取词首、end 取词尾，
    speaker/language 取词首片段。
    """
    merged: list[dict] = []
    for token in tokens:
        text = token.get("text", "")
        if not text:
            continue
        stripped = text.lstrip()
        continuation = (
            bool(merged)
            and not text[0].isspace()
            and bool(stripped)
            and not _is_cjk_char(stripped[0])
        )
        if continuation:
            prev = merged[-1]
            prev["text"] += text
            prev["end_ms"] = token.get("end_ms", prev.get("end_ms"))
        else:
            merged.append(dict(token))
    return merged


def tokens_to_items(tokens: list[dict]) -> list[dict]:
    """Soniox tokens → MAW items（整数毫秒）。一个 token 对应一个 item。

    官方保证每个识别 token 都有 start_ms/end_ms；防御性兜底：
    缺时间戳或时间倒挂时作为零宽 item 放在前一个 item 的末尾。
    """
    items: list[dict] = []
    previous_end = 0
    for token in tokens:
        text = token.get("text", "")
        if not text:
            continue
        start, end = token.get("start_ms"), token.get("end_ms")
        if not (type(start) is int and type(end) is int) or end < start:
            start = end = previous_end
        item: dict = {"text": text, "start": start, "end": end}
        speaker = token.get("speaker")
        if speaker is not None and str(speaker).strip():
            item["speaker"] = str(speaker)
        items.append(item)
        previous_end = max(previous_end, end)
    return items


def split_items_by_speaker(items: list[dict]) -> list[list[dict]]:
    """按 speaker 变化硬切分（两个 speaker 不得合入同一 segment）。

    无 speaker 字段时整体为一个 run；缺 speaker 的 item 跟随前一个
    已知 speaker，不主动制造切分。
    """
    runs: list[list[dict]] = []
    current: list[dict] = []
    current_speaker: str | None = None
    for item in items:
        speaker = item.get("speaker")
        if (current and speaker is not None and current_speaker is not None
                and speaker != current_speaker):
            runs.append(current)
            current = []
            current_speaker = None
        current.append(item)
        if speaker is not None:
            current_speaker = speaker
    if current:
        runs.append(current)
    return runs


# ===== 空格分词语言（英文等）切句 =====

# 默认按词数计量：英文每条字幕 3–13 词（Netflix 风格上限约 14 词）
WESTERN_MAX_WORDS = 13
WESTERN_MIN_WORDS = 3

# 句末强标点（完整句子边界）与弱标点（超长时的断点），兼容 CJK 全角
WESTERN_STRONG_END = ".!?。！？；"
WESTERN_WEAK_END = ",;:，、：,;—–"
# 判定时剥掉的尾部引号/括号（如 word." 仍视为句号结尾）
_TRAILING_QUOTES = "\"'”’)]}』」"


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


def _is_cjk_dominant(items: list[dict]) -> bool:
    """run 内 CJK item 占比 >= 50% 判定为中文主导（走中文切句逻辑）。"""
    if not items:
        return True
    cjk = sum(
        1 for it in items
        if any(_is_cjk_char(c) for c in it["text"] if not c.isspace())
    )
    return cjk * 2 >= len(items)


def build_segments(items: list[dict], *, max_len: int, min_len: int,
                   gap_split_ms: int,
                   max_words: int = WESTERN_MAX_WORDS,
                   min_words: int = WESTERN_MIN_WORDS) -> list[dict]:
    """speaker run 内按主导文字双轨切句。

    CJK 主导：复用与 Qwen 版一致的静音/全角标点/字数切句；
    空格语言主导：按词数与 .!?,;: 切出完整句子（split_words_to_segments_western）。
    每个 segment 的 speaker 来自其 run（run 内统一，满足
    「segment 所有带语音 items 同一 speaker 才写入」的契约）。
    """
    segments: list[dict] = []
    for run in split_items_by_speaker(items):
        run_speaker = next((it["speaker"] for it in run if it.get("speaker")), None)
        if _is_cjk_dominant(run):
            run_segments = split_words_to_segments(run, max_len, min_len, gap_split_ms)
        else:
            run_segments = split_words_to_segments_western(
                run, max_words, min_words, gap_split_ms
            )
        for seg in run_segments:
            if run_speaker is not None:
                seg["speaker"] = run_speaker
            segments.append(seg)
    return segments


def majority_language(tokens: list[dict]) -> str:
    """按 token 数量取多数语言，作为工程 language；无语言标签时返回空。"""
    counts: dict[str, int] = {}
    for token in tokens:
        lang = token.get("language")
        if lang:
            counts[lang] = counts.get(lang, 0) + 1
    return max(counts, key=lambda k: counts[k]) if counts else ""


def apply_speaker_colors(segments: list[dict]) -> dict:
    """把 segments[*].speaker 按首次出现顺序映射成 5 色 head/ref 快照。

    - 同一 speaker 的每个连续段块：首段写 color head，后续段写 color_ref
    - 超过 5 个 speaker 时颜色循环复用（返回 stats["overflow"]=True）
    - 写入的是普通 color 字段，之后用户可在编辑器自由修改：
      这是生成期的一次性快照，不做 speaker ↔ 颜色的动态绑定
    """
    speaker_order: list[str] = []
    for seg in segments:
        spk = seg.get("speaker")
        if spk and spk not in speaker_order:
            speaker_order.append(spk)
    if not speaker_order:
        return {"speakers": [], "colored_segments": 0, "overflow": False}

    overflow = len(speaker_order) > len(SPEAKER_COLOR_PALETTE)
    palette_of = {
        spk: SPEAKER_COLOR_PALETTE[i % len(SPEAKER_COLOR_PALETTE)]
        for i, spk in enumerate(speaker_order)
    }

    colored = 0
    i, n = 0, len(segments)
    while i < n:
        spk = segments[i].get("speaker")
        if not spk:
            i += 1
            continue
        j = i
        while j + 1 < n and segments[j + 1].get("speaker") == spk:
            j += 1
        name, value = palette_of[spk]
        segments[i]["color"] = {
            "name": name,
            "value": value,
            "start": segments[i]["start"],
            "end": segments[j]["end"],
        }
        for k in range(i + 1, j + 1):
            segments[k]["color_ref"] = {"name": name, "headIdx": i}
        colored += j - i + 1
        i = j + 1
    return {"speakers": speaker_order, "colored_segments": colored,
            "overflow": overflow}


# ===== 顶层转写入口 =====

def transcribe(audio_path: str, config: dict, *,
               language_hints: list[str] | None = None,
               enable_speaker: bool = False,
               model: str | None = None,
               on_status=print) -> dict:
    """完整生命周期：上传 → 创建 → 轮询 → 取 transcript → 清理云端资源。

    返回 {"text", "language", "items"}，items 带可选 speaker 字段，
    可直接交给 build_segments() 切成字幕段。
    """
    api_key = config.get("api_key")
    if not api_key:
        raise SystemExit(
            "[错误] 未配置 SONIOX_API_KEY。请在 .env 文件填入（参考 .env.example），\n"
            "       或设置系统环境变量 SONIOX_API_KEY。\n"
            "       API Key 申请：https://console.soniox.com"
        )
    base_url = config["base_url"]
    model = model or config["model"]

    file_id = upload_file(base_url, api_key, audio_path)
    on_status(f"[soniox] 上传完成: file_id={file_id}")
    transcription_id = create_transcription(
        base_url, api_key,
        model=model,
        file_id=file_id,
        language_hints=language_hints,
        enable_speaker_diarization=enable_speaker,
    )
    on_status(f"[soniox] 任务已提交: transcription_id={transcription_id} "
              f"(model={model}, speaker={'on' if enable_speaker else 'off'})")

    try:
        t0 = time.perf_counter()
        poll_transcription(
            base_url, api_key, transcription_id,
            interval=config["poll_interval"], timeout=config["poll_timeout"],
            on_status=on_status,
        )
        elapsed = time.perf_counter() - t0
        transcript = get_transcript(base_url, api_key, transcription_id)
    except TranscriptionFailedError:
        # 任务已是终态失败，云端记录可以安全清理
        delete_transcription(base_url, api_key, transcription_id, on_status=on_status)
        raise
    except Exception:
        # 本地网络错误/超时等中断：任务可能仍在云端运行，绝不能删除，
        # 否则丢掉即将完成的结果；提示用户按需手动清理
        on_status(
            f"[soniox] [警告] 本地轮询中断，云端任务可能仍在运行"
            f"（transcription_id={transcription_id}）。"
            f"如确认不再需要，请到 https://console.soniox.com 手动删除。"
        )
        raise
    delete_transcription(base_url, api_key, transcription_id, on_status=on_status)

    tokens = transcript.get("tokens", [])
    on_status(f"[soniox] 转写完成，耗时 {elapsed:.1f}s | tokens={len(tokens)}")
    return {
        "text": transcript.get("text", ""),
        "language": majority_language(tokens),
        "items": tokens_to_items(merge_word_fragments(tokens)),
    }
