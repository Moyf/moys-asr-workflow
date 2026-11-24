"""Stage a Launcher-authorized burn in its destination directory before publishing."""
from __future__ import annotations

import ctypes
import errno
import logging
import os
import secrets
import stat
import subprocess
import sys
import threading
from collections.abc import Callable, Iterator
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from maw.gui_platform import restore_host_library_path

CHANGED = "保存目标或所在文件夹已变更，请重新选择位置后导出"
UNSAFE = "请选择普通的 MP4 保存目标，且不能覆盖工程或源媒体"
UNCONFIRMED = "已写入视频，但无法确认保存目标的身份"


def _mac_directory_acl_can_change_entries(path: Path) -> bool:
    libc = ctypes.CDLL(None, use_errno=True)
    pointer = ctypes.c_void_p
    libc.acl_get_link_np.argtypes = (ctypes.c_char_p, ctypes.c_int)
    libc.acl_get_link_np.restype = pointer
    libc.acl_free.argtypes = (pointer,)
    libc.acl_get_entry.argtypes = (pointer, ctypes.c_int, ctypes.POINTER(pointer))
    libc.acl_get_tag_type.argtypes = (pointer, ctypes.POINTER(ctypes.c_int))
    libc.acl_get_permset_mask_np.argtypes = (pointer, ctypes.POINTER(ctypes.c_uint64))
    acl = libc.acl_get_link_np(os.fsencode(path), 0x100)  # ACL_TYPE_EXTENDED
    if not acl:
        code = ctypes.get_errno()
        if code in {errno.ENOENT, errno.ENOTSUP, getattr(errno, "ENOATTR", -1)}:
            return False
        raise OSError(code, os.strerror(code))
    try:
        entry = pointer()
        entry_id = 0  # ACL_FIRST_ENTRY
        # Darwin sys/acl.h: add file, delete, add subdirectory, delete child,
        # change permissions and take ownership.
        mutation_mask = (1 << 2) | (1 << 4) | (1 << 5) | (1 << 6) | (1 << 12) | (1 << 13)
        while libc.acl_get_entry(acl, entry_id, ctypes.byref(entry)) == 0:
            tag = ctypes.c_int()
            permissions = ctypes.c_uint64()
            if (libc.acl_get_tag_type(entry, ctypes.byref(tag)) != 0
                    or libc.acl_get_permset_mask_np(entry, ctypes.byref(permissions)) != 0):
                raise PermissionError(errno.EACCES, "无法确认源媒体目录的 ACL")
            if tag.value == 1 and permissions.value & mutation_mask:  # ACL_EXTENDED_ALLOW
                return True
            entry_id = -1  # ACL_NEXT_ENTRY
        return False
    finally:
        libc.acl_free(acl)


def validate_burn_workspace_parent(root: Path) -> None:
    if os.name != "posix":
        return
    trusted_owners = {0, os.geteuid()}
    for parent in (*reversed(root.parents), root):
        info = parent.lstat()
        shared = info.st_mode & (stat.S_IWGRP | stat.S_IWOTH)
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid not in trusted_owners
                or (shared and not info.st_mode & stat.S_ISVTX)):
            raise PermissionError(errno.EACCES, "源媒体目录或上级目录允许其他用户移动任务文件夹")
        unsafe_acl = (_mac_directory_acl_can_change_entries(parent) if sys.platform == "darwin" else
                      sys.platform == "linux" and bool(
                          {"system.nfs4_acl", "system.richacl"}.intersection(os.listxattr(parent, follow_symlinks=False))))
        if unsafe_acl:
            raise PermissionError(errno.EACCES, "源媒体目录或上级目录允许其他用户移动任务文件夹")


def _reparse(info: os.stat_result) -> bool:
    return bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def _identity(info: os.stat_result) -> tuple[int, int]:
    if not info.st_ino:
        raise ValueError("无法确认保存位置的文件身份")
    return info.st_dev, info.st_ino


def _snapshot(info: os.stat_result) -> tuple:
    return (*_identity(info), info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode, info.st_nlink)


def _target_info(path: Path, directory_fd: int | None = None) -> os.stat_result | None:
    try:
        info = (path.lstat() if directory_fd is None else
                os.stat(path.name, dir_fd=directory_fd, follow_symlinks=False))
    except FileNotFoundError:
        return None
    if not stat.S_ISREG(info.st_mode) or _reparse(info) or info.st_nlink != 1:
        raise ValueError(UNSAFE)
    return info


