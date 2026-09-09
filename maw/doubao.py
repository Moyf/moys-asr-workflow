# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""豆包（火山引擎）大模型录音文件识别供应商：HTTP submit/query 客户端 + 结果映射。

范围：异步文件转写、字/词级毫秒时间戳、可选说话人分离与即时热词。
不包含流式 WebSocket、Files API 大文件上传与实时交互。

API 契约（2026-09 官方文档与控制台示例核验，
https://www.volcengine.com/docs/6561/1354868 等）：
- POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit
  提交任务；响应 body 为空，结果在响应头（X-Api-Status-Code / X-Tt-Logid）
- POST https://openspeech.bytedance.com/api/v3/auc/bigmodel/query
  轮询任务；请求 body 为 ``{}``，复用提交时的 X-Api-Request-Id
- 鉴权：新版控制台单一 X-Api-Key（旧版 AppID + Access Token 不使用）
- X-Api-Resource-Id：volc.seedasr.auc（2.0）/ volc.bigasr.auc（1.0）/
  volc.bigasr.auc_idle（闲时）
- X-Api-Sequence：发包序号，非流式固定 -1

音频输入限制（官方文档）：
- base64 直传（MAW 唯一路径）：单文件 ≤ 25MB 且 ≤ 120 分钟
- 支持容器：wav / mp3 / ogg（MAW 统一提取为 ogg + opus 24kbps 单声道）

状态码（响应头 X-Api-Status-Code）：
- 20000000 成功；20000001 处理中；20000002 排队中（两者均为进行中）
- 20000003 静音音频；45000001 请求参数无效；45000002 空音频；
  45000151 音频格式不正确；550xxxx 服务内部错误

