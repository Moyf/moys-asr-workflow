# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownVariableType=false, reportReturnType=false

"""OpenAI-compatible client settings and structured subtitle completion."""

from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlparse

import requests
from requests.exceptions import JSONDecodeError, RequestException

from maw.project_preview import JsonValue


DEFAULT_REASONING_MODE: Final[str] = "off"


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
    reasoning_mode: str = DEFAULT_REASONING_MODE


@dataclass(frozen=True, slots=True)
class LlmClientError(RuntimeError):
    message: str

    def __str__(self) -> str:
        return self.message


LlmDelta = Callable[[str, str], None]
REASONING_MODES: Final[frozenset[str]] = frozenset({"auto", "off", "low", "medium", "high"})
MAX_RESPONSE_ATTEMPTS: Final[int] = 2
_REASONING_ALIASES: Final[dict[str, str]] = {
    "default": DEFAULT_REASONING_MODE,
    "disabled": "off",
    "none": "off",
    "minimal": "low",
}


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
    cues: list[dict[str, JsonValue]],
    *,
    on_delta: LlmDelta | None = None,
) -> dict[str, JsonValue]:
    """Call one OpenAI-compatible chat endpoint and return its JSON object.

    When ``on_delta`` is provided, the response is consumed as an SSE stream.
    The callback receives ``("reasoning", text)`` or ``("content", text)``
    events, while the returned value is still parsed only after the complete
    JSON content has arrived.
    """
    _chat_endpoint(settings.base_url)
    last_error = "LLM response did not pass the local JSON protocol."
    for attempt in range(MAX_RESPONSE_ATTEMPTS):
        if attempt:
            if on_delta is not None:
                # The first streamed attempt may contain malformed JSON. Do
                # not let the UI append the corrected retry to that content.
                on_delta("reset", "")
            prompt = _retry_prompt(system_prompt, last_error)
        else:
            prompt = system_prompt
        body = _request_completion(settings, prompt, cues, on_delta=on_delta)
        content = _response_content(body)
        try:
            parsed = json.loads(_strip_json_fence(content))
        except json.JSONDecodeError as error:
            last_error = f"JSON syntax error: {error.msg} at character {error.pos}"
            if attempt + 1 < MAX_RESPONSE_ATTEMPTS:
                continue
            raise LlmClientError(f"LLM returned invalid JSON after retry: {error}") from error
        protocol_error = _response_protocol_error(parsed)
        if protocol_error is not None:
            last_error = protocol_error
            if attempt + 1 < MAX_RESPONSE_ATTEMPTS:
                continue
            # Keep a structurally valid object so the subtitle layer can
            # discard only malformed groups and still write compliant cues.
            if isinstance(parsed, dict):
                return parsed
            raise LlmClientError(f"LLM response violates the JSON protocol after retry: {protocol_error}")
        return parsed
    raise AssertionError("LLM response retry loop did not return or raise")


def _request_completion(
    settings: LlmSettings,
    system_prompt: str,
    cues: list[dict[str, JsonValue]],
    *,
    on_delta: LlmDelta | None,
) -> dict[str, JsonValue]:
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
    payload.update(_reasoning_parameters(settings))
    streaming = on_delta is not None
    if streaming:
        payload["stream"] = True
        if _provider_family(settings) == "qwen":
            # DashScope can otherwise repeat the full accumulated content in
            # every chunk, which is not useful for a live text area.
            payload["incremental_output"] = True
    headers = _request_headers(settings, streaming=streaming)
    try:
        with requests.Session() as session:
            response = session.post(
                endpoint,
                headers=headers,
                json=payload,
                timeout=(10, 180),
                **({"stream": True} if streaming else {}),
            )
            response.raise_for_status()
            if streaming:
                try:
                    body = _read_stream_response(response, on_delta)
                finally:
                    response.close()
            else:
                body = response.json()
    except (RequestException, JSONDecodeError) as error:
        raise LlmClientError(f"LLM request failed: {error}") from error
    if not isinstance(body, dict):
        raise LlmClientError("LLM response must be a JSON object")
    return body


