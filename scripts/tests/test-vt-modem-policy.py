#!/usr/bin/env python3
"""Run the real pinned OpenWrt rootfs service-enable pass on a harmless root.

Fixtures are exact upstream files from openwrt/openwrt commit
6c40bc0bb0e78c67a1f7d8e6d4b048e78951b932:
  include/rootfs.mk
  package/base-files/files/etc/rc.common
Only unrelated package metadata and init service bodies are synthetic.
"""
import importlib.util
import hashlib
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch


REPO = Path(__file__).resolve().parents[2]
FIXTURES = Path(__file__).resolve().parent / 'fixtures'
spec = importlib.util.spec_from_file_location('vt_modem_policy', REPO / 'scripts/apply-modem-policy.py')
policy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(policy)


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content)


class ModemPolicyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='vt-modem-policy-')
        self.addCleanup(self.tmp.cleanup)
        self.workspace = Path(self.tmp.name)
        self.openwrt = self.workspace / 'openwrt'
        self.root = self.workspace / 'root'
        self.rootfs_mk = self.openwrt / 'include/rootfs.mk'
        write(self.rootfs_mk, (FIXTURES / 'openwrt-6c40bc0-rootfs.mk').read_text())
        self.modemswitch = self.openwrt / 'feeds/modem/luci-app-5gmodem/root/usr/share/5gmodem/modemswitch.sh'
        write(self.modemswitch, '''#!/bin/sh
uci -q get '5gmodem.@5gmodem[0].auto_setup' >/dev/null
vt-policy-helper "$@"
''')
        pinned_fixture = patch.object(policy, 'MODEMSWITCH_UPSTREAM_SHA256',
                                      hashlib.sha256(self.modemswitch.read_bytes()).hexdigest())
        pinned_fixture.start()
        self.addCleanup(pinned_fixture.stop)
        write(self.root / 'etc/rc.common', (FIXTURES / 'openwrt-6c40bc0-rc.common').read_text())
        # rc.common's dispatch helper; enable/disable themselves are unchanged.
        write(self.root / 'lib/functions.sh', '''list_contains() {
    case " ${ALL_COMMANDS} " in *" $2 "*) return 0 ;; *) return 1 ;; esac
}
''')
        write(self.root / 'lib/functions/service.sh', '')
        for name, order in [('modemmanager', 70), ('5gmodem-mm-inhibit', 95),
                            ('network', 20), ('vtmodem-startup', 14), ('firewall', 19)]:
            write(self.root / 'etc/init.d' / name,
                  f'#!/bin/sh /etc/rc.common\nSTART={order}\nSTOP=10\n')
        write(self.root / 'usr/lib/opkg/info/fixture.postinst', '#!/bin/sh\nexit 0\n')
        write(self.root / 'usr/lib/opkg/status', 'Package: fixture\nStatus: install ok installed\n')
        write(self.root / 'usr/share/dbus-1/system-services/org.freedesktop.ModemManager1.service',
              '[D-BUS Service]\nName=org.freedesktop.ModemManager1\nExec=/usr/sbin/ModemManager\nUser=root\n')
        write(self.root / 'etc/config/5gmodem', "config 5gmodem\n\toption auto_port '1'\n")
        self.makefile = self.workspace / 'Makefile'
        write(self.makefile, f'''IB :=
SHELL := /bin/bash
CONFIG_USE_APK :=
CONFIG_CLEAN_IPKG :=
CONFIG_USE_MKLIBS :=
SOURCE_DATE_EPOCH :=
XARGS := xargs
file_copy = cp -a $(1) $(2)
include {self.rootfs_mk}
.PHONY: all
all:
\t$(call prepare_rootfs,{self.root},{self.openwrt}/files,firewall)
''')

    def build_root(self):
        result = subprocess.run(['make', '--no-print-directory', '-f', str(self.makefile)],
                                capture_output=True, text=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result.stdout

    def test_upstream_pass_reproduces_conflicting_autostart(self):
        self.build_root()
        self.assertTrue((self.root / 'etc/rc.d/S70modemmanager').is_symlink())
        self.assertTrue((self.root / 'etc/rc.d/S955gmodem-mm-inhibit').is_symlink())

    def test_real_rootfs_pass_disables_competitors_and_applies_guards(self):
        policy.apply(self.openwrt)
        # The real rc.common disable must remove stale entries too.
        rc = self.root / 'etc/rc.d'
        rc.mkdir(parents=True)
        (rc / 'S01modemmanager').symlink_to('../init.d/modemmanager')
        (rc / 'K09modemmanager').symlink_to('../init.d/modemmanager')
        self.build_root()
        for name in ('modemmanager', '5gmodem-mm-inhibit', 'firewall'):
            self.assertEqual(list(rc.glob('*' + name)), [], name)
        for name in ('S20network', 'K10network', 'S14vtmodem-startup', 'K10vtmodem-startup'):
            self.assertTrue((rc / name).is_symlink(), name)
        for relative in ('etc/config/5gmodem',
                         'usr/share/dbus-1/system-services/org.freedesktop.ModemManager1.service'):
            self.assertEqual((self.root / relative).read_bytes(),
                             (REPO / 'port/rootfs-overlay' / relative).read_bytes())
        config = (self.root / 'etc/config/5gmodem').read_text()
        self.assertIn("option auto_setup '0'", config)
        self.assertIn("option auto_port '1'", config)
        guard = (self.root / 'usr/share/dbus-1/system-services/org.freedesktop.ModemManager1.service').read_text()
        self.assertIn('Exec=/bin/false\n', guard)
        self.assertNotIn('Exec=/usr/sbin/ModemManager', guard)
        installed = self.root / policy.MODEMSWITCH_PATH
        policy.validate_modemswitch(installed.read_bytes())
        self.assertTrue(installed.stat().st_mode & 0o111)

    def test_policy_is_idempotent_and_preserves_other_overlay_files(self):
        identity = self.openwrt / 'files/etc/vt-build.json'
        write(identity, '{"fixture":"identity"}\n')
        policy.apply(self.openwrt)
        first = self.rootfs_mk.read_bytes()
        policy.apply(self.openwrt)
        self.assertEqual(self.rootfs_mk.read_bytes(), first)
        self.assertEqual(identity.read_text(), '{"fixture":"identity"}\n')

    def test_changed_or_duplicate_upstream_anchor_fails_closed(self):
        original = self.rootfs_mk.read_text()
        for changed in (original.replace('if ! echo', 'if ! printf'), original + original):
            with self.subTest(duplicate=len(changed) > len(original)):
                self.rootfs_mk.write_text(changed)
                with self.assertRaisesRegex(ValueError, 'service-enable anchor'):
                    policy.apply(self.openwrt)
                self.assertEqual(self.rootfs_mk.read_text(), changed)
                self.assertFalse((self.openwrt / 'files').exists())

    def test_overlay_cannot_follow_a_host_symlink(self):
        host = self.workspace / 'outside'
        host.mkdir()
        files = self.openwrt / 'files'
        files.mkdir()
        (files / 'etc').symlink_to(host)
        original = self.rootfs_mk.read_bytes()
        with self.assertRaisesRegex(ValueError, 'unsafe modem policy path'):
            policy.apply(self.openwrt)
        self.assertEqual(self.rootfs_mk.read_bytes(), original)
        self.assertEqual(list(host.iterdir()), [])

    def shell_environment(self):
        tools = self.workspace / 'bin'
        for name, content in {
            'uci': '#!/bin/sh\nprintf "uci: %s\\n" "$*" >> "$VT_POLICY_TRACE"\ncat "$VT_POLICY_CONFIG"\n',
            'vt-policy-helper': '#!/bin/sh\nprintf "helper: %s\\n" "$*" >> "$VT_POLICY_TRACE"\n',
        }.items():
            path = tools / name
            write(path, content)
            path.chmod(0o755)
        config = self.root / 'etc/config/5gmodem'
        # Simulate a preserved setting which wins over the image's default.
        write(config, "config 5gmodem\n\toption auto_setup '1'\n")
        trace = self.workspace / 'calls.log'
        env = dict(os.environ, PATH=str(tools) + os.pathsep + os.environ['PATH'],
                   VT_POLICY_TRACE=str(trace), VT_POLICY_CONFIG=str(config))
        return env, trace

    def test_autosetup_is_blocked_before_uci_and_helpers_with_restored_config(self):
        policy.apply(self.openwrt)
        env, trace = self.shell_environment()
        # Demonstrate that the synthetic upstream body would call both tools.
        upstream = subprocess.run(['sh', str(self.modemswitch), 'autosetup'],
                                  env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(upstream.returncode, 0, upstream.stderr)
        self.assertEqual(len(trace.read_text().splitlines()), 2)
        trace.unlink()
        guarded = self.openwrt / 'files' / policy.MODEMSWITCH_PATH
        result = subprocess.run([str(guarded), 'autosetup'], env=env,
                                capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse(trace.exists(), 'automatic setup reached UCI or another helper')
        self.assertIn("option auto_setup '1'", (self.root / 'etc/config/5gmodem').read_text())

    def test_manual_arguments_keep_the_unmodified_upstream_body(self):
        policy.apply(self.openwrt)
        env, trace = self.shell_environment()
        guarded = self.openwrt / 'files' / policy.MODEMSWITCH_PATH
        for args in [('resolve',), ('activate', 'manual-path')]:
            with self.subTest(args=args):
                trace.unlink(missing_ok=True)
                result = subprocess.run([str(guarded), *args], env=env,
                                        capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(trace.read_text().splitlines(),
                                 ['uci: -q get 5gmodem.@5gmodem[0].auto_setup',
                                  'helper: ' + ' '.join(args)])

    def test_unreviewed_upstream_blocks_apply_before_any_write(self):
        original = self.rootfs_mk.read_bytes()
        self.modemswitch.write_text(self.modemswitch.read_text() + '# changed upstream\n')
        with self.assertRaisesRegex(ValueError, 'differs from reviewed'):
            policy.apply(self.openwrt)
        self.assertEqual(self.rootfs_mk.read_bytes(), original)
        self.assertFalse((self.openwrt / 'files').exists())

    def test_installed_guard_and_upstream_body_are_both_checked(self):
        good = policy.render_modemswitch(self.modemswitch.read_bytes())
        policy.validate_modemswitch(good)
        with self.assertRaisesRegex(ValueError, 'guard'):
            policy.validate_modemswitch(good.replace(b'autosetup) exit 0', b'autosetup) true'))
        with self.assertRaisesRegex(ValueError, 'differs from reviewed'):
            policy.validate_modemswitch(good + b'echo unexpected-change\n')


if __name__ == '__main__':
    unittest.main()
