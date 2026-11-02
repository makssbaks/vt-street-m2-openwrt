#!/usr/bin/env python3
"""Repackage the pinned WH3000 Pro eMMC r1 image for a 24.10.3 upgrade.

The old nand_do_platform_check() requires the old board's tar directory name.
emmc_upgrade_tar() discovers that directory and writes its kernel/root payloads.
This changes only tar paths and CONTROL; payloads and fwtool metadata are kept.
It neither edits a router's checks nor adds supported device IDs.
"""
import argparse
import copy
import hashlib
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

SOURCE_SHA256 = '77d8ef6c158f69a964e803658e13a6ca32ff10a87f26da417197befc1b0b2af8'
CANONICAL = 'sysupgrade-huasifei_wh3000-pro-emmc'
LEGACY = 'sysupgrade-huasifei_wh3000-pro'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def convert(source, output, fwtool):
    source, output, fwtool = map(lambda p: Path(p).resolve(), (source, output, fwtool))
    if output.exists():
        raise ValueError('Output already exists; choose a new file')
    if digest(source.read_bytes()) != SOURCE_SHA256:
        raise ValueError('Source is not the pinned, verified WH3000 Pro eMMC r1 image')
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.wh3000-migration-', dir=output.parent) as temp:
        temp = Path(temp)
        metadata = temp / 'metadata.json'
        subprocess.run([str(fwtool), '-i', str(metadata), str(source)], check=True)
        meta = json.loads(metadata.read_text())
        version = meta['version']
        if (meta['compat_version'] != '1.0' or version['version'] != '25.12.6' or
                version['board'] != 'huasifei_wh3000-pro-emmc' or
                version['target'] != 'mediatek/filogic' or
                set(meta['supported_devices']) != {'huasifei,wh3000-pro', 'huasifei,wh3000-pro-emmc'}):
            raise ValueError('Unexpected board, version or compatibility metadata')
        archive = temp / 'image.bin'
        payloads = {}
        with tarfile.open(source, 'r:') as old:
            members = old.getmembers()
            expected = {CANONICAL, *(CANONICAL + '/' + n for n in ['CONTROL', 'kernel', 'root'])}
            if len(members) != 4 or {m.name.rstrip('/') for m in members} != expected:
                raise ValueError('Unexpected source archive members')
            with tarfile.open(archive, 'w', format=tarfile.USTAR_FORMAT) as new:
                for member in members:
                    changed = copy.copy(member)
                    changed.name = member.name.replace(CANONICAL, LEGACY, 1)
                    if member.isdir():
                        new.addfile(changed)
                        continue
                    if not member.isfile():
                        raise ValueError('Archive links or special files are not allowed')
                    data = old.extractfile(member).read()
                    name = member.name.rsplit('/', 1)[-1]
                    if name == 'CONTROL':
                        if data != b'BOARD=huasifei_wh3000-pro-emmc\n':
                            raise ValueError('Unexpected source CONTROL')
                        data = b'BOARD=huasifei_wh3000-pro\n'
                    else:
                        payloads[name] = {'sha256': digest(data), 'bytes': len(data)}
                        if name == 'kernel' and (data[:4] != bytes.fromhex('d00dfeed') or len(data) >= 16*1024*1024):
                            raise ValueError('Kernel is not the expected FIT image or does not fit')
                        if name == 'root' and (data[:4] != b'hsqs' or len(data) >= 2*1024*1024*1024):
                            raise ValueError('Rootfs is not squashfs or does not fit')
                    changed.size = len(data)
                    new.addfile(changed, io.BytesIO(data))
        subprocess.run([str(fwtool), '-I', str(metadata), str(archive)], check=True)
        check_metadata = temp / 'check-metadata.json'
        subprocess.run([str(fwtool), '-i', str(check_metadata), str(archive)], check=True)
        if check_metadata.read_bytes() != metadata.read_bytes():
            raise ValueError('Metadata changed during repackaging')
        with tarfile.open(archive, 'r:') as check:
            for name, info in payloads.items():
                if digest(check.extractfile(LEGACY + '/' + name).read()) != info['sha256']:
                    raise ValueError('Payload changed during repackaging')
        result = {'source_sha256': SOURCE_SHA256, 'sha256': digest(archive.read_bytes()),
                  'bytes': archive.stat().st_size, 'payloads': payloads,
                  'metadata_unchanged': True, 'hardware_tested': False,
                  'purpose': 'One-time migration from huasifei,wh3000-pro on confirmed eMMC'}
        archive.rename(output)
        return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source')
    parser.add_argument('output')
    parser.add_argument('--fwtool', required=True)
    args = parser.parse_args()
    print(json.dumps(convert(args.source, args.output, args.fwtool), indent=2))
