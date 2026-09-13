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
	"let result = run_command(['/bin/sleep', '2'], 100);\n" +
	"printf('%%J\\n', result);\n", module);
let argv = [ binary ];
if (library)
	push(argv, '-L', `${library}/*.so`);
push(argv, '-e', program);
let quoted = [];
for (let arg in argv)
	push(quoted, shellquote(arg));

let unrelated = popen('/bin/sleep 0.01');
assert(unrelated != null, 'Start unrelated parent child');
let start = clock(true);
let worker = popen(join(' ', quoted));
assert(worker != null, 'Start isolated query supervisor');
let output = worker.read('all');
let worker_rc = worker.close();
let end = clock(true);
unrelated.close();

let elapsed = end[0] - start[0] + (end[1] - start[1]) / 1000000000.0;
assert(worker_rc == 0, 'Supervisor exits normally');
let result = json(output);
assert(!result.ok && result.exit_code == -9 && result.output == '',
	'Unrelated parent SIGCHLD must not bypass the query timeout');
assert(elapsed < 1.5, 'Timed query must not wait for the full two-second command');

print('T99_QMI_SUPERVISOR_TESTS_OK\n');
