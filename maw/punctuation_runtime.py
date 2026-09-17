"""Bridge the shared ``ct-punc`` model to the existing local runtime."""

from __future__ import annotations

import json
import sys
import tempfile
from importlib.util import find_spec
from pathlib import Path
from threading import Event
from typing import Any

from maw.punctuation import CT_PUNC_MODEL_REF, PunctuationError


def prepare_model_in_runtime(
    *,
    model_cache_root: str | Path | None = None,
    on_event: Any = None,
    cancel_event: Event | None = None,
) -> int:
    """Prepare ct-punc through the managed local runtime."""
    python, helper, env, cwd, runner = _resolve_worker(model_cache_root)
    command = [python, str(helper), "prepare-punc"]
    return runner(
        command,
        env=env,
        cancel=cancel_event or Event(),
        on_line=on_event or (lambda _line: None),
        cwd=cwd,
    )


def punctuate_text_in_runtime(
    text: str,
    *,
    model_cache_root: str | Path | None = None,
    device: str = "auto",
    on_event: Any = None,
    cancel_event: Event | None = None,
) -> str:
    """Run ct-punc in the managed local runtime and return its text output."""
    from maw.local_models import _find_modelscope_model

    model_path = _find_modelscope_model(CT_PUNC_MODEL_REF, model_cache_root)
    if model_path is None:
        raise PunctuationError("尚未下载 FunASR ct-punc 模型；请先准备 FireRedASR2。")
    python, helper, env, cwd, runner = _resolve_worker(model_cache_root)
    with tempfile.TemporaryDirectory(prefix="maw-ct-punc-") as temp_dir:
        input_path = Path(temp_dir) / "input.json"
        input_path.write_text(json.dumps({"text": text}, ensure_ascii=False), encoding="utf-8")
        command = [
            python,
            str(helper),
            "punctuate",
            "--model-path",
            str(model_path),
            "--input",
            str(input_path),
            "--device",
            device,
        ]
        lines: list[str] = []
        result: str | None = None

        def on_line(line: str) -> None:
            nonlocal result
            lines.append(line)
            try:
                payload = json.loads(line)
            except ValueError:
                payload = None
            if isinstance(payload, dict) and payload.get("type") == "result":
                value = payload.get("text")
                if isinstance(value, str):
                    result = value
                return
            if on_event is not None:
                on_event(line)

        runner(
            command,
            env=env,
            cancel=cancel_event or Event(),
            on_line=on_line,
            cwd=cwd,
        )
        if result is None:
            detail = "\n".join(lines[-8:])
            raise PunctuationError(f"ct-punc worker 未返回结果。{detail}")
        return result


def _resolve_worker(
    model_cache_root: str | Path | None,
) -> tuple[str, Path, dict[str, str], str, Any]:
    """Prefer the installed local runtime, with a source-mode fallback."""
    from maw.local_runtime import (
        _run_process,
        _runtime_env,
        default_runtime_root,
        managed_runtime_status,
    )
    from maw.runtimes import LOCAL

    status = managed_runtime_status(model_cache_root)
    if status.ready:
        helper = LOCAL.bundle_path("maw/local_runtime_worker.py")
        return (
            str(status.python_path),
            helper,
            _runtime_env(model_cache_root, default_runtime_root()),
            str(helper.parent),
            _run_process,
        )
    if find_spec("funasr") is not None:
        helper = Path(__file__).resolve().with_name("local_runtime_worker.py")
        return (
            sys.executable,
            helper,
            _runtime_env(model_cache_root),
            str(helper.parent),
            _run_process,
        )
    raise PunctuationError(
        f"本地 ASR runtime 未就绪，无法运行 FunASR ct-punc：{status.detail}"
    )


__all__ = ["prepare_model_in_runtime", "punctuate_text_in_runtime"]
