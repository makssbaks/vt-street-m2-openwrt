#!/usr/bin/env python3
"""Negative fixtures for firmware packaging validation; no modem operations."""
import importlib.util
from pathlib import Path
import struct
import tempfile
import unittest

script = Path(__file__).resolve().parents[1] / 'validate-vtmodem-root.py'
spec = importlib.util.spec_from_file_location('vt_root', script)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class FirmwareRootTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'root'
        self.source = Path(self.temp.name) / 'source'
        self.contents = {
            'usr/bin/vt-at-locked': '#!/bin/sh\nexec vt-at.real "$@"\n',
            'www/luci-static/resources/view/vtmodem/status.js': 'fixture-status-v18\n',
        }
        for relative, data in self.contents.items():
            source = self.source / relative
            source.parent.mkdir(parents=True, exist_ok=True)
            source.write_text(data)
            target = self.root / module.RENAMED.get(relative, relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(data)
            target.chmod(0o755 if relative.startswith('usr/bin/') else 0o644)
        header = bytearray(52)
        header[:7] = b'\x7fELF\x01\x01\x01'
        struct.pack_into('<H', header, 18, 8)
        for name in ['vt-at.real', 'vt-sms.real']:
            target = self.root / 'usr/bin' / name
            target.write_bytes(header)
            target.chmod(0o755)

    def test_complete_package(self):
        self.assertEqual(len(module.validate(self.root, self.source)), 4)

    def test_stale_page_is_rejected(self):
        (self.root / 'www/luci-static/resources/view/vtmodem/status.js').write_text('old-version')
        with self.assertRaisesRegex(ValueError, 'differs'):
            module.validate(self.root, self.source)

    def test_missing_wrapper_is_rejected(self):
        (self.root / 'usr/bin/vt-at').unlink()
        with self.assertRaisesRegex(ValueError, 'missing regular file'):
            module.validate(self.root, self.source)

    def test_uninstalled_new_source_is_rejected(self):
        (self.source / 'new-helper.uc').write_text('new helper')
        with self.assertRaisesRegex(ValueError, 'missing regular file'):
            module.validate(self.root, self.source)

    def test_nonexecutable_script_is_rejected(self):
        (self.root / 'usr/bin/vt-at').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'executable permission'):
            module.validate(self.root, self.source)

    def test_wrong_architecture_is_rejected(self):
        path = self.root / 'usr/bin/vt-at.real'
        data = bytearray(path.read_bytes())
        struct.pack_into('<H', data, 18, 62)
        path.write_bytes(data)
        with self.assertRaisesRegex(ValueError, 'MIPS ELF'):
            module.validate(self.root, self.source)

    def test_nonexecutable_binary_is_rejected(self):
        (self.root / 'usr/bin/vt-sms.real').chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'executable permission'):
            module.validate(self.root, self.source)

    def test_symlink_to_matching_outside_file_is_rejected(self):
        path = self.root / 'usr/bin/vt-at'
        path.unlink()
        path.symlink_to(self.source / 'usr/bin/vt-at-locked')
        with self.assertRaisesRegex(ValueError, 'symbolic link'):
            module.validate(self.root, self.source)


if __name__ == '__main__':
    unittest.main()