def _open_windows_pin(path: Path, stack: ExitStack) -> None:
    # Keep each directory name attached to its current object during path-based
    # Windows operations. OPEN_REPARSE_POINT keeps junctions visible to validation.
    from ctypes import wintypes

    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    create_file = kernel.CreateFileW
    create_file.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                            wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    create_file.restype = wintypes.HANDLE
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = create_file(str(path), 0x80, 1, None, 3, 0x02200000, None)
    if handle == wintypes.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    stack.callback(kernel.CloseHandle, handle)
    info = path.lstat()
    if _reparse(info) or stat.S_ISLNK(info.st_mode):
        raise ValueError(CHANGED)


@contextmanager
def _pin_directory(path: Path, expected: tuple[int, int]) -> Iterator[int | None]:
    with ExitStack() as stack:
        fd = None
        if os.name == "nt":
            # A drive/share root itself cannot be renamed. Some SMB servers do
            # not allow handles to the share root, so pin only its descendants.
            for ancestor in reversed((path, *path.parents)):
                if ancestor != Path(ancestor.anchor):
                    _open_windows_pin(ancestor, stack)
        else:
            fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            stack.callback(os.close, fd)
            if _identity(os.fstat(fd)) != expected:
                raise ValueError(CHANGED)
        _check_directory(path, expected)
        yield fd


def _check_directory(path: Path, expected: tuple[int, int]) -> None:
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or _reparse(info) or _identity(info) != expected:
        raise ValueError(CHANGED)
    if path.resolve(strict=True) != path:
        raise ValueError(CHANGED)


@dataclass(frozen=True)
class BurnDestination:
    path: Path
    directory: tuple[int, int]
    original: tuple | None
    mode: int | None
    source: Path
    source_identity: tuple[int, int]
    protected: tuple[Path, ...]

    @classmethod
    def capture(cls, selected: Path, source: Path, *protected: Path) -> BurnDestination:
        name = selected.name
        if (not selected.is_absolute() or selected.suffix.lower() != ".mp4"
                or (os.name == "nt" and (":" in name or PureWindowsPath(name).is_reserved()))):
            raise ValueError(UNSAFE)
        parent = selected.parent.resolve(strict=True)
        path = parent / name
        directory = _identity(parent.stat())
        with _pin_directory(parent, directory) as fd:
            info = _target_info(path, fd)
            result = cls(path, directory, _snapshot(info) if info else None,
                         stat.S_IMODE(info.st_mode) & 0o666 if info else None,
                         source, _identity(source.stat()), protected)
            result._check(fd)
            return result

    def _check(self, fd: int | None) -> None:
        _check_directory(self.path.parent, self.directory)
        if _identity(self.source.stat()) != self.source_identity:
            raise ValueError(CHANGED)
        info = _target_info(self.path, fd)
        if (_snapshot(info) if info else None) != self.original:
            raise ValueError(CHANGED)
        if info is not None and (not info.st_mode & 0o222 or not os.access(self.path, os.W_OK)):
            raise PermissionError(errno.EACCES, "保存目标不可写")
        for protected in (self.source, *self.protected):
            if (os.path.normcase(str(protected.resolve())) == os.path.normcase(str(self.path))
                    or (info is not None and os.path.samestat(info, protected.stat()))):
                raise ValueError(UNSAFE)

    def validate(self) -> None:
        with _pin_directory(self.path.parent, self.directory) as fd:
            self._check(fd)

    @contextmanager
    def stage(self, encoded: Path, check_cancelled: Callable[[], object]) -> Iterator[StagedBurn]:
        with _pin_directory(self.path.parent, self.directory) as fd:
            self._check(fd)
            check_cancelled()
            path = self.path.with_name(f".maw-burn-{secrets.token_hex(16)}.partial")
            stage_fd = os.open(path if fd is None else path.name,
                               os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_BINARY", 0),
                               0o600, dir_fd=fd)
            identity = os.fstat(stage_fd)
            try:
                with os.fdopen(stage_fd, "wb") as sink, encoded.open("rb") as source:
                    size = os.fstat(source.fileno()).st_size
                    if size <= 0:
                        raise ValueError("服务器返回的视频大小无效")
                    copied = 0
                    while chunk := source.read(1024 * 1024):
                        check_cancelled()
                        sink.write(chunk)
                        copied += len(chunk)
                        if copied > size:
                            raise ValueError("视频传输不完整，未保存部分文件")
                    if copied != size:
                        raise ValueError("视频传输不完整，未保存部分文件")
                    if self.mode is not None and fd is not None:
                        os.fchmod(sink.fileno(), self.mode)
                    sink.flush()
                    os.fsync(sink.fileno())
                    staged = _snapshot(os.fstat(sink.fileno()))
                yield StagedBurn(self, path, fd, staged)
            finally:
                _remove_stage(path, fd, identity)


