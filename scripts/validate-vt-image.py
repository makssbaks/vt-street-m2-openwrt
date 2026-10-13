#!/usr/bin/env python3
"""Offline, board-specific checks for the actual VT-STREET-M2 sysupgrade.

fwtool must first extract and CRC-check the appended metadata. Archive members
are copied individually, never extracted by tar with names from the image.
The expected uImage format comes from the pinned ramips Device/Default and the
local Device/nand profile: Linux/MIPS/kernel/LZMA, load and entry 0x80001000.
"""
import argparse
import json
from pathlib import Path
import re
import struct
import tarfile
import zlib

BOARD = 'vertell,vt-mt7621d'
PROFILE = 'vertell_vt-mt7621d'
PREFIX = 'sysupgrade-' + PROFILE
KERNEL_LIMIT = 4 * 1024 * 1024
ROOT_LIMIT = 0x07280000


def require(condition, message):
    if not condition:
        raise ValueError(message)


def validate_uimage(data):
    require(64 < len(data) <= KERNEL_LIMIT, 'kernel size outside 65..4194304 bytes')
    header = data[:64]
    magic, hcrc, timestamp, size, load, entry, dcrc, os_, arch, typ, comp, name = struct.unpack('>7I4B32s', header)
    require(magic == 0x27051956, 'invalid legacy uImage magic')
    require(size == len(data) - 64, 'uImage payload length does not match actual bytes')
    require(zlib.crc32(header[:4] + bytes(4) + header[8:]) == hcrc, 'uImage header CRC mismatch')
    require(zlib.crc32(data[64:]) == dcrc, 'uImage data CRC mismatch')
    require((os_, arch, typ, comp) == (5, 5, 2, 3), 'expected Linux/MIPS/kernel/LZMA uImage')
    require(load == entry == 0x80001000, 'unexpected MT7621 kernel load/entry address')
    return {'kernel_bytes': len(data), 'payload_bytes': size, 'load': f'0x{load:08x}',
            'entry': f'0x{entry:08x}', 'header_crc': 'OK', 'payload_crc': 'OK'}


def validate_metadata(meta):
    require(isinstance(meta, dict), 'metadata must be an object')
    require(meta.get('metadata_version') == '1.1', 'unexpected metadata format')
    # Device/nand inherits dsa-migration. OpenWrt puts the true IDs in
    # new_supported_devices for compat_version != 1.0; supported_devices then
    # contains the intentional legacy mismatch message, not a bare board ID.
    require(meta.get('compat_version') == '1.1', 'unexpected board compatibility version')
    require(meta.get('new_supported_devices') == [BOARD], 'wrong supported device list')
    legacy = meta.get('supported_devices')
    require(isinstance(legacy, list) and len(legacy) == 1 and
            isinstance(legacy[0], str) and
            legacy[0].startswith(BOARD + ' - Image version mismatch: image 1.1,'),
            'missing legacy compatibility guard')
    version = meta.get('version')
    require(isinstance(version, dict) and version.get('target') == 'ramips/mt7621'
            and version.get('board') == PROFILE, 'wrong image target/profile')
    return {'device': BOARD, 'compat_version': '1.1', 'target': version['target']}


def validate_archive(image, destination):
    required = {f'{PREFIX}/{part}' for part in ('CONTROL', 'kernel', 'root')}
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    with tarfile.open(image, mode='r:') as archive:
        members = archive.getmembers()
        names = [member.name.rstrip('/') for member in members]
        require(len(names) == len(set(names)), 'duplicate sysupgrade archive member')
        require(set(names) == required | {PREFIX}, 'unexpected sysupgrade archive layout')
        for member in members:
            if member.name.rstrip('/') == PREFIX:
                require(member.isdir(), 'sysupgrade prefix must be a directory')
                continue
            require(member.isfile(), 'sysupgrade members must be regular files')
            part = member.name.rsplit('/', 1)[1]
            limit = {'CONTROL': 1024, 'kernel': KERNEL_LIMIT, 'root': ROOT_LIMIT}[part]
            require(0 < member.size <= limit, f'invalid {part} member size')
            with archive.extractfile(member) as source:
                data = source.read(limit + 1)
            require(len(data) == member.size, f'truncated {part} member')
            if part == 'CONTROL':
                require(data == f'BOARD={PROFILE}\n'.encode(), 'wrong CONTROL board')
            elif part == 'kernel':
                validate_uimage(data)
            else:
                require(data[:4] == b'hsqs', 'root member is not little-endian squashfs')
            (destination / part).write_bytes(data)
    return validate_uimage((destination / 'kernel').read_bytes())


def validate_platform(text):
    # Check the installed source, and additionally compare it byte-for-byte to
    # the reviewed ported platform.sh in collect-and-validate.sh.
    match = re.search(r'^platform_do_upgrade\(\)\s*\{\n(.*?)^\}', text, re.M | re.S)
    require(match is not None, 'platform_do_upgrade is missing')
    body = match.group(1)
    entry = '\t' + BOARD + '|\\\n'
    require(body.count(entry) == 1, 'missing/duplicate board NAND upgrade entry')
    after = body.split(entry, 1)[1]
    block, separator, _ = after.partition('\n\t\t;;')
    require(bool(separator) and 'nand_do_upgrade "$1"' in block and
            'default_do_upgrade' not in block, 'installed board does not use nand_do_upgrade')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--image', type=Path)
    parser.add_argument('--metadata', type=Path)
    parser.add_argument('--extract-to', type=Path)
    parser.add_argument('--platform', type=Path)
    args = parser.parse_args()
    try:
        if args.platform:
            validate_platform(args.platform.read_text())
            print('Installed NAND upgrade handler: OK')
        else:
            require(all((args.image, args.metadata, args.extract_to)), 'image, metadata and extract-to are required')
            result = validate_metadata(json.loads(args.metadata.read_text()))
            result.update(validate_archive(args.image, args.extract_to))
            print(json.dumps(result, indent=2))
    except (ValueError, OSError, tarfile.TarError) as error:
        raise SystemExit(f'ERROR: {error}')


if __name__ == '__main__':
    main()
