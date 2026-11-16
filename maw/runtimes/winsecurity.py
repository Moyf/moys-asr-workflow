"""Windows identity and private runtime directories (no environment identity).

Create private directories with their DACL already in place; never repair or
adopt a pre-existing untrusted directory. Validate ancestors against replacement.
"""

from __future__ import annotations

import ctypes as c
from ctypes import wintypes as w
from pathlib import Path

SYSTEM = "S-1-5-18"
ADMINISTRATORS = "S-1-5-32-544"
TRUSTED_INSTALLER = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"


class SecurityError(OSError):
    """Directory identity or access policy cannot be trusted."""


def _api():
    kernel = c.WinDLL("kernel32", use_last_error=True)
    adv = c.WinDLL("advapi32", use_last_error=True)
    declarations = (
        (kernel.GetCurrentProcess, [], w.HANDLE),
        (kernel.CloseHandle, [w.HANDLE], w.BOOL),
        (kernel.LocalFree, [c.c_void_p], c.c_void_p),
        (kernel.CreateDirectoryW, [w.LPCWSTR, c.c_void_p], w.BOOL),
        (adv.OpenProcessToken, [w.HANDLE, w.DWORD, c.POINTER(w.HANDLE)], w.BOOL),
        (adv.GetTokenInformation, [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.POINTER(w.DWORD)], w.BOOL),
        (adv.ConvertSidToStringSidW, [c.c_void_p, c.POINTER(w.LPWSTR)], w.BOOL),
        (adv.ConvertStringSecurityDescriptorToSecurityDescriptorW,
         [w.LPCWSTR, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p], w.BOOL),
        (adv.GetNamedSecurityInfoW,
         [w.LPWSTR, c.c_int, w.DWORD, c.POINTER(c.c_void_p), c.c_void_p,
          c.POINTER(c.c_void_p), c.c_void_p, c.POINTER(c.c_void_p)], w.DWORD),
        (adv.GetAce, [c.c_void_p, w.DWORD, c.POINTER(c.c_void_p)], w.BOOL),
    )
    for function, args, result in declarations:
        function.argtypes, function.restype = args, result
    return kernel, adv


def _check(ok):
    if not ok:
        raise c.WinError(c.get_last_error())


def _sid_string(sid, kernel, adv):
    text = w.LPWSTR()
    _check(adv.ConvertSidToStringSidW(sid, c.byref(text)))
    try:
        return text.value
    finally:
        kernel.LocalFree(text)


def current_user_sid() -> str:
    kernel, adv = _api()
    token = w.HANDLE()
    _check(adv.OpenProcessToken(kernel.GetCurrentProcess(), 0x0008, c.byref(token)))
    try:
        size = w.DWORD()
        adv.GetTokenInformation(token, 1, None, 0, c.byref(size))
        if not size.value:
            raise c.WinError(c.get_last_error())
        data = c.create_string_buffer(size.value)
        _check(adv.GetTokenInformation(token, 1, data, size, c.byref(size)))
        return _sid_string(c.cast(data, c.POINTER(c.c_void_p))[0], kernel, adv)
    finally:
        kernel.CloseHandle(token)


def _descriptor(path: Path, *, include_inherit_only: bool = False):
    kernel, adv = _api()
    owner, dacl, descriptor = c.c_void_p(), c.c_void_p(), c.c_void_p()
    error = adv.GetNamedSecurityInfoW(str(path), 1, 5, c.byref(owner), None,
                                    c.byref(dacl), None, c.byref(descriptor))
    if error:
        raise c.WinError(error)
    try:
        if not dacl.value:
            raise SecurityError("目录没有限制访问的 DACL")
        # ACL header: revision BYTE, reserved BYTE, size WORD, count WORD.
        count = c.cast(dacl, c.POINTER(w.WORD))[2]
        entries = []
        for index in range(count):
            ace = c.c_void_p()
            _check(adv.GetAce(dacl, index, c.byref(ace)))
            header = c.cast(ace, c.POINTER(c.c_ubyte))
            kind, flags = header[0], header[1]
            if flags & 0x08 and not include_inherit_only:
                # Ancestors can grant inherited access: newly created private
                # roots block it. A private root must also protect descendants.
                continue
            if kind == 1:  # Deny ACE: ignoring it is conservative.
                continue
            if kind != 0:
                raise SecurityError("目录包含不支持的访问控制条目")
            mask = c.cast(ace.value + 4, c.POINTER(w.DWORD))[0]
            entries.append((_sid_string(ace.value + 8, kernel, adv), mask))
        return _sid_string(owner, kernel, adv), entries
    finally:
        kernel.LocalFree(descriptor)


def _validate(path: Path, sid: str, *, private: bool):
    info = path.lstat()
    if info.st_file_attributes & 0x400:  # All reparse points, including junctions.
        raise SecurityError("运行时目录链不能包含重解析点")
    if not path.is_dir():
        raise SecurityError("运行时目录链包含非目录对象")
    owner, entries = _descriptor(path, include_inherit_only=private)
    trusted = {sid, SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER}
    if owner not in trusted:
        raise SecurityError("运行时目录属于其他用户")
    # Ancestors may allow creating children, but never replacing existing ones
    # or changing their own security. Private runtime roots also forbid writes.
    dangerous = 0x10000000 | 0x40000000 | 0x000D0040  # GA/GW, DELETE/WRITE_DAC/OWNER/DELETE_CHILD
    if private:
        dangerous |= 0x00000116  # write data/add file, append/add dir, EA, attributes
    if any(account not in trusted and mask & dangerous for account, mask in entries):
        raise SecurityError("运行时目录可被其他用户修改或替换")


def _create_private(path: Path, sid: str):
    kernel, adv = _api()
    descriptor = c.c_void_p()
    sddl = f"O:{sid}D:P(A;OICI;FA;;;{sid})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
    _check(adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, c.byref(descriptor), None))

    class SecurityAttributes(c.Structure):
        _fields_ = [("length", w.DWORD), ("descriptor", c.c_void_p), ("inherit", w.BOOL)]

    attributes = SecurityAttributes(c.sizeof(SecurityAttributes), descriptor, False)
    try:
        if not kernel.CreateDirectoryW(str(path), c.byref(attributes)):
            error = c.get_last_error()
            if error != 183:  # Raced an existing directory: validate, never adopt blindly.
                raise c.WinError(error)
    finally:
        kernel.LocalFree(descriptor)


def private_runtime_root(root: Path, *, create: bool = False):
    """Check before reading a manifest/starting Python; create only at install."""
    sid = current_user_sid()
    chain = list(reversed(root.parents)) + [root]
    for path in chain:
        private = path == root.parent or path == root
        try:
            path.lstat()
        except FileNotFoundError:
            if not create:
                return
            _create_private(path, sid)
        _validate(path, sid, private=private)
