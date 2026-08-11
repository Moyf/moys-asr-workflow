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

import json
import os
import re
import time
from collections.abc import Mapping
from pathlib import Path

import requests
from requests.exceptions import RequestException

from generate_subtitle_qwen_api import (
    WESTERN_MAX_WORDS,
    WESTERN_MIN_WORDS,
    is_cjk_char,
    split_segments_auto,
)
from maw.speaker import (
    SPEAKER_COLOR_PALETTE,
    apply_speaker_colors,
    split_items_by_speaker,
)

BASE_URL = "https://api.soniox.com"
DEFAULT_MODEL = "stt-async-v5"

# Soniox documents this as 8,000 tokens (approximately 10,000 characters).
# The API remains authoritative for the actual token count.
SONIOX_CONTEXT_MAX_CHARS = 10_000

# Soniox 异步转写单文件上限 300 分钟（官方 limits 文档，不可提升）
MAX_AUDIO_SECONDS = 300 * 60

# 轮询时允许的连续网络错误次数（api.soniox.com 在海外，偶发超时属正常）
MAX_CONSECUTIVE_NETWORK_ERRORS = 5
POLL_HEARTBEAT_SECONDS = 15

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"


class TranscriptionFailedError(RuntimeError):
    """Soniox 任务进入终态失败（error/failed）。

    与本地网络错误/超时区分：只有终态任务才可以安全删除云端记录。"""


class SonioxContextError(ValueError):
    """Soniox context input is malformed or exceeds the documented size."""

    def __init__(self, field: str, message: str, *, code: str = "soniox_context_invalid") -> None:
        self.field = field
        self.code = code
        super().__init__(message)

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


# ===== context =====

def _context_lines(value: str) -> list[str]:
    return [
        line.strip()
        for line in str(value or "").splitlines()
        if line.strip() and not line.strip().startswith("#")
    ]


def _context_error(field: str, message: str) -> SonioxContextError:
    return SonioxContextError(field, message)


def _parse_general_context(value: str) -> list[dict[str, str]]:
    raw = str(value or "").strip()
    if not raw:
        return []

    if raw.startswith(("[", "{")):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise _context_error("sonioxContextGeneral", "Soniox general context JSON 无法解析。") from exc
        if isinstance(parsed, Mapping):
            parsed = [{"key": key, "value": item} for key, item in parsed.items()]
        if not isinstance(parsed, list):
            raise _context_error("sonioxContextGeneral", "Soniox general context 必须是对象数组。")
        entries: list[dict[str, str]] = []
        for index, item in enumerate(parsed, start=1):
            if not isinstance(item, Mapping):
                raise _context_error("sonioxContextGeneral", f"Soniox general context 第 {index} 项必须是对象。")
            key = str(item.get("key") or "").strip()
            item_value = item.get("value")
            if not key or item_value is None or not str(item_value).strip():
                raise _context_error("sonioxContextGeneral", f"Soniox general context 第 {index} 项缺少 key/value。")
            entries.append({"key": key, "value": str(item_value).strip()})
        return entries

    entries = []
    for index, line in enumerate(_context_lines(raw), start=1):
        if "=" not in line:
            raise _context_error(
                "sonioxContextGeneral",
                f"Soniox general context 第 {index} 行应使用 key=value 格式。",
            )
        key, item_value = (part.strip() for part in line.split("=", 1))
        if not key or not item_value:
            raise _context_error(
                "sonioxContextGeneral",
                f"Soniox general context 第 {index} 行缺少 key 或 value。",
            )
        entries.append({"key": key, "value": item_value})
    return entries