def _retry_prompt(system_prompt: str, reason: str) -> str:
    return (
        f"{system_prompt}\n\n"
        f"上一次输出未通过本地协议校验（{reason}）。请重新处理同一批输入并完整返回结果。"
        "只输出一个严格有效的 JSON 对象，不要 Markdown 代码块、注释、解释或额外文字。"
        "顶层必须是 groups 数组；普通字幕 group 必须包含 source_ids 数组和非空 text 字符串，"
        "字词重分句 group 必须包含 atom_ids 数组且不得包含空数组。"
        "text 中的双引号、反斜杠和换行必须按 JSON 规则转义。"
    )


def _response_protocol_error(parsed: object) -> str | None:
    if not isinstance(parsed, dict):
        return "LLM response content must be a JSON object"
    groups = parsed.get("groups")
    if not isinstance(groups, list):
        return "LLM response must contain a groups array"
    for index, group in enumerate(groups, start=1):
        if not isinstance(group, dict):
            return f"LLM group {index} must be an object"
        raw_atom_ids = group.get("atom_ids")
        if raw_atom_ids is not None:
            if (
                not isinstance(raw_atom_ids, list)
                or not raw_atom_ids
                or not all(isinstance(value, str) and value for value in raw_atom_ids)
            ):
                return f"LLM group {index} must contain atom_ids"
            continue
        raw_ids = group.get("source_ids")
        if raw_ids is None and isinstance(group.get("id"), str):
            raw_ids = [group["id"]]
        if not isinstance(raw_ids, list) or not raw_ids or not all(isinstance(value, str) and value for value in raw_ids):
            return f"LLM group {index} must contain source_ids"
        text = group.get("text")
        if not isinstance(text, str) or not text.strip():
            return f"LLM group {index} must contain non-empty text"
    return None


def test_llm_connection(settings: LlmSettings) -> None:
    """Send a minimal chat request to verify the current LLM settings."""
    endpoint = _chat_endpoint(settings.base_url)
    payload = {
        "model": settings.model,
        "messages": [{"role": "user", "content": "Reply with OK."}],
        "max_tokens": 1,
    }
    payload.update(_reasoning_parameters(settings))
    try:
        with requests.Session() as session:
            response = session.post(
                endpoint,
                headers=_request_headers(settings, streaming=False),
                json=payload,
                timeout=(10, 30),
            )
            response.raise_for_status()
    except RequestException as error:
        raise LlmClientError(f"LLM connection test failed: {error}") from error


def list_llm_models(settings: LlmSettings) -> list[str]:
    """Fetch model IDs from an OpenAI-compatible ``/models`` endpoint."""
    endpoint = _models_endpoint(settings.base_url)
    try:
        with requests.Session() as session:
            response = session.get(
                endpoint,
                headers=_request_headers(settings, streaming=False),
                timeout=(10, 30),
            )
            response.raise_for_status()
            body = response.json()
    except (RequestException, JSONDecodeError) as error:
        raise LlmClientError(f"LLM model list request failed: {error}") from error

    if not isinstance(body, dict):
        raise LlmClientError("LLM model list must be a JSON object")
    entries = body.get("data")
    if not isinstance(entries, list):
        entries = body.get("models")
    if not isinstance(entries, list):
        raise LlmClientError("LLM model list is missing data")

    models: list[str] = []
    seen: set[str] = set()
    for entry in entries:
        model_id = ""
        if isinstance(entry, str):
            model_id = entry.strip()
        elif isinstance(entry, dict):
            for key in ("id", "model", "name"):
                candidate = entry.get(key)
                if isinstance(candidate, str) and candidate.strip():
                    model_id = candidate.strip()
                    break
        if model_id and model_id not in seen:
            seen.add(model_id)
            models.append(model_id)
    if not models:
        raise LlmClientError("LLM model list is empty")
    return models[:200]


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


def _models_endpoint(base_url: str) -> str:
    return _chat_endpoint(base_url).removesuffix("/chat/completions") + "/models"


def normalize_reasoning_mode(value: object) -> str:
    """Return the stable UI value used by provider adapters."""
    mode = str(value or DEFAULT_REASONING_MODE).strip().lower()
    mode = _REASONING_ALIASES.get(mode, mode)
    if mode not in REASONING_MODES:
        allowed = ", ".join(sorted(REASONING_MODES))
        raise ValueError(f"reasoning mode must be one of: {allowed}")
    return mode


