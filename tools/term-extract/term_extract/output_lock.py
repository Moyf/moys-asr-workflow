"""Process-scoped output ownership, released by the OS even after a crash."""

from __future__ import annotations

import errno
import os
from contextlib import contextmanager
from pathlib import Path


@contextmanager
def lock_output(out_dir: Path):
    # Keep the inode: unlinking on release lets a waiting opener lock an old file
    # while a third process locks its replacement. No PID/stale-lock guessing.
    with (out_dir / ".term-output.lock").open("a+b") as handle:
        handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt

                # Windows permits locking a byte beyond EOF.
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as error:
            if error.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise RuntimeError("输出目录正在被另一任务使用，请等待该任务结束或使用其他 --out 目录。") from error
            raise
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
