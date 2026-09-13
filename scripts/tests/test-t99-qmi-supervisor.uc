'use strict';

import { popen, realpath } from 'fs';

function shellquote(s) {
	return `'${replace(s, "'", "'\\''")}'`;
}

let binary = getenv('UCODE_BIN') || '/usr/bin/ucode';
let library = getenv('UCODE_LIB');
let module = realpath('package/vtmodem/files/usr/share/vtmodem/qmi.uc');
assert(module != null, 'Run from the repository root');

// Reproduce the relevant process topology without accessing a modem:
// rpcd/test owns an unrelated child plus a standalone supervisor; only the
// supervisor owns the command whose execution time must be bounded.
let program = sprintf("import { run_command } from %J;\n" +
	"let result = run_command(['/bin/sh', '-c', 'exec sleep 2'], 500);\n" +
	"printf('%%J\\n', result);\n", module);
function ucode_command(source) {
	let argv = [ binary ];
	if (library)
		push(argv, '-L', `${library}/*.so`);
	push(argv, '-e', source);
	let quoted = [];
	for (let arg in argv)
		push(quoted, shellquote(arg));
	return join(' ', quoted);
}

// BusyBox on the target rejects fractional sleep arguments. Ucode sleep()
// uses milliseconds and is already required by this test's interpreter.
let unrelated = popen(ucode_command('sleep(100);'));
assert(unrelated != null, 'Start unrelated parent child');
let start = clock(true);
let worker = popen(ucode_command(program));
assert(worker != null, 'Start isolated query supervisor');
let output = worker.read('all');
let worker_rc = worker.close();
let end = clock(true);
assert(unrelated.close() == 0, 'Unrelated child must complete successfully');

let elapsed = end[0] - start[0] + (end[1] - start[1]) / 1000000000.0;
assert(worker_rc == 0, 'Supervisor exits normally');
let result = json(output);
assert(!result.ok && result.exit_code == -9 && result.output == '',
	'Unrelated parent SIGCHLD must not bypass the query timeout');
assert(elapsed < 1.5, 'Timed query must not wait for the full two-second command');

print('T99_QMI_SUPERVISOR_TESTS_OK\n');
