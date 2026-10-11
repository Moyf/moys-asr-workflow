"""Private, cancellable stream-copy export jobs for the local editor.

The runner receives a control object; paths are chosen by the server, never
by an HTTP client. A slot remains owned until download or disposal finishes.
"""
from __future__ import annotations

import secrets
import os
import signal
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Callable

from maw.gui_platform import (popen_process_tree, process_group_kwargs,
                              release_process_tree, terminate_process_tree)

MAX_MEDIA_JOB_STDOUT_BYTES = 2 * 1024 * 1024
MAX_MEDIA_JOB_STDERR_BYTES = 64 * 1024
MEDIA_JOB_PIPE_READ_CHARS = 4096


class MediaJobCancelled(RuntimeError):
    pass


class MediaJobBusy(RuntimeError):
    pass


class MediaJobUnavailable(RuntimeError):
    pass


class MediaJob:
    def __init__(self, manager, source: Path, binding: tuple[int, str], intervals):
        self.manager = manager
        self.id = secrets.token_urlsafe(24)
        self.source = source
        self.binding = binding
        self.intervals = tuple(intervals)
        self.directory = Path(tempfile.mkdtemp(prefix="maw-media-job-", dir=manager.temp_root))
        self.output = self.directory / ("restructured" + source.suffix.lower())
        self.state = "running"
        self.stage = "preparing"
        self.progress = None
        self.error = None
        self.cancelled = threading.Event()
        self.process = None
        self.thread = None
        self.disposed = False
        self.cleanup_error = None
        self.timer = None
        self.abort_download = None
        self.disposed_event = threading.Event()

    def check_cancelled(self):
        if self.cancelled.is_set():
            raise MediaJobCancelled("视频重组已停止")

    def update(self, stage: str, progress: float | None = None):
        with self.manager.lock:
            self.check_cancelled()
            self.stage = stage
            self.progress = None if progress is None else max(0, min(1, progress))

    def snapshot(self):
        with self.manager.lock:
            return {"ok": True, "jobId": self.id, "state": self.state,
                    "stage": self.stage, "progress": self.progress,
                    "bindingGeneration": self.binding[0], "sourceMediaId": self.binding[1],
                    "error": self.error, "cleanupError": self.cleanup_error}

    def run_command(self, command, *, timeout=120, duration_ms=None):
        """Drain both pipes while observing cancellation and FFmpeg progress."""
        self.check_cancelled()
        process = popen_process_tree(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", errors="replace",
                                   **process_group_kwargs())
        with self.manager.lock:
            self.process = process
        stdout, stderr = [], []
        output_overflow = threading.Event()

        def drain(pipe, target, progress=False):
            retained_bytes = 0
            while line := pipe.readline(MEDIA_JOB_PIPE_READ_CHARS):
                # readline(size) bounds even a single line without a newline.
                # FFmpeg progress is consumed live rather than retained for hours.
                if progress and duration_ms and line.startswith("out_time_us="):
                    try:
                        value = int(line.partition("=")[2]) / (duration_ms * 1000)
                        with self.manager.lock:
                            if not self.cancelled.is_set():
                                self.progress = max(0, min(0.99, value))
                    except (ValueError, OverflowError):
                        pass
                if progress and duration_ms:
                    continue
                size = len(line.encode("utf-8"))
                if progress:
                    if output_overflow.is_set():
                        continue
                    if retained_bytes + size > MAX_MEDIA_JOB_STDOUT_BYTES:
                        output_overflow.set()
                        continue
                target.append(line)
                retained_bytes += size
                if not progress:
                    while retained_bytes > MAX_MEDIA_JOB_STDERR_BYTES:
                        retained_bytes -= len(target.pop(0).encode("utf-8"))

        readers = [threading.Thread(target=drain, args=(process.stdout, stdout, True), daemon=True),
                   threading.Thread(target=drain, args=(process.stderr, stderr), daemon=True)]
        for reader in readers:
            reader.start()
        deadline = time.monotonic() + timeout
        try:
            while process.poll() is None:
                self.check_cancelled()
                if output_overflow.is_set():
                    raise RuntimeError("媒体进程标准输出超过安全大小上限")
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(command, timeout)
                self.cancelled.wait(0.05)
            self.check_cancelled()
        finally:
            # A child can exit while its descendants still own the pipe handles.
            # Always close the registered Windows Job / POSIX process group.
            terminate_process_tree(process)
            if os.name != "nt":
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            process.wait()
            for reader in readers:
                reader.join(timeout=5)
            for pipe, reader in zip((process.stdout, process.stderr), readers):
                if not reader.is_alive():
                    pipe.close()
            release_process_tree(process)
            with self.manager.lock:
                self.process = None
            if any(reader.is_alive() for reader in readers):
                raise RuntimeError("无法关闭媒体进程输出")
        if output_overflow.is_set():
            # FFprobe JSON is never silently truncated and then parsed.
            raise RuntimeError("媒体进程标准输出超过安全大小上限")
        return subprocess.CompletedProcess(command, process.returncode, "".join(stdout), "".join(stderr))


