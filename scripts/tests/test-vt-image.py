#!/usr/bin/env python3
"""Regression checks for malformed firmware and reproducible packaging gates."""
import importlib.util
import io
import json
from pathlib import Path
import struct
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import zlib

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


image = module('image_validator', ROOT / 'scripts/validate-vt-image.py')
profile = module('profile_apply', ROOT / 'scripts/apply-device-profile.py')
identity = module('build_identity', ROOT / 'scripts/build-identity.py')


def kernel(**changes):
    payload = b'test kernel payload\x00' * 10
    fields = dict(magic=0x27051956, hcrc=0, timestamp=0, size=len(payload),
                  load=0x80001000, entry=0x80001000, dcrc=zlib.crc32(payload),
                  os=5, arch=5, type=2, comp=3, name=b'Linux test')
    fields.update(changes)
    header = struct.pack('>7I4B32s', *fields.values())
    header = header[:4] + struct.pack('>I', zlib.crc32(header)) + header[8:]
    return header + payload


def metadata():
    return {'metadata_version': '1.1', 'compat_version': '1.1',
            'new_supported_devices': [image.BOARD],
            'supported_devices': [image.BOARD + ' - Image version mismatch: image 1.1, device 1.0. Please wipe config'],
            'version': {'target': 'ramips/mt7621', 'board': image.PROFILE}}


