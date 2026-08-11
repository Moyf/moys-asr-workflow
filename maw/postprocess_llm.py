# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownVariableType=false, reportReturnType=false

"""OpenAI-compatible client settings and structured subtitle completion."""

from __future__ import annotations

import ipaddress
import json
import re
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlparse

import requests
from requests.exceptions import JSONDecodeError, RequestException

from maw.project_preview import JsonValue


@dataclass(frozen=True, slots=True)
class LlmProviderPreset:
    id: str
    label: str
    base_url: str
    model: str
    env_prefix: str


@dataclass(frozen=True, slots=True)
class LlmSettings:
    provider_id: str
    api_key: str
    base_url: str
    model: str


@dataclass(frozen=True, slots=True)
class LlmClientError(RuntimeError):
    message: str

    def __str__(self) -> str:
        return self.message


PRESETS: Final[tuple[LlmProviderPreset, ...]] = (
    LlmProviderPreset(
        id="deepseek",
        label="DeepSeek",
        base_url="https://api.deepseek.com",
        model="deepseek-v4-flash",
        env_prefix="MAW_POSTPROCESS_DEEPSEEK",
    ),
    LlmProviderPreset(
        id="zhipu",
        label="智谱 Coding Plan",
        base_url="https://open.bigmodel.cn/api/coding/paas/v4",
        model="glm-5.2",
        env_prefix="MAW_POSTPROCESS_ZHIPU",
    ),
    LlmProviderPreset(
        id="qwen",
        label="阿里云 Qwen",
        base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
        model="qwen-plus",
        env_prefix="MAW_POSTPROCESS_QWEN",
    ),
    LlmProviderPreset(
        id="custom",
        label="Custom (OpenAI-compatible)",
        base_url="",
        model="",
        env_prefix="MAW_POSTPROCESS_CUSTOM",
    ),
)


def preset_by_id(provider_id: str) -> LlmProviderPreset:
    return next((preset for preset in PRESETS if preset.id == provider_id), PRESETS[0])


def complete_subtitle_groups(
    settings: LlmSettings,
    system_prompt: str,
    cues: list[dict[str, str]],
) -> dict[str, JsonValue]:
    """Call one OpenAI-compatible chat endpoint and return its JSON object."""
    endpoint = _chat_endpoint(settings.base_url)
    payload = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(cues, ensure_ascii=False)},
        ],
        "response_format": {"type": "json_object"},
        "temperature": 0.1,
    }
    try:
        with requests.Session() as session:
            response = session.post(
                endpoint,
                headers={"Authorization": f"Bearer {settings.api_key}"},
                json=payload,
                timeout=(10, 180),
            )
            response.raise_for_status()
            body = response.json()
    except (RequestException, JSONDecodeError) as error:
        raise LlmClientError(f"LLM request failed: {error}") from error
    content = _response_content(body)
    try:
        parsed = json.loads(_strip_json_fence(content))
    except json.JSONDecodeError as error:
        raise LlmClientError(f"LLM returned invalid JSON: {error}") from error
    if not isinstance(parsed, dict):
        raise LlmClientError("LLM response content must be a JSON object")
    return parsed


def test_llm_connection(settings: LlmSettings) -> None:
    """Send a minimal chat request to verify the current LLM settings."""
    endpoint = _chat_endpoint(settings.base_url)
    payload = {
        "model": settings.model,
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "max_tokens": 1,
    }
    try:
        with requests.Session() as session:
            response = session.post(
                endpoint,
                headers={"Authorization": f"Bearer {settings.api_key}"},
                json=payload,
                timeout=(10, 30),
            )
            response.raise_for_status()
    except RequestException as error:
        raise LlmClientError(f"LLM connection test failed: {error}") from error


def _chat_endpoint(base_url: str) -> str:
    value = base_url.strip().rstrip("/")
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise LlmClientError("LLM API URL must be an absolute HTTP(S) URL")
    if parsed.scheme == "http" and not _is_loopback_host(parsed.hostname):
        raise LlmClientError("plain HTTP LLM API URLs are allowed only for loopback hosts")
    if value.endswith("/chat/completions"):
        return value
    return f"{value}/chat/completions"


def _is_loopback_host(host: str | None) -> bool:
    if not host:
        return False
    normalized = host.rstrip(".").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


def _response_content(body: JsonValue) -> str:
    if not isinstance(body, dict):
        raise LlmClientError("LLM response must be a JSON object")
    choices = body.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise LlmClientError("LLM response is missing choices[0]")
    message = choices[0].get("message")
    if not isinstance(message, dict):
        raise LlmClientError("LLM response is missing message content")
    content = message.get("content")
    if not isinstance(content, str):
        raise LlmClientError("LLM response is missing message content")
    return content


def _strip_json_fence(content: str) -> str:
    value = content.strip()
    match = re.fullmatch(r"```(?:json)?\s*(.*?)\s*```", value, re.DOTALL | re.IGNORECASE)
    return match.group(1) if match else value
