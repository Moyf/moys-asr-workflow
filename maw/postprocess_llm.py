# pyright: reportAny=false, reportImplicitOverride=false, reportUnknownVariableType=false, reportReturnType=false

"""OpenAI-compatible client settings and structured subtitle completion."""

from __future__ import annotations

import ipaddress
import json
import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from threading import Event, Lock, Thread
from typing import Final
from urllib.parse import urlparse

import requests
from requests.exceptions import HTTPError, JSONDecodeError, RequestException

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
    category: str = "client"
    status_code: int | None = None
    diagnostic: str = ""
    operation: str = ""

    def __post_init__(self) -> None:
        # LLM errors cross the GUI bridge and may be copied into logs or an
        # error report.  Keep the exception itself safe even when a caller
        # constructs one from a provider/transport exception directly.
        object.__setattr__(self, "message", _sanitize_error_text(self.message))
        object.__setattr__(self, "diagnostic", _bound_diagnostic(self.diagnostic))
        RuntimeError.__init__(self, self.message)

    def __str__(self) -> str:
        return self.message


LlmDelta = Callable[[str, str], None]
LlmResponseObserver = Callable[[object | None], None]
_CANCELLABLE_REQUEST_POLL_SECONDS: Final[float] = 0.025
REASONING_MODES: Final[frozenset[str]] = frozenset(
    {"auto", "off", "low", "medium", "high"}
)
MAX_RESPONSE_ATTEMPTS: Final[int] = 2
THINK_CLOSED_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"<think>.*?</think>", re.DOTALL | re.IGNORECASE
)
THINK_OPEN_TAG: Final[str] = "<think>"
MAX_PROVIDER_DIAGNOSTIC_CHARS: Final[int] = 240
_REASONING_ALIASES: Final[dict[str, str]] = {
    "default": DEFAULT_REASONING_MODE,
    "disabled": "off",
    "none": "off",
    "minimal": "low",
}


# Endpoints handle JSON output constraints very differently: older LM Studio
# builds reject `response_format: {"type": "json_object"}` outright (HTTP 400),
# newer ones accept only `json_schema`/`text`, and reasoning models get the
# constraint applied to their thinking stream and return empty content
# (lmstudio-bug-tracker #1773). Cached value per (endpoint, model):
# "object" = json_object accepted, "schema" = only json_schema accepted,
# "none" = no constraint works, ride on the prompt alone. Session-scoped on
# purpose: a restarted local server may have a different model loaded, so the
# next launch re-probes instead of trusting a stale verdict.
_json_constraint_support: Final[dict[tuple[str, str], str]] = {}

JSON_CONSTRAINT_OBJECT: Final[str] = "object"
JSON_CONSTRAINT_SCHEMA: Final[str] = "schema"
JSON_CONSTRAINT_NONE: Final[str] = "none"


def _constraint_cache_key(settings: LlmSettings) -> tuple[str, str]:
    return (_chat_endpoint(settings.base_url), settings.model)


def _json_constraint_mode(settings: LlmSettings) -> str:
    """Cached constraint mode; unknown endpoints start with json_object."""
    return _json_constraint_support.get(
        _constraint_cache_key(settings), JSON_CONSTRAINT_OBJECT
    )


def json_constraint_supported(settings: LlmSettings) -> bool | None:
    """True/False once probed for this endpoint this session; None = unknown."""
    mode = _json_constraint_support.get(_constraint_cache_key(settings))
    if mode is None:
        return None
    return mode != JSON_CONSTRAINT_NONE


def _record_json_constraint_mode(settings: LlmSettings, mode: str) -> None:
    _json_constraint_support[_constraint_cache_key(settings)] = mode


def _record_json_constraint_support(settings: LlmSettings, supported: bool) -> None:
    _record_json_constraint_mode(
        settings, JSON_CONSTRAINT_OBJECT if supported else JSON_CONSTRAINT_NONE
    )


def _rejection_means_drop_json_format(error: LlmClientError) -> bool:
    """True when a provider rejection means "drop response_format and retry"."""
    if error.status_code not in (400, 422):
        return False
    text = f"{error.message} {error.diagnostic}".lower()
    markers = (
        "response_format",
        "json_object",
        "json_schema",
    )
    return any(marker in text for marker in markers)


