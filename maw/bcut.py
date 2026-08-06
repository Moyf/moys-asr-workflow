# pyright: reportAny=false, reportAttributeAccessIssue=false, reportMissingParameterType=false, reportMissingTypeArgument=false, reportMissingTypeStubs=false, reportReturnType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedVariable=false, reportImplicitStringConcatenation=false, reportArgumentType=false, reportIndexIssue=false

"""必剪 ASR 供应商（非官方免费接口，实验性）：REST 客户端 + 结果 → MAW 工程映射。

风险说明（务必保留在文档与 GUI 标注中）：
- 这是 B 站必剪产品的内部接口，未公开、未授权第三方使用，可能随时变更或失效；
- 无官方配额文档，高频调用可能触发限流甚至 IP 封禁，本模块因此强制下限管理；
- 仅适合中文为主的轻量转写；无语言参数、无说话人分离、无热词。

接口契约（2026-08 依据 SocialSisterYi/bcut-asr 与社区脚本核验）：
- POST /x/bcut/rubick-interface/resource/create           申请上传（JSON，含 ResourceFileType）
- PUT  <upload_urls[i]>                                    分片上传（预签名 URL，顺序上传）
- POST /x/bcut/rubick-interface/resource/create/complete  提交分片，返回 download_url
- POST /x/bcut/rubick-interface/task                      创建转写任务
- GET  /x/bcut/rubick-interface/task/result               轮询（model_id=7 & task_id）

业务错误走 HTTP 200 + body.code != 0；任务状态 state: 0=排队 1=识别中 3=失败 4=完成。
完成后 data.result 是 JSON 字符串：utterances[] = {transcript, start_time, end_time,
words[] = {label, start_time, end_time}}（整数毫秒，逐字）；识别中 result 字段可能
整个缺失（上游 issue #18），解析必须宽容。

model_id 分歧备注：社区脚本 ASRTool.py 在上传/建任务时用 "8"、查询用 7；
上游 bcut-asr 全程用 7。两种写法目前都被服务端接受，本模块跟随 ASRTool
（上传/建任务 MODEL_ID_CREATE="8"，查询 MODEL_ID_QUERY=7），失效时优先改这两个常量。

上限管理（非官方接口的自我保护，不要被绕过）：
- 单文件时长上限默认 2 小时（BCUT_MAX_AUDIO_SECONDS 可调，但不建议上调）；
- 轮询间隔下限 MIN_POLL_INTERVAL 秒（默认 3 秒），配置再低也会被抬回下限；
- 上传/建任务最多重试 MAX_TRIES 次，指数退避；分片严格顺序上传，不并发；
- 轮询容忍连续 MAX_CONSECUTIVE_NETWORK_ERRORS 次网络错误后才放弃。
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import requests
from requests.exceptions import RequestException

from generate_subtitle_qwen_api import (
    WESTERN_MAX_WORDS,
    WESTERN_MIN_WORDS,
    is_cjk_dominant,
    split_segments_auto,
)

BASE_URL = "https://member.bilibili.com/x/bcut/rubick-interface"
URL_UPLOAD = f"{BASE_URL}/resource/create"
URL_COMMIT = f"{BASE_URL}/resource/create/complete"
URL_TASK = f"{BASE_URL}/task"
URL_RESULT = f"{BASE_URL}/task/result"

# 见模块 docstring 的 model_id 分歧备注
MODEL_ID_CREATE = "8"
MODEL_ID_QUERY = 7

# 浏览器 UA：纯接口 UA 曾触发 412 Precondition Failed（上游 issue #12）
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
    ),
    "Content-Type": "application/json",
}

# 必剪接口直接支持的音频格式；其他格式由 CLI 先用 ffmpeg 转 wav
SUPPORTED_AUDIO_EXTS = frozenset({".flac", ".aac", ".m4a", ".mp3", ".wav"})

# ===== 上限管理常量 =====
DEFAULT_MAX_AUDIO_SECONDS = 2 * 60 * 60  # 非官方接口无文档，保守上限 2 小时
DEFAULT_POLL_INTERVAL = 3
MIN_POLL_INTERVAL = 2      # 轮询间隔硬下限（秒），防止高频打挂免费接口
DEFAULT_POLL_TIMEOUT = 1800
MAX_TRIES = 3              # 上传/建任务重试次数
MAX_CONSECUTIVE_NETWORK_ERRORS = 5

ENV_FILE = Path(__file__).resolve().parent.parent / ".env"

# 任务状态（上游 ResultStateEnum）
STATE_QUEUED = 0
STATE_RUNNING = 1
STATE_ERROR = 3
STATE_COMPLETE = 4


class BcutApiError(RuntimeError):
    """必剪接口返回业务错误（HTTP 200 但 code != 0）或 HTTP 层错误。"""


class TranscriptionFailedError(RuntimeError):
    """任务进入终态失败（state=3），remark 含服务端原因。"""


# ===== 配置（.env，与 Qwen/Soniox 同样的零依赖解析） =====

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
    """合并 .env 与系统环境变量（系统环境变量优先）。必剪无需 API Key。"""
    env = _load_env_file()

    def pick(key: str, default: str = "") -> str:
        return os.getenv(key) or env.get(key, default)

    def pick_int(key: str, default: int) -> int:
        try:
            return int(pick(key, str(default)) or str(default))
        except ValueError:
            return default

    return {
        # 轮询间隔抬到下限之上：非官方接口，高频轮询是最可能的封禁诱因
        "poll_interval": max(
            MIN_POLL_INTERVAL,
            pick_int("BCUT_POLL_INTERVAL", DEFAULT_POLL_INTERVAL),
        ),
        "poll_timeout": pick_int("BCUT_POLL_TIMEOUT", DEFAULT_POLL_TIMEOUT),
        "max_audio_seconds": pick_int("BCUT_MAX_AUDIO_SECONDS", DEFAULT_MAX_AUDIO_SECONDS),
    }


# ===== REST 客户端 =====

def _parse_body(resp: requests.Response, action: str) -> dict:
    """统一处理 HTTP 层错误与业务 code != 0，返回 data 字段。"""
    if resp.status_code == 412:
        raise BcutApiError(
            f"必剪{action}被拒绝 (HTTP 412)：接口可能已变更或触发风控。"
            "非官方接口不稳定，请稍后再试或改用其他供应商。"
        )
    if not resp.ok:
        raise BcutApiError(f"必剪{action}失败 (HTTP {resp.status_code}): {resp.text[:300]}")
    try:
        body = resp.json()
    except ValueError as exc:
        raise BcutApiError(f"必剪{action}返回了非 JSON 内容（接口可能已变更）") from exc
    if not isinstance(body, dict):
        raise BcutApiError(f"必剪{action}返回结构异常（接口可能已变更）: {str(body)[:200]}")
    code = body.get("code", 0)
    if code:
        raise BcutApiError(f"必剪{action}返回错误 [code={code}]: {body.get('message', '')}")
    data = body.get("data")
    if not isinstance(data, dict):
        raise BcutApiError(f"必剪{action}缺少 data 字段（接口可能已变更）: {str(body)[:200]}")
    return data


def request_upload(file_path: str, on_status=print) -> dict:
    """申请分片上传，返回 {in_boss_key, resource_id, upload_id, upload_urls, per_size}。"""
    path = Path(file_path)
    size = path.stat().st_size
    fmt = path.suffix.lower().lstrip(".")
    payload = {
        "type": 2,
        "name": path.name,
        "size": size,
        "ResourceFileType": fmt,
        "model_id": MODEL_ID_CREATE,
    }
    resp = requests.post(URL_UPLOAD, json=payload, headers=HEADERS, timeout=30)
    data = _parse_body(resp, "申请上传")
    upload_urls = data.get("upload_urls") or []
    if not upload_urls or not data.get("per_size"):
        raise BcutApiError(f"必剪申请上传响应缺少分片信息（接口可能已变更）: {str(data)[:300]}")
    on_status(f"[bcut] 申请上传成功: {size / 1024:.0f}KB, {len(upload_urls)} 分片")
    return {
        "in_boss_key": data.get("in_boss_key"),
        "resource_id": data.get("resource_id"),
        "upload_id": data.get("upload_id"),
        "upload_urls": upload_urls,
        "per_size": int(data["per_size"]),
    }


def upload_parts(upload: dict, file_path: str, on_status=print) -> list[str]:
    """顺序上传所有分片（不并发，降低触发限流的概率），返回 etags。"""
    binary = Path(file_path).read_bytes()
    per_size = upload["per_size"]
    etags: list[str] = []
    total = len(upload["upload_urls"])
    for clip, url in enumerate(upload["upload_urls"]):
        chunk = binary[clip * per_size:(clip + 1) * per_size]
        resp = requests.put(url, data=chunk, timeout=300)
        if not resp.ok:
            raise BcutApiError(f"必剪分片 {clip} 上传失败 (HTTP {resp.status_code})")
        etags.append(resp.headers.get("Etag") or "")
        if total > 1:
            on_status(f"[bcut] 分片 {clip + 1}/{total} 上传完成")
    return etags


def commit_upload(upload: dict, etags: list[str]) -> str:
    """提交分片，返回可用于建任务的 download_url。"""
    payload = {
        "InBossKey": upload["in_boss_key"],
        "ResourceId": upload["resource_id"],
        "Etags": ",".join(etags),
        "UploadId": upload["upload_id"],
        "model_id": MODEL_ID_CREATE,
    }
    resp = requests.post(URL_COMMIT, json=payload, headers=HEADERS, timeout=30)
    data = _parse_body(resp, "提交上传")
    download_url = data.get("download_url")
    if not download_url:
        raise BcutApiError(f"必剪提交上传响应缺少 download_url（接口可能已变更）: {str(data)[:300]}")
    return download_url


def create_task(download_url: str, on_status=print) -> str:
    """创建转写任务，返回 task_id。"""
    resp = requests.post(
        URL_TASK,
        json={"resource": download_url, "model_id": MODEL_ID_CREATE},
        headers=HEADERS,
        timeout=30,
    )
    data = _parse_body(resp, "创建任务")
    task_id = data.get("task_id")
    if not task_id:
        raise BcutApiError(f"必剪创建任务响应缺少 task_id（接口可能已变更）: {str(data)[:300]}")
    on_status(f"[bcut] 任务已创建: {task_id}")
    return task_id


def poll_task(task_id: str, *, interval: int, timeout: int, on_status=print) -> str:
    """轮询任务直到完成，返回 result 原始 JSON 字符串。

    临时网络错误重试，连续 MAX_CONSECUTIVE_NETWORK_ERRORS 次失败才放弃；
    interval 会被抬到 MIN_POLL_INTERVAL 以上（上限管理）。
    """
    interval = max(MIN_POLL_INTERVAL, interval)
    deadline = time.time() + timeout
    last_state = None
    network_errors = 0

    while time.time() < deadline:
        try:
            resp = requests.get(
                URL_RESULT,
                params={"model_id": MODEL_ID_QUERY, "task_id": task_id},
                headers=HEADERS,
                timeout=30,
            )
            data = _parse_body(resp, "查询任务")
        except RequestException as e:
            network_errors += 1
            if network_errors >= MAX_CONSECUTIVE_NETWORK_ERRORS:
                raise RuntimeError(
                    f"必剪轮询连续 {network_errors} 次网络失败，放弃等待: {e}"
                ) from e
            on_status(f"[bcut] [警告] 轮询网络错误（第 {network_errors}/"
                      f"{MAX_CONSECUTIVE_NETWORK_ERRORS} 次），{interval}s 后重试: {e}")
            time.sleep(interval)
            continue

        network_errors = 0
        state = data.get("state")
        if state != last_state:
            remark = str(data.get("remark") or "")
            label = {
                STATE_QUEUED: "排队中",
                STATE_RUNNING: "识别中",
                STATE_ERROR: "失败",
                STATE_COMPLETE: "完成",
            }.get(state, f"未知状态({state})")
            on_status(f"[bcut] 任务状态: {label}{f' - {remark}' if remark else ''}")
            last_state = state

        if state == STATE_COMPLETE:
            raw = data.get("result")  # 识别中该字段可能缺失（上游 issue #18）
            if not raw:
                raise BcutApiError(f"必剪任务完成但缺少 result 字段: {str(data)[:300]}")
            return raw
        if state == STATE_ERROR:
            raise TranscriptionFailedError(
                f"必剪转写失败: {data.get('remark') or '服务端未返回原因'}"
            )
        if state not in (STATE_QUEUED, STATE_RUNNING):
            raise RuntimeError(f"必剪返回未知任务状态: {str(data)[:300]}")

        time.sleep(interval)

    raise TimeoutError(f"必剪转写超时（{timeout}秒），task_id={task_id}")


# ===== 结果 → MAW 工程映射 =====

def utterances_to_items(utterances: list) -> list[dict]:
    """必剪 utterances → MAW items（整数毫秒）。

    优先使用逐字 words[]（label/start_time/end_time）；某句缺 words 时
    回退为句级单 item（该句内拆分精度会下降，但时间仍正确）。
    防御性兜底：缺时间戳或时间倒挂时作为零宽 item 放在前一个 item 的末尾。
    """
    items: list[dict] = []
    previous_end = 0
    for utterance in utterances:
        if not isinstance(utterance, dict):
            continue
        words = utterance.get("words") or []
        word_items: list[dict] = []
        for word in words:
            if not isinstance(word, dict):
                continue
            label = str(word.get("label") or "")
            if not label:
                continue
            start, end = word.get("start_time"), word.get("end_time")
            if not (type(start) is int and type(end) is int) or end < start:
                start = end = previous_end
            word_items.append({"text": label, "start": start, "end": end})
            previous_end = max(previous_end, end)
        if word_items:
            items.extend(word_items)
            continue

        transcript = str(utterance.get("transcript") or "")
        if not transcript:
            continue
        start, end = utterance.get("start_time"), utterance.get("end_time")
        if not (type(start) is int and type(end) is int) or end < start:
            start = end = previous_end
        items.append({"text": transcript, "start": start, "end": end})
        previous_end = max(previous_end, end)
    return items


def parse_result_payload(raw: str) -> dict:
    """把必剪 result JSON 字符串转成本地 transcribe() 输出格式。

    返回 {"text", "language", "items"}；language 按 items 的 CJK 占比推断
    （接口本身不返回语种，必剪模型面向中文）。
    """
    try:
        payload = json.loads(raw)
    except ValueError as exc:
        raise BcutApiError("必剪 result 不是合法 JSON（接口可能已变更）") from exc
    if not isinstance(payload, dict):
        raise BcutApiError(f"必剪 result 结构异常（接口可能已变更）: {raw[:200]}")
    utterances = payload.get("utterances") or []
    items = utterances_to_items(utterances)
    text = "".join(
        str(u.get("transcript") or "") for u in utterances if isinstance(u, dict)
    )
    if not text:
        text = "".join(it["text"] for it in items)
    return {
        "text": text,
        "language": "zh" if is_cjk_dominant(items) else "",
        "items": items,
    }


def build_segments(items: list[dict], *, max_len: int, min_len: int,
                   gap_split_ms: int,
                   max_words: int = WESTERN_MAX_WORDS,
                   min_words: int = WESTERN_MIN_WORDS) -> list[dict]:
    """无说话人信息，直接按静音组自动选择 CJK/英文逻辑切句。"""
    return split_segments_auto(
        items, max_len=max_len, min_len=min_len, gap_split_ms=gap_split_ms,
        max_words=max_words, min_words=min_words,
    )


# ===== 顶层转写入口 =====

def transcribe(audio_path: str, config: dict, *, on_status=print) -> dict:
    """完整生命周期：申请上传 → 分片上传 → 提交 → 建任务 → 轮询 → 解析。

    上传/建任务最多重试 MAX_TRIES 次（指数退避）；轮询内部自带网络容错。
    返回 {"text", "language", "items"}，可直接交给 build_segments() 切句。
    """
    path = Path(audio_path)
    fmt = path.suffix.lower()
    if fmt not in SUPPORTED_AUDIO_EXTS:
        raise RuntimeError(
            f"必剪接口仅支持 {'/'.join(sorted(SUPPORTED_AUDIO_EXTS))} 格式，"
            f"当前文件为 {fmt or '未知'}；请先用 ffmpeg 转码（CLI 入口会自动处理）"
        )

    last_error: Exception | None = None
    task_id = ""
    for attempt in range(1, MAX_TRIES + 1):
        try:
            upload = request_upload(str(path), on_status=on_status)
            etags = upload_parts(upload, str(path), on_status=on_status)
            download_url = commit_upload(upload, etags)
            task_id = create_task(download_url, on_status=on_status)
            break
        except (BcutApiError, RequestException, RuntimeError) as exc:
            last_error = exc
            if attempt < MAX_TRIES:
                wait = 2 ** attempt
                on_status(f"[bcut] [警告] 第 {attempt}/{MAX_TRIES} 次尝试失败: {exc}；"
                          f"{wait}s 后重试")
                time.sleep(wait)
    else:
        raise RuntimeError(
            f"必剪上传/建任务连续 {MAX_TRIES} 次失败，已放弃: {last_error}"
        ) from last_error

    t0 = time.perf_counter()
    raw = poll_task(
        task_id,
        interval=config["poll_interval"],
        timeout=config["poll_timeout"],
        on_status=on_status,
    )
    elapsed = time.perf_counter() - t0
    result = parse_result_payload(raw)
    on_status(f"[bcut] 转写完成，耗时 {elapsed:.1f}s | items={len(result['items'])}")
    return result
