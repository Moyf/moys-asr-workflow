"""GUI 后端事件流的本地日志落盘。

Launcher 的「4️⃣ 日志」面板只把事件渲染进页面内存，重启即失；本模块把
同一事件流按天追加写入用户数据目录，供崩溃／退出后排查。写盘失败一律
静默降级，绝不影响主流程。
"""

from __future__ import annotations

import os
import re
import sys
import threading
from collections.abc import Callable, Mapping
from datetime import datetime
from pathlib import Path

# 启动时清理多少天前的日志文件。
LOG_RETENTION_DAYS = 7
_LOG_FILE_PATTERN = "maw-*.log"

# 防御性打码：批处理链路已有 _without_secrets 先例，这里针对 sk-xxx
# 形态再做一层兜底，避免事件消息意外携带 API Key。
_SECRET_PATTERN = re.compile(r"sk-[A-Za-z0-9_-]{4,}")
_SENSITIVE_KEYS = ("key", "secret", "token", "password")


def default_log_directory() -> Path:
    """返回平台对应的 MAW 用户数据日志目录（与 emoji 字体缓存同一命名空间）。"""
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
        if self._closed:
            return
        try:
            line = format_log_line(event, now=self._now())
        except Exception:
            # 格式化失败（如异常对象无法转换）不应影响主流程。
            return
        if not line:
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