# Permissive on purpose: one schema serves the plain grouping, strict
# translation and atom resegment protocols (source_ids / id / atom_ids vary),
# while semantic coverage stays under local protocol validation. `protocol`
# is optional because only the translation protocols send it.
_SUBTITLE_GROUPS_JSON_SCHEMA: Final[dict[str, JsonValue]] = {
    "name": "maw_subtitle_groups",
    "schema": {
        "type": "object",
        "properties": {
            "protocol": {"type": "string"},
            "groups": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "source_ids": {"type": "array", "items": {"type": "string"}},
                        "atom_ids": {"type": "array", "items": {"type": "string"}},
                        "id": {"type": "string"},
                        "text": {"type": "string"},
                    },
                },
            },
        },
        "required": ["groups"],
    },
}

PRESETS: Final[tuple[LlmProviderPreset, ...]] = (
    LlmProviderPreset(
        id="deepseek",
        label="DeepSeek",
        base_url="https://api.deepseek.com",
        model="deepseek-flash",
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
        label="Custom API (or local model)",
        base_url="",
        model="",
        env_prefix="MAW_POSTPROCESS_CUSTOM",
    ),
    LlmProviderPreset(
        id="custom2",
        label="Custom API #2",
        base_url="",
        model="",
        env_prefix="MAW_POSTPROCESS_CUSTOM2",
    ),
    LlmProviderPreset(
        id="custom3",
        label="Custom API #3",
        base_url="",
        model="",
        env_prefix="MAW_POSTPROCESS_CUSTOM3",
    ),
)


def is_custom_slot(provider_id: str) -> bool:
    """custom / custom2 / custom3 共用「自定义接口（含本地）」的显示与存储行为。"""
    return provider_id in {"custom", "custom2", "custom3"}


def preset_by_id(provider_id: str) -> LlmProviderPreset:
    return next((preset for preset in PRESETS if preset.id == provider_id), PRESETS[0])


