#!/usr/bin/env python3
"""Runtime inventory and ELF dependency closure for the extracted firmware root."""
import argparse
import importlib.util
from pathlib import Path
import os
import re
import struct
import subprocess

policy_spec = importlib.util.spec_from_file_location(
    'vt_modem_policy', Path(__file__).with_name('apply-modem-policy.py'))
modem_policy = importlib.util.module_from_spec(policy_spec)
policy_spec.loader.exec_module(modem_policy)

REQUIRED = [
    'bin/ubus', 'bin/busybox', 'bin/false', 'sbin/netifd', 'sbin/procd', 'sbin/logd',
    'usr/bin/qmicli', 'usr/libexec/qmi-proxy', 'usr/bin/ucode', 'usr/lib/ucode/fs.so',
    'usr/lib/rpcd/ucode.so', 'usr/bin/vt-at.real', 'usr/bin/vt-sms.real',
    'usr/libexec/vtmodem-connection', 'usr/share/vtmodem/connection-worker.uc',
    'etc/uci-defaults/21-vt-services',
]
# 5G Modem uses uqmi and standard QMI/WWAN helpers as dependencies.
# Their presence does not change network.modem.proto=t99w175qmi.
FORBIDDEN = ['usr/sbin/wpad', 'usr/sbin/hostapd']
DISABLED_MODEM_SERVICES = ('modemmanager', '5gmodem-mm-inhibit')
POLICY_OVERLAY = Path(__file__).resolve().parents[1] / 'port/rootfs-overlay'
POLICY_FILES = (
    'usr/share/dbus-1/system-services/org.freedesktop.ModemManager1.service',
    'etc/config/5gmodem',
)
MODEMSWITCH_FILE = 'usr/share/5gmodem/modemswitch.sh'


def resolved(root: Path, path: Path) -> Path:
    """Resolve target absolute links inside root, never against the host filesystem."""
    for _ in range(20):
        if not path.is_symlink():
            return path
        dest = Path(path.readlink())
        path = root / str(dest).lstrip('/') if dest.is_absolute() else path.parent / dest
    raise ValueError(f'Symlink loop: {path}')


def validate(root: Path, elf_only: bool = False) -> tuple[int, int]:
    for rel in [] if elf_only else REQUIRED:
        if not resolved(root, root / rel).is_file():
            raise ValueError(f'Missing required runtime file: {rel}')
    # netifd may retain a harmless wifi stub; only competing clients/daemons are forbidden.
    for rel in [] if elf_only else FORBIDDEN:
        if (root / rel).exists() or (root / rel).is_symlink():
            raise ValueError(f'Unused/conflicting client remains: {rel}')
    # Prevent competing daemon from taking the modem's QMI/AT ports at boot.
    if not elf_only:
        for service in DISABLED_MODEM_SERVICES:
            for link in (root / 'etc/rc.d').glob('S*' + service):
                if link.exists() or link.is_symlink():
                    raise ValueError(f'Conflicting {service} autostart: {link.relative_to(root)}')
        # Disabling init alone does not stop mmcli from requesting D-Bus
        # activation, nor 5G Modem coldplug from configuring another interface.
        # Check the actual image against the reviewed board overlays.
        for rel in (*POLICY_FILES, MODEMSWITCH_FILE):
            path = root / rel
            for part in (path, *path.parents):
                if part == root:
                    break
                if part.is_symlink():
                    raise ValueError(f'Unsafe modem isolation policy symlink: {rel}')
            if not path.is_file():
                raise ValueError(f'Modem isolation policy missing or differs: {rel}')
            if rel == MODEMSWITCH_FILE:
                modem_policy.validate_modemswitch(path.read_bytes())
                if not path.stat().st_mode & 0o111:
                    raise ValueError(f'Modem autosetup guard is not executable: {rel}')
            elif path.read_bytes() != (POLICY_OVERLAY / rel).read_bytes():
                raise ValueError(f'Modem isolation policy missing or differs: {rel}')
    elf_count = deps = 0
    for path in root.rglob('*'):
        if path.is_symlink() or not path.is_file():
            continue
        with path.open('rb') as stream:
            header = stream.read(52)
        if not header.startswith(b'\x7fELF'):
            continue
        if len(header) < 52 or header[:7] != b'\x7fELF\x01\x01\x01' or struct.unpack_from('<H', header, 18)[0] != 8:
            raise ValueError(f'Unexpected executable architecture: {path.relative_to(root)}')
        elf_count += 1
        out = subprocess.run(['readelf', '-dW', str(path)], capture_output=True,
                             text=True, check=True, timeout=10,
                             env={**os.environ, 'LC_ALL': 'C'}).stdout
        for name in re.findall(r'\(NEEDED\).*?\[([^\]]+)\]', out):
            if not re.fullmatch(r'[A-Za-z0-9_.+\-]+', name):
                raise ValueError(f'Unexpected library reference: {name}')
            if not any(resolved(root, root / directory / name).is_file() for directory in ['lib', 'usr/lib']):
                raise ValueError(f'{path.relative_to(root)} needs missing library {name}')
            deps += 1
    return elf_count, deps


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path)
    parser.add_argument('--elf-only', action='store_true', help='Audit older roots without the new inventory policy')
    args = parser.parse_args()
    count, dependencies = validate(args.root.resolve(), args.elf_only)
    print(f'VT_RUNTIME_OK: {count} MIPS ELF files; {dependencies} library references resolved; ELF dependency closure checked')
