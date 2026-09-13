'use strict';

import { open, readfile, writefile, mkdir, chmod, rename } from 'fs';

const UINT64_MAX = '18446744073709551615';
const CACHE = '/var/run/vtmodem-traffic/status.json';

function clock_state() {
	for (let pair in [['time-synced', 'ntp'], ['time-confirmed', 'manual']])
		if (match(trim(readfile('/var/run/vtmodem-traffic/' + pair[0]) ?? ''), /^[1-9][0-9]{8,10}$/))
			return { clock_synced: true, clock_source: pair[1] };
	return { clock_synced: false, clock_source: null };
}

function check_time_confirmation(requested, now) {
	if (type(requested) != 'int' || requested < 1577836800 || requested >= 253402300800)
		return 'invalid_timestamp';
	return requested > now + 120 || requested < now - 120 ? 'clock_mismatch' : null;
}

function traffic_confirm_time(requested) {
	let now = time(), error = check_time_confirmation(requested, now);
	if (error) return { ok: false, error: error, router_time: now };
	let state = '/var/run/vtmodem-traffic', path = state + '/time-confirmed';
	mkdir(state, 0700);
	if (!writefile(path + '.new', sprintf('%d\n', now)) ||
	    !chmod(path + '.new', 0600) || !rename(path + '.new', path))
		return { ok: false, error: 'clock_confirmation_failed', router_time: now };
	return { ok: true, clock_source: 'manual', router_time: now };
}

function counter(value) {
	if (type(value) == 'int') {
		if (value < 0) return null;
		value = sprintf('%s', value);
	}
	if (type(value) != 'string' || !match(value, /^(0|[1-9][0-9]{0,19})$/))
		return null;
	if (length(value) == 20 && value > UINT64_MAX)
		return null;
	return value;
}

// Bytes cross the RPC boundary as decimal strings. Never round uint64 counters
// through a JavaScript double, and do not overflow when adding RX and TX.
function add_bytes(a, b) {
	let out = '', carry = 0, i = length(a) - 1, j = length(b) - 1;
	while (i >= 0 || j >= 0 || carry) {
		let n = carry + (i >= 0 ? +substr(a, i--, 1) : 0) +
			(j >= 0 ? +substr(b, j--, 1) : 0);
		out = sprintf('%d', n % 10) + out;
		carry = int(n / 10);
	}
	return length(out) ? out : '0';
}

function bytes_pair(row) {
	if (type(row) != 'object') return null;
	let rx = counter(row.rx), tx = counter(row.tx);
	return rx === null || tx === null ? null : {
		rx_bytes: rx, tx_bytes: tx, total_bytes: add_bytes(rx, tx)
	};
}

function zero_pair() { return bytes_pair({ rx: 0, tx: 0 }); }

function add_pair(a, b) {
	return {
		rx_bytes: add_bytes(a.rx_bytes, b.rx_bytes),
		tx_bytes: add_bytes(a.tx_bytes, b.tx_bytes),
		total_bytes: add_bytes(a.total_bytes, b.total_bytes)
	};
}

function valid_interface(value) {
	// Only the WWAN L3 interface of network.interface.modem is enrolled. A LAN
	// interface or arbitrary name can never be counted by a stale/malformed RPC.
	return type(value) == 'string' && !!match(value, /^wwan[0-9]{1,3}$/);
}

function modem_interface(out) {
	let data;
	try { data = json(out); } catch (e) { return null; }
	return type(data) == 'object' && data.up === true &&
		data.proto == 't99w175qmi' && valid_interface(data.l3_device)
		? data.l3_device : null;
}

function timestamp(value) {
	return type(value) == 'int' && value > 0 && value < 253402300800 ? value : null;
}

function calendar(now) {
	let d = localtime(now);
	return { year: d.year, month: d.mon, day: d.mday,
		day_key: sprintf('%04d-%02d-%02d', d.year, d.mon, d.mday),
		month_key: sprintf('%04d-%02d', d.year, d.mon) };
}

function period_pair(rows, day, is_month) {
	if (type(rows) != 'array') return null;
	let result = zero_pair(), seen = false;
	for (let row in rows) {
		if (type(row) != 'object' || type(row.date) != 'object') return null;
		let d = row.date;
		if (type(d.year) != 'int' || type(d.month) != 'int' ||
		    d.month < 1 || d.month > 12 ||
		    (!is_month && (type(d.day) != 'int' || d.day < 1 || d.day > 31))) return null;
		let pair = bytes_pair(row);
		if (!pair) return null;
		if (d.year != day.year || d.month != day.month || (!is_month && d.day != day.day))
			continue;
		if (seen) return null;
		seen = true;
		result = pair;
	}
	// The newest saved row may be yesterday / last month. It is not today's
	// traffic: until the next save the current period is correctly still zero.
	return result;
}