def complete_subtitle_groups(
    settings: LlmSettings,
    system_prompt: str,
    cues: list[dict[str, JsonValue]],
    *,
    on_delta: LlmDelta | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    on_response: LlmResponseObserver | None = None,
) -> dict[str, JsonValue]:
    """Call one OpenAI-compatible chat endpoint and return its JSON object.

    When ``on_delta`` is provided, the response is consumed as an SSE stream.
    The callback receives ``("reasoning", text)`` or ``("content", text)``
    events, while the returned value is still parsed only after the complete
    JSON content has arrived.

    ``response_format`` is only sent while the endpoint has not proven that it
    mishandles it (HTTP 400, or the #1773 empty-content failure); after a
    proven failure the JSON contract rides on the prompt alone.
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
        body = _request_completion(
            settings,
            prompt,
            cues,
            on_delta=on_delta,
            response_json_schema=_SUBTITLE_GROUPS_JSON_SCHEMA,
            is_cancelled=is_cancelled,
            on_response=on_response,
        )
        content = _response_content(body)
        try:
            parsed = _loads_with_trailing_repair(_strip_json_fence(content))
        except json.JSONDecodeError as error:
            last_error = f"JSON syntax error: {error.msg} at character {error.pos}"
            if attempt + 1 < MAX_RESPONSE_ATTEMPTS:
                continue
            if not content.strip():
                raise LlmClientError(
                    "模型返回了空内容，无法解析 JSON。"
                    "这通常是推理模型（Qwen3、DeepSeek-R1 蒸馏等）与 JSON 输出约束冲突的已知问题"
                    "（LM Studio #1773）：请更换非推理模型，或在本地服务端关闭该模型的思考模式。"
                    "已尝试过无约束重试。"
                ) from error
            raise LlmClientError(
                f"LLM returned invalid JSON after retry: {error}"
            ) from error
        protocol_error = _response_protocol_error(parsed)
        if protocol_error is not None:
            last_error = protocol_error
            if attempt + 1 < MAX_RESPONSE_ATTEMPTS:
                continue
            # Keep a structurally valid object so the subtitle layer can
            # discard only malformed groups and still write compliant cues.
            if isinstance(parsed, dict):
                return parsed
            raise LlmClientError(
                f"LLM response violates the JSON protocol after retry: {protocol_error}"
            )
        return parsed
    raise AssertionError("LLM response retry loop did not return or raise")


def _request_completion(
    settings: LlmSettings,
    system_prompt: str,
    cues: list[dict[str, JsonValue]],
    *,
    on_delta: LlmDelta | None,
    use_json_format: bool | None = None,
    response_json_schema: Mapping[str, JsonValue] | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    on_response: LlmResponseObserver | None = None,
) -> dict[str, JsonValue]:
    """One bounded transport downgrade, independent of JSON protocol retries.

    Preferred order: cached mode → (json_object rejected) json_schema →
    unconstrained.  ``response_json_schema`` is the caller's payload schema,
    required for the json_schema step because each operation (subtitle
    groups, cleanup decisions) needs its own grammar.
    """
    mode = _json_constraint_mode(settings)
    schema = response_json_schema
    if use_json_format is True:
        mode = JSON_CONSTRAINT_OBJECT
    elif use_json_format is False:
        mode = JSON_CONSTRAINT_NONE

    while mode != JSON_CONSTRAINT_NONE:
        json_format = _json_format_payload(mode, schema)
        if json_format is None:
            break
        try:
            body = _request_completion_once(
                settings,
                system_prompt,
                cues,
                on_delta=on_delta,
                json_format=json_format,
                is_cancelled=is_cancelled,
                on_response=on_response,
            )
        except LlmClientError as error:
            if not _rejection_means_drop_json_format(error):
                raise
            if mode == JSON_CONSTRAINT_SCHEMA:
                break
            mode = JSON_CONSTRAINT_SCHEMA
            continue
        if _response_content(body).strip():
            _record_json_constraint_mode(settings, mode)
            return body
        # The constraint reached the server but the content is empty (#1773):
        # json_schema is also a constraint, so it cannot rescue this model.
        break
    return _unconstrained_completion(
        settings, system_prompt, cues, on_delta=on_delta,
        is_cancelled=is_cancelled, on_response=on_response,
    )


def _json_format_payload(
    mode: str, schema: Mapping[str, JsonValue] | None
) -> dict[str, JsonValue] | None:
    if mode == JSON_CONSTRAINT_OBJECT:
        return {"type": "json_object"}
    if mode == JSON_CONSTRAINT_SCHEMA:
        if schema is None:
            return None
        return {"type": "json_schema", "json_schema": dict(schema)}
    return None


def _unconstrained_completion(
    settings: LlmSettings,
    system_prompt: str,
    cues: list[dict[str, JsonValue]],
    *,
    on_delta: LlmDelta | None,
    is_cancelled: Callable[[], bool] | None = None,
    on_response: LlmResponseObserver | None = None,
) -> dict[str, JsonValue]:
    _record_json_constraint_mode(settings, JSON_CONSTRAINT_NONE)
    if on_delta is not None:
        on_delta("reset", "")
    body = _request_completion_once(
        settings, system_prompt, cues, on_delta=on_delta, json_format=None,
        is_cancelled=is_cancelled, on_response=on_response,
    )
    if not _response_content(body).strip():
        raise LlmClientError(
            "模型在无约束重试后仍返回空内容，无法解析 JSON。可能与推理模型和 JSON 约束冲突有关"
            "（LM Studio #1773）；请检查服务端日志，或尝试关闭思考、更换模型。",
            category="protocol",
        )
    return body


def _request_completion_once(
    settings: LlmSettings,
    system_prompt: str,
    cues: list[dict[str, JsonValue]],
    *,
    on_delta: LlmDelta | None,
    json_format: Mapping[str, JsonValue] | None = None,
    is_cancelled: Callable[[], bool] | None = None,
    on_response: LlmResponseObserver | None = None,
) -> dict[str, JsonValue]:
    endpoint = _chat_endpoint(settings.base_url)
    payload: dict[str, JsonValue] = {
        "model": settings.model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": json.dumps(cues, ensure_ascii=False)},
        ],
        "temperature": 0.1,
    }
    if json_format is not None:
        # Endpoints that rejected json_object may still accept json_schema;
        # endpoints proven to fail both run without any response_format and
        # rely on the prompt alone.
        payload["response_format"] = dict(json_format)
    payload.update(_reasoning_parameters(settings))
    streaming = on_delta is not None
    if streaming:
        payload["stream"] = True
        if _provider_family(settings) == "qwen":
            # DashScope can otherwise repeat the full accumulated content in
            # every chunk, which is not useful for a live text area.
            payload["incremental_output"] = True
    headers = _request_headers(settings, streaming=streaming)
    _raise_if_cancelled(is_cancelled)
    try:
        request = _post_completion_request(
            endpoint,
            headers=headers,
            payload=payload,
            streaming=streaming,
            is_cancelled=is_cancelled,
        )
        response = request.response
        response_owned_by_worker = False
        try:
            if on_response is not None:
                # Pass the close handle rather than only the Response: the
                # observer must also be able to close the Session that owns it.
                on_response(request)
            _raise_if_cancelled(is_cancelled)
            if is_cancelled is None:
                body = _consume_completion_response(
                    response,
                    settings=settings,
                    streaming=streaming,
                    on_delta=on_delta,
                    is_cancelled=None,
                )
            else:
                pending_body = _PendingCompletionBody()

                def consume_response() -> None:
                    result: object | None = None
                    failure: BaseException | None = None
                    try:
                        result = _consume_completion_response(
                            response,
                            settings=settings,
                            streaming=streaming,
                            on_delta=on_delta,
                            is_cancelled=is_cancelled,
                        )
                    except BaseException as error:  # Relay transport failures to the caller thread.
                        failure = error
                    finally:
                        request.close()
                        if on_response is not None:
                            on_response(None)
                    pending_body.publish(
                        body=result,
                        error=failure,
                        is_cancelled=is_cancelled,
                    )

                response_owned_by_worker = True
                worker = Thread(
                    target=consume_response,
                    name="maw-llm-response-body",
                    daemon=True,
                )
                try:
                    worker.start()
                except BaseException:
                    response_owned_by_worker = False
                    raise
                body = pending_body.wait(is_cancelled)
        finally:
            if not response_owned_by_worker:
                request.close()
                if on_response is not None:
                    on_response(None)
    except LlmClientError:
        raise
    except JSONDecodeError as error:
        detail = _bound_diagnostic(str(error), settings=settings)
        raise LlmClientError(
            f"LLM response was not valid JSON: {detail or 'invalid JSON'}",
            category="protocol",
            operation="completion",
        ) from error
    except RequestException as error:
        if is_cancelled is not None and is_cancelled():
            raise LlmClientError(
                "操作已取消。", category="cancelled", operation="completion"
            ) from error
        detail = _bound_diagnostic(str(error), settings=settings)
        raise LlmClientError(
            f"LLM network request failed: {detail or 'request failed'}",
            category="network",
            operation="completion",
        ) from error
    if not isinstance(body, dict):
        raise LlmClientError("LLM response must be a JSON object")
    return body


class _CompletionResponseLease:
    """Keep the originating Session open until the response body is consumed."""

    def __init__(self, session: requests.Session, response: requests.Response) -> None:
        self.session = session
        self.response = response
        self._close_lock = Lock()
        self._close_started = False

    def close(self) -> None:
        with self._close_lock:
            if self._close_started:
                return
            self._close_started = True
        _close_response(self.response)
        try:
            self.session.close()
        except Exception:  # noqa: BLE001 - cleanup must not hide the request result.
            pass


class _PendingCompletionBody:
    """Transfer a parsed response body unless cancellation abandons the read."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._ready = Event()
        self._abandoned = False
        self._body: object | None = None
        self._has_body = False
        self._error: BaseException | None = None

    def publish(
        self,
        *,
        body: object | None,
        error: BaseException | None,
        is_cancelled: Callable[[], bool],
    ) -> None:
        with self._lock:
            if self._abandoned or is_cancelled():
                self._abandoned = True
            else:
                self._body = body
                self._has_body = error is None
                self._error = error
            self._ready.set()

    def wait(self, is_cancelled: Callable[[], bool]) -> object:
        while not self._ready.wait(_CANCELLABLE_REQUEST_POLL_SECONDS):
            if is_cancelled():
                self.abandon()
                _raise_if_cancelled(is_cancelled)

        body: object | None = None
        error: BaseException | None = None
        has_body = False
        cancelled = False
        with self._lock:
            if self._abandoned or is_cancelled():
                self._abandoned = True
                self._body = None
                self._has_body = False
                self._error = None
                cancelled = True
            else:
                body = self._body
                has_body = self._has_body
                error = self._error
        if cancelled:
            _raise_if_cancelled(is_cancelled)
        if error is not None:
            raise error
        if not has_body:
            raise RuntimeError("LLM response completed without a body")
        return body

    def abandon(self) -> None:
        with self._lock:
            self._abandoned = True
            self._body = None
            self._has_body = False
            self._error = None