结果契约：result.text 为全文（含标点）；result.utterances[] 为分句
（start_time/end_time 毫秒，text 含标点）；utterances[].words[] 为字/词级
start_time/end_time 毫秒；说话人标签位于 utterances.additions.speaker
（部分版本为 utterances.speaker_id）。标点只出现在句文本、不出现在 words
里，映射时由 timestamp_items_cover_text 的「忽略标点」规则消化；
拉丁文本的词间是时间码为 -1 的独立空白 token，映射时还原为词首空格。
"""

from __future__ import annotations

import base64
import json
import os
import time
import uuid
from pathlib import Path

import requests
from requests.exceptions import RequestException

from maw.app_paths import default_env_path
from generate_subtitle_qwen_api import (
    WESTERN_MAX_WORDS,
    WESTERN_MIN_WORDS,
)
from maw.language import (
    normalize_timestamp_range,
    split_mode_for_text,
    timestamp_items_cover_text,
    timestamp_granularity_for_items,
)
from maw.speaker import split_items_by_speaker

BASE_URL = "https://openspeech.bytedance.com"
SUBMIT_PATH = "/api/v3/auc/bigmodel/submit"
QUERY_PATH = "/api/v3/auc/bigmodel/query"
DEFAULT_RESOURCE_ID = "volc.seedasr.auc"

STATUS_OK = "20000000"
STATUS_PROCESSING = ("20000001", "20000002")
STATUS_SILENT = "20000003"

# base64 直传上限（官方文档）：文件 ≤25MB 且 ≤120 分钟
MAX_INLINE_BYTES = 25 * 1024 * 1024
MAX_AUDIO_SECONDS = 120 * 60

# 轮询时允许的连续网络错误次数（openspeech.bytedance.com 偶发超时属正常）
MAX_CONSECUTIVE_NETWORK_ERRORS = 5
POLL_HEARTBEAT_SECONDS = 15

ENV_FILE = default_env_path()

# MAW 语言代码 → 豆包 audio.language。豆包不提供显式 zh/yue 取值
# （不传 language 即自动覆盖中文、粤语与多地方言），这些一律省略。
LANGUAGE_CODES = {
    "en": "en-US",
    "ja": "ja-JP",
    "ko": "ko-KR",
    "de": "de-DE",
    "fr": "fr-FR",
    "es": "es-MX",
    "pt": "pt-BR",
    "ar": "ar-SA",
    "id": "id-ID",
    "ms": "ms-MY",
    "th": "th-TH",
    "fil": "fil-PH",
}

# ogg + opus 24kbps 单声道 16kHz：约 10.8MB/小时，120 分钟 ≈ 21.6MB，
# 留出余量低于 25MB base64 直传上限；对 ASR 识别质量无可感知影响。
AUDIO_FORMAT = "ogg"
AUDIO_CODEC = "opus"
AUDIO_BITRATE = "24k"
AUDIO_SAMPLE_RATE = 16000


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
        "api_key": pick("VOLC_API_KEY"),
        "resource_id": pick("VOLC_ASR_RESOURCE_ID", DEFAULT_RESOURCE_ID) or DEFAULT_RESOURCE_ID,
        "poll_interval": int(pick("VOLC_POLL_INTERVAL", "3") or "3"),
        "poll_timeout": int(pick("VOLC_POLL_TIMEOUT", "1800") or "1800"),
        "ffmpeg_path": pick("FFMPEG_PATH"),
    }


def doubao_language_code(language: str | None) -> str | None:
    """MAW 语言代码 → 豆包 audio.language；不支持/留空返回 None（自动）。"""
    if not language:
        return None
    return LANGUAGE_CODES.get(str(language).strip().lower())


def build_headers(api_key: str, resource_id: str, task_id: str, *,
                  sequence: str | None = None, logid: str = "") -> dict[str, str]:
    """构建请求头；submit 传 sequence="-1"，query 复用 task_id 并回传 logid。"""
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": api_key,
        "X-Api-Resource-Id": resource_id,
        "X-Api-Request-Id": task_id,
    }
    if sequence is not None:
        headers["X-Api-Sequence"] = sequence
    if logid:
        headers["X-Tt-Logid"] = logid
    return headers


def build_hotwords_context(hotwords: list[str] | None) -> str | None:
    """热词列表 → corpus.context JSON（官方格式 {"hotwords":[{"word":...}]}）。"""
    words: list[str] = []
    seen: set[str] = set()
    for word in hotwords or []:
        text = str(word).strip()
        if text and text not in seen:
            words.append(text)
            seen.add(text)
    if not words:
        return None
    return json.dumps(
        {"hotwords": [{"word": word} for word in words]},
        ensure_ascii=False,
    )


def build_submit_payload(
    audio_b64: str,
    *,
    audio_format: str = AUDIO_FORMAT,
    audio_codec: str | None = AUDIO_CODEC,
    language: str | None = None,
    enable_speaker: bool = False,
    hotwords: list[str] | None = None,
) -> dict:
    """构建 submit 请求体（大模型录音文件识别）。"""
    audio: dict[str, object] = {
        "data": audio_b64,
        "format": audio_format,
    }
    if audio_codec:
        audio["codec"] = audio_codec
    doubao_language = doubao_language_code(language)
    if doubao_language:
        audio["language"] = doubao_language
    request: dict[str, object] = {
        "model_name": "bigmodel",
        "enable_itn": True,
        "enable_punc": True,
        "show_utterances": True,
    }
    if enable_speaker:
        request["enable_speaker_info"] = True
    context = build_hotwords_context(hotwords)
    if context:
        request["corpus"] = {"context": context}
    return {
        "user": {"uid": "maw"},
        "audio": audio,
        "request": request,
    }


def submit_task(
    api_key: str,
    payload: dict,
    *,
    resource_id: str = DEFAULT_RESOURCE_ID,
    task_id: str | None = None,
) -> tuple[str, str]:
    """提交识别任务，返回 (task_id, logid)。任务 ID 由客户端生成。"""
    request_id = task_id or str(uuid.uuid4())
    headers = build_headers(api_key, resource_id, request_id, sequence="-1")
    response = requests.post(
        f"{BASE_URL}{SUBMIT_PATH}",
        data=json.dumps(payload, ensure_ascii=False),
        headers=headers,
        timeout=120,
    )
    status = response.headers.get("X-Api-Status-Code", "")
    logid = response.headers.get("X-Tt-Logid", "")
    if status != STATUS_OK:
        message = response.headers.get("X-Api-Message", response.text[:300] or "未知错误")
        raise RuntimeError(f"豆包任务提交失败 [{status or 'NO-STATUS'}]: {message}")
    return request_id, logid


def query_task(
    api_key: str,
    resource_id: str,
    task_id: str,
    *,
    logid: str = "",
) -> tuple[str, str, dict]:
    """查询一次任务状态，返回 (status_code, message, body)。"""
    headers = build_headers(api_key, resource_id, task_id, logid=logid)
    response = requests.post(
        f"{BASE_URL}{QUERY_PATH}",
        data="{}",
        headers=headers,
        timeout=60,
    )
    status = response.headers.get("X-Api-Status-Code", "")
    message = response.headers.get("X-Api-Message", "")
    body: dict = {}
    if response.text.strip():
        try:
            parsed = response.json()
            if isinstance(parsed, dict):
                body = parsed
        except ValueError:
            body = {}
    return status, message, body


def poll_task(
    api_key: str,
    resource_id: str,
    task_id: str,
    *,
    logid: str = "",
    interval: int = 3,
    timeout: int = 1800,
    on_status=print,
) -> dict:
    """轮询直到完成；进行中状态继续等待，终态失败抛 RuntimeError。

    临时网络错误重试，连续 MAX_CONSECUTIVE_NETWORK_ERRORS 次失败才放弃
    ——任务状态在云端，本地一次超时不代表转写失败。
    """
    deadline = time.monotonic() + max(timeout, 0)
    started_at = time.monotonic()
    last_report_at = started_at
    network_errors = 0
    while True:
        now = time.monotonic()
        if now >= deadline:
            raise TimeoutError(
                f"豆包转写超时（{timeout}秒），task_id={task_id}"
            )
        try:
            status, message, body = query_task(
                api_key, resource_id, task_id, logid=logid
            )
        except RequestException as error:
            network_errors += 1
            if network_errors >= MAX_CONSECUTIVE_NETWORK_ERRORS:
                raise RuntimeError(
                    f"豆包轮询连续 {network_errors} 次网络失败，放弃等待: {error}"
                ) from error
            on_status(
                f"[doubao] [警告] 轮询网络错误（第 {network_errors}/"
                f"{MAX_CONSECUTIVE_NETWORK_ERRORS} 次），{interval}s 后重试: {error}"
            )
            time.sleep(max(interval, 0))
            continue

        network_errors = 0
        now = time.monotonic()
        if status == STATUS_OK:
            return body
        if status in STATUS_PROCESSING:
            if now - last_report_at >= POLL_HEARTBEAT_SECONDS:
                elapsed = int(now - started_at)
                on_status(
                    f"[doubao] 任务仍在处理中（状态: {status}，已等待约 {elapsed}s），"
                    f"下一次检查约 {max(interval, 0)}s 后。"
                )
                last_report_at = now
        elif status == STATUS_SILENT:
            raise RuntimeError(
                "豆包判定音频为静音（20000003）。请确认媒体包含可识别的人声。"
            )
        else:
            raise RuntimeError(f"豆包转写失败 [{status or 'NO-STATUS'}]: {message or '未知错误'}")
        time.sleep(max(interval, 0))


def _utterance_speaker(utterance: dict) -> str | None:
    """兼容两种说话人字段：utterances.speaker_id 与 additions.speaker。"""
    speaker = utterance.get("speaker_id")
    if speaker is None:
        additions = utterance.get("additions")
        if isinstance(additions, dict):
            speaker = additions.get("speaker")
    if speaker is None:
        return None
    text = str(speaker).strip()
    return text or None


def _utterance_items(utterance: dict) -> tuple[list[dict], bool]:
    """单个 utterance 的 words → items；返回 (items, 是否存在不可用时间戳)。

    官方实测（2026-09，volc.seedasr.auc）：拉丁文本的词间以独立空白 token
    分隔，且空白 token 的时间码为 -1；空白不参与时间码，只作为「下一个
    有效词带前导空格」的记号还原，保证英文字幕保留词间空格。
    """
    raw_words = utterance.get("words")
    words = raw_words if isinstance(raw_words, list) else []
    items: list[dict] = []
    invalid = False
    speaker = _utterance_speaker(utterance)
    pending_space = False
    for word in words:
        if not isinstance(word, dict):
            invalid = True
            continue
        text = str(word.get("text") or "")
        if not text.strip():
            if text:
                pending_space = True
            continue
        timestamp = normalize_timestamp_range(
            word.get("start_time"), word.get("end_time")
        )
        if timestamp is None:
            invalid = True
            continue
        if pending_space:
            text = " " + text
            pending_space = False
        item: dict = {
            "text": text,
            "start": timestamp[0],
            "end": timestamp[1],
        }
        if speaker is not None:
            item["speaker"] = speaker
        items.append(item)
    return items, invalid


def parse_result(body: dict) -> dict:
    """把豆包 query 结果归一化为 MAW 形状。

    正常路径：每句 words → items（含可选 speaker），句文本仅用于校验与兜底。
    降级路径：任一句时间码不可用/与文本不匹配时，全部句子退化为粗粒度
    segments（句级范围、无 items），与腾讯云适配器保持同一策略。
    """
    result = body.get("result") if isinstance(body.get("result"), dict) else {}
    raw_utterances = result.get("utterances")
    utterances = raw_utterances if isinstance(raw_utterances, list) else []

    items: list[dict] = []
    segments: list[dict] = []
    has_fallback = False
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        text = str(utterance.get("text") or "")
        sentence_items, invalid = _utterance_items(utterance)
        sentence_range = normalize_timestamp_range(
            utterance.get("start_time"), utterance.get("end_time")
        )
        if sentence_items and not invalid and not timestamp_items_cover_text(
            text, sentence_items
        ):
            # 句范围完整但 words 与文本不一致：不能安全当作词级转写使用
            invalid = True
        valid_item_range = (
            min(item["start"] for item in sentence_items),
            max(item["end"] for item in sentence_items),
        ) if sentence_items else None
        if sentence_range is None and valid_item_range is not None:
            sentence_range = valid_item_range
        if sentence_range is None or not text.strip():
            continue
        start, end = sentence_range
        if sentence_items and not invalid:
            start = min(start, *(item["start"] for item in sentence_items))
            end = max(end, *(item["end"] for item in sentence_items))
            items.extend(sentence_items)
        else:
            has_fallback = True
        segment: dict = {"start": start, "end": end, "text": text}
        speaker = _utterance_speaker(utterance)
        if speaker is not None:
            segment["speaker"] = speaker
        segments.append(segment)

    text = str(result.get("text") or "")
    if not text:
        text = "".join(str(segment["text"]) for segment in segments)
    split_mode = split_mode_for_text(text)
    if has_fallback or (segments and not items):
        # 至少一句不可用：全部退化为句级粗字幕，绝不混用词级与插值粒度
        timestamp_granularity = "segment"
        items = []
    else:
        timestamp_granularity = timestamp_granularity_for_items(
            items, split_mode, explicit_items=True, has_segments=bool(segments)
        )
    if has_fallback:
        items = []
    return {
        "text": text,
        "language": "",
        "items": items,
        "segments": segments if has_fallback else [],
        "timestamp_granularity": timestamp_granularity,
    }


def build_segments(items: list[dict], *, max_len: int, min_len: int,
                   gap_split_ms: int,
                   max_words: int = WESTERN_MAX_WORDS,
                   min_words: int = WESTERN_MIN_WORDS,
                   split_mode: str | None = None) -> list[dict]:
    """speaker run 内切句（split_segments_auto 按静音组自动选择 CJK/英文逻辑）。"""
    from generate_subtitle_qwen_api import split_segments_auto

    segments: list[dict] = []
    for run in split_items_by_speaker(items):
        run_speaker = next((it["speaker"] for it in run if it.get("speaker")), None)
        for seg in split_segments_auto(
            run, max_len=max_len, min_len=min_len, gap_split_ms=gap_split_ms,
            max_words=max_words, min_words=min_words, split_mode=split_mode,
        ):
            if run_speaker is not None:
                seg["speaker"] = run_speaker
            segments.append(seg)
    return segments


def _require_api_key(config: dict) -> str:
    api_key = str(config.get("api_key") or "")
    if not api_key:
        raise SystemExit(
            "[错误] 未配置 VOLC_API_KEY。请在 .env 文件填入（参考 .env.example），\n"
            "       或设置系统环境变量 VOLC_API_KEY。\n"
            "       API Key 申请：https://console.volcengine.com/speech/new/experience/asr"
        )
    return api_key


def transcribe(
    audio_path: str,
    config: dict,
    *,
    language: str | None = None,
    enable_speaker: bool = False,
    hotwords: list[str] | None = None,
    audio_format: str = AUDIO_FORMAT,
    audio_codec: str | None = AUDIO_CODEC,
    resource_id: str | None = None,
    capture_raw: bool = False,
    on_status=print,
) -> dict:
    """完整生命周期：读取音频 → base64 提交 → 轮询 → 解析。

    返回 {"text", "language", "items", "segments", "timestamp_granularity"}，
    形状与 maw.soniox.transcribe 一致，可直接交给 build_segments() 切句。
    """
    api_key = _require_api_key(config)
    resource = resource_id or str(config.get("resource_id") or DEFAULT_RESOURCE_ID)
    path = Path(audio_path)
    data = path.read_bytes()
    if len(data) > MAX_INLINE_BYTES:
        raise SystemExit(
            f"[错误] 提取后音频 {len(data) / 1024 / 1024:.1f}MB 超过豆包 base64 "
            f"直传上限（25MB）。请用 -ll 截取部分时长，或先把音频分割成多个文件。"
        )
    payload = build_submit_payload(
        base64.b64encode(data).decode("ascii"),
        audio_format=audio_format,
        audio_codec=audio_codec,
        language=language,
        enable_speaker=enable_speaker,
        hotwords=hotwords,
    )
    on_status("[doubao] 正在提交豆包录音文件识别任务（base64 直传）...")
    task_id, logid = submit_task(
        api_key, payload, resource_id=resource,
    )
    on_status(
        f"[doubao] 任务已提交: task_id={task_id}"
        f" (resource={resource}, speaker={'on' if enable_speaker else 'off'})"
    )

    t0 = time.perf_counter()
    body = poll_task(
        api_key, resource, task_id,
        logid=logid,
        interval=int(config.get("poll_interval", 3)),
        timeout=int(config.get("poll_timeout", 1800)),
        on_status=on_status,
    )
    elapsed = time.perf_counter() - t0
    on_status(f"[doubao] 转写完成，耗时 {elapsed:.1f}s")

    result = parse_result(body)
    if capture_raw:
        result["_raw_response"] = body
    return result
