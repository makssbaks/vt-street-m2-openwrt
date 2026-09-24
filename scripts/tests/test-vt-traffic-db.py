#!/usr/bin/env python3
"""Compile and exercise the real SQLite snapshot helper; never touch router data."""
import argparse
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import threading
import time

p = argparse.ArgumentParser()
p.add_argument('--include', help='Optional directory containing sqlite3.h')
p.add_argument('--sqlite-lib', default='-lsqlite3')
a = p.parse_args()
root = Path(__file__).resolve().parents[2]

with tempfile.TemporaryDirectory(prefix='vt-traffic-db-test-') as work:
    work = Path(work)
    state = work / 'state'
    (state / 'traffic').mkdir(parents=True)
    exe = work / 'vt-traffic-db'
    command = [os.environ.get('CC', 'cc'), '-Wall', '-Wextra', '-Werror',
               f'-DVT_TRAFFIC_DIR="{state}"']
    if a.include:
        command += ['-I', a.include]
    subprocess.run(command + [str(root / 'package/vtmodem/src/vt-traffic-db.c'),
                              a.sqlite_lib, '-o', str(exe)], check=True)
    live = state / 'traffic/vnstat.db'
    backup = state / 'traffic-backup.db'

    def run(action, success=True):
        result = subprocess.run([str(exe), action], capture_output=True, timeout=7)
        assert (result.returncode == 0) == success, (action, result.stderr)

    def contents(path):
        with sqlite3.connect(path) as db:
            assert db.execute('PRAGMA integrity_check').fetchone() == ('ok',)
            return db.execute('SELECT rx,tx FROM traffic').fetchone()

    run('backup')  # Fresh install before accounting has no database to copy.
    assert not backup.exists()
    with sqlite3.connect(live) as db:
        db.execute('CREATE TABLE traffic(rx INTEGER, tx INTEGER)')
        db.execute('INSERT INTO traffic VALUES(9007199254740993, 9876543210)')
    run('backup')
    assert contents(backup) == (9007199254740993, 9876543210)
    assert backup.stat().st_mode & 0o777 == 0o600
    assert abs(int((state / 'traffic-backup.time').read_text()) - time.time()) < 10
    with sqlite3.connect(live) as db:
        db.execute('UPDATE traffic SET rx=17, tx=18')
    run('restore')
    assert contents(live) == (17, 18), 'Restore must never overwrite existing live database'
    live.unlink()
    run('restore')
    assert contents(live) == (9007199254740993, 9876543210)

    # Concurrent committed transactions must always produce a coherent pair.
    stop = threading.Event()
    def writer():
        with sqlite3.connect(live, timeout=1) as db:
            n = 0
            while not stop.is_set():
                with db:
                    db.execute('UPDATE traffic SET rx=?, tx=?', (n, -n))
                n += 1
                time.sleep(0.01)
    thread = threading.Thread(target=writer)
    thread.start()
    try:
        time.sleep(0.05)
        for _ in range(4):
            run('backup')
            rx, tx = contents(backup)
            assert rx + tx == 0
    finally:
        stop.set()
        thread.join()

    # A locked DB must terminate within the end-to-end bound and retain the
    # previous coherent snapshot rather than publishing an incomplete file.
    old = backup.read_bytes()
    with sqlite3.connect(live) as lock:
        lock.execute('BEGIN EXCLUSIVE')
        start = time.monotonic()
        run('backup', success=False)
        assert time.monotonic() - start < 6.5
        assert backup.read_bytes() == old
        lock.rollback()
    live.write_bytes(b'not a sqlite database')
    run('backup', success=False)
    assert backup.read_bytes() == old
    assert not list(state.rglob('*.new.*')), 'Temporary files removed after failures'

print('VT_TRAFFIC_DB_TESTS_OK')
