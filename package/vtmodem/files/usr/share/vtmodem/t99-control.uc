'use strict';

import { run_command } from './qmi.uc';

// These helpers run in an isolated process. vt-at.real owns the AT-port lock;
// the caller serializes whole configuration transactions separately.
function token(value) { return value == null ? null : sprintf('%J', value); }

function bounded(runner) {
	// Worst supported band transaction: 52.5 s. Stay below uhttpd's 60 s
	// script timeout as well as the page's dedicated 90 s request deadline.
	let remaining = 55000;
	return (argv, timeout_ms) => {
		if (timeout_ms > remaining) return { ok: false, output: '' };
		remaining -= timeout_ms;
		try { return runner(argv, timeout_ms); }
		catch (e) { return { ok: false, output: '' }; }
	};
}

function lines(output) {
	if (type(output) != 'string') return null;
	let result = [];
	for (let line in split(output, '\n')) {
		line = trim(line);
		if (length(line) && line != 'OK') push(result, line);
	}
	return result;
}

function numbers(text, min, max, limit, empty) {
	if (text == '' && empty) return [];
	if (type(text) != 'string' || !match(text, /^[0-9]+(,[0-9]+)*$/)) return null;
	let result = [];
	for (let item in split(text, ',')) {
		let n = +item;
		if (n < min || n > max || index(result, n) >= 0) return null;
		push(result, n);
	}
	return length(result) <= limit ? result : null;
}

function parse_mode(output) {
	let ls = lines(output);
	if (ls == null || length(ls) != 1) return null;
	let m = match(ls[0], /^\^SLMODE: *(0|1),([0-7])$/);
	return m ? { persist: +m[1], mode: +m[2] } : null;
}

function support_range(text, max) {
	if (match(text, /^[0-9]+(,[0-9]+)*$/)) return numbers(text, 0, max, max + 1, false);
	let m = match(text, /^([0-9]+)-([0-9]+)$/);
	if (!m || +m[1] > +m[2] || +m[2] > max) return null;
	let result = [];
	for (let i = +m[1]; i <= +m[2]; i++) push(result, i);
	return result;
}

function parse_mode_support(output) {
	let ls = lines(output);
	if (ls == null || length(ls) != 1) return null;
	let m = match(ls[0], /^\^SLMODE: *\(([0-9,-]+)\),\(([0-9,-]+)\)$/);
	if (!m) return null;
	let persist = support_range(m[1], 1), modes = support_range(m[2], 7);
	return persist != null && modes != null ? { persist, modes } : null;
}

function parse_supported(output) {
	let ls = lines(output), result = {};
	if (ls == null || length(ls) != 3) return null;
	for (let line in ls) {
		let m = match(line, /^(\^SLBAND: *)?(WCDMA|LTE|NR5G),\(([0-9,]+)\)$/);
		if (!m || result[m[2]] != null) return null;
		result[m[2]] = numbers(m[3], 1, 256, 128, false);
		if (result[m[2]] == null) return null;
	}
	return { WCDMA: result.WCDMA, LTE: result.LTE, NR5G: result.NR5G };
}

function parse_bands(output) {
	let ls = lines(output), result = { WCDMA: {}, LTE: {}, NR5G: {} };
	if (ls == null || length(ls) != 6) return null;
	for (let line in ls) {
		let m = match(line, /^(WCDMA|LTE|NR5G), *(Enable|Disable) Bands *: *([0-9,]*)$/);
		if (!m) return null;
		let key = m[2] == 'Enable' ? 'enabled' : 'disabled';
		if (result[m[1]][key] != null) return null;
		let list = replace(m[3], /,$/, '');
		result[m[1]][key] = numbers(list, 1, 256, 128, true);
		if (result[m[1]][key] == null) return null;
	}
	for (let tech in ['WCDMA', 'LTE', 'NR5G']) {
		if (result[tech].enabled == null || result[tech].disabled == null) return null;
		for (let band in result[tech].enabled)
			if (index(result[tech].disabled, band) >= 0) return null;
		// Bands are sets, unlike the ordered priority list.
		sort(result[tech].enabled, (a, b) => a - b);
		sort(result[tech].disabled, (a, b) => a - b);
	}
	return result;
}

