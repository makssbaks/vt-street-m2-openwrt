#!/usr/bin/env python3
"""Configuration/launcher safety regressions. No router, network or modem access."""
from pathlib import Path
import subprocess
import tempfile
import json
import unittest
R = Path(__file__).resolve().parents[2]
F = R/'package/vtmodem/files'


class StabilityTests(unittest.TestCase):
    def test_no_second_qmi_owner(self):
        seed=(R/'config/seed.config').read_text()
        profile=(R/'port/vertell-profile.mk').read_text()
        self.assertNotIn('CONFIG_PACKAGE_uqmi=y',seed)
        self.assertIn('-uqmi -wwan',profile)
        self.assertIn('+qmi-utils',(R/'package/vtmodem/Makefile').read_text())

    def test_timeout_and_rpc_explicit(self):
        seed=(R/'config/seed.config').read_text()
        for setting in ['CONFIG_BUSYBOX_CUSTOM=y','CONFIG_BUSYBOX_CONFIG_TIMEOUT=y']:
            self.assertIn(setting,seed)
        self.assertIn('+rpcd-mod-ucode',(R/'package/vtmodem/Makefile').read_text())

    def test_only_stock_traffic_autostart_disabled(self):
        source=(F/'etc/uci-defaults/21-vt-services').read_text()
        with tempfile.TemporaryDirectory() as d:
            d=Path(d); cmd=d/'vnstat'; log=d/'log'
            cmd.write_text(f'#!/bin/sh\nprintf "%s\\n" "$*" >> "{log}"\n')
            cmd.chmod(0o700)
            subprocess.run(['sh','-c',source.replace('/etc/init.d/vnstat',str(cmd))],check=True)
            self.assertEqual(log.read_text(),'disable\n')
        self.assertIn('procd_open_instance vnstat',(F/'etc/init.d/vtmodem-traffic').read_text())

    def test_connection_launcher_busy_does_not_execute(self):
        source=(F/'usr/libexec/vtmodem-connection').read_text()
        with tempfile.TemporaryDirectory() as d:
            d=Path(d); source=source.replace('/var/run/vtmodem-connection',str(d/'state'))
            source=source.replace('flock -n 9','false')
            result=subprocess.run(['sh','-c',source],capture_output=True,text=True,check=True)
            self.assertEqual(json.loads(result.stdout)['error_code'],'busy')

    def test_no_network_or_modem_resets_in_helper(self):
        source=(F/'usr/share/vtmodem/connection.uc').read_text()
        for forbidden in ['AT+CFUN','AT^BAND_PREF','AT^LTE_LOCK','power_usb/value','/etc/init.d/network','qmicli','/sbin/reboot']:
            self.assertNotIn(forbidden,source)
        self.assertIn("'network.interface.modem'",source)
        self.assertIn("io.command('down')",source)
        self.assertIn("io.command('up')",source)

    def test_target_gate_is_mandatory(self):
        collect=(R/'scripts/collect-and-validate.sh').read_text()
        self.assertIn('scripts/test-vtmodem-target.sh',collect)
        self.assertLess(collect.index('scripts/test-vtmodem-target.sh'),collect.index('# Promote the candidate'))
        self.assertNotIn('|| true',collect[collect.index('bash "$REPO_DIR/scripts/test-vtmodem-target.sh"'):].splitlines()[0])


if __name__=='__main__': unittest.main()