def _provider_family(settings: LlmSettings) -> str:
    provider = settings.provider_id.strip().lower()
    if provider != "custom":
        return provider
    url = settings.base_url.lower()
    if "dashscope.aliyuncs.com" in url or "maas.aliyuncs.com" in url:
        return "qwen"
    if "deepseek.com" in url:
        return "deepseek"
    if "bigmodel.cn" in url or "zhipuai.cn" in url:
        return "zhipu"
    return "custom"


def _reasoning_parameters(settings: LlmSettings) -> dict[str, JsonValue]:
    mode = normalize_reasoning_mode(settings.reasoning_mode)
    if mode == "auto":
        return {}

    family = _provider_family(settings)
    model = settings.model.strip().lower()
    if family == "qwen":
        if mode == "off":
            return {"enable_thinking": False}
        result: dict[str, JsonValue] = {"enable_thinking": True}
        if "qwen3.8" in model:
            result["reasoning_effort"] = "xhigh" if mode == "high" else mode
        elif "qwen3" in model or "qwq" in model or "qvq" in model:
            budgets = {"low": 4096, "medium": 16384}
            if mode in budgets:
                result["thinking_budget"] = budgets[mode]
        return result

    if family == "deepseek":
        result = {"thinking": {"type": "disabled" if mode == "off" else "enabled"}}
        if mode != "off" and "v4" in model:
            # Current DeepSeek V4 endpoints expose high/max rather than the
            # full five-level scale. Keep low/medium conservative and stable.
            result["reasoning_effort"] = "high"
        return result

    if family == "zhipu":
        result = {"thinking": {"type": "disabled" if mode == "off" else "enabled"}}
        if mode != "off" and "glm-5.2" in model:
            result["reasoning_effort"] = mode
        return result

    # Custom OpenAI-compatible endpoints have no reliable capability
    # discovery. Leaving the parameter out is the safest way to keep the new
    # default compatible; explicit enabled choices use the common parameter.
    return {} if mode == "off" else {"reasoning_effort": mode}


def _request_headers(settings: LlmSettings, *, streaming: bool) -> dict[str, str]:
    headers = {"Authorization": f"Bearer {settings.api_key}"}
    if streaming and _provider_family(settings) == "qwen":
        headers["X-DashScope-SSE"] = "enable"
    return headers


def _read_stream_response(response: requests.Response, on_delta: LlmDelta | None) -> dict[str, JsonValue]:
    if on_delta is None:
        raise AssertionError("stream callback is required for an SSE response")
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    for data in _iter_sse_data(response.iter_lines(decode_unicode=True)):
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError as error:
            raise LlmClientError(f"LLM stream returned invalid JSON: {error}") from error
        if not isinstance(chunk, dict):
            continue
        error = chunk.get("error")
        if isinstance(error, dict):
            message = error.get("message") or error.get("code") or "LLM stream failed"
            raise LlmClientError(str(message))
        choice = _first_stream_choice(chunk)
        if choice is None:
            continue
        delta = choice.get("delta") or choice.get("message")
        if not isinstance(delta, dict):
            continue
        reasoning = _stream_text(delta.get("reasoning_content")) or _stream_text(delta.get("reasoning"))
        content = _stream_text(delta.get("content"))
        if reasoning:
            reasoning_parts.append(reasoning)
            on_delta("reasoning", reasoning)
        if content:
            content_parts.append(content)
            on_delta("content", content)
    return {
        "choices": [
            {
                "message": {
                    "content": "".join(content_parts),
                    "reasoning_content": "".join(reasoning_parts),
                }
            }
        ]
    }


def _iter_sse_data(lines: Iterable[str | bytes]) -> Iterable[str]:
    for raw_line in lines:
        line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line)
        line = line.strip()
        if not line or line.startswith(":"):
            continue
        if line.startswith("data:"):
            yield line[5:].strip()


def _first_stream_choice(chunk: dict[str, JsonValue]) -> dict[str, JsonValue] | None:
    choices = chunk.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        output = chunk.get("output")
        if isinstance(output, dict):
            choices = output.get("choices")
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        return None
    return choices[0]


def _stream_text(value: JsonValue) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        text = item.get("text")
        if isinstance(text, str):
            parts.append(text)
    return "".join(parts)


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
