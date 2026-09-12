#!/usr/bin/env python3
"""Host-only state-machine tests. Never access a modem or the host network."""
from __future__ import annotations

import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'package/vtmodem/files/usr/libexec/t99w175-net-ready'
HOTPLUG = ROOT / 'package/vtmodem/files/etc/hotplug.d/usb/03_t99w175'
INIT = ROOT / 'package/vtmodem/files/etc/init.d/vtmodem-startup'
SOURCE = HELPER.read_text()
assert SOURCE.endswith('main "$@"\n')
LIBRARY = SOURCE.removesuffix('main "$@"\n')

HARNESS = r'''
. "$SOURCE"
LOCKFILE="$WORK/lock"
log() { printf 'log %s\n' "$*" >>"$WORK/trace"; }
sleep() { printf 'sleep %s\n' "$*" >>"$WORK/trace"; }
device_ready() {
    printf 'device\n' >>"$WORK/trace"
    [ "$MOCK_DEVICE" = 1 ]
}
uci() {
    [ "$1" = -q ] && [ "$2" = get ] || return 98
    case "$3" in
        network.modem.proto) printf '%s\n' "$MOCK_CONFIG_PROTO" ;;
        network.modem.auto) printf '%s\n' "$MOCK_AUTO" ;;
        network.modem.disabled) printf '%s\n' "$MOCK_DISABLED" ;;
        *) return 98 ;;
    esac
}
ubus() {
    [ "$1" = -t ] && [ "$2" = 3 ] && [ "$3" = call ] || return 98
    shift 3
    printf 'ubus %s\n' "$*" >>"$WORK/trace"
    case "$1/$2" in
        network.interface.modem/status)
            count=$(cat "$WORK/count")
            count=$((count + 1))
            printf '%s\n' "$count" >"$WORK/count"
            [ "$count" -gt "$MOCK_STATUS_FAILURES" ] || return 1
            printf 'mock-status\n'
            ;;
        network.interface/notify_proto)
            [ "$3" = '{"interface":"modem","action":5,"available":true}' ] || return 98
            return "$MOCK_NOTIFY_RC"
            ;;
        network.interface.modem/up)
            [ "$3" = '{}' ] || return 98
            return "$MOCK_UP_RC"
            ;;
        *) return 98 ;;
    esac
}
jsonfilter() {
    [ "$1" = -s ] && [ "$2" = mock-status ] && [ "$3" = -e ] || return 98
    case "$4" in
        '@.proto') printf '%s\n' "$MOCK_PROTO" ;;
        '@.up') printf '%s\n' "$MOCK_UP" ;;
        '@.pending') printf '%s\n' "$MOCK_PENDING" ;;
        '@.available') printf '%s\n' "$MOCK_AVAILABLE" ;;
        '@.autostart') printf '%s\n' "$MOCK_AUTOSTART" ;;
        *) return 98 ;;
    esac
}
main
'''

DEFAULTS = {
    'DEVICE': '1', 'CONFIG_PROTO': 't99w175qmi', 'AUTO': '', 'DISABLED': '',
    'PROTO': 't99w175qmi', 'UP': 'false', 'PENDING': 'false',
    'AVAILABLE': 'true', 'AUTOSTART': 'true', 'STATUS_FAILURES': '0',
    'NOTIFY_RC': '0', 'UP_RC': '0',
}
# name, mock overrides, expected result, notify count, up count, status count
CASES = [
    ('available idle interface', {}, 0, 0, 1, 1),
    ('restore NO_DEVICE availability', {'AVAILABLE': 'false'}, 0, 1, 0, 1),
    ('already connected', {'UP': 'true'}, 0, 0, 0, 1),
    ('connection pending', {'PENDING': 'true'}, 0, 0, 0, 1),
    ('manual runtime disconnect', {'AUTOSTART': 'false'}, 0, 0, 0, 1),
    ('UCI auto=0', {'AUTO': '0'}, 0, 0, 0, 0),
    ('UCI auto=false', {'AUTO': 'false'}, 0, 0, 0, 0),
    ('disabled interface', {'DISABLED': '1'}, 0, 0, 0, 0),
    ('different configured modem', {'CONFIG_PROTO': 'ncm'}, 0, 0, 0, 0),
    ('different running protocol', {'PROTO': 'ncm'}, 0, 0, 0, 1),
    ('USB absent/not ready', {'DEVICE': '0'}, 0, 0, 0, 0),
    ('late netifd object', {'STATUS_FAILURES': '3'}, 0, 0, 1, 4),
    ('netifd absent: bounded stop', {'STATUS_FAILURES': '999'}, 1, 0, 0, 60),
    ('missing autostart: fail closed', {'AUTOSTART': ''}, 1, 0, 0, 60),
    ('missing pending: fail closed', {'PENDING': ''}, 1, 0, 0, 60),
    ('missing availability: fail closed', {'AVAILABLE': ''}, 1, 0, 0, 60),
    ('notify failure: no forced up', {'AVAILABLE': 'false', 'NOTIFY_RC': '1'}, 1, 60, 0, 60),
    ('up failure: bounded retries', {'UP_RC': '1'}, 1, 0, 60, 60),
]