class _PendingCompletionResponse:
    """Transfer a response from the request thread without stranding late replies."""

    def __init__(self) -> None:
        self._lock = Lock()
        self._ready = Event()
        self._abandoned = False
        self._response: _CompletionResponseLease | None = None
        self._error: BaseException | None = None

    def publish(
        self,
        *,
        response: _CompletionResponseLease | None = None,
        error: BaseException | None = None,
        is_cancelled: Callable[[], bool],
    ) -> None:
        close_response: _CompletionResponseLease | None = None
        with self._lock:
            if self._abandoned or is_cancelled():
                self._abandoned = True
                close_response = response
            else:
                self._response = response
                self._error = error
            self._ready.set()
        if close_response is not None:
            _close_response(close_response)

    def wait(self, is_cancelled: Callable[[], bool]) -> _CompletionResponseLease:
        while not self._ready.wait(_CANCELLABLE_REQUEST_POLL_SECONDS):
            if is_cancelled():
                self.abandon()
                _raise_if_cancelled(is_cancelled)

        close_response: _CompletionResponseLease | None = None
        response: _CompletionResponseLease | None = None
        error: BaseException | None = None
        cancelled = False
        with self._lock:
            if self._abandoned or is_cancelled():
                self._abandoned = True
                close_response = self._response
                self._response = None
                cancelled = True
            else:
                response = self._response
                self._response = None
                error = self._error
        if close_response is not None:
            _close_response(close_response)
        if cancelled:
            _raise_if_cancelled(is_cancelled)
        if error is not None:
            raise error
        if response is None:
            raise RuntimeError("LLM request completed without a response")
        return response

    def abandon(self) -> None:
        close_response: _CompletionResponseLease | None = None
        with self._lock:
            self._abandoned = True
            close_response = self._response
            self._response = None
        if close_response is not None:
            _close_response(close_response)


