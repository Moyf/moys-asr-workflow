"""腾讯云录音文件识别 API 适配器。"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
from pathlib import Path
from typing import Final

import requests


SERVICE: Final = "asr"
HOST: Final = "asr.tencentcloudapi.com"
ENDPOINT: Final = f"https://{HOST}"
API_VERSION: Final = "2019-06-14"
DEFAULT_ENGINE: Final = "16k_zh_en_2.0"
DEFAULT_REGION: Final = "ap-guangzhou"
MAX_INLINE_BYTES: Final = 5 * 1024 * 1024
SUCCESS_STATUS: Final = 2
FAILURE_STATUS: Final = 3


def _load_env_file() -> dict[str, str]:
    path = Path(__file__).resolve().parents[1] / ".env"
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip()
    return values


def load_config() -> dict[str, str | int]:
    """Load Tencent credentials and recording-recognition options."""
    file_values = _load_env_file()

    def pick(key: str, default: str = "") -> str:
        return os.getenv(key) or file_values.get(key, default)

    return {
        "secret_id": pick("TENCENT_SECRET_ID"),
        "secret_key": pick("TENCENT_SECRET_KEY"),
        "app_id": pick("TENCENT_APP_ID"),
        "region": pick("TENCENT_REGION", DEFAULT_REGION),
        "engine": pick("TENCENT_ASR_ENGINE", DEFAULT_ENGINE),
        "poll_interval": int(pick("TENCENT_POLL_INTERVAL", "3") or "3"),
        "poll_timeout": int(pick("TENCENT_POLL_TIMEOUT", "1800") or "1800"),
    }


def _sha256(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def build_tc3_headers(
    payload: str,
    *,
    action: str,
    secret_id: str,
    secret_key: str,
    region: str,
    timestamp: int,
) -> dict[str, str]:
    """Build Tencent Cloud API 3.0 TC3-HMAC-SHA256 headers."""
    date = time.strftime("%Y-%m-%d", time.gmtime(timestamp))
    canonical_headers = f"content-type:application/json; charset=utf-8\nhost:{HOST}\n"
    signed_headers = "content-type;host"
    canonical_request = "\n".join(("POST", "/", "", canonical_headers, signed_headers, _sha256(payload)))
    credential_scope = f"{date}/{SERVICE}/tc3_request"
    string_to_sign = "\n".join(("TC3-HMAC-SHA256", str(timestamp), credential_scope, _sha256(canonical_request)))
    secret_date = hmac.new(f"TC3{secret_key}".encode(), date.encode(), hashlib.sha256).digest()
    secret_service = hmac.new(secret_date, SERVICE.encode(), hashlib.sha256).digest()
    secret_signing = hmac.new(secret_service, b"tc3_request", hashlib.sha256).digest()
    signature = hmac.new(secret_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
    return {
        "Content-Type": "application/json; charset=utf-8",
        "Host": HOST,
        "X-TC-Action": action,
        "X-TC-Version": API_VERSION,
        "X-TC-Region": region,
        "X-TC-Timestamp": str(timestamp),
        "Authorization": (
            f"TC3-HMAC-SHA256 Credential={secret_id}/{credential_scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }


def _request(action: str, payload: dict[str, object], config: dict[str, str | int]) -> dict[str, object]:
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    headers = build_tc3_headers(
        body,
        action=action,
        secret_id=str(config["secret_id"]),
        secret_key=str(config["secret_key"]),
        region=str(config["region"]),
        timestamp=int(time.time()),
    )
    response = requests.post(ENDPOINT, headers=headers, data=body, timeout=30)
    response.raise_for_status()
    result = response.json()
    if not isinstance(result, dict):
        raise RuntimeError("腾讯云 API 返回了无效 JSON")
    error = result.get("Response", {}).get("Error") if isinstance(result.get("Response"), dict) else None
    if isinstance(error, dict):
        raise RuntimeError(f"腾讯云 {action} 失败 [{error.get('Code', 'UNKNOWN')}]: {error.get('Message', '')}")
    return result


def _file_payload(
    audio_path: str,
    *,
    engine: str,
    app_id: str,
    speaker_diarization: bool,
) -> dict[str, object]:
    path = Path(audio_path)
    data = path.read_bytes()
    if len(data) > MAX_INLINE_BYTES:
        raise RuntimeError("腾讯云录音文件识别的本地直传上限为 5MB；请使用 --file-url 提供 COS/公网 URL。")
    payload: dict[str, object] = {
        "EngineModelType": engine,
        "ChannelNum": 1,
        "ResTextFormat": 3,
        "SourceType": 1,
        "Data": base64.b64encode(data).decode("ascii"),
    }
    if app_id:
        payload["AppId"] = app_id
    if speaker_diarization:
        payload["SpeakerDiarization"] = 1
    return payload


def submit_task(
    audio_path: str,
    config: dict[str, str | int],
    file_url: str | None = None,
    *,
    speaker_diarization: bool = False,
) -> int:
    """Submit a URL or small local audio file and return TaskId."""
    if file_url:
        payload: dict[str, object] = {
            "EngineModelType": str(config["engine"]),
            "ChannelNum": 1,
            "ResTextFormat": 3,
            "SourceType": 0,
            "Url": file_url,
        }
        if config["app_id"]:
            payload["AppId"] = str(config["app_id"])
        if speaker_diarization:
            payload["SpeakerDiarization"] = 1
    else:
        payload = _file_payload(
            audio_path,
            engine=str(config["engine"]),
            app_id=str(config["app_id"]),
            speaker_diarization=speaker_diarization,
        )
    response = _request("CreateRecTask", payload, config)
    envelope = response.get("Response")
    data = envelope.get("Data") if isinstance(envelope, dict) else None
    task_id = data.get("TaskId") if isinstance(data, dict) else None
    if not isinstance(task_id, int):
        raise RuntimeError(f"腾讯云未返回 TaskId: {response}")
    return task_id


def poll_task(task_id: int, config: dict[str, str | int], on_status=print) -> dict[str, object]:
    """Poll DescribeTaskStatus until the recording task completes."""
    deadline = time.monotonic() + int(config["poll_timeout"])
    while time.monotonic() < deadline:
        response = _request("DescribeTaskStatus", {"TaskId": task_id}, config)
        envelope = response.get("Response", {})
        if not isinstance(envelope, dict):
            raise RuntimeError("腾讯云任务状态响应无效")
        result = envelope.get("Data", {})
        if not isinstance(result, dict):
            raise RuntimeError("腾讯云任务状态响应缺少 Data")
        status = int(result.get("Status", -1))
        on_status(f"[tencent] 任务状态: {result.get('StatusStr', status)}")
        if status == SUCCESS_STATUS:
            return result
        if status == FAILURE_STATUS:
            raise RuntimeError(f"腾讯云任务失败: {result.get('ErrorMsg', '未知错误')}")
        time.sleep(max(1, int(config["poll_interval"])))
    raise TimeoutError(f"腾讯云 ASR 任务超时，task_id={task_id}")


def _detail_items(detail: dict[str, object]) -> list[dict[str, object]]:
    words = detail.get("Words")
    if not isinstance(words, list):
        return []
    return [
        {
            "text": str(word.get("Word", "")),
            "start": int(word.get("OffsetStartMs", 0)),
            "end": int(word.get("OffsetEndMs", 0)),
            **({"speaker": str(detail["SpeakerId"])} if detail.get("SpeakerId") is not None else {}),
        }
        for word in words
        if isinstance(word, dict) and word.get("Word")
    ]


def parse_result(response: dict[str, object]) -> dict[str, object]:
    """Normalize Tencent ResultDetail into MAW items and sentence groups."""
    raw_details = response.get("ResultDetail", [])
    if isinstance(raw_details, str):
        raw_details = json.loads(raw_details)
    details = raw_details if isinstance(raw_details, list) else []
    sentences: list[dict[str, object]] = []
    items: list[dict[str, object]] = []
    for detail in details:
        if not isinstance(detail, dict):
            continue
        sentence_items = _detail_items(detail)
        start = int(detail.get("StartMs", sentence_items[0]["start"] if sentence_items else 0))
        end = int(detail.get("EndMs", sentence_items[-1]["end"] if sentence_items else start))
        sentence: dict[str, object] = {
            "text": str(detail.get("FinalSentence") or detail.get("SliceSentence") or ""),
            "start": start,
            "end": end,
            "items": sentence_items,
        }
        if detail.get("SpeakerId") is not None:
            sentence["speaker"] = str(detail["SpeakerId"])
        sentences.append(sentence)
        items.extend(sentence_items)
    text = "".join(str(sentence["text"]) for sentence in sentences)
    return {"text": text, "language": "", "items": items, "sentences": sentences}


def transcribe(
    audio_path: str,
    config: dict[str, str | int],
    file_url: str | None = None,
    *,
    speaker_diarization: bool = False,
    on_status=print,
) -> dict[str, object]:
    """Submit, poll, and normalize one Tencent recording-recognition task."""
    task_id = submit_task(
        audio_path,
        config,
        file_url,
        speaker_diarization=speaker_diarization,
    )
    on_status(f"[tencent] 任务已提交: task_id={task_id}")
    result = poll_task(task_id, config, on_status=on_status)
    normalized = parse_result(result)
    normalized["_raw_response"] = result
    return normalized