def check_shell(shell: list[str]) -> int:
    for path in (HELPER, HOTPLUG, INIT):
        subprocess.run([*shell, '-n', str(path)], check=True)
    passed = 0
    for name, overrides, code, notify, up, status in CASES:
        with tempfile.TemporaryDirectory(prefix='vt-start-test-') as tmp:
            work = Path(tmp)
            library = work / 'library.sh'
            library.write_text(LIBRARY)
            (work / 'count').write_text('0\n')
            (work / 'trace').touch()
            env = dict(os.environ, SOURCE=str(library), WORK=tmp)
            env.update({f'MOCK_{k}': v for k, v in (DEFAULTS | overrides).items()})
            p = subprocess.run([*shell, '-c', HARNESS], env=env, text=True,
                               capture_output=True, timeout=15)
            trace = (work / 'trace').read_text().splitlines()
            actual = (p.returncode,
                      sum(x.startswith('ubus network.interface notify_proto ') for x in trace),
                      sum(x == 'ubus network.interface.modem up {}' for x in trace),
                      sum(x == 'ubus network.interface.modem status' for x in trace))
            expected = (code, notify, up, status)
            assert actual == expected, (name, actual, expected, p.stderr, trace)
            with (work / 'lock').open('a') as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            print(f'PASS [{" ".join(shell)}] {name}')
            passed += 1
    # Kernel lock held by another process: a second worker must do nothing.
    with tempfile.TemporaryDirectory(prefix='vt-start-lock-') as tmp:
        work = Path(tmp)
        (work / 'library.sh').write_text(LIBRARY)
        (work / 'trace').touch()
        (work / 'count').write_text('0\n')
        env = dict(os.environ, SOURCE=str(work / 'library.sh'), WORK=tmp)
        env.update({f'MOCK_{k}': v for k, v in DEFAULTS.items()})
        with (work / 'lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            p = subprocess.run([*shell, '-c', HARNESS], env=env,
                               capture_output=True, timeout=5)
            assert p.returncode == 0
            assert not (work / 'trace').read_text()
        print(f'PASS [{" ".join(shell)}] duplicate worker rejected')
        passed += 1
    return passed


def main() -> None:
    shells = [['/bin/sh']]
    if shutil.which('busybox'):
        shells.append(['busybox', 'ash'])
    total = sum(check_shell(shell) for shell in shells)
    makefile = (ROOT / 'package/vtmodem/Makefile').read_text()
    assert '+flock ' in makefile and '+jsonfilter ' in makefile
    assert '$(1)/usr/libexec/t99w175-net-ready' in makefile
    assert '$(1)/etc/init.d/vtmodem-startup' in makefile
    hotplug = HOTPLUG.read_text()
    assert '/usr/libexec/t99w175-net-ready </dev/null >/dev/null 2>&1 &' in hotplug
    assert 'ifup modem' not in hotplug
    # The helper itself has no command path to reset or query the modem.
    for token in ('qmicli ', 'vt-at ', 'ifup ', 'ifdown ', 'power_usb/value'):
        assert not any(token in line for line in SOURCE.splitlines()
                       if line.strip() and not line.lstrip().startswith('#'))
    print(f'PASS: {total} isolated state/locking cases + syntax/package checks.')
    print('NOT TESTED: physical USB enumeration, real netifd integration, LTE or SMS.')

if __name__ == '__main__':
    main()
