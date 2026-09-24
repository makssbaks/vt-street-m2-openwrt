#!/usr/bin/env python3
"""Apply the patch to exact upstream 2.13 and execute its shutdown code.

The fixture is the complete GPL-2.0 vnstatd.c from upstream tag v2.13 (license
retained in the file). Only database and unrelated cleanup calls are stubbed;
the tested shutdown and capability statements are extracted from patched C.
"""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
PATCH = ROOT / 'port/patches/vnstat2/910-vt-flush-exit-status.patch'
FIXTURE = ROOT / 'scripts/tests/fixtures/vnstat-2.13-vnstatd.c'
SOURCE_SHA256 = '67aaca70427fe168141a80e600b9ff3ac4a75575e6e3fbffc1fd2aafda9a559f'
DBSQL_FIXTURE = ROOT / 'scripts/tests/fixtures/vnstat-2.13-dbsql.c'
DBSQL_SHA256 = '4a0b69350d115a206b42f51e4b1fd664a9dbe813b7ae93b0462837c7f7594cf7'
SOURCE_ARCHIVE_SHA256 = 'c9fe19312d1ec3ddfbc4672aa951cf9e61ca98dc14cad3d3565f7d9803a6b187'

spec = importlib.util.spec_from_file_location('identity', ROOT / 'scripts/build-identity.py')
identity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(identity)


class FlushPatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.work = Path(cls.directory.name)
        (cls.work / 'src').mkdir()
        original = FIXTURE.read_bytes()
        assert hashlib.sha256(original).hexdigest() == SOURCE_SHA256
        (cls.work / 'src/vnstatd.c').write_bytes(original)
        dbsql = DBSQL_FIXTURE.read_bytes()
        assert hashlib.sha256(dbsql).hexdigest() == DBSQL_SHA256
        (cls.work / 'src/dbsql.c').write_bytes(dbsql)
        result = subprocess.run(['patch', '--batch', '--fuzz=0', '-p1', '-i', str(PATCH)],
                                cwd=cls.work, capture_output=True, text=True)
        assert result.returncode == 0, result.stdout + result.stderr
        cls.source = (cls.work / 'src/vnstatd.c').read_text()

    @classmethod
    def tearDownClass(cls):
        cls.directory.cleanup()

    def compile(self, name, code):
        path = self.work / (name + '.c')
        path.write_text(code)
        binary = self.work / name
        subprocess.run(['cc', '-std=c99', '-Wall', '-Werror', str(path), '-o', str(binary)], check=True)
        return str(binary)

    def test_exit_reflects_save_and_close_errors(self):
        shutdown = self.source.split('\tflushcachetodisk(&s);\n', 1)[1].split('\nvoid showhelp', 1)[0]
        shutdown = '\tflushcachetodisk(&s);\n' + shutdown
        binary = self.compile('shutdown', '''
#include <stdlib.h>
#include <unistd.h>
#define SQLITE_OK 0
typedef struct { int rundaemon; void *dcache; } DSTATE;
struct { const char *pidfile; } cfg;
int db_errcode, debug, pidfile;
void flushcachetodisk(DSTATE *s) { (void)s; db_errcode = atoi(getenv("SAVE_ERROR")); }
int db_close(void) { db_errcode = 0; return !atoi(getenv("CLOSE_ERROR")); }
void datacache_clear(void **p) { (void)p; }
void ibwflush(void) { }
int main(void) {
    DSTATE s = {0};
    int flush_failed;
''' + shutdown)
        for save_error, close_error, expected in [(0, 0, 0), (5, 0, 1), (6, 0, 1),
                                                   (10, 0, 1), (13, 0, 1), (0, 1, 1), (5, 1, 1)]:
            with self.subTest(save_error=save_error, close_error=close_error):
                result = subprocess.run([binary], env=dict(os.environ, SAVE_ERROR=str(save_error),
                                                          CLOSE_ERROR=str(close_error)))
                self.assertEqual(result.returncode, expected)

    def test_capability_is_read_only_and_requires_exact_option(self):
        block = self.source.split('\t/* Private supervisor capability:', 1)[1].split('\n\tinitdstate(&s);', 1)[0]
        binary = self.compile('capability', '''
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
int main(int argc, char **argv) {
    /* Private supervisor capability:''' + block + '\nreturn 77;\n}\n')
        result = subprocess.run([binary, '--vt-flush-exit-status'], capture_output=True, text=True)
        self.assertEqual((result.returncode, result.stdout), (0, 'VT_VNSTAT_FLUSH_EXIT_V1\n'))
        for args in ([], ['--other'], ['--vt-flush-exit-status', '--config', '/missing']):
            result = subprocess.run([binary, *args], capture_output=True, text=True)
            self.assertEqual((result.returncode, result.stdout), (77, ''))

    def test_patch_gate_rejects_modified_missing_and_extra_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            openwrt = Path(tmp)
            feed = openwrt / 'feeds/packages'
            package = feed / 'net/vnstat2'
            patches = package / 'patches'
            patches.mkdir(parents=True)
            (package / 'Makefile').write_text('PKG_VERSION:=2.13\nPKG_HASH:=' + SOURCE_ARCHIVE_SHA256 + '\n')
            subprocess.run(['git', 'init', '-q', str(feed)], check=True)
            target = patches / PATCH.name
            target.write_bytes(PATCH.read_bytes())
            hashes = identity.verify_feed_patches(openwrt)
            self.assertEqual(hashes['packages/net/vnstat2/patches/' + PATCH.name],
                             hashlib.sha256(PATCH.read_bytes()).hexdigest())
            target.write_text('unreviewed modification\n')
            with self.assertRaisesRegex(ValueError, 'differs'):
                identity.verify_feed_patches(openwrt)
            target.unlink()
            with self.assertRaisesRegex(ValueError, 'missing'):
                identity.verify_feed_patches(openwrt)
            target.write_bytes(PATCH.read_bytes())
            (patches / '999-unreviewed.patch').write_text('extra\n')
            with self.assertRaisesRegex(ValueError, 'unreviewed'):
                identity.verify_feed_patches(openwrt)
            (patches / '999-unreviewed.patch').unlink()
            (package / 'Makefile').write_text('PKG_VERSION:=2.14\nPKG_HASH:=' + SOURCE_ARCHIVE_SHA256 + '\n')
            with self.assertRaisesRegex(ValueError, '2.13'):
                identity.verify_feed_patches(openwrt)


if __name__ == '__main__':
    unittest.main()