function parse_priority(output) {
	let ls = lines(output);
	if (ls == null) return null;
	// GC.004 has been observed to report an unset priority as an OK-only
	// reply, a bare vendor message, a prefixed vendor message, or an empty
	// ^BAND_PRI field depending on boot/state. All mean the same empty list.
	if (!length(ls)) return [];
	if (length(ls) != 1) return null;
	if (match(ls[0], /^(\^BAND_PRI: *)?Band priority file does not exist$/) ||
	    match(ls[0], /^\^BAND_PRI: *$/)) return [];
	let m = match(ls[0], /^\^BAND_PRI: *([0-9,]+)$/);
	return m ? numbers(m[1], 1, 256, 15, false) : null;
}

function lock_pairs(text) {
	if (type(text) != 'string' || !match(text, /^[0-9]+,[0-9]+(,[0-9]+,[0-9]+)*$/)) return null;
	let parts = split(text, ','), result = [], seen = [];
	if (length(parts) > 16) return null;
	for (let i = 0; i < length(parts); i += 2) {
		let pci = +parts[i], earfcn = +parts[i + 1];
		let key = `${pci},${earfcn}`;
		if (pci > 503 || earfcn > 262143 || index(seen, key) >= 0) return null;
		push(seen, key);
		push(result, { pci, earfcn });
	}
	return result;
}

function parse_lock(output) {
	let ls = lines(output);
	if (ls == null || length(ls) != 1) return null;
	if (ls[0] == '^LTE_LOCK:Have not set cell lock before' ||
	    ls[0] == '^LTE_LOCK: Have not set cell lock before') return [];
	let m = match(ls[0], /^\^LTE_LOCK: *(.*)$/);
	if (!m) return null;
	let text = m[1];
	if (match(text, /^\( *[0-9]+ *, *[0-9]+ *\)( *, *\( *[0-9]+ *, *[0-9]+ *\))*$/))
		text = replace(text, /[() ]/g, '');
	return lock_pairs(text);
}

function query(device, command, parser, runner) {
	let response = runner(['/usr/bin/vt-at', '-t', '3000', device, command], 3500);
	if (type(response) != 'object' || response.ok !== true) return null;
	return parser(response.output);
}

function collect_control(device, runner) {
	runner = bounded(runner ?? run_command);
	let result = { ok: false, supported: device == '/dev/t99w175-at', mode: null,
		mode_support: null, bands_supported: null, bands: null, priority: null,
		lock: null, errors: [], tokens: { mode: null, priority: null, lock: null, bands: null } };
	if (!result.supported) {
		push(result.errors, 'Unsupported AT device');
		return result;
	}
	let commands = [
		['mode', 'AT^SLMODE?', parse_mode],
		['mode_support', 'AT^SLMODE=?', parse_mode_support],
		['bands_supported', 'AT^SLBAND=?', parse_supported],
		['bands', 'AT^BAND_PREF?', parse_bands],
		['priority', 'AT^BAND_PRI?', parse_priority],
		['lock', 'AT^LTE_LOCK?', parse_lock]
	];
	for (let item in commands) {
		result[item[0]] = query(device, item[1], item[2], runner);
		if (result[item[0]] == null) push(result.errors, `${item[0]}: query failed or response not recognized`);
	}
	for (let key in ['mode', 'priority', 'lock', 'bands']) result.tokens[key] = token(result[key]);
	result.ok = true;
	return result;
}

function refused(error, current) {
	return { ok: false, changed: false, verified: false, restart_required: false,
		error, current: current ?? null };
}

function parse_cfun(output) {
	let ls = lines(output);
	if (ls == null || length(ls) != 1) return null;
	let m = match(ls[0], /^\+CFUN: *([0-9]+)$/);
	return m ? +m[1] : null;
}

function minus(a, b) {
	let result = [];
	for (let item in a) if (index(b, item) < 0) push(result, item);
	return result;
}

