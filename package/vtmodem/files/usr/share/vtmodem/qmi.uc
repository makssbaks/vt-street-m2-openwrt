'use strict';

import { mkstemp } from 'fs';

function shellquote(s) {
	return `'${replace(s, "'", "'\\''")}'`;
}

// Run from the isolated qmi-status.uc process, not directly inside rpcd:
// ucode system() timeouts can be interrupted by unrelated child exits.
// exec keeps the timeout attached to this query, never to qmi-proxy.
// The unlinked temporary file disappears when closed, including on failure.
function run_command(argv, timeout_ms) {
	let fd = mkstemp();
	if (!fd)
		return { ok: false, exit_code: null, output: '' };

	let rc = null;
	let out = '';
	try {
		let args = [];
		for (let arg in argv)
			push(args, shellquote(arg));
		rc = system(`LC_ALL=C exec ${join(' ', args)} >/proc/self/fd/${fd.fileno()} 2>/dev/null`, timeout_ms);
		if (rc === 0) {
			fd.seek(0);
			out = fd.read(32768) ?? '';
		}
	}
	catch (e) {
		rc = null;
	}
	fd.close();
	return { ok: rc === 0, exit_code: rc, output: out };
}

function parse_signal(out) {
	let s = { rssi_dbm: null, rsrp_dbm: null, rsrq_db: null, snr_db: null };
	let lte = false;
	for (let line in split(out, '\n')) {
		line = trim(line);
		// Only the LTE section belongs to these fields. In particular, a
		// subsequent 5G section with n/a must not replace LTE measurements.
		if (match(line, /^[^:]+:$/)) {
			lte = line == 'LTE:';
			continue;
		}
		if (!lte)
			continue;
		let m = match(line, /^(RSSI|RSRP|RSRQ|SNR): '(-?[0-9]+(\.[0-9]+)?) (dBm|dB)'$/);
		if (!m)
			continue;
		if (m[1] == 'RSSI' && m[4] == 'dBm')
			s.rssi_dbm = +m[2];
		else if (m[1] == 'RSRP' && m[4] == 'dBm')
			s.rsrp_dbm = +m[2];
		else if (m[1] == 'RSRQ' && m[4] == 'dB')
			s.rsrq_db = +m[2];
		else if (m[1] == 'SNR' && m[4] == 'dB')
			s.snr_db = +m[2];
	}
	return s;
}

function parse_radio(out) {
	let groups = { basic: {}, extended: {}, bandwidth: {} };
	let section = '';
	let lte = false;
	for (let line in split(out, '\n')) {
		line = trim(line);
		if (line == 'Band Information:' || line == 'Band Information (Extended):' || line == 'Bandwidth:') {
			section = line == 'Band Information:' ? 'basic' :
				(line == 'Bandwidth:' ? 'bandwidth' : 'extended');
			lte = false;
			continue;
		}
		let m = match(line, /^Radio Interface: *'([^']+)'$/);
		if (m) {
			lte = m[1] == 'lte';
			continue;
		}
		if (!lte || !length(section))
			continue;
		let g = groups[section];
		m = match(line, /^Active Band Class: *'eutran-([0-9]+)'$/);
		if (m && g.band == null)
			g.band = +m[1];
		m = match(line, /^Active Channel: *'([0-9]+)'$/);
		if (m && g.earfcn == null)
			g.earfcn = +m[1];
		m = match(line, /^Bandwidth: *'([0-9]+(\.[0-9]+)?)( MHz)?'$/);
		if (m && g.bandwidth_mhz == null)
			g.bandwidth_mhz = +m[1];
	}
	let radio = groups.extended.band != null && groups.extended.earfcn != null
		? groups.extended : groups.basic;
	return {
		band: radio.band ?? null,
		earfcn: radio.earfcn ?? null,
		bandwidth_mhz: groups.bandwidth.bandwidth_mhz ?? null
	};
}

function t99_qmi_status(device) {
	let result = { qmi_signal: null, qmi_radio: null };
	if (device != '/dev/cdc-wdm0')
		return result;

	let signal = run_command(['/usr/bin/qmicli', '-d', device, '-p', '--nas-get-signal-info'], 3000);
	if (signal.ok)
		result.qmi_signal = parse_signal(signal.output);

	let radio = run_command(['/usr/bin/qmicli', '-d', device, '-p', '--nas-get-rf-band-info'], 3000);
	if (radio.ok)
		result.qmi_radio = parse_radio(radio.output);

	return result;
}

// Keep exports separate for the ucode version pinned by OpenWrt 25.12.
export { run_command, parse_signal, parse_radio, t99_qmi_status };
