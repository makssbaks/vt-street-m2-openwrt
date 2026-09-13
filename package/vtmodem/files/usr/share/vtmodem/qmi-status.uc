'use strict';

import { t99_qmi_status } from './qmi.uc';

// Run separately from rpcd. This process owns only the current QMI child, so
// unrelated rpcd children cannot wake system() before its timeout expires.
let status = { qmi_signal: null, qmi_radio: null };
try {
	status = t99_qmi_status('/dev/cdc-wdm0');
}
catch (e) {
	// Optional telemetry must not prevent the rest of the status page loading.
}

printf('%J\n', status);
