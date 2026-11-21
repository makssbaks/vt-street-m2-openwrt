'use strict';

import { access, readfile, writefile, rename, mkdir, chmod, open } from 'fs';
import { run_command } from './qmi.uc';
import { valid_interface, modem_interface, parse_vnstat, monotonic_ms, clock_state } from './traffic.uc';

const CONFIG = '/etc/vtmodem/vnstat.conf';
const STATE = '/var/run/vtmodem-traffic';
const DATA = '/etc/vtmodem/traffic';

function atomic_text(path, value) {
	let temp = path + '.new';
	if (!writefile(temp, value)) return false;
	chmod(temp, 0600);
	return rename(temp, path);
}

function enrolled_interfaces() {
	let list = [];
	for (let name in split(trim(readfile(DATA + '/interfaces') ?? ''), '\n'))
		if (valid_interface(name) && index(list, name) < 0 && length(list) < 8)
			push(list, name);
	return list;
}

mkdir(STATE, 0700);
mkdir(DATA, 0700);
let last = null;
let current = trim(readfile(DATA + '/current') ?? '');
if (!valid_interface(current)) current = null;

while (true) {
	let now = time(), enrolled = enrolled_interfaces();
	let operation_lock = null;
	let clock = clock_state(), synced = clock.clock_synced;
	let result = { version: 1, ok: false, status: synced ? 'waiting_for_interface' : 'waiting_for_time',
		error: null, interface: current, interfaces: enrolled, clock_synced: synced, clock_source: clock.clock_source,
		today: null, month: null, total: null, accounting_since: null, updated_at: null,
		period: null, save_interval_seconds: 600, time_basis: 'router_local' };
	try {
		let session = run_command(['/bin/ubus', '-t', '1', 'call', 'network.interface.modem', 'status'], 1200);
		let iface = session.ok ? modem_interface(session.output) : null;
		if (iface !== null) {
			if (iface != current && atomic_text(DATA + '/current', iface + '\n')) current = iface;
			result.interface = current;
		}
		// Only add an observed modem L3 device. Never automatically enumerate
		// LAN interfaces. vnstat preserves enrolled interfaces over USB removal.
		if (synced && iface !== null && index(enrolled, iface) < 0 && length(enrolled) < 8 &&
		    access(STATE + '/daemon-ready') &&
		    (operation_lock = open(STATE + '/operation.lock', 'a')) && operation_lock.lock('xn')) {
			let added = run_command(['/usr/bin/vnstat', '--config', CONFIG, '--add', '-i', iface], 1500);
			// A prior interrupted write may already have added it to SQLite.
			let known = added.ok || run_command(['/usr/bin/vnstat', '--config', CONFIG,
				'--json', 's', '2', '-i', iface], 1500).ok;
			if (known) {
				push(enrolled, iface);
				if (atomic_text(DATA + '/interfaces', join('\n', enrolled) + '\n')) {
					// HUP only the dedicated vnstat instance: flush/rescan counters,
					// with no effect on network, USB, QMI or the user's stock vnstat.
					run_command(['/bin/ubus', '-t', '1', 'call', 'service', 'signal',
						'{"name":"vtmodem-traffic","instance":"vnstat","signal":1}'], 1200);
				}
			}
			operation_lock.close(); operation_lock = null;
		}
		result.interfaces = enrolled;
		if (length(enrolled)) {
			let query = run_command(['/usr/bin/vnstat', '--config', CONFIG, '--json', 's', '2'], 1500);
			let parsed = query.ok ? parse_vnstat(query.output, enrolled, now) : null;
			if (parsed) {
				for (let key in keys(parsed)) result[key] = parsed[key];
				result.ok = true;
				result.status = synced ? 'ready' : 'waiting_for_time';
				last = parsed;
			}
			else {
				result.status = 'unavailable';
				result.error = 'vnstat_read_failed';
				if (last)
					for (let key in keys(last)) result[key] = last[key];
			}
		}
	}
	catch (e) { result.status = 'unavailable'; result.error = 'collection_failed'; }
	if (operation_lock) operation_lock.close();
	if (!synced) { result.today = null; result.month = null; result.period = null; }
	result.collected_monotonic_ms = monotonic_ms(readfile('/proc/uptime'));
	result.generated_at = time();
	atomic_text(STATE + '/status.json', sprintf('%J\n', result));
	sleep(10000);
}
