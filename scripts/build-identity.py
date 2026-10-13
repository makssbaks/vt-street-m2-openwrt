#!/usr/bin/env python3
"""Pin verification and an inspectable build identity inside the firmware."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

REPO = Path(__file__).resolve().parents[1]


def git_head(path):
    value = subprocess.check_output(['git', '-C', str(path), 'rev-parse', 'HEAD'], text=True).strip()
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError(f'invalid commit at {path}')
    return value


def feed_pins(text):
    result = {}
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith('#'):
            continue
        match = re.fullmatch(r'src-git ([a-z0-9_-]+) https://github\.com/openwrt/[a-z0-9_-]+\.git\^([0-9a-f]{40})', line)
        if not match or match[1] in result:
            raise ValueError(f'invalid/duplicate feed lock entry: {line}')
        result[match[1]] = match[2]
    if set(result) != {'packages', 'luci', 'routing', 'telephony', 'video'}:
        raise ValueError('feed lock must cover all five configured feeds')
    return result


def verify_feeds(openwrt):
    lock = (REPO / 'config/feeds.conf.lock').read_text()
    if (openwrt / 'feeds.conf').read_text() != lock:
        raise ValueError('OpenWrt feeds.conf does not match the reviewed lock')
    pins = feed_pins(lock)
    for name, expected in pins.items():
        if git_head(openwrt / 'feeds' / name) != expected:
            raise ValueError(f'{name} feed HEAD does not match the lock')
        dirty = subprocess.check_output(['git', '-C', str(openwrt / 'feeds' / name),
                                         'status', '--porcelain', '--untracked-files=no'], text=True)
        if dirty:
            raise ValueError(f'{name} feed has modified tracked source')
    return pins


def feed_patch_plan(openwrt):
    package = openwrt / 'feeds/packages/net/vnstat2'
    makefile = (package / 'Makefile').read_text()
    if not re.search(r'^PKG_VERSION:=2\.13$', makefile, re.M) or not re.search(
            r'^PKG_HASH:=c9fe19312d1ec3ddfbc4672aa951cf9e61ca98dc14cad3d3565f7d9803a6b187$', makefile, re.M):
        raise ValueError('VT final-flush patch requires the reviewed vnstat 2.13 source archive')
    sources = sorted((REPO / 'port/patches/vnstat2').glob('*.patch'))
    if not sources:
        raise ValueError('VT vnstat final-flush patch is missing')
    return [(source, package / 'patches' / source.name) for source in sources]


def verify_feed_patches(openwrt):
    plan = feed_patch_plan(openwrt)
    expected = set()
    hashes = {}
    for source, destination in plan:
        if source.is_symlink() or destination.is_symlink() or not destination.is_file():
            raise ValueError(f'missing/unsafe approved feed patch: {destination}')
        data = source.read_bytes()
        if destination.read_bytes() != data:
            raise ValueError(f'feed patch differs from reviewed port source: {destination}')
        expected.add(destination.relative_to(openwrt / 'feeds/packages').as_posix())
        hashes[destination.relative_to(openwrt / 'feeds').as_posix()] = hashlib.sha256(data).hexdigest()
    feed = openwrt / 'feeds/packages'
    patchdir = feed / 'net/vnstat2/patches'
    tracked = set(subprocess.check_output(['git', '-C', str(feed), 'ls-files', '-z',
                                          '--', 'net/vnstat2/patches'], text=True).split('\0'))
    for path in patchdir.rglob('*'):
        relative = path.relative_to(feed).as_posix()
        if path.is_symlink() or (path.is_file() and relative not in tracked | expected):
            raise ValueError(f'unreviewed vnstat feed patch input: {relative}')
    return hashes


def install_feed_patches(openwrt):
    verify_feeds(openwrt)
    for source, destination in feed_patch_plan(openwrt):
        destination.parent.mkdir(parents=True, exist_ok=True)
        if destination.parent.is_symlink() or destination.is_symlink():
            raise ValueError(f'unsafe feed patch path: {destination}')
        destination.write_bytes(source.read_bytes())
    return verify_feed_patches(openwrt)


def package_version(package):
    # VT Modem currently uses PKG_RELEASE alone. Do not invent PKG_VERSION
    # or change package version semantics merely to populate the identity.
    def value(name):
        match = re.search(r'^' + name + r'[ \t]*:?=[ \t]*(\S+)[ \t]*$', package, re.M)
        return match[1] if match else None
    release = value('PKG_RELEASE')
    if not release:
        raise ValueError('missing PKG_RELEASE')
    version = value('PKG_VERSION')
    return version + '-' + release if version else 'release-' + release


def identity(openwrt):
    dirty = subprocess.check_output(['git', '-C', str(REPO), 'status', '--porcelain',
                                     '--untracked-files=no'], text=True)
    if dirty:
        raise ValueError('commit tracked port changes before producing a release identity')
    for source, _ in feed_patch_plan(openwrt):
        subprocess.run(['git', '-C', str(REPO), 'ls-files', '--error-unmatch', '--',
                        source.relative_to(REPO).as_posix()], check=True,
                       stdout=subprocess.DEVNULL)
    package = (REPO / 'package/vtmodem/Makefile').read_text()
    return {'schema': 1, 'board': 'vertell,vt-mt7621d',
            'source_commit': git_head(REPO), 'openwrt_commit': git_head(openwrt),
            'feeds': verify_feeds(openwrt),
            'feed_patches': verify_feed_patches(openwrt),
            'vtmodem_version': package_version(package)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--feeds-only', action='store_true')
    mode.add_argument('--install-feed-patches', action='store_true')
    mode.add_argument('--verify', action='store_true')
    parser.add_argument('openwrt', type=Path)
    parser.add_argument('rootfs', type=Path, nargs='?')
    args = parser.parse_args()
    try:
        if args.install_feed_patches:
            install_feed_patches(args.openwrt)
            print('Reviewed vnstat final-flush patch installed and verified: OK')
            return
        if args.feeds_only:
            verify_feeds(args.openwrt)
            print('All configured feed commits match the lock: OK')
            return
        result = identity(args.openwrt)
        if args.verify:
            if not args.rootfs:
                raise ValueError('verification needs the extracted rootfs')
            actual = json.loads((args.rootfs / 'etc/vt-build.json').read_text())
            # Build run is informational; immutable source/feeds/version must match.
            if {key: actual.get(key) for key in result} != result:
                raise ValueError('installed build identity does not match source/feeds')
            print('Installed build source/feeds/package identity: OK')
        else:
            run = os.environ.get('GITHUB_RUN_NUMBER', '')
            if run:
                if not run.isdecimal():
                    raise ValueError('invalid GitHub build run number')
                result['build_run'] = int(run)
            dest = args.openwrt / 'files/etc/vt-build.json'
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(json.dumps(result, indent=2, sort_keys=True) + '\n')
            print(f'Build identity written: {dest}')
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        raise SystemExit(f'ERROR: {error}')


if __name__ == '__main__':
    main()
