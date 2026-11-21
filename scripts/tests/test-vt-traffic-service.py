#!/usr/bin/env python3
"""Run the shipped lifecycle hooks with remapped paths and process stubs."""
import os
import signal
import textwrap
from pathlib import Path
import subprocess
import tempfile
import time

root = Path(__file__).resolve().parents[2]
files = root / 'package/vtmodem/files'
with tempfile.TemporaryDirectory(prefix='vt-traffic-service-test-') as work:
    work = Path(work)
    state = work / 'run'
    data = work / 'etc'
    commands = work / 'commands'
    commands.mkdir()
    log = work / 'calls'
    env = dict(os.environ, VT_TEST_LOG=str(log))

    def calls_text():
        return log.read_text() if log.exists() else ''

    def wait_for(predicate, why, timeout=4):
        deadline = time.monotonic() + timeout
        while not predicate() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert predicate(), why

    def remap(source):
        return (source.replace('/var/run/vtmodem-traffic', str(state))
                .replace('/etc/vtmodem', str(data))
                .replace('/usr/bin/vt-traffic-db', str(commands / 'vt-traffic-db'))
                .replace('/usr/sbin/vnstatd', str(commands / 'vnstatd'))
                .replace('/usr/libexec/vtmodem-traffic-backup', str(commands / 'backup-client')))

    def stub(name, content):
        path = commands / name
        path.write_text('#!/bin/sh\n' + content)
        path.chmod(0o755)
        return path

    hook = work / 'ntp-hook'
    hook.write_text(remap((files / 'etc/hotplug.d/ntp/90-vtmodem-traffic').read_text()))
    for action, stratum in [('step', '0'), ('step', '16'), ('stratum', 'bad'), ('unknown', '2')]:
        subprocess.run(['sh', str(hook)], env=dict(env, ACTION=action, stratum=stratum), check=True)
        assert not (state / 'time-synced').exists(), 'Unsynchronized event must not start calendar accounting'
    subprocess.run(['sh', str(hook)], env=dict(env, ACTION='step', stratum='10'), check=True)
    marker = (state / 'time-synced').read_text()
    assert int(marker) > 1700000000, 'NTP strata 10-15 are valid too'
    subprocess.run(['sh', str(hook)], env=dict(env, ACTION='periodic', stratum='2'), check=True)
    assert (state / 'time-synced').read_text() == marker, 'No repeated state writes after sync'
    (state / 'time-synced').unlink()

    stub('vt-traffic-db', 'echo "snapshot $*" >> "$VT_TEST_LOG"\nexit 0\n')
    native = commands / 'vnstatd'
    native.write_text("#!/usr/bin/env python3\n" + textwrap.dedent(r"""
        import os, sys, signal, time
        from pathlib import Path
        log = Path(os.environ['VT_TEST_LOG'])
        if '--vt-flush-exit-status' in sys.argv:
            print('VT_VNSTAT_FLUSH_EXIT_V1')
            sys.exit(0)
        def record(value):
            with log.open('a') as out: out.write(value + '\n')
        record('vnstatd ' + ' '.join(sys.argv[1:]))
        if '--initdb' in sys.argv: sys.exit(0)
        def terminate(sig, frame):
            failed = (log.parent / 'fail-final').exists()
            record('FINAL_FAIL' if failed else 'FLUSHED')
            sys.exit(1 if failed else 0)
        signal.signal(signal.SIGTERM, terminate)
        signal.signal(signal.SIGHUP, lambda *args: None)
        while True: time.sleep(0.05)
    """))
    native.chmod(0o755)
    client = commands / 'backup-client'
    client.write_text(remap((files / 'usr/libexec/vtmodem-traffic-backup').read_text()))
    client.chmod(0o755)
    daemon = work / 'daemon'
    daemon.write_text(remap((files / 'usr/libexec/vtmodem-traffic-daemon').read_text()))
    proc = subprocess.Popen(['sh', str(daemon)], env=env)
    try:
        deadline = time.monotonic() + 4
        while not log.exists() and proc.poll() is None and time.monotonic() < deadline:
            time.sleep(0.02)
        assert log.exists(), f'Supervisor did not restore history: exit={proc.poll()}'
        assert log.read_text().strip() == 'snapshot restore', 'Restore history but do not start accounting before time confirmation'
        subprocess.run([str(client)], env=env, check=True, timeout=2)
        # Manual verified time is an alternative to NTP, without changing clock.
        (state / 'time-confirmed').write_text(marker)
        deadline = time.monotonic() + 4
        while not (state / 'daemon-ready').exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert (state / 'daemon-ready').exists()
        wait_for(lambda: '--nodaemon' in calls_text(), 'Native accounting process did not start')
        result = subprocess.run([str(client)], env=env, capture_output=True, timeout=8)
        assert result.returncode == 0, result.stderr
        wait_for(lambda: calls_text().count('--nodaemon') >= 2, 'Accounting process did not resume after backup')
        calls = log.read_text()
        assert calls.index('FLUSHED') < calls.rindex('snapshot backup'), 'Confirm RAM flush before coherent snapshot'
        assert calls.count('--nodaemon') >= 2, 'Accounting daemon resumes after backup'
        # Force token collision and delay supervisor handling. A stale success
        # must be removed before the new request, not accepted immediately.
        stub('mktemp', 'token=${1%XXXXXX}ABC123; : > "$token"; printf "%s\\n" "$token"\n')
        (state / 'backup-result').write_text('backup-token.ABC123 0\n')
        os.kill(proc.pid, signal.SIGSTOP)
        pending = None
        try:
            pending = subprocess.Popen([str(client)], env=dict(env, PATH=str(commands) + ':' + env['PATH']),
                                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            wait_for(lambda: (state / 'backup-request').exists() or pending.poll() is not None, 'Backup client did not publish its request')
            assert pending.poll() is None, 'Stale matching success cannot complete a new backup'
        finally:
            os.kill(proc.pid, signal.SIGCONT)
        assert pending.wait(timeout=8) == 0
        new_calls = log.read_text()
        assert new_calls.count('snapshot backup') == calls.count('snapshot backup') + 1
        calls = new_calls
        previous = calls.count('snapshot backup')
        (work / 'fail-final').touch()
        result = subprocess.run([str(client)], env=env, capture_output=True, timeout=8)
        assert result.returncode != 0, 'Failed final flush cannot be acknowledged as success'
        calls = log.read_text()
        assert calls.count('snapshot backup') == previous, 'Do not publish snapshot after failed flush'
        assert calls.count('--nodaemon') >= 3, 'Accounting daemon resumes after failure too'
        (work / 'fail-final').unlink()
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=12)
    calls = log.read_text()
    assert '--initdb --noadd' in calls
    assert '--nodaemon --noadd --startempty --noremove' in calls
    assert str(data / 'vnstat.conf') in calls
    assert not (state / 'daemon-ready').exists()

    time.sleep(1.2)
    # An orphaned native process retains the inherited lifetime lock. A procd
    # respawn must not create a second writer, nor may backup bypass its RAM.
    proc = subprocess.Popen(['sh', str(daemon)], env=env)
    orphan = None
    try:
        deadline = time.monotonic() + 4
        while not (state / 'daemon-ready').exists() and time.monotonic() < deadline:
            time.sleep(0.05)
        assert (state / 'daemon-ready').exists(), (proc.poll(), log.read_text(), [x.name for x in state.iterdir()])
        orphan = int((state / 'daemon-child').read_text())
        wait_for(lambda: calls_text().count('--nodaemon') > calls.count('--nodaemon'), 'Orphan fixture writer did not start')
        proc.kill()
        proc.wait(timeout=2)
        count = log.read_text().count('--nodaemon')
        duplicate = subprocess.run(['sh', str(daemon)], env=env, capture_output=True, timeout=2)
        assert duplicate.returncode != 0
        assert log.read_text().count('--nodaemon') == count, 'No second native writer after supervisor death'
        (state / 'daemon-ready').unlink(missing_ok=True)
        result = subprocess.run([str(client)], env=env, capture_output=True, timeout=2)
        assert result.returncode != 0, 'Missing ready marker cannot bypass surviving writer flush'
    finally:
        if proc.poll() is None:
            proc.terminate()
            proc.wait(timeout=12)
        if orphan:
            try: os.kill(orphan, signal.SIGTERM)
            except ProcessLookupError: pass
        time.sleep(1.2)
        (state / 'daemon-ready').unlink(missing_ok=True)

    # A sysupgrade backup hook must abort the backup if the coherent snapshot
    # fails; it must not continue and archive an older snapshot as if fresh.
    backup_hook = work / 'backup-hook'
    backup_hook.write_text(remap((files / 'lib/upgrade/vtmodem-traffic.sh').read_text()))
    stub('vt-traffic-db', 'exit 1\n')
    script = f'append() {{ :; }}; . "{backup_hook}"; vtmodem_traffic_backup "{work / "list"}"; echo BAD_CONTINUATION'
    result = subprocess.run(['sh', '-c', script], capture_output=True, text=True, env=env)
    assert result.returncode == 1 and 'BAD_CONTINUATION' not in result.stdout
    stub('vt-traffic-db', 'exit 0\n')
    (data / 'traffic-backup.db').write_text('fixture')
    (data / 'traffic-backup.time').write_text(marker)
    result = subprocess.run(['sh', '-c', script], capture_output=True, text=True, env=env)
    assert result.returncode == 0
    keep = (work / 'list').read_text().splitlines()
    assert str(data / 'traffic-backup.db') in keep and str(data / 'traffic-backup.time') in keep

print('VT_TRAFFIC_SERVICE_TESTS_OK')
