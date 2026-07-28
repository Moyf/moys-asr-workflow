# pyright: reportAny=false, reportUnusedCallResult=false

from __future__ import annotations

import html
import json
import os
import queue
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from typing import Final, TextIO, final

from maw.gui_config import DEFAULT_MODEL_ID, DEFAULT_ENV_PATH, load_env


@dataclass(frozen=True, slots=True)
class OutputPaths:
    srt: Path
    json: Path
    html: Path


@dataclass(frozen=True, slots=True)
class TranscriptionRequest:
    media_path: Path
    srt_path: Path
    model: str = DEFAULT_MODEL_ID
    language: str = ""
    api_key: str = ""
    length_limit: str = ""
    region: str = ""
    workspace_id: str = ""
    provider: str = "qwen"
    speaker_colors: bool = False


@dataclass(frozen=True, slots=True)
class TranscriptionResult:
    srt_path: Path
    json_path: Path
    html_path: Path | None


ProgressCallback = Callable[[str], None]
ProcessStartCallback = Callable[[int], None]


@final
class TranscriptionCancelledError(Exception):
    """Raised after a user requests cancellation."""

    def __init__(self) -> None:
        super().__init__("Transcription cancelled")


@final
class TranscriptionProcessError(Exception):
    """Raised when the transcription subprocess exits unsuccessfully."""

    exit_code: int

    def __init__(self, exit_code: int) -> None:
        self.exit_code = exit_code
        super().__init__(f"Transcription failed with exit code {exit_code}")


@final
class MissingOutputError(Exception):
    """Raised when a successful child process omits a promised artifact."""

    label: str
    path: Path

    def __init__(self, label: str, path: Path) -> None:
        self.label = label
        self.path = path
        super().__init__(f"{label} output was not created: {path}")


def build_output_paths(srt_path: Path) -> OutputPaths:
    srt = Path(srt_path).expanduser().resolve()
    return OutputPaths(srt=srt, json=srt.with_suffix(".json"), html=srt.with_suffix(".edit.html"))


PROVIDER_SRT_TAGS: Final = {"qwen": ".qwen3-asr-api", "soniox": ".soniox"}


def default_srt_path(media_path: Path, provider: str = "qwen") -> Path:
    media = Path(media_path).expanduser()
    tag = PROVIDER_SRT_TAGS.get(provider, PROVIDER_SRT_TAGS["qwen"])
    return media.with_name(f"{media.stem}{tag}.srt")


def build_transcribe_command(
    request: TranscriptionRequest,
    *,
    executable: Path | str | None = None,
    frozen: bool | None = None,
) -> list[str]:
    exe = str(executable or sys.executable)
    is_frozen = bool(getattr(sys, "frozen", False) if frozen is None else frozen)
    is_soniox = request.provider == "soniox"
    script_name = "generate_subtitle_soniox_api.py" if is_soniox else "generate_subtitle_qwen_api.py"
    script = Path(__file__).resolve().parents[1] / script_name
    if is_frozen:
        command = [exe, "--transcribe-soniox" if is_soniox else "--transcribe"]
    else:
        command = [exe, str(script)]
    command.append(str(request.media_path))
    command.extend(["--output", str(build_output_paths(request.srt_path).srt), "--json", "--no-html", "--with-waveform"])
    if is_soniox:
        _append_option(command, "--model", request.model if request.model != DEFAULT_MODEL_ID else "")
        if request.speaker_colors:
            command.append("--speaker-colors")
    else:
        _append_option(command, "--model", request.model or DEFAULT_MODEL_ID)
        _append_option(command, "--region", request.region)
    _append_option(command, "--language", request.language)
    _append_option(command, "--length-limit", request.length_limit)
    return command


def build_serve_command(
    json_path: Path | None,
    media_path: Path | None,
    port: int,
    *,
    executable: Path | str | None = None,
    frozen: bool | None = None,
) -> list[str]:
    exe = str(executable or sys.executable)
    is_frozen = bool(getattr(sys, "frozen", False) if frozen is None else frozen)
    script = Path(__file__).resolve().parents[1] / "server-editor" / "serve.py"
    command = [exe, "--serve"] if is_frozen else [exe, str(script)]
    if json_path is None:
        # 无工程时启动空白编辑器，由用户在页面内自行选择 JSON 与媒体
        command.append("--blank")
    else:
        command.append(str(json_path))
        if media_path:
            command.extend(["-m", str(media_path)])
    command.extend(["--port", str(port)])
    return command