class MediaJobManager:
    def __init__(self, slot: threading.Lock | None = None, *, ready_timeout=1800, temp_root=None):
        self.lock = threading.RLock()
        self.slot = slot or threading.Lock()
        self.jobs = {}
        self.active = None
        self.ready_timeout = ready_timeout
        self.temp_root = temp_root
        self.closed = False

    def start(self, source: Path, binding: tuple[int, str], intervals,
              runner: Callable[[MediaJob], object]) -> MediaJob:
        with self.lock:
            if self.closed:
                raise MediaJobUnavailable("视频任务服务已关闭")
            if self.active and self.active.cleanup_error:
                self._dispose(self.active)
            if not self.slot.acquire(blocking=False):
                raise MediaJobBusy("另一个去空隙视频重组操作正在进行")
            try:
                job = MediaJob(self, source, binding, intervals)
            except BaseException:
                self.slot.release()
                raise
            # Keep bounded terminal diagnostics; no active job is evicted.
            for key in list(self.jobs)[:-31]:
                if self.jobs[key].disposed:
                    del self.jobs[key]
            self.jobs[job.id] = job
            self.active = job

            def work():
                try:
                    job.check_cancelled()
                    runner(job)
                    with self.lock:
                        job.check_cancelled()
                        job.state = "ready"
                        job.stage = "ready"
                        job.progress = 1
                        job.timer = threading.Timer(self.ready_timeout, self._expire_ready, args=(job.id,))
                        job.timer.daemon = True
                        job.timer.start()
                except MediaJobCancelled:
                    with self.lock:
                        job.state = "cancelled"
                except Exception as error:
                    with self.lock:
                        job.state = "cancelled" if job.cancelled.is_set() else "failed"
                        job.error = None if job.cancelled.is_set() else str(error)[-4000:]
                finally:
                    with self.lock:
                        if job.state in {"failed", "cancelled"}:
                            self._dispose(job)

            job.thread = threading.Thread(target=work, name="maw-media-" + job.id, daemon=True)
            job.thread.start()
            return job

    def get(self, job_id: str) -> MediaJob:
        with self.lock:
            if job_id not in self.jobs:
                raise MediaJobUnavailable("视频任务不存在或已过期")
            return self.jobs[job_id]

    def _expire_ready(self, job_id: str):
        with self.lock:
            job = self.jobs.get(job_id)
            # Timer.cancel cannot stop a callback already waiting for this lock.
            if job is not None and job.state == "ready":
                self.cancel(job_id)

    def cancel(self, job_id: str):
        with self.lock:
            job = self.get(job_id)
            if job.state in {"completed", "failed", "cancelled"}:
                if not job.disposed:
                    self._dispose(job)
                return job.snapshot()
            job.cancelled.set()
            if job.state == "ready":
                job.state = "cancelled"
                self._dispose(job)
            else:
                job.state = "cancelling"
                if job.abort_download:
                    try:
                        job.abort_download()
                    except OSError:
                        pass
            return job.snapshot()

    def begin_download(self, job_id: str, *, abort_download: Callable[[], object] | None = None) -> MediaJob:
        with self.lock:
            job = self.get(job_id)
            if job.state != "ready":
                raise MediaJobUnavailable("视频任务尚未完成或已停止")
            job.check_cancelled()
            # Registration and download admission are atomic with cancellation.
            job.abort_download = abort_download
            job.state = "downloading"
            job.stage = "downloading"
            if job.timer:
                job.timer.cancel()
            return job

    def finish_download(self, job: MediaJob, *, success: bool):
        with self.lock:
            job.state = "cancelled" if job.cancelled.is_set() or not success else "completed"
            self._dispose(job)

    def _dispose(self, job):
        if job.disposed:
            return
        if job.timer:
            job.timer.cancel()
        try:
            shutil.rmtree(job.directory)
        except OSError as error:
            job.state = "failed"
            job.cleanup_error = "无法清理视频任务临时文件：" + str(error)
            job.error = job.cleanup_error
            # Do not admit another task while private output still exists.
            # A subsequent cancel/start/close retries disposal.
            return
        job.cleanup_error = None
        job.disposed = True
        job.abort_download = None
        if self.active is job:
            self.active = None
            self.slot.release()
        job.disposed_event.set()

    def close(self):
        with self.lock:
            self.closed = True
            job = self.active
            if job:
                self.cancel(job.id)
        if job and job.thread:
            job.thread.join(timeout=5)
        if job and not job.disposed_event.wait(timeout=5):
            raise MediaJobUnavailable(job.cleanup_error or "视频任务关闭后尚未完成输出清理")
