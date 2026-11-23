# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""MOSS（模思智能开放平台）云端转写供应商：HTTP 客户端 + 结果映射。

范围：moss-transcribe-diarize-pro 的异步文件转写（multipart 上传）、
说话人分段（段级时间码）、keyterms 热词。不包含 SSE 流式、Files API
与 webhook 回调。

API 契约（2026-11 官方文档核验，https://platform.moss.cn/en/docs/reference/transcriptions）：
- POST https://api.mosi.cn/v1/audio/transcriptions
  multipart 表单：model / file / diarize / keyterms / response_format / async；
  ``async=true`` 时立即返回任务对象（id、task_id、retry_after 秒）
- GET https://api.mosi.cn/v1/audio/tasks/{task_id}
  轮询任务状态 PENDING / PROCESSING / SUCCESS / FAILED；
  SUCCESS 且 object=audio.transcription 时顶层带 text，说话人任务另有 segments
- 鉴权：``Authorization: Bearer <MOSS_API_KEY>``
- keyterms：最多 20 个、每个最多 30 字符；multipart 下传 JSON 编码字符串数组
  （官方示例 ``["MOSS","SGLang"]``）

输入限制（官方文档）：
- 单文件 ≤512MB；支持 AAC/AMR/FLAC/M4A/ALAC/MOV/MP3/MP4/MPG/OGG/OPUS/WAV/WebM/WMA
- moss-transcribe-diarize-pro 最长 60 分钟音频
- 每用户并发 2 个转写任务；RPM 70 / RPD 30000

结果契约：diarize 响应 ``{task, duration(秒), text, segments[]}``；
segments[].start/end 为秒（小数），speaker 如 ``S01``。模型只给段级时间码，
没有字词级边界——与本地 MOSS 引擎一致，MAW 不伪造 items，也不对段文本做
字数硬切；字词时间码交给现有对齐流程补齐。
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Mapping

import requests
from requests.exceptions import RequestException

from maw.app_paths import default_env_path
from maw.language import normalize_timestamp_range

BASE_URL = "https://api.mosi.cn/v1"
TRANSCRIPTION_PATH = "/audio/transcriptions"
TASK_PATH = "/audio/tasks"
DEFAULT_MODEL = "moss-transcribe-diarize-pro"

STATUS_PENDING = "PENDING"
STATUS_PROCESSING = "PROCESSING"
STATUS_SUCCESS = "SUCCESS"
STATUS_FAILED = "FAILED"

# 官方上传限制：单文件 ≤512MB；diarize-pro 单次 ≤60 分钟。
MAX_UPLOAD_BYTES = 512 * 1024 * 1024
MAX_AUDIO_SECONDS = 60 * 60
# 转码容器时长的毫秒级舍入误差（3600s 素材经 ogg/opus 转码后 ffprobe 可读
# 出 3600.006s）：恰好等于上限的合法素材不因舍入被拒。
MAX_AUDIO_SECONDS_TOLERANCE = 0.1

# keyterms 官方限制：最多 20 个、每个最多 30 字符。
MAX_KEYTERMS = 20
MAX_KEYTERM_CHARS = 30

# 轮询时允许的连续网络错误次数（与豆包适配器同一容错策略）。
MAX_CONSECUTIVE_NETWORK_ERRORS = 5
POLL_HEARTBEAT_SECONDS = 15
DEFAULT_POLL_INTERVAL = 3
DEFAULT_POLL_TIMEOUT = 1800

ENV_FILE = default_env_path()

# ogg + opus 24kbps 单声道 16kHz（与豆包通道相同）：约 10.8MB/小时，
# 60 分钟 ≈ 11MB，远低于 512MB 上传上限；对 ASR 识别质量无可感知影响。
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
        key, value = line.split("=", 1)
        config[key.strip()] = value.strip()
    return config


def load_config() -> dict[str, str]:
    """合并 .env 与系统环境变量（系统环境变量优先）。"""
    env = _load_env_file()

    def pick(key: str, default: str = "") -> str:
        return os.getenv(key) or env.get(key, default)

    return {
        "api_key": pick("MOSS_API_KEY"),
        "model": pick("MOSS_MODEL", DEFAULT_MODEL) or DEFAULT_MODEL,
        "poll_interval": pick("MOSS_POLL_INTERVAL", str(DEFAULT_POLL_INTERVAL)),
        "poll_timeout": pick("MOSS_POLL_TIMEOUT", str(DEFAULT_POLL_TIMEOUT)),
        "ffmpeg_path": pick("FFMPEG_PATH"),
    }


