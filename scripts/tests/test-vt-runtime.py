#!/usr/bin/env python3
"""Negative cases for the final firmware inventory/dependency gate."""
import importlib.util
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
script = Path(__file__).resolve().parents[1] / 'validate-vt-runtime.py'
spec = importlib.util.spec_from_file_location('vt_runtime', script)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        for rel in m.REQUIRED:
            p = self.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('fixture')
        header = bytearray(52)
        header[:7] = b'\x7fELF\x01\x01\x01'
        struct.pack_into('<H', header, 18, 8)
        self.header = bytes(header)
        self.app = self.root/'usr/bin/unit-app'
        self.app.write_bytes(self.header)

    def test_required_and_mips(self):
        with patch.object(m.subprocess, 'run', return_value=SimpleNamespace(stdout='')):
            self.assertEqual(m.validate(self.root), (1, 0))

    def test_missing_rpc_interpreter_rejected(self):
        (self.root/'usr/lib/rpcd/ucode.so').unlink()
        with self.assertRaisesRegex(ValueError, 'Missing required'):
            m.validate(self.root)

    def test_competing_client_rejected(self):
        (self.root/'sbin/uqmi').touch()
        with self.assertRaisesRegex(ValueError, 'conflicting client'):
            m.validate(self.root)

    def test_host_binary_rejected(self):
        header = bytearray(self.header)
        struct.pack_into('<H', header, 18, 62)
        self.app.write_bytes(header)
        with self.assertRaisesRegex(ValueError, 'architecture'):
            m.validate(self.root)

    def test_missing_shared_library_rejected(self):
        with patch.object(m.subprocess, 'run', return_value=SimpleNamespace(stdout=' 0x1 (NEEDED) Shared library: [libunit.so]\n')):
            with self.assertRaisesRegex(ValueError, 'missing library libunit.so'):
                m.validate(self.root)

    def test_target_absolute_link(self):
        lib = self.root/'lib'
        lib.mkdir(exist_ok=True)
        (lib/'libunit-real.so').write_bytes(self.header)
        (lib/'libunit.so').symlink_to('/lib/libunit-real.so')
        def readelf(args, **kwargs):
            return SimpleNamespace(stdout=' 0x1 (NEEDED) Shared library: [libunit.so]\n' if args[-1].endswith('unit-app') else '')
        with patch.object(m.subprocess, 'run', side_effect=readelf):
            self.assertEqual(m.validate(self.root), (2, 1))


if __name__ == '__main__': unittest.main()
