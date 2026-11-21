'use strict';

import { access, mkdir, glob, unlink, readfile } from 'fs';
import { read_json, write_json, monotonic_ms } from './telemetry-cache.uc';
import { run_command } from './qmi.uc';

const DIR = '/var/run/vtmodem-connection';
const OBJECT = 'network.interface.modem';
const ACTIONS = [ 'connect', 'disconnect', 'reconnect' ];
function refusal(code, error) {
	return { ok: false, accepted: false, outcome_unknown: false, error_code: code, error };
}
function valid_request(args) {
	return type(args) == 'object' && index(ACTIONS, args.action) >= 0 &&
		args.confirm === true && type(args.request_id) == 'string' &&
		match(args.request_id, /^[0-9a-f]{32}$/) != null &&
		type(args.expected) == 'string' && length(args.expected) > 0 && length(args.expected) <= 4096;
}
function snapshot(raw, boot) {
	if (type(raw) != 'object' || raw.proto != 't99w175qmi' ||
		type(boot) != 'string' || !match(boot, /^[0-9a-f-]{36}$/)) return null;
	for (let key in [ 'up', 'pending', 'available', 'autostart' ])
		if (type(raw[key]) != 'bool') return null;
	let data = raw.data ?? {}, ids = {};
	if (type(data) != 'object') return null;
	for (let key in [ 'qmi_generation', 'cid_4', 'pdh_4', 'cid_6', 'pdh_6' ]) {
		let v = data[key];
		if (v != null && ((type(v) != 'string' && type(v) != 'int') || length('' + v) > 512)) return null;
		ids[key] = v ?? null;
	}
	let state = { up: raw.up, pending: raw.pending, available: raw.available,
		autostart: raw.autostart, session_key: sprintf('%J', ids) };
	return { ok: true, supported: true, interface: 'modem', ...state,
		token: sprintf('%J', { boot, ...state }) };
}
// Called only by the isolated worker, under its exclusive flock. The test
// adapter never touches the real interface, filesystem receipts or SMS.
function connection_request(args, io) {
	if (type(args) != 'object') return refusal('invalid_request', 'Invalid connection request');
	if (args.action == 'status')
		return snapshot(io.query(), io.boot()) ?? refusal('unavailable', 'Cannot read the T99W175 netifd interface');
	if (!valid_request(args)) return refusal('invalid_request', 'Read connection state and confirm an allowed action');
	let old = io.read(args.request_id);
	if (old != null) {
		if (old.action != args.action || old.expected != args.expected)
			return refusal('id_conflict', 'This request id belongs to another action');
		return old.result;
	}
	let before = snapshot(io.query(), io.boot());
	if (!before) return refusal('unavailable', 'Cannot read the T99W175 netifd interface');
	if (before.token != args.expected) return refusal('stale', 'Connection changed; read its state again');
	if (args.action != 'disconnect' && !before.available)
		return refusal('unavailable', 'The modem is not available; no reset was performed');
	if (!io.reserve()) return refusal('storage_full', 'Recent connection history is full; wait before another action');
	let result = { ok: false, accepted: true, request_id: args.request_id, action: args.action,
		outcome_unknown: true, error_code: 'interrupted',
		error: 'A previous request may have started; inspect current state instead of replaying it' };
	let receipt = { action: args.action, expected: args.expected, created_ms: io.now(), result };
	// Write-ahead receipt prevents a duplicate transport request from disconnecting
	// a second time. Never evict recent receipts just to make a write possible.
	if (!io.write(args.request_id, receipt)) return refusal('storage_error', 'Could not record action; nothing was changed');
	let noop = args.action == 'connect' ? before.autostart && (before.up || before.pending) :
		args.action == 'disconnect' && !before.autostart && !before.up && !before.pending;
	let down = null, up = null;
	if (!noop) {
		if (args.action != 'connect') down = io.command('down');
		// Reconnect's up is issued server-side even if the browser disappears or
		// the down acknowledgement is lost. Netifd waits for protocol teardown.
		// One request each; never reset USB, CFUN, bands or the whole network.
		if (args.action != 'disconnect') up = io.command('up');
	}
	let acknowledged = (down == null || down === true) && (up == null || up === true);
	result = { ok: acknowledged, accepted: true, request_id: args.request_id, action: args.action,
		changed: !noop, outcome_unknown: !acknowledged, down_ack: down, up_ack: up,
		state: snapshot(io.query(), io.boot()),
		error: acknowledged ? null : 'Netifd acknowledgement incomplete; inspect state. No automatic retry.' };
	receipt.result = result;
	if (!io.write(args.request_id, receipt)) {
		result.ok = false; result.outcome_unknown = true;
		result.error = 'Action was issued but the final receipt could not be saved; inspect state';
	}
	io.log(args.action, acknowledged);
	return result;
}
function production_io() {
	return {
		boot: () => trim(readfile('/proc/sys/kernel/random/boot_id') ?? ''),
		now: monotonic_ms,
		query: () => {
			let r = run_command([ '/bin/ubus', '-t', '3', 'call', OBJECT, 'status' ], 3500);
			try { return r.ok ? json(r.output) : null; } catch (e) { return null; }
		},
		command: method => run_command([ '/bin/ubus', '-t', '3', 'call', OBJECT, method ], 3500).ok,
		read: id => {
			let path = DIR + '/' + id + '.json';
			return read_json(path, 16384) ?? (access(path) ? { action: null } : null);
		},
		write: (id, value) => write_json(DIR + '/' + id + '.json', value),
		reserve: () => {
			let count = 0, now = monotonic_ms();
			for (let p in glob(DIR + '/*.json')) {
				let r = read_json(p, 16384);
				if (type(r?.created_ms) == 'int' && now - r.created_ms > 3600000) unlink(p);
				else count++;
			}
			return count < 64;
		},
		log: (action, ok) => run_command([ '/usr/bin/logger', '-t', 'vtmodem-connection',
			`Manual ${action}: netifd acknowledgement ${ok ? 'received' : 'unknown'}; modem/USB not reset` ], 1000)
	};
}
export { valid_request, snapshot, connection_request, production_io };
