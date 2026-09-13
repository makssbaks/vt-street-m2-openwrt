'use strict';

import { readfile, mkstemp } from 'fs';
import { parse_signal, parse_radio } from './qmi.uc';
import { parse_temperature, parse_ca, parse_cells, parse_iccid } from './t99-radio.uc';
import { parse_session, parse_link } from './t99-session.uc';
import { empty_status } from './telemetry-cache.uc';

function shellquote(s) { return `'${replace(s, "'", "'\\''")}'`; }
// Isolated singleton process: only one supervised child exists at a time.
// Preserve structured failure output, needed for partial SMS outcomes.
function worker_command(argv, timeout_ms) {
	let fd = mkstemp();
	if (!fd) return { ok: false, output: '', exit_code: null };
	let rc = null, output = '', captured = false;
	try {
		let args = [];
		for (let arg in argv) push(args, shellquote(arg));
		rc = system(`LC_ALL=C exec ${join(' ', args)} >/proc/self/fd/${fd.fileno()} 2>/dev/null`, int(timeout_ms));
		if (fd.seek(0)) {
			let data = fd.read(262145);
			// Discarded or unreadable output must not masquerade as a
			// successfully captured empty reply from the modem.
			if (type(data) == 'string' && length(data) <= 262144) {
				output = data; captured = true;
			}
		}
	} catch (e) {}
	fd.close();
	return { ok: rc === 0 && captured, exit_code: rc, output };
}
function field_value(out, prefix) {
	for (let line in split(out ?? '', '\n')) {
		line = trim(line);
		if (!length(line) || line == 'ERROR' || line == 'OK') continue;
		if (prefix && index(line, prefix) == 0) return trim(substr(line, length(prefix)));
		if (!prefix) return line;
	}
	return null;
}
function prefixed_lines(out, prefix) {
	let result = [];
	for (let line in split(out ?? '', '\n')) if (index(trim(line), prefix) == 0) push(result, trim(line));
	return result;
}
function specs(modem) {
	let result = [];
	function at(name, command, prefix, seconds, parser) {
		push(result, { name, seconds, max_age: max(seconds * 3, 15),
			argv: [ '/usr/bin/vt-at', '-t', '1300', modem.at_port, command ],
			parse: parser ?? (out => field_value(out, prefix)) });
	}
	if (modem.type == 't99w175') {
		if (modem.control_device == '/dev/cdc-wdm0') {
			push(result, { name: 'qmi_signal', seconds: 5, max_age: 15,
				argv: [ '/usr/bin/qmicli', '-d', '/dev/cdc-wdm0', '-p', '--nas-get-signal-info' ], parse: parse_signal });
			push(result, { name: 'qmi_radio', seconds: 30, max_age: 90,
				argv: [ '/usr/bin/qmicli', '-d', '/dev/cdc-wdm0', '-p', '--nas-get-rf-band-info' ], parse: parse_radio });
		}
		at('t99_radio', 'AT^DEBUG?', null, 5, parse_cells);
		at('t99_temperature', 'AT^TEMP?', null, 30, parse_temperature);
		at('t99_ca', 'AT^CA_INFO?', null, 30, parse_ca);
		at('iccid', 'AT+ICCID', null, 300, parse_iccid);
		push(result, { name: 't99_session', seconds: 5, max_age: 15,
			argv: [ '/bin/ubus', '-t', '1', 'call', 'network.interface.modem', 'status' ], parse: parse_session });
	}
	else {
		at('iccid', 'AT+CCID', '+CCID:', 300);
		at('cesq', 'AT+CESQ', '+CESQ:', 30);
		at('xcesq', 'AT+XCESQ?', '+XCESQ:', 5);
		// L860 can acknowledge XMCI without returning any measurements.
		// apply_sample only parses successful queries; a fresh empty value
		// clears old cell text without implying a registration state.
		at('cell_measurement', 'AT+XMCI=1', '+XMCI:', 30,
			out => modem.type == 'fibocom-l860' && type(out) == 'string' && !length(trim(out))
				? '' : field_value(out, '+XMCI:'));
		at('ca_state', 'AT+XLEC?', '+XLEC:', 30);
		at('temperature', 'AT+MTSM=1', '+MTSM:', 30);
		at('data_channel', 'AT+XDATACHANNEL=2', '+XDATACHANNEL:', 30);
		at('dns', 'AT+XDNS?', null, 30, out => prefixed_lines(out, '+XDNS:'));
	}
	at('sim_state', 'AT+CPIN?', '+CPIN:', 30);
	at('registration', 'AT+CEREG?', '+CEREG:', 30);
	at('operator', 'AT+COPS?', '+COPS:', 30);
	at('attached', 'AT+CGATT?', '+CGATT:', 30);
	at('csq', 'AT+CSQ', '+CSQ:', 30);
	at('cfun', 'AT+CFUN?', '+CFUN:', 300);
	at('manufacturer', 'AT+CGMI', null, 300);
	at('model', 'AT+CGMM', null, 300);
	at('firmware', 'AT+CGMR', null, 300);
	at('imei', 'AT+CGSN', null, 300);
	at('imsi', 'AT+CIMI', null, 300);
	at('pdp_contexts', 'AT+CGDCONT?', null, 300, out => prefixed_lines(out, '+CGDCONT:'));
	return result;
}
function new_cache(modem, now, wall) {
	return { generation: modem?.generation ?? '', status: empty_status(modem),
		sources: {}, monotonic_ms: now, updated_at: wall, busy: null };
}
function due_queries(queries, attempted, now) {
	let due = [];
	for (let q in queries) if (attempted[q.name] == null || now - attempted[q.name] >= q.seconds * 1000) push(due, q);
	// Oldest first within priority classes: a failed/missing source cannot
	// starve another source indefinitely during the bounded collection round.
	return sort(due, (a, b) => (a.seconds == 5 ? 0 : 1) - (b.seconds == 5 ? 0 : 1) ||
		(attempted[a.name] ?? -1) - (attempted[b.name] ?? -1));
}
function apply_sample(cache, spec, reply, now, wall) {
	let src = cache.sources[spec.name] ?? { monotonic_ms: null, updated_at: null };
	src.max_age = spec.max_age;
	let value = null;
	if (reply.ok) try { value = spec.parse(reply.output); } catch (e) {}
	if (value != null) {
		cache.status[spec.name] = value;
		src.monotonic_ms = now; src.updated_at = wall; src.error = null;
	}
	else src.error = reply.ok ? 'unrecognized_reply' : 'query_failed';
	cache.sources[spec.name] = src;
	cache.monotonic_ms = now; cache.updated_at = wall;
}
function collect_round(cache, modem, queries, attempted, runner, now, wall, interrupted, publish) {
	let end = now() + 4500;
	let due = due_queries(queries, attempted, now());
	for (let spec in due) {
		if (interrupted() || end - now() < 200) break;
		let budget = min(1500, end - now());
		// AT helper's own global deadline must fit the supervisor budget.
		let argv = [];
		for (let arg in spec.argv) push(argv, arg);
		if (argv[0] == '/usr/bin/vt-at') argv[2] = sprintf('%d', max(100, budget - 100));
		let reply = runner(argv, budget);
		attempted[spec.name] = now();
		apply_sample(cache, spec, reply, now(), wall());
		publish(cache);
	}
	if (modem.type == 't99w175') {
		cache.status.t99_link = parse_link(readfile('/sys/class/net/wwan0/qmi/raw_ip'),
			readfile('/sys/class/net/wwan0/type'), readfile('/sys/class/net/wwan0/addr_len'),
			readfile('/sys/class/net/wwan0/address'));
	}
	cache.monotonic_ms = now(); cache.updated_at = wall();
	publish(cache);
}
export { worker_command, field_value, specs, new_cache, due_queries, apply_sample, collect_round };