def _post_completion_request(
    endpoint: str,
    *,
    headers: Mapping[str, str],
    payload: Mapping[str, JsonValue],
    streaming: bool,
    is_cancelled: Callable[[], bool] | None,
) -> _CompletionResponseLease:
    def post() -> _CompletionResponseLease:
        _raise_if_cancelled(is_cancelled)
        session = requests.Session()
        try:
            response = session.post(
                endpoint,
                headers=dict(headers),
                json=dict(payload),
                timeout=(10, 180),
                **({"stream": True} if streaming else {}),
            )
        except BaseException:
            _close_session(session)
            raise
        return _CompletionResponseLease(session, response)

    if is_cancelled is None:
        return post()

    pending = _PendingCompletionResponse()

    def request_headers() -> None:
        try:
            response_lease = post()
        except BaseException as error:  # Relay transport failures to the caller thread.
            pending.publish(error=error, is_cancelled=is_cancelled)
        else:
            pending.publish(response=response_lease, is_cancelled=is_cancelled)

    # requests.post blocks until response headers arrive. Keep that wait off the
    # bridge thread so cancellation can return promptly. A request already in
    # progress may continue until Requests' connect/read timeout; its late
    # response is closed by the worker and is never handed to the parser.
    worker = Thread(target=request_headers, name="maw-llm-request", daemon=True)
    worker.start()
    return pending.wait(is_cancelled)


def _close_response(response: requests.Response) -> None:
    try:
        response.close()
    except Exception:  # noqa: BLE001 - response cleanup must not hide the request result.
        pass


def _close_session(session: requests.Session) -> None:
    try:
        session.close()
    except Exception:  # noqa: BLE001 - cleanup must not hide the request result.
        pass