def normalize_keyterms(keyterms: Sequence[str] | None) -> list[str]:
    """清洗 keyterms：去空白、去重、按原顺序保留；不改变条目内容。

    条目数量与长度校验由 ``validate_keyterms`` 负责；这里只负责把
    Launcher / CLI 传来的原始列表整理成可提交的形状。
    """
    cleaned: list[str] = []
    seen: set[str] = set()
    for value in keyterms or ():
        text = str(value or "").strip()
        if text and text not in seen:
            cleaned.append(text)
            seen.add(text)
    return cleaned


def validate_keyterms(keyterms: Sequence[str]) -> None:
    """按官方限制校验 keyterms；违例抛 RuntimeError，由提交前拦截。"""
    terms = [str(value or "").strip() for value in keyterms]
    if len(terms) > MAX_KEYTERMS:
        raise RuntimeError(
            f"MOSS keyterms 最多 {MAX_KEYTERMS} 个（当前 {len(terms)} 个）；"
            "请删减后再试。"
        )
    for term in terms:
        if len(term) > MAX_KEYTERM_CHARS:
            raise RuntimeError(
                f"MOSS keyterm「{term[:MAX_KEYTERM_CHARS]}…」超过 {MAX_KEYTERM_CHARS} 字符"
                f"（当前 {len(term)} 字符）；请拆分或精简。"
            )


def build_request_data(
    model: str,
    *,
    keyterms: Sequence[str] | None = None,
) -> list[tuple[str, str]]:
    """构建 multipart 表单字段（异步 diarize 转写）。

    - ``diarize=true`` + ``response_format=json``：返回说话人分段。
    - ``async=true``：提交即返回任务对象，随后轮询；长音频下比同步
      长连接稳，且能在等待期间输出心跳进度。
    - keyterms 按 multipart 约定传 JSON 编码字符串数组。
    """
    data: list[tuple[str, str]] = [
        ("model", model),
        ("diarize", "true"),
        ("response_format", "json"),
        ("async", "true"),
    ]
    cleaned = normalize_keyterms(keyterms)
    if cleaned:
        validate_keyterms(cleaned)
        data.append(("keyterms", json.dumps(cleaned, ensure_ascii=False)))
    return data


def _error_detail(response: requests.Response) -> str:
    """提取服务端错误信息；兼容 error.message / message / 纯文本。"""
    try:
        body = response.json()
    except ValueError:
        text = (response.text or "").strip()
        return text[:500] or "服务端未返回错误正文"
    if isinstance(body, Mapping):
        error = body.get("error")
        if isinstance(error, Mapping):
            message = error.get("message") or error.get("code")
            if message:
                detail = str(message)
                code = error.get("code")
                if code and str(code) not in detail:
                    detail = f"{code}: {detail}"
                return detail
        message = body.get("message")
        if message:
            return str(message)
        return json.dumps(body, ensure_ascii=False)[:500]
    return str(body)[:500]


def _request_error(response: requests.Response, action: str) -> RuntimeError:
    return RuntimeError(
        f"MOSS {action}失败 (HTTP {response.status_code}): {_error_detail(response)}"
    )


def submit_task(
    audio_path: str | Path,
    *,
    api_key: str,
    model: str = DEFAULT_MODEL,
    keyterms: Sequence[str] | None = None,
    base_url: str = BASE_URL,
) -> dict[str, Any]:
    """提交异步转写任务，返回任务对象（含 task_id 与 retry_after）。"""
    path = Path(audio_path)
    data = build_request_data(model, keyterms=keyterms)
    content_type = (
        "application/ogg" if path.suffix.lower() in {".ogg", ".oga", ".opus"}
        else "application/octet-stream"
    )
    with path.open("rb") as handle:
        response = requests.post(
            f"{base_url}{TRANSCRIPTION_PATH}",
            headers={"Authorization": f"Bearer {api_key}"},
            data=data,
            files={"file": (path.name, handle, content_type)},
            timeout=(30, 600),
        )
    if not response.ok:
        raise _request_error(response, "任务提交")
    try:
        body = response.json()
    except ValueError as error:
        raise RuntimeError("MOSS 任务提交返回的不是 JSON。") from error
    if not isinstance(body, dict):
        raise RuntimeError("MOSS 任务提交返回的不是 JSON 对象。")
    task_id = str(body.get("task_id") or body.get("id") or "")
    if not task_id:
        raise RuntimeError("MOSS 任务提交成功但没有返回 task_id。")
    return body


