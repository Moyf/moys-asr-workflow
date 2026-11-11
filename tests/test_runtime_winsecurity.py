"""Identity, pre-created directory rejection, and actual Windows DACL creation."""

from __future__ import annotations

import os
import contextlib
import ctypes as c
from ctypes import wintypes as w
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock
from uuid import uuid4

from maw.runtimes import pathwin, winsecurity as security
from maw.runtimes import LOCAL

SID = "S-1-5-21-1-2-3-1001"
OTHER = "S-1-5-21-4-5-6-1001"


@contextlib.contextmanager
def private_fixture():
    folder = Path.home() / ('maw-security-test-' + uuid4().hex)
    security._create_private(folder, security.current_user_sid())
    try:
        yield folder
    finally:
        shutil.rmtree(folder)


class RuntimeSecurityPolicyTests(unittest.TestCase):
    def test_explicit_fallback_is_checked_before_junction_resolution(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'account' / 'runtime'
            target = Path(folder) / 'attacker'
            with mock.patch.object(pathwin.sys, 'platform', 'win32'), \
                    mock.patch.object(pathwin, 'fallback_root', return_value=root), \
                    mock.patch.object(Path, 'resolve', return_value=target), \
                    mock.patch.object(security, 'private_runtime_root', side_effect=security.SecurityError('junction')):
                with self.assertRaises(pathwin.AsciiRootUnavailable):
                    LOCAL.resolve_root(root)

    def test_default_accounts_have_no_user_owned_shared_parent(self):
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.dict(os.environ, {'PROGRAMDATA': folder, 'MAW_RUNTIME_ASCII_ROOT': ''}):
            roots = []
            for sid in (SID, OTHER):
                with mock.patch.object(security, 'current_user_sid', return_value=sid):
                    roots.append(pathwin.fallback_root('runtime'))
            self.assertNotEqual(roots[0].parent, roots[1].parent)
            self.assertEqual(roots[0].parent.parent, Path(folder))
            self.assertEqual(roots[1].parent.parent, Path(folder))

    def test_owner_and_write_permissions_reject_untrusted_directory(self):
        path = mock.Mock()
        path.lstat.return_value = SimpleNamespace(st_file_attributes=0)
        path.is_dir.return_value = True
        for owner, entries in ((OTHER, [(SID, 0x1F01FF)]), (SID, [(OTHER, 0x1F01FF)]),
                               (SID, [(OTHER, 0x40)]), (SID, [(OTHER, 0x40000)])):
            with self.subTest(owner=owner, entries=entries), \
                    mock.patch.object(security, '_descriptor', return_value=(owner, entries)):
                with self.assertRaises(security.SecurityError):
                    security._validate(path, SID, private=True)

    def test_junction_is_rejected_before_reading_security_descriptor(self):
        path = mock.Mock()
        path.lstat.return_value = SimpleNamespace(st_file_attributes=0x400)
        with mock.patch.object(security, '_descriptor') as read:
            with self.assertRaises(security.SecurityError):
                security._validate(path, SID, private=True)
            read.assert_not_called()

    def test_relocated_and_explicit_fallback_are_checked_before_use(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'account' / 'runtime'
            with mock.patch.object(pathwin.sys, 'platform', 'win32'), \
                    mock.patch.object(pathwin, 'fallback_root', return_value=root), \
                    mock.patch.object(pathwin, 'ascii_alias', side_effect=lambda p: p), \
                    mock.patch.object(security, 'private_runtime_root', side_effect=security.SecurityError('untrusted')):
                for supplied, relocate in ((Path(folder) / '中文' / 'runtime', True), (root, False)):
                    with self.subTest(relocate=relocate), self.assertRaises(pathwin.AsciiRootUnavailable):
                        pathwin.ensure_ascii_root(supplied, dir_name='runtime', allow_relocate=relocate)

    def test_same_name_different_token_users_do_not_share_root(self):
        with mock.patch.dict(os.environ, {'USERNAME': 'same', 'MAW_RUNTIME_ASCII_ROOT': 'runtime-test'}):
            with mock.patch.object(security, 'current_user_sid', return_value=SID):
                first = pathwin.fallback_root('local-runtime')
            with mock.patch.object(security, 'current_user_sid', return_value=OTHER):
                second = pathwin.fallback_root('local-runtime')
        self.assertNotEqual(first, second)


@unittest.skipUnless(sys.platform == 'win32', 'Actual Windows token and ACL APIs')
class WindowsSecurityIntegrationTests(unittest.TestCase):
    def test_inherit_only_write_grants_cannot_make_child_executables_public(self):
        with private_fixture() as folder:
            root = folder / 'runtime'
            sid = security.current_user_sid()
            kernel, adv = security._api()
            descriptor = c.c_void_p()
            sddl = f'O:{sid}D:P(A;OICI;FA;;;{sid})(A;OIIO;FA;;;WD)'
            security._check(adv.ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl, 1, c.byref(descriptor), None))

            class Attributes(c.Structure):
                _fields_ = [('length', w.DWORD), ('descriptor', c.c_void_p), ('inherit', w.BOOL)]

            attrs = Attributes(c.sizeof(Attributes), descriptor, False)
            try:
                security._check(kernel.CreateDirectoryW(str(root), c.byref(attrs)))
            finally:
                kernel.LocalFree(descriptor)
            executable = root / 'python.exe'
            executable.write_bytes(b'synthetic executable')
            _, entries = security._descriptor(executable)
            self.assertTrue(any(account == 'S-1-1-0' and mask & 2 for account, mask in entries))
            with self.assertRaises(security.SecurityError):
                security.private_runtime_root(root)

    def test_token_identity_is_independent_of_environment(self):
        original = security.current_user_sid()
        with mock.patch.dict(os.environ, {'USERNAME': 'other', 'USERDOMAIN': 'other', 'USERPROFILE': 'fake'}):
            self.assertEqual(security.current_user_sid(), original)
        self.assertTrue(original.startswith('S-1-'))

    def test_atomic_private_creation_and_reuse(self):
        # The system temp directory can deliberately grant other sandbox users
        # modify rights. Use the profile for this actual private-directory test.
        with private_fixture() as folder:
            root = Path(folder) / 'account' / 'runtime'
            security.private_runtime_root(root)
            self.assertFalse(root.exists())
            security.private_runtime_root(root, create=True)
            security.private_runtime_root(root)
            owner, entries = security._descriptor(root)
            sid = security.current_user_sid()
            self.assertEqual(owner, sid)
            self.assertEqual({account for account, _ in entries}, {sid, security.SYSTEM, security.ADMINISTRATORS})
            (root / 'probe').write_bytes(b'works')

    def test_existing_world_writable_root_is_not_adopted_or_repaired(self):
        with private_fixture() as folder:
            root = Path(folder) / 'account' / 'runtime'
            security.private_runtime_root(root, create=True)
            real = security._descriptor

            def injected(path, **kwargs):
                owner, entries = real(path, **kwargs)
                return (owner, entries + [('S-1-1-0', 0x1F01FF)]) if path == root else (owner, entries)

            with mock.patch.object(security, '_descriptor', side_effect=injected), \
                    mock.patch.object(security, '_create_private') as create:
                with self.assertRaises(security.SecurityError):
                    security.private_runtime_root(root, create=True)
                create.assert_not_called()