def _consume_completion_response(
    response: requests.Response,
    *,
    settings: LlmSettings,
    streaming: bool,
    on_delta: LlmDelta | None,
    is_cancelled: Callable[[], bool] | None,
) -> object:
    _raise_if_cancelled(is_cancelled)
    try:
        response.raise_for_status()
    except HTTPError as error:
        _raise_if_cancelled(is_cancelled)
        raise _provider_response_error(
            response, settings=settings, operation="completion"
        ) from error
    if streaming:
        return _read_stream_response(
            response,
            on_delta,
            settings=settings,
            is_cancelled=is_cancelled,
        )
    body = response.json()
    _raise_if_cancelled(is_cancelled)
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
        if (
            not isinstance(raw_ids, list)
            or not raw_ids
            or not all(isinstance(value, str) and value for value in raw_ids)
        ):
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
            try:
                response.raise_for_status()
            except HTTPError as error:
                raise _provider_response_error(
                    response, settings=settings, operation="connection test"
                ) from error
    except LlmClientError:
        raise
    except RequestException as error:
        detail = _bound_diagnostic(str(error), settings=settings)
        raise LlmClientError(
            f"LLM network connection test failed: {detail or 'request failed'}",
            category="network",
            operation="connection test",
        ) from error


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
            try:
                response.raise_for_status()
            except HTTPError as error:
                raise _provider_response_error(
                    response, settings=settings, operation="model list"
                ) from error
            body = response.json()
    except LlmClientError:
        raise
    except JSONDecodeError as error:
        detail = _bound_diagnostic(str(error), settings=settings)
        raise LlmClientError(
            f"LLM model list response was not valid JSON: {detail or 'invalid JSON'}",
            category="protocol",
            operation="model list",
        ) from error
    except RequestException as error:
        detail = _bound_diagnostic(str(error), settings=settings)
        raise LlmClientError(
            f"LLM network model-list request failed: {detail or 'request failed'}",
            category="network",
            operation="model list",
        ) from error

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
        raise LlmClientError(
            "plain HTTP LLM API URLs are allowed only for loopback hosts"
        )
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
    if not is_custom_slot(provider):
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


def _read_stream_response(
    response: requests.Response,
    on_delta: LlmDelta | None,
    *,
    settings: LlmSettings | None = None,
    is_cancelled: Callable[[], bool] | None = None,
) -> dict[str, JsonValue]:
    if on_delta is None:
        raise AssertionError("stream callback is required for an SSE response")
    content_parts: list[str] = []
    reasoning_parts: list[str] = []
    # Read raw bytes and let _iter_sse_data decode as UTF-8 explicitly.
    # With decode_unicode=True, requests falls back to ISO-8859-1 for
    # text/event-stream responses without an explicit charset, which mangles
    # multi-byte UTF-8 (e.g. 0x85 in a Chinese character becomes U+0085 NEL
    # and splitlines() breaks SSE events mid-JSON).
    for data in _iter_sse_data(response.iter_lines(decode_unicode=False)):
        _raise_if_cancelled(is_cancelled)
        if data == "[DONE]":
            break
        try:
            chunk = json.loads(data)
        except json.JSONDecodeError as error:
            raise LlmClientError(
                f"LLM stream returned invalid JSON: {error}", category="protocol"
            ) from error
        if not isinstance(chunk, dict):
            continue
        error = chunk.get("error")
        if isinstance(error, dict):
            diagnostic = _bound_diagnostic(
                _extract_diagnostic_fields(error), settings=settings
            )
            message = diagnostic or "LLM stream failed"
            raise LlmClientError(
                f"LLM provider stream returned an error: {message}",
                category="provider_response",
                diagnostic=diagnostic,
            )
        choice = _first_stream_choice(chunk)
        if choice is None:
            continue
        delta = choice.get("delta") or choice.get("message")
        if not isinstance(delta, dict):
            continue
        reasoning = _stream_text(delta.get("reasoning_content")) or _stream_text(
            delta.get("reasoning")
        )
        content = _stream_text(delta.get("content"))
        if reasoning:
            _raise_if_cancelled(is_cancelled)
            reasoning_parts.append(reasoning)
            on_delta("reasoning", reasoning)
        if content:
            _raise_if_cancelled(is_cancelled)
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