def query_task(
    task_id: str,
    *,
    api_key: str,
    base_url: str = BASE_URL,
) -> dict[str, Any]:
    """查询一次任务状态，返回响应 body（含 status / text / segments）。"""
    response = requests.get(
        f"{base_url}{TASK_PATH}/{task_id}",
        headers={"Authorization": f"Bearer {api_key}"},
        timeout=60,
    )
    if not response.ok:
        raise _request_error(response, "任务查询")
    try:
        body = response.json()
    except ValueError as error:
        raise RuntimeError("MOSS 任务查询返回的不是 JSON。") from error
    if not isinstance(body, dict):
        raise RuntimeError("MOSS 任务查询返回的不是 JSON 对象。")
    return body


def poll_task(
    task_id: str,
    *,
    api_key: str,
    interval: int = DEFAULT_POLL_INTERVAL,
    timeout: int = DEFAULT_POLL_TIMEOUT,
    retry_after: int = 0,
    base_url: str = BASE_URL,
    on_status=print,
) -> dict[str, Any]:
    """轮询直到 SUCCESS；FAILED / 超时抛 RuntimeError。

    服务端在任务对象里给出 ``retry_after`` 建议间隔，首次等待优先采用；
    临时网络错误连续 MAX_CONSECUTIVE_NETWORK_ERRORS 次才放弃。
    """
    wait_seconds = max(int(retry_after or 0), int(interval), 1)
    deadline = time.monotonic() + max(int(timeout), 0)
    started_at = time.monotonic()
    last_report_at = started_at
    network_errors = 0
    while True:
        now = time.monotonic()
        if now >= deadline:
            raise TimeoutError(f"MOSS 转写超时（{timeout}秒），task_id={task_id}")
        try:
            body = query_task(task_id, api_key=api_key, base_url=base_url)
        except RequestException as error:
            network_errors += 1
            if network_errors >= MAX_CONSECUTIVE_NETWORK_ERRORS:
                raise RuntimeError(
                    f"MOSS 轮询连续 {network_errors} 次网络失败，放弃等待: {error}"
                ) from error
            on_status(
                f"[moss] [警告] 轮询网络错误（第 {network_errors}/"
                f"{MAX_CONSECUTIVE_NETWORK_ERRORS} 次），{wait_seconds}s 后重试: {error}"
            )
            time.sleep(wait_seconds)
            continue

        network_errors = 0
        status = str(body.get("status") or "")
        now = time.monotonic()
        if status == STATUS_SUCCESS:
            return body
        if status in (STATUS_PENDING, STATUS_PROCESSING):
            if now - last_report_at >= POLL_HEARTBEAT_SECONDS:
                elapsed = int(now - started_at)
                phase = "排队" if status == STATUS_PENDING else "处理"
                on_status(
                    f"[moss] 任务仍在{phase}中"
                    f"（已等待约 {elapsed}s），下一次检查约 {wait_seconds}s 后。"
                )
                last_report_at = now
            time.sleep(wait_seconds)
            continue
        if status == STATUS_FAILED:
            error = body.get("error")
            detail = ""
            if isinstance(error, Mapping):
                detail = str(error.get("message") or error.get("code") or "")
            raise RuntimeError(f"MOSS 转写任务失败: {detail or '服务端未返回原因'}")
        raise RuntimeError(f"MOSS 转写任务返回未知状态: {status or 'NO-STATUS'}")


def _seconds_milliseconds(value: object) -> int | None:
    """秒（小数）→ 整数毫秒；非法值返回 None。"""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    milliseconds = number * 1000
    if not (milliseconds == milliseconds) or milliseconds in (float("inf"), float("-inf")):
        return None
    return int(round(milliseconds))