def run_transcription(
    request: TranscriptionRequest,
    *,
    on_event: ProgressCallback | None = None,
    cancel_event: Event | None = None,
    executable: Path | str | None = None,
    frozen: bool | None = None,
    on_process_start: ProcessStartCallback | None = None,
) -> TranscriptionResult:
    if cancel_event and cancel_event.is_set():
        raise TranscriptionCancelledError
    paths = build_output_paths(request.srt_path)
    paths.srt.parent.mkdir(parents=True, exist_ok=True)
    env = _child_environment(os.environ, request.api_key, request.workspace_id, request.provider)
    command = build_transcribe_command(request, executable=executable, frozen=frozen)
    process = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        cwd=str(Path(__file__).resolve().parents[1]),
    )
    if on_process_start is not None:
        on_process_start(process.pid)
    _stream_process(process, on_event or _ignore, cancel_event)
    if process.returncode != 0:
        raise TranscriptionProcessError(process.returncode)
    _require_output(paths.srt, "SRT")
    _require_output(paths.json, "JSON")
    try:
        html_path = render_editor_html(paths.json, request.media_path, paths.html)
    except Exception as error:  # HTML is optional; preserve successful SRT/JSON outputs.
        html_path = None
        (on_event or _ignore)(f"[warning] 编辑器 HTML 生成失败，SRT/JSON 已保留：{error}")
    return TranscriptionResult(srt_path=paths.srt, json_path=paths.json, html_path=html_path)


def render_editor_html(json_path: Path, media_path: Path, html_path: Path) -> Path | None:
    try:
        from edit import media_tag, render_editor_page
        from maw.project import normalize_project
    except ImportError:
        return None

    project = json.loads(Path(json_path).read_text(encoding="utf-8"))
    normalized = normalize_project(project)
    media = Path(media_path).expanduser().resolve()
    try:
        media_url = media.relative_to(Path(html_path).parent.resolve()).as_posix()
    except ValueError:
        media_url = media.as_uri()
    content = render_editor_page(
        title=f"MAWE - {Path(json_path).name}",
        media_html=media_tag(media, media_url),
        data_json=json.dumps(normalized, ensure_ascii=False),
        filename_base_json=json.dumps(Path(json_path).stem, ensure_ascii=False),
        stickers_json="[]",
        sticker_root_json="null",
        generated_at=time.strftime("%Y-%m-%d %H:%M:%S"),
        json_display=html.escape(Path(json_path).name),
        json_name_class="",
        media_name_display=html.escape(media.name),
        media_name_title=html.escape(str(media)),
        media_name_class="",
    )
    Path(html_path).write_text(content, encoding="utf-8", newline="\n")
    return Path(html_path)


def _stream_process(process: subprocess.Popen[str], on_event: ProgressCallback, cancel_event: Event | None) -> None:
    lines: queue.Queue[str | None] = queue.Queue()
    reader = threading.Thread(target=_read_process_lines, args=(process.stdout, lines), daemon=True)
    reader.start()
    while True:
        if cancel_event and cancel_event.is_set():
            _terminate(process)
            raise TranscriptionCancelledError
        try:
            line = lines.get(timeout=0.1)
        except queue.Empty:
            if process.poll() is not None and not reader.is_alive():
                break
            continue
        if line is None:
            break
        text = line.rstrip("\r\n")
        if text:
            on_event(text)
    process.wait()


def _read_process_lines(stdout: TextIO | None, lines: queue.Queue[str | None]) -> None:
    if stdout is not None:
        for line in stdout:
            lines.put(line)
    lines.put(None)


def _child_environment(parent: Mapping[str, str], api_key: str, workspace_id: str = "", provider: str = "qwen") -> dict[str, str]:
    env = dict(parent)
    env["PYTHONUNBUFFERED"] = "1"
    _prepend_ffmpeg_path(env, parent.get("FFMPEG_PATH") or load_env(DEFAULT_ENV_PATH).get("FFMPEG_PATH", ""))
    if provider == "soniox":
        if api_key:
            env["SONIOX_API_KEY"] = api_key
    else:
        if api_key:
            env["DASHSCOPE_API_KEY"] = api_key
        if workspace_id:
            env["DASHSCOPE_WORKSPACE_ID"] = workspace_id
    return env


def _prepend_ffmpeg_path(env: dict[str, str], configured_path: str) -> None:
    if not configured_path.strip():
        return
    candidate = Path(configured_path.strip()).expanduser()
    directory = candidate if candidate.is_dir() else candidate.parent
    if not directory.exists():
        return
    old_path = env.get("PATH", "")
    env["PATH"] = str(directory) if not old_path else str(directory) + os.pathsep + old_path


def _terminate(process: subprocess.Popen[str]) -> None:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def _require_output(path: Path, label: str) -> None:
    if not path.exists():
        raise MissingOutputError(label=label, path=path)


def _append_option(command: list[str], name: str, value: str) -> None:
    if value.strip():
        command.extend([name, value.strip()])


def _ignore(_message: str) -> None:
    return None
