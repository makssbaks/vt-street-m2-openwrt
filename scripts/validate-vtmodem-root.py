#!/usr/bin/env python3
"""Check the actual extracted firmware root against this checkout's VT package."""
import argparse
import hashlib
from pathlib import Path
import struct
import sys


RENAMED = {
    'usr/bin/vt-at-locked': 'usr/bin/vt-at',
    'usr/bin/vt-sms-locked': 'usr/bin/vt-sms',
}
EXECUTABLE_PREFIXES = (
    'etc/hotplug.d/', 'etc/init.d/', 'etc/uci-defaults/',
    'lib/netifd/proto/', 'usr/bin/', 'usr/libexec/',
)


def regular_file(root, relative):
    path = root / relative
    # Package scripts are real files; reject a link or linked parent even when
    # it happens to resolve to the expected bytes outside the extracted image.
    for part in [path, *path.parents]:
        if part == root:
            break
        if part.is_symlink():
            raise ValueError(f'{relative}: unexpected symbolic link')
    if not path.is_file():
        raise ValueError(f'{relative}: missing regular file')
    return path


def validate(root, sources):
    entries = sorted(p for p in sources.rglob('*') if p.is_file())
    if not entries:
        raise ValueError('package source files are missing')
    report = []
    for source in entries:
        relative = source.relative_to(sources).as_posix()
        installed = RENAMED.get(relative, relative)
        target = regular_file(root, installed)
        data = source.read_bytes()
        if target.read_bytes() != data:
            raise ValueError(f'{installed}: differs from the checked-out package source')
        if installed.startswith(EXECUTABLE_PREFIXES) and not target.stat().st_mode & 0o111:
            raise ValueError(f'{installed}: executable permission is missing')
        report.append(f'{hashlib.sha256(data).hexdigest()}  /{installed}')

    for relative in ['usr/bin/vt-at.real', 'usr/bin/vt-sms.real', 'usr/bin/vt-traffic-db', 'usr/sbin/vnstatd']:
        target = regular_file(root, relative)
        data = target.read_bytes()
        if (len(data) < 52 or data[:7] != b'\x7fELF\x01\x01\x01'
                or struct.unpack_from('<H', data, 18)[0] != 8):
            raise ValueError(f'{relative}: expected a 32-bit little-endian MIPS ELF helper')
        if not target.stat().st_mode & 0o111:
            raise ValueError(f'{relative}: executable permission is missing')
        if relative == 'usr/sbin/vnstatd' and b'VT_VNSTAT_FLUSH_EXIT_V1' not in data:
            raise ValueError('usr/sbin/vnstatd: final-save acknowledgement patch is missing')
        report.append(f'{hashlib.sha256(data).hexdigest()}  /{relative}')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('root', type=Path, help='root extracted from the sysupgrade squashfs')
    parser.add_argument('--sources', type=Path,
                        default=Path(__file__).resolve().parents[1] / 'package/vtmodem/files')
    args = parser.parse_args()
    try:
        lines = validate(args.root.resolve(), args.sources.resolve())
    except (OSError, ValueError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        return 1
    print('\n===== VT MODEM FILES IN FIRMWARE ROOT =====')
    print('\n'.join(lines))
    print(f'VT_MODEM_ROOT_OK: {len(lines)} installed files verified')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