class ImageTests(unittest.TestCase):
    def test_correct_legacy_uimage(self):
        self.assertEqual(image.validate_uimage(kernel())['payload_crc'], 'OK')

    def test_missing_payload_rejected(self):
        with self.assertRaises(ValueError):
            image.validate_uimage(kernel(size=99999999)[:64])

    def test_corruption_and_truncation_rejected(self):
        original = kernel()
        bad_header = bytearray(original)
        bad_header[20] ^= 1
        bad_payload = bytearray(original)
        bad_payload[-1] ^= 1
        for data in (bad_header, bad_payload, original[:-1], original + b'\x00'):
            with self.subTest(size=len(data)), self.assertRaises(ValueError):
                image.validate_uimage(data)

    def test_semantically_wrong_but_crc_valid_headers_rejected(self):
        for changes in ({'magic': 1}, {'arch': 2}, {'os': 0}, {'type': 4},
                        {'comp': 0}, {'load': 0x80000000}, {'entry': 0x81800000},
                        {'size': 99999999}, {'dcrc': 123}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                image.validate_uimage(kernel(**changes))

    def test_oversized_kernel_rejected(self):
        with self.assertRaises(ValueError):
            image.validate_uimage(kernel() + bytes(image.KERNEL_LIMIT))

    def test_current_dsa_metadata_format_accepted(self):
        image.validate_metadata(metadata())

    def test_wrong_metadata_rejected(self):
        for key, value in (('new_supported_devices', ['other,board']),
                           ('new_supported_devices', [image.BOARD, 'other,board']),
                           ('supported_devices', [image.BOARD]),
                           ('compat_version', '1.0'), ('metadata_version', None),
                           ('version', {'target': 'ramips/mt7620', 'board': image.PROFILE}),
                           ('version', {'target': 'ramips/mt7621', 'board': 'wrong'})):
            meta = metadata()
            meta[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                image.validate_metadata(meta)

    def archive(self, dest, extra=None, wrong_control=False):
        with tarfile.open(dest, 'w') as archive:
            parent = tarfile.TarInfo(image.PREFIX + '/')
            parent.type = tarfile.DIRTYPE
            archive.addfile(parent)
            data = {'CONTROL': ('BOARD=' + ('wrong' if wrong_control else image.PROFILE) + '\n').encode(),
                    'kernel': kernel(), 'root': b'hsqs' + bytes(128)}
            for part, value in data.items():
                member = tarfile.TarInfo(image.PREFIX + '/' + part)
                member.size = len(value)
                archive.addfile(member, io.BytesIO(value))
            if extra:
                archive.addfile(extra)

    def test_exact_archive_and_bad_members(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            path = tmp / 'image.bin'
            self.archive(path)
            image.validate_archive(path, tmp / 'valid')
            self.assertEqual((tmp / 'valid/kernel').read_bytes(), kernel())
            for name in ('../outside', image.PREFIX + '/unexpected', image.PREFIX + '/kernel'):
                self.archive(path, tarfile.TarInfo(name))
                with self.subTest(member=name), self.assertRaises(ValueError):
                    image.validate_archive(path, tmp / 'bad')
            self.archive(path, wrong_control=True)
            with self.assertRaises(ValueError):
                image.validate_archive(path, tmp / 'bad')

    def test_installed_platform_routing(self):
        text = ('platform_do_upgrade() {\n\tcase "$board" in\n\t' + image.BOARD +
                '|\\\n\tother,board)\n\t\tnand_do_upgrade "$1"\n\t\t;;\n\tesac\n}\n')
        image.validate_platform(text)
        for bad in (text.replace('nand_do_upgrade', 'default_do_upgrade'),
                    text.replace(image.BOARD, 'wrong,board'),
                    text.replace('platform_do_upgrade', 'unrelated')):
            with self.assertRaises(ValueError):
                image.validate_platform(bad)

    def test_profile_reapplication_updates_and_is_idempotent(self):
        source = (ROOT / 'port/vertell-profile.mk').read_text()
        upstream = 'define Device/other\n  DEVICE_MODEL := other\nendef\n'
        old = upstream + source.replace('VT-STREET-M2', 'STALE')
        updated = profile.apply_profile(old, source)
        self.assertNotIn('STALE', updated)
        self.assertEqual(updated, profile.apply_profile(updated, source))
        self.assertIn(upstream, updated)
        self.assertEqual(updated.count('define Device/vertell_vt-mt7621d'), 1)

    def test_feed_lock_rejects_floating_heads(self):
        lock = (ROOT / 'config/feeds.conf.lock').read_text()
        pins = identity.feed_pins(lock)
        self.assertEqual(len(pins), 5)
        with self.assertRaises(ValueError):
            identity.feed_pins(lock.replace('^' + pins['luci'], ';openwrt-25.12'))

    def test_release_only_and_optional_full_package_version(self):
        self.assertEqual(identity.package_version('PKG_NAME:=vtmodem\nPKG_RELEASE:=19\n'), 'release-19')
        self.assertEqual(identity.package_version('PKG_VERSION:=2.0\nPKG_RELEASE:=19\n'), '2.0-19')
        with self.assertRaisesRegex(ValueError, 'PKG_RELEASE'):
            identity.package_version('PKG_NAME:=vtmodem\n')

    def test_identity_reads_actual_branch_package_without_pkg_version(self):
        # Keep the real checked-out Makefile. Only absent host Git/feed context
        # is mocked, so a release-only package cannot pass parser tests and then
        # fail inside the real apply/build identity path.
        with patch.object(identity.subprocess, 'check_output', return_value=''), \
             patch.object(identity, 'git_head', return_value='a' * 40), \
             patch.object(identity, 'feed_patch_plan', return_value=[]), \
             patch.object(identity, 'verify_feeds', return_value={'packages': 'b' * 40}), \
             patch.object(identity, 'verify_feed_patches', return_value={}):
            result = identity.identity(Path('/unused-openwrt'))
        self.assertEqual(result['board'], 'vertell,vt-mt7621d')
        self.assertRegex(result['vtmodem_version'], r'^release-[0-9]+$')

    def test_real_feed_checkout_verification(self):
        # A syntactically pinned feeds.conf is insufficient if an existing
        # checkout stayed on another revision or contains edited tracked files.
        with tempfile.TemporaryDirectory() as directory:
            tmp = Path(directory)
            port = tmp / 'port'
            (port / 'config').mkdir(parents=True)
            openwrt = tmp / 'openwrt'
            rows = []
            for name in ('packages', 'luci', 'routing', 'telephony', 'video'):
                feed = openwrt / 'feeds' / name
                feed.mkdir(parents=True)
                subprocess.run(['git', 'init', '-q', str(feed)], check=True)
                (feed / 'tracked').write_text('baseline\n')
                subprocess.run(['git', '-C', str(feed), 'add', 'tracked'], check=True)
                subprocess.run(['git', '-C', str(feed), '-c', 'user.name=Test', '-c',
                                'user.email=test@example.invalid', 'commit', '-qm', 'baseline'], check=True)
                sha = identity.git_head(feed)
                rows.append(f'src-git {name} https://github.com/openwrt/{name}.git^{sha}')
            lock = '\n'.join(rows) + '\n'
            (port / 'config/feeds.conf.lock').write_text(lock)
            (openwrt / 'feeds.conf').write_text(lock)
            previous = identity.REPO
            identity.REPO = port
            try:
                self.assertEqual(len(identity.verify_feeds(openwrt)), 5)
                (openwrt / 'feeds/luci/tracked').write_text('edited\n')
                with self.assertRaisesRegex(ValueError, 'modified tracked source'):
                    identity.verify_feeds(openwrt)
                (openwrt / 'feeds/luci/tracked').write_text('baseline\n')
                altered = lock.replace(rows[1].split('^')[1], '0' * 40)
                (port / 'config/feeds.conf.lock').write_text(altered)
                (openwrt / 'feeds.conf').write_text(altered)
                with self.assertRaisesRegex(ValueError, 'HEAD does not match'):
                    identity.verify_feeds(openwrt)
            finally:
                identity.REPO = previous

    def test_old_builders_fail_before_writing_any_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'must-not-exist.zip'
            for name in ('t99-telemetry', 'sms-web', 'radio-web', 'status-web'):
                result = subprocess.run(['python3', str(ROOT / f'scripts/package-{name}.py'), str(output)],
                                        capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('retired', result.stderr)
                self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
