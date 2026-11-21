#!/usr/bin/env python3
"""Exercise the actual defaults functions against an isolated UCI model."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'package/vtmodem/files/etc/uci-defaults/20-vt-mac'

UCI = '''#!/usr/bin/env python3
import json, os, pathlib, sys
path = pathlib.Path(os.environ['TEST_STATE'])
state = json.loads(path.read_text())
args = [arg for arg in sys.argv[1:] if arg != '-q']
action = args.pop(0)
if action == 'get':
    if args[0] not in state: sys.exit(1)
    print(state[args[0]])
elif action == 'set':
    key, value = args[0].split('=', 1)
    state[key] = value
    state['_sets'] = state.get('_sets', 0) + 1
    path.write_text(json.dumps(state))
elif action == 'commit':
    state['_commits'] = state.get('_commits', 0) + 1
    path.write_text(json.dumps(state))
else: sys.exit(2)
'''


class MacTests(unittest.TestCase):
    def run_defaults(self, state=None, saved='', factory='ffffffffffff', serial='different-modem'):
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            current = {'network.@device[0]': 'device', 'network.@device[0].name': 'br-lan'}
            current.update(state or {})
            (tmp / 'state.json').write_text(json.dumps(current))
            (tmp / 'uci').write_text(UCI)
            (tmp / 'uci').chmod(0o755)
            # Load production definitions, replacing only the hardware/file seams.
            functions = SOURCE.read_text().rsplit('\nmain "$@"', 1)[0]
            (tmp / 'run.sh').write_text(functions + '\n' + '\n'.join((
                'log() { :; }',
                'sleep() { :; }',
                'factory_hex() { printf "%s" ' + shlex.quote(factory) + '; }',
                'find_t99_serial() { printf "%s" ' + shlex.quote(serial) + '; }',
                'saved_mac() { printf "%s" ' + shlex.quote(saved) + '; }',
                'save_mac() { printf "%s" "$1" >"$TEST_SAVED"; }',
                'main',
            )))
            environment = dict(os.environ, PATH=str(tmp) + ':' + os.environ['PATH'],
                               TEST_STATE=str(tmp / 'state.json'), TEST_SAVED=str(tmp / 'saved'))
            result = subprocess.run(['/bin/sh', str(tmp / 'run.sh')], env=environment,
                                    capture_output=True, text=True)
            return result, json.loads((tmp / 'state.json').read_text()), (tmp / 'saved').read_text() if (tmp / 'saved').exists() else None

    def test_custom_bridge_and_lan_are_never_replaced(self):
        state = {'network.@device[0].macaddr': '02:11:22:33:44:55',
                 'network.lan.macaddr': '02:aa:bb:cc:dd:ee'}
        result, actual, saved = self.run_defaults(state, saved='02:99:99:99:99:99')
        self.assertEqual(result.returncode, 0, result.stderr)
        for key, value in state.items():
            self.assertEqual(actual[key], value)
        self.assertNotIn('_sets', actual)
        self.assertIsNone(saved)

    def test_existing_lan_repairs_invalid_bridge_without_new_serial_mac(self):
        result, actual, _ = self.run_defaults({'network.@device[0].macaddr': 'ff:ff:ff:ff:ff:ff',
                                               'network.lan.macaddr': '02:aa:bb:cc:dd:ee'})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(actual['network.@device[0].macaddr'], '02:aa:bb:cc:dd:ee')
        self.assertEqual(actual['network.lan.macaddr'], '02:aa:bb:cc:dd:ee')

    def test_saved_mac_survives_modem_replacement_or_absence(self):
        for serial in ('replacement', ''):
            result, actual, saved = self.run_defaults(saved='02:12:34:56:78:9a', serial=serial)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(actual['network.lan.macaddr'], '02:12:34:56:78:9a')
            self.assertEqual(actual['network.@device[0].macaddr'], '02:12:34:56:78:9a')
            self.assertIsNone(saved)

    def test_fresh_blank_factory_derives_stable_address(self):
        result, actual, saved = self.run_defaults(serial='T99-12345')
        suffix = hashlib.sha256(b'T99-12345').hexdigest()[:10]
        expected = '02:' + ':'.join(suffix[index:index+2] for index in range(0, 10, 2))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(actual['network.lan.macaddr'], expected)
        self.assertEqual(saved, expected)

    def test_valid_factory_does_not_provision_fallback(self):
        result, actual, saved = self.run_defaults(factory='001122AABBCC')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('_sets', actual)
        self.assertIsNone(saved)

    def test_invalid_saved_and_factory_values_are_rejected(self):
        for saved in ('ff:ff:ff:ff:ff:ff', '01:11:22:33:44:55', '00:00:00:00:00:00',
                      '02:xx:22:33:44:55', '021122334455', '02:11:22:33:44:55\nextra'):
            result, actual, _ = self.run_defaults(saved=saved, factory='invalidvalue', serial='')
            self.assertNotEqual(result.returncode, 0)
            self.assertNotIn('_sets', actual)


if __name__ == '__main__':
    unittest.main()