def _raise_if_cancelled(is_cancelled: Callable[[], bool] | None) -> None:
    if is_cancelled is not None and is_cancelled():
        raise LlmClientError(
            "操作已取消。", category="cancelled", operation="completion"
        )


def _iter_sse_data(lines: Iterable[str | bytes]) -> Iterable[str]:
    for raw_line in lines:
        line = (
            raw_line.decode("utf-8", errors="replace")
            if isinstance(raw_line, bytes)
            else str(raw_line)
        )
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


def _provider_response_error(
    response: requests.Response,
    *,
    settings: LlmSettings | None = None,
    operation: str = "",
) -> LlmClientError:
    status_code = _response_status_code(response)
    diagnostic = _extract_server_diagnostic(response, settings=settings)
    status_text = f"HTTP {status_code}" if status_code is not None else "an HTTP error"
    detail = f"{status_text}: {diagnostic}" if diagnostic else status_text
    message = f"LLM provider returned {detail}. This is a provider response, not a network outage."
    return LlmClientError(
        message,
        category="provider_response",
        status_code=status_code,
        diagnostic=diagnostic,
        operation=operation,
    )


def _response_status_code(response: object) -> int | None:
    value = getattr(response, "status_code", None)
    try:
        status_code = int(value)
    except (TypeError, ValueError):
        return None
    return status_code if 100 <= status_code <= 599 else None


def _extract_server_diagnostic(
    response: object, *, settings: LlmSettings | None = None
) -> str:
    """Extract a short, redacted provider message without retaining request data."""

    try:
        body = response.json()  # type: ignore[union-attr]
    except (AttributeError, TypeError, ValueError):
        body = getattr(response, "text", "")
    if isinstance(body, Mapping):
        return _bound_diagnostic(_extract_diagnostic_fields(body), settings=settings)
    if isinstance(body, str):
        return _bound_diagnostic(body, settings=settings)
    return ""


def _extract_diagnostic_fields(
    value: Mapping[object, object], *, depth: int = 0
) -> str:
    """Pick provider error fields only; never serialize arbitrary response JSON."""

    if depth > 2:
        return ""
    parts: list[str] = []
    nested_error = value.get("error")
    if isinstance(nested_error, Mapping):
        nested = _extract_diagnostic_fields(nested_error, depth=depth + 1)
        if nested:
            parts.append(nested)
    elif isinstance(nested_error, (str, int, float)):
        parts.append(str(nested_error))
    for key in ("message", "detail", "code", "type", "param"):
        candidate = value.get(key)
        if isinstance(candidate, (str, int, float)) and str(candidate).strip():
            parts.append(f"{key}={candidate}" if key != "message" else str(candidate))
    unique: list[str] = []
    for part in parts:
        if part not in unique:
            unique.append(part)
    return " | ".join(unique)


def _sanitize_error_text(value: object, *, settings: LlmSettings | None = None) -> str:
    compact = re.sub(r"[\x00-\x1f\x7f]+", " ", str(value))
    compact = re.sub(r"\s+", " ", compact).strip()
    return _redact_diagnostic(compact, settings=settings)


def _bound_diagnostic(value: str, *, settings: LlmSettings | None = None) -> str:
    compact = _sanitize_error_text(value, settings=settings)
    if len(compact) <= MAX_PROVIDER_DIAGNOSTIC_CHARS:
        return compact
    return f"{compact[: MAX_PROVIDER_DIAGNOSTIC_CHARS - 1]}…"


