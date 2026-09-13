'use strict';

import { access, readfile } from 'fs';
import { run_command, t99_qmi_status } from './qmi.uc';
import { t99_at_status } from './t99-radio.uc';
import { parse_session, parse_link } from './t99-session.uc';

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
status.t99_iccid = at.t99_iccid;

// Query netifd, never this rpcd object's own status. Both the ubus client and
// its supervisor deadline are bounded; no network configuration is changed.
status.t99_session = null;
try {
	let reply = run_command([ '/bin/ubus', '-t', '2', 'call', 'network.interface.modem', 'status' ], 2500);
	if (reply.ok)
		status.t99_session = parse_session(reply.output);
}
catch (e) {}
status.t99_link = parse_link(
	readfile('/sys/class/net/wwan0/qmi/raw_ip'),
	readfile('/sys/class/net/wwan0/type'),
	readfile('/sys/class/net/wwan0/addr_len'),
	readfile('/sys/class/net/wwan0/address'));

printf('%J\n', status);