function joined_set(a, b) {
	let result = [];
	for (let item in a) push(result, item);
	for (let item in b) if (index(result, item) < 0) push(result, item);
	sort(result, (x, y) => x - y);
	return result;
}

function consistent_bands(state, supported) {
	if (state == null || supported == null) return false;
	for (let tech in ['WCDMA', 'LTE', 'NR5G'])
		if (token(joined_set(state[tech].enabled, state[tech].disabled)) != token(joined_set(supported[tech], [])))
			return false;
	return true;
}

function unchanged_other_bands(before, after) {
	return token(before.WCDMA) == token(after.WCDMA) && token(before.NR5G) == token(after.NR5G);
}

function write_failed(current, error) {
	return { ok: false, changed: true, verified: false, restart_required: false,
		current: current ?? null, error };
}

function apply_bands(device, desired, before, runner) {
	let supported = query(device, 'AT^SLBAND=?', parse_supported, runner);
	if (!consistent_bands(before, supported)) return refused('Band state is incomplete or inconsistent with modem capabilities', before);
	// Bound the worst-case transaction. This firmware reports thirty LTE bands.
	if (length(supported.LTE) > 30) return refused('This modem needs a larger band transaction than supported', before);
	for (let band in desired)
		if (index(supported.LTE, band) < 0) return refused('Requested LTE band is not supported', before);
	if (token(desired) == token(before.LTE.enabled))
		return { ok: true, changed: false, verified: true, restart_required: false, current: before };
	let lock = query(device, 'AT^LTE_LOCK?', parse_lock, runner);
	if (lock == null) return refused('Could not read the cell lock', before);
	if (length(lock)) return refused('Clear the LTE cell lock before changing enabled bands', before);
	let missing = minus(desired, before.LTE.enabled);
	if (length(missing) && length(desired) > 15)
		return refused('Enabling bands requires a desired list of at most fifteen bands', before);
	let current = before;
	if (length(missing)) {
		// Hardware verification on T99W175 GC.004 confirmed that operation 2
		// replaces the complete LTE enabled set; it is not additive. Send the
		// exact desired set once and require exact readback before proceeding.
		let reply = runner(['/usr/bin/vt-at', '-t', '10000', device,
			`AT^BAND_PREF=LTE,2,${join(',', desired)}`], 10500);
		let after = query(device, 'AT^BAND_PREF?', parse_bands, runner);
		if (type(reply) != 'object' || reply.ok !== true)
			return write_failed(after, 'The band replacement command did not complete cleanly. Settings may have changed; refresh before another action.');
		if (!consistent_bands(after, supported) || !unchanged_other_bands(current, after) ||
		    token(after.LTE.enabled) != token(desired))
			return write_failed(after, 'Unexpected band readback after replacement. No further commands were sent.');
		current = after;
	}
	let extras = minus(current.LTE.enabled, desired);
	while (length(extras)) {
		let chunk = [], expected = null;
		for (let i = 0; i < length(extras) && i < 15; i++) push(chunk, extras[i]);
		expected = minus(current.LTE.enabled, chunk);
		let reply = runner(['/usr/bin/vt-at', '-t', '10000', device,
			`AT^BAND_PREF=LTE,1,${join(',', chunk)}`], 10500);
		let after = query(device, 'AT^BAND_PREF?', parse_bands, runner);
		if (type(reply) != 'object' || reply.ok !== true)
			return write_failed(after, 'The disable command did not complete cleanly. Settings may have changed; refresh before another action.');
		if (!consistent_bands(after, supported) || !unchanged_other_bands(current, after) ||
		    token(after.LTE.enabled) != token(expected))
			return write_failed(after, 'Unexpected band readback after disabling. No further commands were sent.');
		current = after;
		extras = minus(current.LTE.enabled, desired);
	}
	return { ok: true, changed: true, verified: true, restart_required: false, current };
}