def _parse_terms_context(value: str) -> list[str]:
    raw = str(value or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise _context_error("sonioxContextTerms", "Soniox terms JSON 无法解析。") from exc
        if not isinstance(parsed, list) or any(not isinstance(item, str) for item in parsed):
            raise _context_error("sonioxContextTerms", "Soniox terms 必须是字符串数组。")
        candidates = [item.strip() for item in parsed]
    else:
        candidates = [
            item.strip()
            for item in re.split(r"[\r\n,，;；]+", raw)
        ]

    terms: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        if item and item not in seen:
            terms.append(item)
            seen.add(item)
    return terms


def _parse_translation_terms_context(value: str) -> list[dict[str, str]]:
    raw = str(value or "").strip()
    if not raw:
        return []
    if raw.startswith("["):
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise _context_error(
                "sonioxContextTranslationTerms",
                "Soniox translation_terms JSON 无法解析。",
            ) from exc
        if not isinstance(parsed, list):
            raise _context_error(
                "sonioxContextTranslationTerms",
                "Soniox translation_terms 必须是对象数组。",
            )
        entries: list[dict[str, str]] = []
        for index, item in enumerate(parsed, start=1):
            if not isinstance(item, Mapping):
                raise _context_error(
                    "sonioxContextTranslationTerms",
                    f"Soniox translation_terms 第 {index} 项必须是对象。",
                )
            source = str(item.get("source") or "").strip()
            target = str(item.get("target") or "").strip()
            if not source or not target:
                raise _context_error(
                    "sonioxContextTranslationTerms",
                    f"Soniox translation_terms 第 {index} 项缺少 source/target。",
                )
            entries.append({"source": source, "target": target})
        return entries

    entries = []
    for index, line in enumerate(_context_lines(raw), start=1):
        if "=>" in line:
            source, target = (part.strip() for part in line.split("=>", 1))
        elif "\t" in line:
            source, target = (part.strip() for part in line.split("\t", 1))
        else:
            raise _context_error(
                "sonioxContextTranslationTerms",
                f"Soniox translation_terms 第 {index} 行应使用 source => target 格式。",
            )
        if not source or not target:
            raise _context_error(
                "sonioxContextTranslationTerms",
                f"Soniox translation_terms 第 {index} 行缺少 source 或 target。",
            )
        entries.append({"source": source, "target": target})
    return entries


def _validate_context_size(context: dict[str, object]) -> None:
    content: list[str] = []
    for item in context.get("general", []):
        if isinstance(item, Mapping):
            content.extend((str(item.get("key") or ""), str(item.get("value") or "")))
    content.append(str(context.get("text") or ""))
    content.extend(str(item) for item in context.get("terms", []))
    for item in context.get("translation_terms", []):
        if isinstance(item, Mapping):
            content.extend((str(item.get("source") or ""), str(item.get("target") or "")))
    size = len("".join(content))
    if size > SONIOX_CONTEXT_MAX_CHARS:
        raise SonioxContextError(
            "sonioxContextText",
            f"Soniox context 约限制为 {SONIOX_CONTEXT_MAX_CHARS} 个字符，当前序列化长度为 {size}。",
            code="soniox_context_too_long",
        )


def build_soniox_context(
    *,
    general: str = "",
    text: str = "",
    terms: str = "",
    translation_terms: str = "",
) -> dict[str, object] | None:
    """Build Soniox's documented context object from Launcher-friendly text fields."""
    context: dict[str, object] = {}
    general_entries = _parse_general_context(general)
    term_entries = _parse_terms_context(terms)
    translation_entries = _parse_translation_terms_context(translation_terms)
    if general_entries:
        context["general"] = general_entries
    if str(text or "").strip():
        context["text"] = str(text).strip()
    if term_entries:
        context["terms"] = term_entries
    if translation_entries:
        context["translation_terms"] = translation_entries
    if not context:
        return None
    _validate_context_size(context)
    return context


def parse_soniox_context_json(value: str) -> dict[str, object] | None:
    """Validate a serialized Soniox context passed by CLI/internal Launcher calls."""
    raw = str(value or "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise SonioxContextError("sonioxContextText", "Soniox context JSON 无法解析。") from exc
    if not isinstance(parsed, Mapping):
        raise SonioxContextError("sonioxContextText", "Soniox context 必须是 JSON 对象。")
    unknown = set(parsed) - {"general", "text", "terms", "translation_terms"}
    if unknown:
        names = ", ".join(sorted(str(item) for item in unknown))
        raise SonioxContextError("sonioxContextText", f"Soniox context 含有未知分区：{names}。")
    text = parsed.get("text", "")
    if text is not None and not isinstance(text, str):
        raise SonioxContextError("sonioxContextText", "Soniox context.text 必须是字符串。")
    return build_soniox_context(
        general=json.dumps(parsed["general"], ensure_ascii=False) if "general" in parsed else "",
        text=text or "",
        terms=json.dumps(parsed["terms"], ensure_ascii=False) if "terms" in parsed else "",
        translation_terms=(
            json.dumps(parsed["translation_terms"], ensure_ascii=False)
            if "translation_terms" in parsed else ""
        ),
    )


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
                         enable_language_identification: bool = True,
                         context: dict[str, object] | None = None) -> str:
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
    if context:
        payload["context"] = context
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
    started_at = time.monotonic()
    last_report_at = started_at
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
        now = time.monotonic()

        if status != last_status:
            on_status(f"[soniox] 任务状态: {status or 'UNKNOWN'}")
            last_status = status
            last_report_at = now
        elif now - last_report_at >= POLL_HEARTBEAT_SECONDS:
            elapsed = int(now - started_at)
            on_status(
                f"[soniox] 任务仍在处理中（状态: {status or 'UNKNOWN'}，"
                f"已等待约 {elapsed}s），下一次检查约 {max(interval, 0)}s 后。"
            )
            last_report_at = now

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
            and not is_cjk_char(stripped[0])
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


def build_segments(items: list[dict], *, max_len: int, min_len: int,
                   gap_split_ms: int,
                   max_words: int = WESTERN_MAX_WORDS,
                   min_words: int = WESTERN_MIN_WORDS) -> list[dict]:
    """speaker run 内切句（split_segments_auto 按静音组自动选择 CJK/英文逻辑）。

    每个 segment 的 speaker 来自其 run（run 内统一，满足
    「segment 所有带语音 items 同一 speaker 才写入」的契约）。
    """
    segments: list[dict] = []
    for run in split_items_by_speaker(items):
        run_speaker = next((it["speaker"] for it in run if it.get("speaker")), None)
        for seg in split_segments_auto(
            run, max_len=max_len, min_len=min_len, gap_split_ms=gap_split_ms,
            max_words=max_words, min_words=min_words,
        ):
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


# ===== 顶层转写入口 =====

def transcribe(audio_path: str, config: dict, *,
               language_hints: list[str] | None = None,
               enable_speaker: bool = False,
               model: str | None = None,
               context: dict[str, object] | None = None,
               capture_raw: bool = False,
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
    on_status(f"[soniox] 正在创建异步转写任务（model={model}）...")
    create_kwargs: dict[str, object] = {
        "model": model,
        "file_id": file_id,
        "language_hints": language_hints,
        "enable_speaker_diarization": enable_speaker,
    }
    if context:
        create_kwargs["context"] = context
    transcription_id = create_transcription(base_url, api_key, **create_kwargs)
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
        on_status("[soniox] 转写完成，正在下载转写结果...")
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
    on_status(f"[soniox] 转写结果下载完成，耗时 {elapsed:.1f}s | tokens={len(tokens)}")
    result = {
        "text": transcript.get("text", ""),
        "language": majority_language(tokens),
        "items": tokens_to_items(merge_word_fragments(tokens)),
    }
    if capture_raw:
        result["_raw_response"] = transcript
    return result
