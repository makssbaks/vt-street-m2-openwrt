'use strict';
import { connection_request, production_io } from './connection.uc';
let result;
try {
	if (length(ARGV) != 1 || length(ARGV[0]) > 8192) die('Invalid connection argument');
	result = connection_request(json(ARGV[0]), production_io());
}
catch (e) {
	result = { ok: false, accepted: null, outcome_unknown: true,
		error: 'Connection helper failed; inspect state before another action' };
}
printf('%J\n', result);