function apply_control(device, args, runner) {
	runner = bounded(runner ?? run_command);
	if (device != '/dev/t99w175-at') return refused('Unsupported AT device');
	if (type(args) != 'object' || type(args.action) != 'string' ||
	    type(args.value) != 'string' || length(args.value) > 256 ||
	    type(args.expected) != 'string' || length(args.expected) > 8192)
		return refused('Invalid configuration request');
	if (args.confirm !== true) return refused('Explicit confirmation is required');
	let action = args.action, desired = null, command = null, read = null, parser = null;
	if (action == 'mode') {
		let m = match(args.value, /^(0|1),([0-7])$/);
		if (!m) return refused('Invalid mode');
		desired = { persist: +m[1], mode: +m[2] };
		command = `AT^SLMODE=${args.value}`; read = 'AT^SLMODE?'; parser = parse_mode;
	}
	else if (action == 'priority') {
		desired = numbers(args.value, 1, 256, 15, false);
		if (desired == null) return refused('Enter one to fifteen distinct LTE bands');
		command = `AT^BAND_PRI=${join(',', desired)}`; read = 'AT^BAND_PRI?'; parser = parse_priority;
	}
	else if (action == 'lock' || action == 'unlock') {
		desired = action == 'unlock' ? (args.value == '' ? [] : null) : lock_pairs(args.value);
		if (desired == null) return refused('Enter up to eight valid PCI and EARFCN pairs');
		command = action == 'unlock' ? 'AT^LTE_LOCK' : `AT^LTE_LOCK=${args.value}`;
		read = 'AT^LTE_LOCK?'; parser = parse_lock;
	}
	else if (action == 'bands') {
		desired = numbers(args.value, 1, 256, 30, false);
		if (desired == null) return refused('Enter one to thirty distinct LTE bands');
		sort(desired, (a, b) => a - b);
		read = 'AT^BAND_PREF?'; parser = parse_bands;
	}
	else return refused('Unsupported configuration action');

	let current = query(device, read, parser, runner);
	if (current == null) return refused('Could not read current settings');
	if (args.expected != token(current)) return refused('Settings changed; refresh before applying', current);
	if (action == 'bands') return apply_bands(device, desired, current, runner);
	if (action == 'mode') {
		let support = query(device, 'AT^SLMODE=?', parse_mode_support, runner);
		if (support == null || index(support.persist, desired.persist) < 0 || index(support.modes, desired.mode) < 0)
			return refused('Requested mode is not confirmed as supported', current);
		let lock = query(device, 'AT^LTE_LOCK?', parse_lock, runner);
		if (lock == null) return refused('Could not read the cell lock', current);
		if (length(lock) && desired.mode != 2) return refused('Clear the LTE cell lock before choosing another mode', current);
		if (query(device, 'AT+CFUN?', parse_cfun, runner) !== 1)
			return refused('The modem must already be in full functionality mode', current);
	}
	if (action == 'priority') {
		let support = query(device, 'AT^SLBAND=?', parse_supported, runner);
		if (support == null) return refused('Could not read supported LTE bands', current);
		for (let band in desired)
			if (index(support.LTE, band) < 0) return refused('Requested LTE band is not supported', current);
	}
	if (token(current) == token(desired))
		return { ok: true, changed: false, verified: true, restart_required: false, current };

	// A missing reply cannot prove that the modem did not store the write.
	// Never retry, roll back, or reset automatically after an uncertain result.
	let written = runner(['/usr/bin/vt-at', '-t', '10000', device, command], 10500);
	let after = query(device, read, parser, runner);
	let acknowledged = type(written) == 'object' && written.ok === true;
	let verified = acknowledged && after != null && token(after) == token(desired);
	return { ok: acknowledged && verified, changed: true, verified,
		restart_required: action != 'mode', current: after,
		error: acknowledged && verified ? null : (!acknowledged
			? 'The write did not complete cleanly; settings may have changed. Refresh before another action.'
			: 'The stored settings could not be verified. Refresh before another action.') };
}

export { parse_mode, parse_mode_support, parse_supported, parse_bands,
	parse_priority, parse_lock, collect_control, apply_control };
