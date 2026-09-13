'use strict';

import { run_command } from './qmi.uc';
import { collect_control, apply_control } from './t99-control.uc';

// An isolated process owns query deadlines; unrelated rpcd children cannot
// interrupt ucode system() waits. Only the fixed launcher invokes this helper.
let result = { ok: false, supported: true, changed: false, verified: false,
	error: 'Invalid radio request' };
let request = null;
try {
	if (length(ARGV) == 2 && length(ARGV[1]) <= 16384)
		request = json(ARGV[1]);
	if (type(request) == 'object') {
		if (request.action == 'status')
			result = collect_control(ARGV[0], run_command);
		else
			result = apply_control(ARGV[0], request, run_command);
	}
}
catch (e) {
	result = { ok: false, supported: true,
		changed: request != null && request.action != 'status', verified: false,
		error: 'Radio request failed. Read the settings again before another change.' };
}
printf('%J\n', result);
