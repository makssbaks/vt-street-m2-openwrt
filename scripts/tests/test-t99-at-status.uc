'use strict';

import { readfile } from 'fs';
import { t99_at_status } from '../../package/vtmodem/files/usr/share/vtmodem/t99-radio.uc';

let calls = [];
let replies = {
	'AT^TEMP?': readfile('scripts/tests/fixtures/t99-temp.txt'),
	'AT^CA_INFO?': readfile('scripts/tests/fixtures/t99-ca.txt'),
	'AT^DEBUG?': readfile('scripts/tests/fixtures/t99-debug.txt')
};
function success(argv, timeout_ms) {
	assert(argv[0] == '/usr/bin/vt-at' && argv[1] == '-t' && argv[2] == '3000', 'Bounded vt-at invocation');
	assert(argv[3] == '/dev/t99w175-at' || argv[3] == '/dev/ttyUSB2', 'Known AT port');
	assert(length(argv) == 5 && timeout_ms == 3500, 'Outer deadline and single query');
	assert(replies[argv[4]] != null, 'Only verified read queries');
	push(calls, argv[4]);
	return { ok: true, output: replies[argv[4]] };
}

let result = t99_at_status('/dev/t99w175-at', success);
assert(length(calls) == 3, 'Three read queries');
assert(result.t99_temperature.tsens_c == 29, 'Temperature forwarded');
assert(length(result.t99_ca) == 2 && result.t99_ca[1].band == 1, 'CA forwarded');
assert(result.t99_radio.cells[0].pci == 213, 'Cell details forwarded');

result = t99_at_status('/dev/ttyUSB2', function(argv, timeout_ms) {
	if (argv[4] == 'AT^CA_INFO?')
		return { ok: false, output: replies[argv[4]] };
	return success(argv, timeout_ms);
});
assert(result.t99_ca == null, 'Failed command output discarded');
assert(result.t99_temperature.tsens_c == 29 && result.t99_radio.cells[1].pci == 224,
	'One query failure preserves other readings');

result = t99_at_status('/dev/t99w175-at', function(argv, timeout_ms) {
	if (argv[4] == 'AT^TEMP?')
		die('query failed');
	return success(argv, timeout_ms);
});
assert(result.t99_temperature == null && length(result.t99_ca) == 2,
	'One query exception preserves later readings');
calls = [];
result = t99_at_status('/dev/ttyACM0', success);
assert(length(calls) == 0 && result.t99_radio == null, 'Other modems never queried');

print('T99_AT_STATUS_TESTS_OK\n');
