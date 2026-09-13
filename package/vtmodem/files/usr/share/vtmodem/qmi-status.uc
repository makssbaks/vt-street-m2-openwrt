'use strict';

import { access } from 'fs';
import { run_command, t99_qmi_status } from './qmi.uc';
import { t99_at_status } from './t99-radio.uc';

// Run separately from rpcd. This process owns only the current query child, so
// unrelated rpcd children cannot wake system() before its timeout expires.
let status = { qmi_signal: null, qmi_radio: null };
try {
	status = t99_qmi_status('/dev/cdc-wdm0');
}
catch (e) {
	// Optional telemetry must not prevent the rest of the status page loading.
}

let device = access('/dev/t99w175-at') ? '/dev/t99w175-at' :
	(access('/dev/ttyUSB2') ? '/dev/ttyUSB2' : '');
let at = t99_at_status(device, run_command);
status.t99_temperature = at.t99_temperature;
status.t99_ca = at.t99_ca;
status.t99_radio = at.t99_radio;

printf('%J\n', status);