def _redact_diagnostic(value: str, *, settings: LlmSettings | None = None) -> str:
    redacted = value
    if settings is not None:
        # Requests can include the configured endpoint and key in transport
        # exception text.  Replace those exact values before generic URL and
        # header redaction; this also covers non-standard key formats.
        parsed = urlparse(settings.base_url.strip())
        settings_values = (
            settings.api_key,
            settings.base_url,
            parsed.netloc,
            parsed.hostname or "",
        )
        for secret in settings_values:
            normalized = str(secret).strip()
            if normalized:
                redacted = re.sub(
                    re.escape(normalized), "[REDACTED]", redacted, flags=re.IGNORECASE
                )

    # Never expose an endpoint, including its path or query string.  Provider
    # diagnostics remain useful because their non-URL message/code fields are
    # retained below.
    redacted = re.sub(r"(?i)\bhttps?://[^\s<>'\"`]+", "[REDACTED_URL]", redacted)
    redacted = re.sub(
        r"(?i)(\b(?:authorization|proxy-authorization)\b\s*['\"]?\s*[:=]\s*['\"]?)(?!\[REDACTED(?:_[A-Z]+)?\])[^'\"\r\n,;}\]]+",
        r"\1[REDACTED]",
        redacted,
    )
    redacted = re.sub(
        r"(?i)\b(?:bearer|basic|token)\s+(?!\[REDACTED(?:_[A-Z]+)?\])[^\s,;}\]]+",
        lambda match: f"{match.group(0).split(None, 1)[0]} [REDACTED]",
        redacted,
    )
    redacted = re.sub(r"\bsk-[A-Za-z0-9_-]{4,}\b", "[REDACTED_API_KEY]", redacted)
    return re.sub(
        r"(?i)(\b(?:api[-_ ]?key|access[-_ ]?token|api[-_ ]?token|token|key|password|secret)\b\s*['\"]?\s*[:=]\s*['\"]?)(?!\[REDACTED(?:_[A-Z]+)?\])[^'\"\s,;}\]]+",
        r"\1[REDACTED]",
        redacted,
    )


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


def _close_truncated_json(value: str) -> str | None:
    """Close missing containers or remove one comma at the structural tail.

    Only a clean structural prefix can be repaired: an unterminated string or
    a mismatched closer means the damage is mid-content, and silently closing
    it would accept a truncated answer, so ``None`` is returned instead.
    """
    stack: list[str] = []
    closer_for = {"{": "}", "[": "]"}
    in_string = False
    escaped = False
    last_comma: int | None = None
    for index, char in enumerate(value):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
        elif char == '"':
            in_string = True
        elif char in "{[":
            stack.append(char)
        elif char in "}]":
            if not stack or closer_for[stack.pop()] != char:
                return None
        elif char == ",":
            last_comma = index
    if in_string:
        return None
    repaired = value.rstrip()
    if last_comma is not None:
        prefix = value[:last_comma].rstrip()
        suffix = value[last_comma + 1:]
        # Repair a comma only at the structural tail, whether the closing
        # containers were emitted or omitted. Never remove string content or
        # a comma without a preceding value (e.g. {,} or [,]).
        if prefix and prefix[-1] not in "{[:," and all(
            char.isspace() or char in "}]" for char in suffix
        ):
            repaired = (value[:last_comma] + suffix).rstrip()
    if not stack and repaired == value.rstrip():
        return None
    return repaired + "".join(closer_for[opener] for opener in reversed(stack))


def _loads_with_trailing_repair(content: str) -> JsonValue:
    """json.loads with one best-effort repair for truncated JSON suffixes.

    Local models occasionally stop one closing bracket short or leave a
    trailing comma before the closers. Only these structural suffixes are
    repaired; anything else re-raises the original error so the normal
    protocol retry still happens.
    """
    try:
        return json.loads(content)
    except json.JSONDecodeError as error:
        repaired = _close_truncated_json(content)
        if repaired is not None:
            try:
                return json.loads(repaired)
            except json.JSONDecodeError:
                pass
        raise error from None


def _strip_json_fence(content: str) -> str:
    value = content.strip()
    # Thinking models through proxies that do not split the reasoning stream
    # (and LM Studio's #1773 constraint failure) leak the raw think block into
    # content. Drop closed <think>...</think> spans first.
    value = THINK_CLOSED_PATTERN.sub("", value).strip()
    if THINK_OPEN_TAG in value.lower():
        # Truncated reasoning is not a final answer, even if it contains JSON.
        value = value[: value.lower().index(THINK_OPEN_TAG)].strip()
    match = re.fullmatch(
        r"```(?:json)?\s*(.*?)\s*```", value, re.DOTALL | re.IGNORECASE
    )
    if match:
        value = match.group(1).strip()
    # Decode one complete object, respecting braces inside JSON strings.
    start = value.find("{")
    if start >= 0:
        try:
            _, end = json.JSONDecoder().raw_decode(value[start:])
        except json.JSONDecodeError:
            return value
        tail = value[start + end :].strip()
        if not tail.startswith(("{", "[")):
            return value[start : start + end]
    return value
