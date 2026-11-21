#!/usr/bin/env python3
"""Negative cases for the final firmware inventory/dependency gate."""
import importlib.util
import hashlib
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
        for rel in m.POLICY_FILES:
            p = self.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes((m.POLICY_OVERLAY / rel).read_bytes())
        # Use a harmless upstream body; the production fingerprint is separately
        # checked when the pinned feed is ported, before compilation.
        source=b'#!/bin/sh\nprintf "runtime fixture\\n"\n'
        fingerprint=patch.object(m.modem_policy, 'MODEMSWITCH_UPSTREAM_SHA256',
                                 hashlib.sha256(source).hexdigest())
        fingerprint.start()
        self.addCleanup(fingerprint.stop)
        guard=self.root / m.MODEMSWITCH_FILE
        guard.parent.mkdir(parents=True, exist_ok=True)
        guard.write_bytes(m.modem_policy.render_modemswitch(source))
        guard.chmod(0o755)
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

    def test_uqmi_helper_allowed(self):
        (self.root/'sbin/uqmi').touch()
        with patch.object(m.subprocess, 'run', return_value=SimpleNamespace(stdout='')):
            self.assertEqual(m.validate(self.root), (1, 0))

    def test_modemmanager_autostart_rejected(self):
        autostart = self.root/'etc/rc.d/S50modemmanager'
        autostart.parent.mkdir(parents=True, exist_ok=True)
        autostart.symlink_to('../init.d/modemmanager')
        with self.assertRaisesRegex(ValueError, 'modemmanager autostart'):
            m.validate(self.root)

    def test_inhibitor_autostart_rejected(self):
        autostart = self.root/'etc/rc.d/S95-5gmodem-mm-inhibit'
        autostart.parent.mkdir(parents=True, exist_ok=True)
        autostart.symlink_to('../init.d/5gmodem-mm-inhibit')
        with self.assertRaisesRegex(ValueError, '5gmodem-mm-inhibit autostart'):
            m.validate(self.root)

    def test_dbus_activation_of_modemmanager_rejected(self):
        activation = self.root / m.POLICY_FILES[0]
        activation.write_text(activation.read_text().replace('Exec=/bin/false', 'Exec=/usr/sbin/ModemManager'))
        with self.assertRaisesRegex(ValueError, 'Modem isolation policy'):
            m.validate(self.root)

    def test_missing_modem_policy_rejected(self):
        (self.root / m.POLICY_FILES[1]).unlink()
        with self.assertRaisesRegex(ValueError, 'Modem isolation policy'):
            m.validate(self.root)

    def test_autosetup_reenabled_rejected(self):
        config = self.root / m.POLICY_FILES[1]
        config.write_text(config.read_text().replace("option auto_setup '0'", "option auto_setup '1'"))
        with self.assertRaisesRegex(ValueError, 'Modem isolation policy'):
            m.validate(self.root)

    def test_policy_link_to_host_rejected(self):
        config = self.root / m.POLICY_FILES[1]
        config.unlink()
        config.symlink_to(m.POLICY_OVERLAY / m.POLICY_FILES[1])
        with self.assertRaisesRegex(ValueError, 'policy symlink'):
            m.validate(self.root)

    def test_missing_permanent_autosetup_guard_rejected(self):
        guard = self.root / m.MODEMSWITCH_FILE
        guard.write_bytes(guard.read_bytes().replace(m.modem_policy.MODEMSWITCH_GUARD, b'', 1))
        with self.assertRaisesRegex(ValueError, 'autosetup|guard'):
            m.validate(self.root)

    def test_modified_manual_modem_actions_rejected(self):
        guard = self.root / m.MODEMSWITCH_FILE
        guard.write_bytes(guard.read_bytes() + b'\n# unexpected upstream change\n')
        with self.assertRaisesRegex(ValueError, 'SHA256|source|fingerprint'):
            m.validate(self.root)

    def test_nonexecutable_autosetup_guard_rejected(self):
        (self.root / m.MODEMSWITCH_FILE).chmod(0o644)
        with self.assertRaisesRegex(ValueError, 'not executable'):
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
