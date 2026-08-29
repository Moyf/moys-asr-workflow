"""本地日志落盘：GUI 事件流与进程 stdout/stderr 统一按天写入用户数据目录。

Launcher 的「4️⃣ 日志」面板只把事件渲染进页面内存，重启即失；本模块把
同一事件流按天追加写入用户数据目录，并通过 TeeWriter 把进程内的
print / traceback 一并接入，供崩溃／退出后排查。写盘失败一律静默降级，
绝不影响主流程。
"""

from __future__ import annotations

import io
import os
import re
import sys
import threading
from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path
from typing import TextIO

# 启动时清理多少天前的日志文件。
LOG_RETENTION_DAYS = 7
_LOG_FILE_PATTERN = "maw-*.log"

# 防御性打码：批处理链路已有 _without_secrets 先例，这里针对 sk-xxx
# 形态再做一层兜底，避免事件消息意外携带 API Key。
_SECRET_PATTERN = re.compile(r"sk-[A-Za-z0-9_-]{4,}")
_SENSITIVE_KEYS = ("key", "secret", "token", "password")


def default_log_directory() -> Path:
    """返回平台对应的 MAW 用户数据日志目录（与 emoji 字体缓存同一命名空间）。

    `MAW_APP_DATA_ROOT` 覆盖整个基目录（打包/测试环境用），与启动错误
    日志的回退路径保持同一命名空间，避免日志分散在两处。
    """
    override = os.environ.get("MAW_APP_DATA_ROOT", "").strip()
    if override:
        return Path(override).expanduser().resolve(strict=False) / "logs"
    if sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support" / "Moy" / "MAW"
    elif sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA", str(Path.home() / "AppData" / "Local"))) / "Moy" / "MAW"
    else:
        base = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "Moy" / "MAW"
    return base / "logs"


def _log_path_for(directory: Path, day: datetime) -> Path:
    return directory / f"maw-{day:%Y-%m-%d}.log"


def _sensitive_key(key: str) -> bool:
    lowered = key.casefold()
    return any(token in lowered for token in _SENSITIVE_KEYS)


def _scalar_pairs(value: object) -> list[tuple[str, object]]:
    """把单层 dict 展开成键值对；嵌套结构与敏感键忽略。"""
    if isinstance(value, Mapping):
        return [
            (str(key), item)
            for key, item in value.items()
            if item not in (None, "") and not isinstance(item, (dict, list)) and not _sensitive_key(str(key))
        ]
    return []


def _format_event(event: Mapping[str, object]) -> str:
    """把单个事件归一化成一行可读文本；返回空串表示不值得落盘。"""
    event_type = str(event.get("type") or "unknown")
    if event_type == "postprocess_stream":
        # LLM token 级回显，逐 token 落盘会刷屏；信息已由 pipeline step 摘要覆盖。
        return ""
    message = event.get("message")
    if message not in (None, ""):
        body = f"[{event_type}] {message}"
    elif event_type == "error":
        code = str(event.get("code") or "?")
        detail = str(event.get("detail") or "")
        body = f"[error:{code}] {detail}".rstrip()
    else:
        parts: list[str] = []
        for key, value in event.items():
            if key in ("type", "message") or _sensitive_key(str(key)):
                continue
            for pair_key, pair_value in _scalar_pairs(value):
                parts.append(f"{pair_key}={pair_value}")
            if value not in (None, "") and not isinstance(value, (dict, list)) and not _sensitive_key(str(key)):
                parts.append(f"{str(key)}={value}")
        payload = " ".join(parts)
        body = f"[{event_type}] {payload}" if payload else f"[{event_type}]"
    return _SECRET_PATTERN.sub("sk-***", body)


def format_log_line(event: Mapping[str, object], *, now: datetime) -> str:
    """生成带毫秒时间戳的完整一行（落盘文本）；返回空串表示跳过。"""
    body = _format_event(event)
    if not body:
        return ""
    stamp = now.strftime("%H:%M:%S.%f")[:-3]
    return f"{stamp} {body}"


