#!/usr/bin/env python3
"""Apply the board's modem ownership policy before rootfs construction.

OpenWrt's prepare_rootfs enables every init script after package postinsts and
the files overlay have run. Extend its existing disabled-service list, rather
than removing symlinks before OpenWrt would recreate them. The tracked overlay
also prevents D-Bus activation and 5G Modem's automatic WAN setup.
"""
from pathlib import Path
import argparse
import hashlib
import shutil


REPO = Path(__file__).resolve().parents[1]
DISABLED_SERVICES = ('modemmanager', '5gmodem-mm-inhibit')
ORIGINAL = '\t\t\tif ! echo " $(3) " | grep -q " $$(basename $$script) "; then \\\n'
PATCHED = ORIGINAL.replace('" $(3) "', '" $(3) ' + ' '.join(DISABLED_SERVICES) + ' "')
MODEMSWITCH_UPSTREAM_SHA256 = '2e4c96bf92b1ab26844e57d750d35e417a7f8d7c2e304d125897a639d170593c'
MODEMSWITCH_SHEBANG = b'#!/bin/sh\n'
MODEMSWITCH_GUARD = b'''# VT-STREET-M2: preserve the existing t99w175qmi WAN even with restored settings.
case "${1-}" in
    autosetup) exit 0 ;;
esac
'''
MODEMSWITCH_PATH = 'usr/share/5gmodem/modemswitch.sh'


def render_modemswitch(source: bytes) -> bytes:
    """Add only the permanent automatic-setup guard to the reviewed upstream."""
    if hashlib.sha256(source).hexdigest() != MODEMSWITCH_UPSTREAM_SHA256:
        raise ValueError('5G Modem modemswitch.sh differs from reviewed v3.9.43 source')
    if not source.startswith(MODEMSWITCH_SHEBANG):
        raise ValueError('5G Modem modemswitch.sh has an unexpected shell header')
    return MODEMSWITCH_SHEBANG + MODEMSWITCH_GUARD + source[len(MODEMSWITCH_SHEBANG):]


def validate_modemswitch(installed: bytes) -> None:
    """Verify the installed guard and every remaining byte of the upstream body."""
    prefix = MODEMSWITCH_SHEBANG + MODEMSWITCH_GUARD
    if not installed.startswith(prefix):
        raise ValueError('5G Modem permanent autosetup guard is missing or changed')
    original = MODEMSWITCH_SHEBANG + installed[len(prefix):]
    if hashlib.sha256(original).hexdigest() != MODEMSWITCH_UPSTREAM_SHA256:
        raise ValueError('5G Modem guarded modemswitch.sh differs from reviewed v3.9.43 source')


def regular_path(path: Path, boundary: Path):
    """Refuse overlay paths which would follow an existing host symlink."""
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f'unsafe modem policy path: {part}')
        if part == boundary:
            break


def apply(openwrt: Path, overlay: Path = REPO / 'port/rootfs-overlay'):
    openwrt = openwrt.resolve()
    rootfs = openwrt / 'include/rootfs.mk'
    regular_path(rootfs, openwrt)
    source = rootfs.read_text()
    if source.count(ORIGINAL) == 1 and source.count(PATCHED) == 0:
        updated = source.replace(ORIGINAL, PATCHED, 1)
    elif source.count(ORIGINAL) == 0 and source.count(PATCHED) == 1:
        updated = source
    else:
        raise ValueError('expected exactly one reviewed prepare_rootfs service-enable anchor')

    files = []
    regular_path(overlay, REPO)
    for path in sorted(overlay.rglob('*')):
        regular_path(path, overlay)
        if not path.is_file():
            continue
        destination = openwrt / 'files' / path.relative_to(overlay)
        regular_path(destination, openwrt)
        files.append((path, destination))
    expected = {
        'etc/config/5gmodem',
        'usr/share/dbus-1/system-services/org.freedesktop.ModemManager1.service',
    }
    if {p.relative_to(overlay).as_posix() for p, _ in files} != expected:
        raise ValueError('modem policy overlay must contain the reviewed config and D-Bus guard')

    # Saved /etc/config/5gmodem may still say auto_setup=1 at early coldplug,
    # before uci-defaults can update it. Guard this automatic entry point before
    # it sources libraries or queries UCI; manual actions keep the upstream body.
    upstream = openwrt / 'feeds/modem/luci-app-5gmodem/root' / MODEMSWITCH_PATH
    regular_path(upstream, openwrt)
    guarded = render_modemswitch(upstream.read_bytes())
    generated = openwrt / 'files' / MODEMSWITCH_PATH
    regular_path(generated, openwrt)

    if updated != source:
        rootfs.write_text(updated)
    for path, destination in files:
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(path, destination)
        destination.chmod(0o644)
    generated.parent.mkdir(parents=True, exist_ok=True)
    generated.write_bytes(guarded)
    generated.chmod(0o755)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('openwrt', type=Path)
    args = parser.parse_args()
    try:
        apply(args.openwrt)
    except (OSError, ValueError) as error:
        raise SystemExit(f'ERROR: {error}')
    print('VT modem ownership policy: init autostart, D-Bus and automatic WAN setup guarded')