def parse_result(body: Mapping[str, Any]) -> dict[str, Any]:
    """把 MOSS 任务结果归一化为 MAW 形状。

    diarize 任务每个 segment 带 start/end（秒）+ text + speaker；
    模型不提供字词级时间码，items 恒为空、timestamp_granularity 恒为
    ``segment``。官方文档允许 segments 为空（短音频或无有效分段）、个别
    段也可能缺时间码——任一情况只要 text 完整，就用 duration 兜底为
    整段单条（与本地 MOSS 引擎同策略：宁可粗粒度也不丢文本）；既无
    时间戳又无时长时抛错，绝不静默产出空字幕。
    """
    raw_segments = body.get("segments")
    segments_list = raw_segments if isinstance(raw_segments, list) else []

    segments: list[dict[str, Any]] = []
    ordered_texts: list[str] = []
    has_unranged = False
    for raw in segments_list:
        if not isinstance(raw, Mapping):
            has_unranged = True
            continue
        seg_text = str(raw.get("text") or "").strip()
        if not seg_text:
            continue
        ordered_texts.append(seg_text)
        start = _seconds_milliseconds(raw.get("start"))
        end = _seconds_milliseconds(raw.get("end"))
        timestamp = normalize_timestamp_range(start, end)
        if timestamp is None:
            has_unranged = True
            continue
        segment: dict[str, Any] = {"start": timestamp[0], "end": timestamp[1], "text": seg_text}
        speaker = str(raw.get("speaker") or "").strip()
        if speaker:
            segment["speaker"] = speaker
        segments.append(segment)

    text = str(body.get("text") or "").strip()
    if not text and ordered_texts:
        # 顶层 text 缺失时按出现顺序重建全文；无时间码段的文字也必须计入，
        # 否则整段兜底会输出不完整字幕。
        text = "".join(ordered_texts)
    duration = _seconds_milliseconds(body.get("duration"))
    if text and (has_unranged or not segments):
        # 官方文档明确允许 segments 为空（短音频或无有效分段），个别段也可能
        # 缺时间码；两种情况都不能丢文本——用 duration（以及已有段的最大
        # 结束点）兜底为整段单条，与豆包/OpenAI 适配器的降级策略同构。
        fallback_end = duration if duration is not None else 0
        if segments:
            fallback_end = max(fallback_end, max(item["end"] for item in segments))
        if not fallback_end:
            raise RuntimeError(
                "MOSS 返回了转写文本，但没有可用的时间戳或音频时长，无法生成字幕时间码。"
            )
        segments = [{"start": 0, "end": fallback_end, "text": text}]

    return {
        "text": text,
        "language": "",
        "items": [],
        "segments": segments,
        "timestamp_granularity": "segment",
        "duration_ms": duration,
    }


def transcribe(
    audio_path: str | Path,
    config: Mapping[str, str],
    *,
    model: str | None = None,
    keyterms: Sequence[str] | None = None,
    capture_raw: bool = False,
    on_status=print,
) -> dict[str, Any]:
    """完整生命周期：校验 → 异步提交 → 轮询 → 解析。

    返回形状与 maw.doubao.transcribe 一致（text/language/items/segments/
    timestamp_granularity），另含 ``_raw_response``（capture_raw 时）与
    ``duration_ms``（响应 duration 秒 → 毫秒，用于耗时统计）。
    """
    api_key = str(config.get("api_key") or "")
    if not api_key:
        raise SystemExit(
            "[错误] 未配置 MOSS_API_KEY。请在 .env 文件填入（参考 .env.example），\n"
            "       或设置系统环境变量 MOSS_API_KEY。\n"
            "       API Key 申请：https://platform.moss.cn/app/api-keys"
        )
    resolved_model = str(model or config.get("model") or DEFAULT_MODEL)
    path = Path(audio_path)
    upload_bytes = path.stat().st_size
    if upload_bytes > MAX_UPLOAD_BYTES:
        raise SystemExit(
            f"[错误] 提取后音频 {upload_bytes / 1024 / 1024:.1f}MB 超过 MOSS 上传上限"
            f"（512MB）。请用 -ll 截取部分时长，或先把音频分割成多个文件。"
        )
    cleaned = normalize_keyterms(keyterms)
    if cleaned:
        validate_keyterms(cleaned)
    on_status(f"[moss] 正在提交 MOSS 转写任务（{resolved_model}）...")
    task = submit_task(path, api_key=api_key, model=resolved_model, keyterms=cleaned)
    task_id = str(task.get("task_id") or task.get("id") or "")
    on_status(f"[moss] 任务已提交: task_id={task_id}")

    t0 = time.perf_counter()
    body = poll_task(
        task_id,
        api_key=api_key,
        interval=int(str(config.get("poll_interval") or DEFAULT_POLL_INTERVAL) or DEFAULT_POLL_INTERVAL),
        timeout=int(str(config.get("poll_timeout") or DEFAULT_POLL_TIMEOUT) or DEFAULT_POLL_TIMEOUT),
        retry_after=int(task.get("retry_after") or 0),
        on_status=on_status,
    )
    elapsed = time.perf_counter() - t0
    on_status(f"[moss] 转写完成，耗时 {elapsed:.1f}s")

    result = parse_result(body)
    if capture_raw:
        result["_raw_response"] = body
    return result