class LocalLogSink:
    """把后端事件流按天追加写入日志目录；所有 I/O 失败静默。

    每次 append 行缓冲写入后立即关闭文件：崩溃时最多丢失正在写的一行，
    也免去跨天管理句柄的负担；事件频率下性能足够。
    """

    def __init__(
        self,
        *,
        directory: Path | None = None,
        now: Callable[[], datetime] = datetime.now,
    ) -> None:
        self.directory = directory if directory is not None else default_log_directory()
        self._now = now
        self._lock = threading.Lock()
        self._closed = False
        self._swept_on = ""

    def append(self, event: Mapping[str, object]) -> None:
        try:
            line = format_log_line(event, now=self._now())
        except Exception:
            # 格式化失败（如异常对象无法转换）不应影响主流程。
            return
        self._write_line(line)

    def write_text(self, text: str, *, label: str = "print") -> None:
        """把一段非事件文本（如 print 输出）写成一行的日志。"""
        try:
            stamp = self._now().strftime("%H:%M:%S.%f")[:-3]
            line = f"{stamp} [{label}] " + _SECRET_PATTERN.sub("sk-***", str(text))
        except Exception:
            return
        self._write_line(line)

    def _write_line(self, line: str) -> None:
        if not line or self._closed:
            return
        try:
            with self._lock:
                if self._closed:
                    return
                self.directory.mkdir(parents=True, exist_ok=True)
                self._sweep_if_needed()
                path = _log_path_for(self.directory, self._now())
                with path.open("a", encoding="utf-8", buffering=1) as handle:
                    handle.write(line + "\n")
        except OSError:
            pass

    def close(self) -> None:
        with self._lock:
            self._closed = True

    def _sweep_if_needed(self) -> None:
        today = self._now().date().isoformat()
        if self._swept_on == today:
            return
        self._swept_on = today
        self._sweep(LOG_RETENTION_DAYS)

    def _sweep(self, retention_days: int) -> None:
        try:
            cutoff = self._now().timestamp() - retention_days * 24 * 3600
            for old in self.directory.glob(_LOG_FILE_PATTERN):
                try:
                    if old.stat().st_mtime < cutoff:
                        old.unlink(missing_ok=True)
                except OSError:
                    continue
        except OSError:
            pass


class TeeWriter(io.TextIOBase):
    """把写入的文本按行追加到 LocalLogSink，同时透明转发给原流。

    print 的 write 调用可能不带换行（分段到达），这里累积到行边界再落盘；
    flush 时把残留的半行也写掉。原流为 None（如 pythonw 无控制台）时只写
    sink。所有对原流的转发异常都不向上抛，避免写日志拖垮主流程。
    """

    def __init__(self, sink: LocalLogSink, stream: TextIO | None, *, label: str) -> None:
        super().__init__()
        self._sink = sink
        self._stream = stream
        self._label = label
        self._buffer = ""
        self._lock = threading.Lock()

    @property
    def encoding(self) -> str:
        return self._stream.encoding if self._stream is not None else "utf-8"

    def write(self, s: str) -> int:
        text = str(s)
        with self._lock:
            self._buffer += text
            while "\n" in self._buffer:
                line, _, self._buffer = self._buffer.partition("\n")
                self._sink.write_text(line, label=self._label)
        if self._stream is not None:
            try:
                return self._stream.write(text)
            except (OSError, ValueError):
                pass
        return len(text)

    def flush(self) -> None:
        with self._lock:
            if self._buffer:
                self._sink.write_text(self._buffer, label=self._label)
                self._buffer = ""
        if self._stream is not None:
            try:
                self._stream.flush()
            except (OSError, ValueError):
                pass

    def isatty(self) -> bool:
        return self._stream.isatty() if self._stream is not None else False

    def fileno(self) -> int:
        return self._stream.fileno() if self._stream is not None else -1


def install_stdio_tee(sink: LocalLogSink) -> None:
    """把 sys.stdout / sys.stderr 替换为 TeeWriter；重复调用不会叠加包装。"""
    for name, label in (("stdout", "stdout"), ("stderr", "stderr")):
        current = getattr(sys, name, None)
        if isinstance(current, TeeWriter):
            continue
        setattr(sys, name, TeeWriter(sink, current, label=label))
