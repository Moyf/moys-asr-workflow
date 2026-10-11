"""Credential input checks and cloud ASR failure classification.

Only obvious paste mistakes are rejected locally. Provider-specific key shapes
and validity remain the provider's responsibility.
"""

from __future__ import annotations

import re

from maw.audio_diagnostics import AudioInputError


_HTTP_STATUS = re.compile(
    r"\bHTTP(?:/\d(?:\.\d)?)?\s*[:=(]?\s*([45]\d{2})\b"
    r"|\b([45]\d{2})\s+(?:Client|Server)\s+Error\b",
    re.IGNORECASE,
)
_KEY_ASSIGNMENT = re.compile(r"^(?:[\w-]*api[-_]?key|key|authorization)\s*[:=]", re.IGNORECASE)


def api_key_error_code(value: str) -> str:
    """Return a non-secret error code; do not impose a vendor prefix or length."""
    key = value.strip()
    if not key:
        return "api_key_missing"
    if (
        any(ord(char) < 33 or ord(char) > 126 or char in "\"'" for char in key)
        or key.casefold().startswith(("http://", "https://"))
        or _KEY_ASSIGNMENT.match(key)
    ):
        return "api_key_invalid_format"
    return ""


def redact_asr_text(value: object, api_key: str) -> str:
    """Remove the active credential locally before emitting or persisting text.

    This replacement is for redaction only, never a key-validity check.
    """
    text = str(value)
    key = api_key.strip()
    return text.replace(key, "[REDACTED]") if key else text


def asr_error_code(error: BaseException, *, provider: str) -> str:
    """Recognize explicit API evidence without confusing local engine failures.

    TranscriptionProcessError keeps the complete child output even when its
    summary only contains the last line of a multi-line provider exception.
    Prefer the final exception block over earlier retry warnings.
    """
    if isinstance(error, AudioInputError):
        return error.code
    if provider == "local":
        return ""
    child_output = getattr(error, "output", ())
    if not isinstance(child_output, (list, tuple)):
        child_output = ()
    detail = str(error)
    if child_output:
        trace = "\n".join(child_output)
        exceptions = list(re.finditer(r"^[\w.]+(?:Error|Exception):", trace, re.MULTILINE))
        if exceptions:
            detail = trace[exceptions[-1].start():]
    statuses = list(_HTTP_STATUS.finditer(detail))
    if statuses:
        match = statuses[-1]
        status = int(match.group(1) or match.group(2))
        if status == 401:
            return "asr_auth_failed"
        if status == 403:
            return "asr_permission_denied"
        if status == 404:
            return "asr_endpoint_invalid"
        if status == 429:
            return "asr_rate_limited"
        if status >= 500:
            return "asr_service_unavailable"
        if status == 408:
            return "asr_timeout"
        if status in {400, 413, 415, 422}:
            return "asr_request_invalid"
    lowered = detail.casefold()
    if re.search(r"\b(?:invalid_?api_?key|incorrect_api_key|unauthenticated|authfailure(?:\.[\w]+)?)\b", lowered):
        return "asr_auth_failed"
    if re.search(r"\b(?:invalid|incorrect) api[- ]?key\b", lowered):
        return "asr_auth_failed"
    if "invalidheader:" in lowered and ("authorization" in lowered or "api-key" in lowered):
        return "api_key_invalid_format"
    if isinstance(error, TimeoutError) or any(marker in lowered for marker in (
        "timeouterror:", "readtimeout:", "connecttimeout:", "timed out", "转写超时", "asr 任务超时",
    )):
        return "asr_timeout"
    if any(marker in lowered for marker in (
        "requests.exceptions.connectionerror:", "requests.exceptions.proxyerror:",
        "requests.exceptions.sslerror:", "newconnectionerror", "name resolution",
        "failed to establish a new connection", "connection refused",
    )):
        return "asr_network_error"
    return ""
