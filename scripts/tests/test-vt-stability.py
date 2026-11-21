#!/usr/bin/env python3
"""Configuration/launcher safety regressions. No router, network or modem access."""
from pathlib import Path
import os
import subprocess
import sys
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

    def run_service_defaults(self, *, have_config=True, failed_service='', fail_commit=False):
        source=(F/'etc/uci-defaults/21-vt-services').read_text()
        with tempfile.TemporaryDirectory() as d:
            d=Path(d); init=d/'init.d'; init.mkdir(); log=d/'log'
            for name in ('vnstat', 'modemmanager', '5gmodem-mm-inhibit', 'network', 'vtmodem-startup'):
                cmd=init/name
                cmd.write_text(f'#!/bin/sh\nprintf "%s %s\\n" "{name}" "$*" >> "{log}"\n'
                               + ('exit 1\n' if name == failed_service else 'exit 0\n'))
                cmd.chmod(0o700)
            original={'network.modem.proto':'t99w175qmi', '5gmodem.sms.cmd_enabled':'0'}
            if have_config:
                original.update({'5gmodem.@5gmodem[0]':'5gmodem',
                                 '5gmodem.@5gmodem[0].auto_setup':'1',
                                 '5gmodem.@5gmodem[0].at_port':'/dev/t99w175-at'})
            state=d/'uci.json'; state.write_text(json.dumps(original))
            uci=d/'uci'
            uci.write_text(f'''#!{sys.executable}
import json, sys
from pathlib import Path
state=Path({str(state)!r}); data=json.loads(state.read_text())
args=sys.argv[1:]
if args and args[0]=='-q': args=args[1:]
if len(args)!=2: sys.exit(2)
operation, value=args
if operation=='get':
    if value not in data: sys.exit(1)
    print(data[value])
elif operation=='set':
    key, setting=value.split('=',1); data[key]=setting
    state.write_text(json.dumps(data))
elif operation=='commit' and value=='5gmodem':
    sys.exit({1 if fail_commit else 0})
else: sys.exit(2)
''')
            uci.chmod(0o700)
            result=subprocess.run(['sh','-c',source.replace('/etc/init.d/',str(init)+'/')],
                                  capture_output=True,text=True,timeout=5,
                                  env={**os.environ,'PATH':str(d)+os.pathsep+os.environ['PATH']})
            return result, original, json.loads(state.read_text()), log.read_text().splitlines()

    def test_competing_services_disabled_and_saved_settings_preserved(self):
        result, before, after, calls=self.run_service_defaults()
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(calls,['vnstat disable','modemmanager disable','5gmodem-mm-inhibit disable'])
        self.assertEqual(after,{**before,'5gmodem.@5gmodem[0].auto_setup':'0'})
        self.assertIn('procd_open_instance vnstat',(F/'etc/init.d/vtmodem-traffic').read_text())

    def test_absent_5gmodem_config_does_not_create_network(self):
        result, before, after, calls=self.run_service_defaults(have_config=False)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(after,before)
        self.assertEqual(len(calls),3)

    def test_service_disable_failure_remains_retryable(self):
        result, before, after, calls=self.run_service_defaults(failed_service='modemmanager')
        self.assertNotEqual(result.returncode,0)
        self.assertEqual(after,before)
        self.assertEqual(calls,['vnstat disable','modemmanager disable'])

    def test_uci_commit_failure_remains_retryable(self):
        result, _, _, _=self.run_service_defaults(fail_commit=True)
        self.assertNotEqual(result.returncode,0)

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
