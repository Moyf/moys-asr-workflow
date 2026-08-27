"""Shared process-level console encoding setup for MAW entrypoints."""

from __future__ import annotations

import os
import sys
from collections.abc import MutableMapping
from typing import TextIO


PYTHON_UTF8_VALUE = "1"
PYTHON_IO_ENCODING_VALUE = "utf-8:replace"
UTF8_ENCODING = "utf-8"
UTF8_ERRORS = "replace"


def configure_utf8_environment(environment: MutableMapping[str, str]) -> None:
    """Set UTF-8 environment variables for this process and its children."""
    environment["PYTHONUTF8"] = PYTHON_UTF8_VALUE
    environment["PYTHONIOENCODING"] = PYTHON_IO_ENCODING_VALUE


def configure_utf8_stdio() -> None:
    """Make MAW's already-created stdout/stderr streams safe for Unicode text."""
    configure_utf8_environment(os.environ)
    _configure_stream(sys.stdout)
    _configure_stream(sys.stderr)


def _configure_stream(stream: TextIO | None) -> None:
    if stream is None:
        return
    reconfigure = getattr(stream, "reconfigure", None)
    if reconfigure is None:
        return

    options = (
        {
            "encoding": UTF8_ENCODING,
            "errors": UTF8_ERRORS,
            "line_buffering": True,
            "write_through": True,
        },
        {
            "encoding": UTF8_ENCODING,
            "errors": UTF8_ERRORS,
            "line_buffering": True,
        },
        {"encoding": UTF8_ENCODING, "errors": UTF8_ERRORS},
        {"line_buffering": True},
    )
    for kwargs in options:
        try:
            reconfigure(**kwargs)
        except (OSError, TypeError, ValueError):
            continue
        return
