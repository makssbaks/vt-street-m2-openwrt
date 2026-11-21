#!/usr/bin/env python3
"""Run release workflow shell blocks against clean, real Git checkouts.

The OpenWrt compile/board/image operations are stubbed. Release identity and
its tracked-source guard are deliberately real, including Git file modes.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / '.github/workflows/build-openwrt.yml'
APPLY_STEP = 'Apply VT-STREET-M2 board port'
COLLECT_STEP = 'Collect and validate firmware'
DIRTY_ERROR = 'commit tracked port changes before producing a release identity'


def run_block(name):
    """Extract these literal run blocks without adding a YAML dependency.

    Reject an unexpected structure rather than silently running an empty or
    invented command when the workflow is reorganized.
    """
    lines = WORKFLOW.read_text().splitlines()
    step = '      - name: ' + name
    if lines.count(step) != 1:
        raise AssertionError('expected exactly one workflow step: ' + name)
    position = lines.index(step) + 1
    while position < len(lines) and lines[position] != '        run: |':
        if lines[position].startswith('      - '):
            raise AssertionError('expected a literal run block: ' + name)
        position += 1
    position += 1
    commands = []
    while position < len(lines):
        line = lines[position]
        if line and not line.startswith('          '):
            break
        commands.append(line[10:] if line else '')
        position += 1
    if not any(commands):
        raise AssertionError('empty workflow run block: ' + name)
    return '\n'.join(commands) + '\n'


def write(path, contents, mode=0o644):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(contents)
    path.chmod(mode)


def git(directory, *args):
    return subprocess.check_output(['git', '-C', str(directory), *args], text=True)


def commit(directory):
    git(directory, 'init', '-q')
    git(directory, 'config', 'core.filemode', 'true')
    git(directory, 'add', '.')
    git(directory, '-c', 'user.name=Workflow test', '-c',
        'user.email=workflow-test@example.invalid', 'commit', '-qm', 'fixture')
    return git(directory, 'rev-parse', 'HEAD').strip()


class WorkflowFixture:
    def __init__(self, directory, collect_mode=0o755):
        self.port = Path(directory) / 'port'
        self.openwrt = self.port / 'openwrt'
        self.port.mkdir()
        # Commit OpenWrt before creating feeds so each checkout has its own
        # independent HEAD and feed modifications do not alter the port index.
        write(self.openwrt / 'tracked', 'OpenWrt compile fixture\n')
        commit(self.openwrt)
        pins = []
        for name in ('packages', 'luci', 'routing', 'telephony', 'video'):
            feed = self.openwrt / 'feeds' / name
            write(feed / 'tracked', name + '\n')
            if name == 'packages':
                write(feed / 'net/vnstat2/Makefile',
                      'PKG_VERSION:=2.13\n'
                      'PKG_HASH:=c9fe19312d1ec3ddfbc4672aa951cf9e61ca98dc14cad3d3565f7d9803a6b187\n')
            sha = commit(feed)
            pins.append(f'src-git {name} https://github.com/openwrt/{name}.git^{sha}')
        lock = '\n'.join(pins) + '\n'
        write(self.port / 'config/feeds.conf.lock', lock)
        write(self.openwrt / 'feeds.conf', lock)
        write(self.port / '.gitignore', 'openwrt/\nartifacts/\n')
        write(self.port / 'package/vtmodem/Makefile',
              (ROOT / 'package/vtmodem/Makefile').read_text())
        write(self.port / '.github/workflows/build-openwrt.yml', WORKFLOW.read_text())
        shutil.copytree(ROOT / 'port/patches/vnstat2', self.port / 'port/patches/vnstat2')
        write(self.port / 'scripts/build-identity.py',
              (ROOT / 'scripts/build-identity.py').read_text())
        # Bash syntax makes using sh or executing a non-executable checkout
        # fail. Both stubs execute the unchanged production identity program.
        write(self.port / 'scripts/apply-port.sh', '''#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 1 ]]
python3 scripts/build-identity.py --install-feed-patches "$1"
python3 scripts/build-identity.py "$1"
printf 'CONFIG_TARGET_ramips=y\\n' > "$1/.config"
''', 0o644)
        write(self.port / 'scripts/collect-and-validate.sh', '''#!/usr/bin/env bash
set -euo pipefail
[[ "$#" == 2 ]]
python3 scripts/build-identity.py --verify "$1" "$1/files"
mkdir -p "$2"
printf 'WORKFLOW_FIXTURE_VALIDATED\\n' > "$2/VALIDATION.txt"
''', collect_mode)
        self.head = commit(self.port)
        self.index = git(self.port, 'ls-files', '--stage')

    def run(self, commands):
        env = dict(os.environ, GITHUB_WORKSPACE=str(self.port), GITHUB_RUN_NUMBER='50')
        return subprocess.run(['bash', '--noprofile', '--norc', '-e', '-o',
                               'pipefail', '-c', commands], cwd=self.port,
                              env=env, text=True, capture_output=True, timeout=30)

    def dirty(self):
        return git(self.port, 'status', '--porcelain', '--untracked-files=no')


class BuildWorkflowTests(unittest.TestCase):
    def test_actual_apply_and_collect_blocks_leave_checkout_clean(self):
        # Build 50 tracked apply as 100644 and collect as 100755. Also check
        # a fully non-executable checkout: Bash invocation must not depend on
        # changing Git metadata, nor on collect accidentally being executable.
        for collect_mode in (0o755, 0o644):
            with self.subTest(collect_mode=oct(collect_mode)), \
                    tempfile.TemporaryDirectory() as directory:
                fixture = WorkflowFixture(directory, collect_mode)
                for step in (APPLY_STEP, COLLECT_STEP):
                    result = fixture.run(run_block(step))
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(fixture.dirty(), '')
                    self.assertEqual(git(fixture.port, 'ls-files', '--stage'), fixture.index)
                identity = json.loads((fixture.openwrt / 'files/etc/vt-build.json').read_text())
                self.assertEqual(identity['source_commit'], fixture.head)
                self.assertEqual(identity['build_run'], 50)
                self.assertTrue((fixture.port / 'artifacts/VALIDATION.txt').is_file())

    def test_old_workflow_chmod_reproduces_release_identity_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            fixture = WorkflowFixture(directory)
            result = fixture.run(
                'chmod +x scripts/apply-port.sh scripts/collect-and-validate.sh\n'
                './scripts/apply-port.sh "$GITHUB_WORKSPACE/openwrt"\n')
            self.assertNotEqual(result.returncode, 0)
            self.assertIn(DIRTY_ERROR, result.stderr)
            self.assertEqual(fixture.dirty().strip(), 'M scripts/apply-port.sh')
            self.assertIn('mode change 100644 => 100755 scripts/apply-port.sh',
                          git(fixture.port, 'diff', '--summary'))
            self.assertFalse((fixture.openwrt / 'files/etc/vt-build.json').exists())

    def test_real_source_edits_still_block_apply_and_collection(self):
        for step in (APPLY_STEP, COLLECT_STEP):
            with self.subTest(step=step), tempfile.TemporaryDirectory() as directory:
                fixture = WorkflowFixture(directory)
                if step == COLLECT_STEP:
                    first = fixture.run(run_block(APPLY_STEP))
                    self.assertEqual(first.returncode, 0, first.stdout + first.stderr)
                package = fixture.port / 'package/vtmodem/Makefile'
                package.write_text(package.read_text() + '\n# uncommitted source edit\n')
                result = fixture.run(run_block(step))
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(DIRTY_ERROR, result.stderr)
                self.assertFalse((fixture.port / 'artifacts/VALIDATION.txt').exists())


if __name__ == '__main__':
    unittest.main()