// Schema verified against vnStat 2.13 src/dbjson.c (JSON API version 2).
// --json s 2 includes total and two most recent day/month rows per interface.
function parse_vnstat(out, enrolled, now) {
	if (type(out) != 'string' || !length(out) || length(out) > 65536 ||
	    type(enrolled) != 'array' || !length(enrolled) || length(enrolled) > 8) return null;
	let source;
	try { source = json(out); } catch (e) { return null; }
	if (type(source) != 'object' || source.jsonversion != '2' ||
	    type(source.interfaces) != 'array') return null;
	let day = calendar(now), total = zero_pair(), today = zero_pair(), month = zero_pair();
	let seen = {}, created = null, updated = null;
	for (let iface in source.interfaces) {
		if (type(iface) != 'object' || !valid_interface(iface.name) ||
		    index(enrolled, iface.name) < 0) continue;
		if (seen[iface.name]) return null;
		seen[iface.name] = true;
		if (type(iface.traffic) != 'object' || type(iface.created) != 'object' ||
		    type(iface.updated) != 'object') return null;
		let a = bytes_pair(iface.traffic.total);
		let b = period_pair(iface.traffic.day, day, false);
		let c = period_pair(iface.traffic.month, day, true);
		let since = timestamp(iface.created.timestamp), at = timestamp(iface.updated.timestamp);
		if (!a || !b || !c || since === null || at === null || at < since) return null;
		total = add_pair(total, a); today = add_pair(today, b); month = add_pair(month, c);
		created = created === null || since < created ? since : created;
		updated = updated === null || at > updated ? at : updated;
	}
	if (length(keys(seen)) != length(enrolled)) return null;
	return { today: today, month: month, total: total,
		accounting_since: created, updated_at: updated,
		period: { day: day.day_key, month: day.month_key } };
}

function monotonic_ms(text) {
	if (type(text) != 'string') return null;
	let m = match(text, /^([0-9]+)(\.([0-9]{1,3}))? /);
	if (!m) return null;
	let seconds = +m[1];
	if (seconds > 9007199254740) return null;
	return seconds * 1000 + +(substr((m[3] ?? '') + '000', 0, 3));
}

function read_small(path, limit) {
	let fd = open(path, 'r');
	if (!fd) return null;
	let out = fd.read(limit + 1);
	fd.close();
	return type(out) == 'string' && length(out) <= limit ? out : null;
}

function live_counters(iface, reader) {
	if (!valid_interface(iface)) return null;
	let base = '/sys/class/net/' + iface;
	let before = trim(reader(base + '/ifindex') ?? '');
	let rx = counter(trim(reader(base + '/statistics/rx_bytes') ?? ''));
	let tx = counter(trim(reader(base + '/statistics/tx_bytes') ?? ''));
	let after = trim(reader(base + '/ifindex') ?? '');
	let boot = trim(reader('/proc/sys/kernel/random/boot_id') ?? '');
	let at = monotonic_ms(reader('/proc/uptime'));
	if (!match(before, /^[1-9][0-9]{0,9}$/) || before != after ||
	    rx === null || tx === null || at === null ||
	    !match(boot, /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/)) return null;
	return { rx_bytes: rx, tx_bytes: tx, ifindex: +after, boot_id: boot, monotonic_ms: at };
}

function traffic_status() {
	let result;
	try { result = json(read_small(CACHE, 65536) ?? 'null'); } catch (e) {}
	if (type(result) != 'object' || result.version !== 1 || type(result.ok) != 'bool')
		result = { version: 1, ok: false, status: 'unavailable', error: 'collector_unavailable',
			interface: null, interfaces: [], clock_synced: false, today: null, month: null,
			total: null, accounting_since: null, updated_at: null, period: null,
			save_interval_seconds: 600, time_basis: 'router_local' };
	let now = monotonic_ms(readfile('/proc/uptime'));
	let age = now !== null && type(result.collected_monotonic_ms) == 'int'
		? now - result.collected_monotonic_ms : null;
	result.age_seconds = age !== null && age >= 0 ? int(age / 1000) : null;
	result.stale = result.ok !== true || age === null || age < 0 || age > 45000;
	result.live = live_counters(result.interface, readfile);
	result.router_time = time();
	let clock = clock_state();
	result.clock_synced = clock.clock_synced;
	result.clock_source = clock.clock_source;
	return result;
}

export { counter, add_bytes, bytes_pair, valid_interface, modem_interface,
	parse_vnstat, monotonic_ms, live_counters, traffic_status, clock_state,
	check_time_confirmation, traffic_confirm_time };
