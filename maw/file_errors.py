"""File-system failures shared by post-processing and Launcher diagnostics."""

from __future__ import annotations

import errno
import re
from functools import wraps
from typing import Callable, ParamSpec, TypeVar


_P = ParamSpec("_P")
_T = TypeVar("_T")
_WRITE_MESSAGE = "文件创建或写入失败"
_INTERMEDIATE_MESSAGE = "中间文件创建或写入失败"
_LONG_PATH = re.compile(r"\[WinError 206\]|\[Errno 36\]|\bENAMETOOLONG\b|file(?:name| name) too long", re.IGNORECASE)


def file_error_code(error: BaseException | str) -> str:
    """Recognize OS evidence, including wrapped errors and child tracebacks."""
    current: BaseException | None = error if isinstance(error, BaseException) else None
    details = [str(error)]
    seen: set[int] = set()
    too_long = False
    intermediate = False
    write_failed = False
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        details.append(str(current))
        intermediate |= isinstance(current, IntermediateFileError)
        write_failed |= isinstance(current, FileWriteError)
        too_long |= isinstance(current, OSError) and (
            current.errno == errno.ENAMETOOLONG or getattr(current, "winerror", None) == 206
        )
        current = current.__cause__ or current.__context__
    detail = "\n".join(details)
    intermediate |= _INTERMEDIATE_MESSAGE in detail
    write_failed |= _WRITE_MESSAGE in detail
    too_long |= bool(_LONG_PATH.search(detail))
    if too_long:
        return "intermediate_path_too_long" if intermediate else "file_path_too_long"
    return "intermediate_file_failed" if intermediate else "file_write_failed" if write_failed else ""


class FileWriteError(OSError):
    """A file write failed; retain the OS cause for diagnostics."""

    message = _WRITE_MESSAGE

    def __init__(self, cause: OSError) -> None:
        hint = (
            "文件名或路径过长。请缩短原文件名，或将文件移到更浅的目录，重新选择文件后重试。"
            if file_error_code(cause).endswith("path_too_long")
            else "请检查目录权限、剩余磁盘空间和文件占用后重试。"
        )
        super().__init__(f"{self.message}：{hint} 原因：{cause}")


class IntermediateFileError(FileWriteError):
    """A failure in an operation dedicated to intermediate artifacts."""

    message = _INTERMEDIATE_MESSAGE


def intermediate_file_operation(operation: Callable[_P, _T]) -> Callable[_P, _T]:
    return _file_operation(operation, IntermediateFileError)


def file_write_operation(operation: Callable[_P, _T]) -> Callable[_P, _T]:
    return _file_operation(operation, FileWriteError)


def _file_operation(operation: Callable[_P, _T], error_type: type[FileWriteError]) -> Callable[_P, _T]:
    """Add write context without relabeling provider or validation failures."""
    @wraps(operation)
    def wrapped(*args: _P.args, **kwargs: _P.kwargs) -> _T:
        try:
            return operation(*args, **kwargs)
        except OSError as error:
            if isinstance(error, error_type):
                raise
            if isinstance(error, FileWriteError) and isinstance(error.__cause__, OSError):
                error = error.__cause__
            raise error_type(error) from error
    return wrapped