def _remove_stage(path: Path, fd: int | None, identity: os.stat_result) -> None:
    try:
        info = path.lstat() if fd is None else os.stat(path.name, dir_fd=fd, follow_symlinks=False)
        if identity.st_ino and os.path.samestat(info, identity) and not _reparse(info):
            os.unlink(path if fd is None else path.name, dir_fd=fd)
    except FileNotFoundError:
        pass  # The staged file was renamed into place.


def _publish_new(stage: Path, destination: Path, fd: int | None) -> None:
    if fd is None:
        os.rename(stage, destination)  # Windows fails if destination exists.
        return
    mac = sys.platform == "darwin"
    rename = getattr(ctypes.CDLL(None, use_errno=True), "renameatx_np" if mac else "renameat2", None)
    if rename is not None:
        rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
        rename.restype = ctypes.c_int
        if rename(fd, os.fsencode(stage.name), fd, os.fsencode(destination.name), 4 if mac else 1) == 0:
            return  # RENAME_EXCL on Darwin, RENAME_NOREPLACE on Linux.
        code = ctypes.get_errno()
        if code not in {errno.ENOSYS, errno.EOPNOTSUPP, errno.EINVAL}:
            raise OSError(code, os.strerror(code))
    # Still refuses a newly appeared entry. Only supported on volumes with links.
    os.link(stage.name, destination.name, src_dir_fd=fd, dst_dir_fd=fd, follow_symlinks=False)
    os.unlink(stage.name, dir_fd=fd)


@dataclass(frozen=True)
class PublishedBurn:
    path: Path
    directory: tuple[int, int]
    output: tuple
    sync_warning: bool = False


@dataclass(frozen=True)
class StagedBurn:
    target: BurnDestination
    stage: Path
    directory_fd: int | None
    fingerprint: tuple

    def commit(self) -> PublishedBurn:
        target, fd = self.target, self.directory_fd
        info = _target_info(self.stage, fd)
        if info is None or _snapshot(info) != self.fingerprint:
            raise ValueError(CHANGED)
        target._check(fd)
        if target.original is None:
            _publish_new(self.stage, target.path, fd)
        elif fd is None:
            # Verified above. Replacement has no destination-identity predicate.
            os.replace(self.stage, target.path)
        else:
            # The directory fd anchors the parent. A concurrent writer can
            # still change the destination entry before this replacement.
            os.replace(self.stage.name, target.path.name, src_dir_fd=fd, dst_dir_fd=fd)
        sync_warning = False
        if fd is not None:
            # The file was synced before publication. Persist the new directory
            # entry as well, where the filesystem supports directory fsync.
            try:
                os.fsync(fd)
            except OSError as error:
                sync_warning = True
                logging.getLogger(__name__).warning("Burn output directory sync failed (errno=%s)", error.errno)
        try:
            published = _target_info(target.path, fd)
            _check_directory(target.path.parent, target.directory)
        except (OSError, ValueError) as error:
            raise ValueError(UNCONFIRMED) from error
        # Renaming and desktop applications can change metadata such as ctime.
        # Check file identity, size and mtime while still rejecting nonfiles,
        # links and reparse points when publishing or subsequently opening.
        if published is None or _snapshot(published)[:4] != self.fingerprint[:4]:
            raise ValueError(UNCONFIRMED)
        return PublishedBurn(target.path, target.directory, self.fingerprint[:4], sync_warning)


def _system_open(path: Path) -> None:
    if os.name == "nt":
        os.startfile(str(path), "open")
    else:
        with_env = restore_host_library_path(os.environ.copy())
        if sys.platform == "darwin":
            subprocess.run(["/usr/bin/open", str(path)], env=with_env, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
        else:
            command = ["xdg-open", str(path)]
            process = subprocess.Popen(command, env=with_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            try:
                status = process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                # xdg-open may run the application in the foreground. Report
                # submission without waiting for or terminating that app.
                def reap():
                    if status := process.wait():
                        logging.getLogger(__name__).warning("xdg-open exited with status %d", status)

                threading.Thread(target=reap, name="maw-burn-open", daemon=True).start()
            else:
                if status:
                    raise subprocess.CalledProcessError(status, command)


def open_burn_output(output: PublishedBurn, *, folder: bool) -> None:
    with _pin_directory(output.path.parent, output.directory) as fd, ExitStack() as stack:
        if folder:
            _system_open(output.path.parent)
            return
        if os.name == "nt":
            _open_windows_pin(output.path, stack)
        info = _target_info(output.path, fd)
        if info is None or _snapshot(info)[:4] != output.output:
            raise ValueError("保存的视频已移走或变更，无法从此处打开")
        _check_directory(output.path.parent, output.directory)
        # The desktop receives a path. It can resolve that path after these
        # checks, or after the Windows pin is released.
        _system_open(output.path)
