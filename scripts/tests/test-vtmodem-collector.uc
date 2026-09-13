'use strict';
import { readfile } from 'fs';
import { cached_status_at } from '../../package/vtmodem/files/usr/share/vtmodem/telemetry-cache.uc';
import { specs, new_cache, apply_sample, collect_round, worker_command } from '../../package/vtmodem/files/usr/share/vtmodem/collector-core.uc';

let m = { type: 't99w175', generation: '1-1:4', at_port: '/dev/t99w175-at', control_device: '/dev/cdc-wdm0' };
let cache = new_cache(m, 1000, 100), qs = specs(m);
let boot = cached_status_at(cache, m, 1001);
assert(boot.telemetry.stale && boot.telemetry.error == 'starting' && length(keys(boot.telemetry.sources)) == 0, 'Published empty boot cache remains explicitly starting until a real source sample arrives');
let signal = filter(qs, q => q.name == 'qmi_signal')[0];
apply_sample(cache, signal, { ok: true, output: "LTE:\n RSRP: '-107 dBm'\n SNR: '4.4 dB'" }, 1000, 100);
let seen = cached_status_at(cache, m, 2000);
assert(seen.qmi_signal.rsrp_dbm == -107 && seen.telemetry.sources.qmi_signal.age_seconds == 1, 'RPC reads cached measurements with source age');
assert(seen.telemetry.sources.qmi_signal.monotonic_ms == 1000, 'Repeated HTTP reads do not invent new signal samples');
apply_sample(cache, signal, { ok: false, output: '' }, 3000, 103);
seen = cached_status_at(cache, m, 4000);
assert(seen.qmi_signal.rsrp_dbm == -107 && seen.telemetry.sources.qmi_signal.stale && seen.telemetry.sources.qmi_signal.error == 'query_failed', 'Failed read preserves explicit stale measurement, not fabricated zero');
assert(seen.telemetry.sources.qmi_signal.monotonic_ms == 1000, 'Failure does not advance source sample timestamp');
seen = cached_status_at(null, m, 10000);
assert(seen.present && seen.telemetry.stale && seen.telemetry.error == 'starting' && seen.imei == '', 'Startup is explicit and performs no AT query');
seen = cached_status_at(cache, { ...m, generation: '1-1:5' }, 4000);
assert(seen.qmi_signal == null && seen.telemetry.error == 'starting', 'USB replacement cannot inherit signal or identity cache');
cache.status.t99_session = { up: true, ipv4: [ { address: '192.0.2.1', mask: 32 } ], dns: [] };
cache.sources.t99_session = { monotonic_ms: 1000, updated_at: 100, max_age: 15, error: null };
seen = cached_status_at(cache, m, 20000);
assert(seen.t99_session == null && seen.telemetry.sources.t99_session.stale, 'Old session is no longer presented as connected');

cache.sources.qmi_signal = { monotonic_ms: 30000, updated_at: 100, max_age: 15 };
seen = cached_status_at(cache, m, 20000);
assert(seen.telemetry.sources.qmi_signal.stale && seen.telemetry.sources.qmi_signal.monotonic_ms == null, 'Future monotonic sample cannot be treated as fresh after invalid cache metadata');
cache.sources.qmi_signal = { monotonic_ms: '1000', updated_at: 100, max_age: 15 };
seen = cached_status_at(cache, m, 20000);
assert(seen.telemetry.sources.qmi_signal.age_seconds == null && seen.telemetry.sources.qmi_signal.stale, 'String sample timestamp is rejected');

// Exercise the deployed L860 spec through collection and the RPC cache boundary.
let l860 = { type: 'fibocom-l860', generation: '2-1:3', at_port: '/dev/ttyACM0' };
let l860_queries = specs(l860);
let measurement = filter(l860_queries, q => q.name == 'cell_measurement')[0];
assert(measurement.argv[4] == 'AT+XMCI=1', 'Empty-measurement regression uses the real L860 XMCI query');
let l860_cache = new_cache(l860, 1000, 100);
apply_sample(l860_cache, measurement, { ok: true, output: '' }, 2000, 101);
seen = cached_status_at(l860_cache, l860, 3000);
assert(seen.cell_measurement === '' && !seen.telemetry.stale &&
	!seen.telemetry.sources.cell_measurement.stale && seen.telemetry.sources.cell_measurement.error == null,
	'Successful empty L860 XMCI is a fresh empty sample, including on first collection');
assert(seen.telemetry.sources.cell_measurement.monotonic_ms == 2000 &&
	seen.telemetry.sources.cell_measurement.updated_at == 101 && seen.telemetry.sources.cell_measurement.age_seconds == 1,
	'Empty L860 measurement carries the actual sample time and freshness');
assert(seen.registration === '' && seen.attached === '', 'Empty XMCI does not infer registration or packet attachment');

for (let empty in [ '', ' \t\r\n  \n' ]) {
	apply_sample(l860_cache, measurement, { ok: true, output: '+XMCI: 1,2,3\r\n' }, 4000, 103);
	assert(l860_cache.status.cell_measurement == '1,2,3', 'Recognized XMCI measurement still populates the cell field');
	l860_cache.status.registration = '0,1';
	l860_cache.status.attached = '1';
	apply_sample(l860_cache, measurement, { ok: true, output: empty }, 5000, 104);
	seen = cached_status_at(l860_cache, l860, 6000);
	assert(seen.cell_measurement === '' && !seen.telemetry.sources.cell_measurement.stale &&
		seen.telemetry.sources.cell_measurement.monotonic_ms == 5000,
		'Successful empty or whitespace XMCI clears the previous cell measurement with a fresh sample');
	assert(seen.registration == '0,1' && seen.attached == '1', 'Clearing cell measurements leaves independent registration fields unchanged');
}
seen = cached_status_at(l860_cache, l860, 96000);
assert(seen.cell_measurement === '' && seen.telemetry.sources.cell_measurement.stale,
	'An empty measurement expires at the same age limit as a populated measurement');

for (let bad in [
	{ ok: true, output: 'unexpected payload', error: 'unrecognized_reply' },
	{ ok: true, output: 'OK\r\n', error: 'unrecognized_reply' },
	{ ok: true, output: 'ERROR\r\n', error: 'unrecognized_reply' },
	{ ok: true, output: null, error: 'unrecognized_reply' },
	{ ok: false, output: '', error: 'query_failed' },
	{ ok: false, output: ' \r\n', error: 'query_failed' },
	{ ok: false, output: '+XMCI: 9,8,7', error: 'query_failed' }
]) {
	apply_sample(l860_cache, measurement, { ok: true, output: '+XMCI: 1,2,3' }, 10000, 109);
	apply_sample(l860_cache, measurement, bad, 11000, 110);
	seen = cached_status_at(l860_cache, l860, 12000);
	assert(seen.cell_measurement == '1,2,3' && seen.telemetry.sources.cell_measurement.stale &&
		seen.telemetry.sources.cell_measurement.error == bad.error && seen.telemetry.sources.cell_measurement.monotonic_ms == 10000,
		'Nonempty unknown replies, missing output and failed queries preserve a stale prior measurement and explicit error');
	apply_sample(l860_cache, measurement, { ok: true, output: '' }, 13000, 112);
	seen = cached_status_at(l860_cache, l860, 14000);
	assert(seen.cell_measurement === '' && !seen.telemetry.sources.cell_measurement.stale &&
		seen.telemetry.sources.cell_measurement.error == null, 'A subsequent acknowledged empty XMCI recovers from a prior failure');
}
for (let unchanged in [
	{ modem: l860, name: 'sim_state', output: '+CPIN: READY', value: 'READY' },
	{ modem: l860, name: 'xcesq', output: '+XCESQ: 1,2,3', value: '1,2,3' },
	{ modem: m, name: 'sim_state', output: '+CPIN: READY', value: 'READY' },
	{ modem: { ...l860, type: 'other-modem' }, name: 'cell_measurement', output: '+XMCI: 1,2,3', value: '1,2,3' }
]) {
	let unchanged_spec = filter(specs(unchanged.modem), q => q.name == unchanged.name)[0];
	let unchanged_cache = new_cache(unchanged.modem, 1000, 100);
	apply_sample(unchanged_cache, unchanged_spec, { ok: true, output: unchanged.output }, 2000, 101);
	apply_sample(unchanged_cache, unchanged_spec, { ok: true, output: '' }, 3000, 102);
	seen = cached_status_at(unchanged_cache, unchanged.modem, 4000);
	assert(seen[unchanged.name] == unchanged.value && seen.telemetry.sources[unchanged.name].stale &&
		seen.telemetry.sources[unchanged.name].error == 'unrecognized_reply' && seen.telemetry.sources[unchanged.name].monotonic_ms == 2000,
		'Empty-reply handling remains unchanged for T99, other AT commands and non-L860 modems');
}

let ticks = 0, calls = [], publishes = [], attempted = {};
collect_round(new_cache(m, 0, 0), m, qs, attempted,
	(argv, budget) => { push(calls, { argv, budget }); ticks += budget; return { ok: false, output: '' }; },
	() => ticks, () => 1000, () => false, value => push(publishes, value.monotonic_ms));
assert(ticks <= 4500 && length(calls) <= 3 && length(publishes) >= 1, 'Worst-case query round has one overall 4500ms deadline');
for (let c in calls) assert(c.budget <= 1500, 'Every spawned query has a deadline');
calls = [];
collect_round(cache, m, qs, {}, (argv, budget) => push(calls, argv), () => 0, () => 1000, () => true, () => null);
assert(length(calls) == 0, 'Accepted SMS job interrupts scheduling before another telemetry query');
let immutable = filter(qs, q => index([ 'manufacturer', 'model', 'firmware', 'imei' ], q.name) >= 0);
assert(length(immutable) == 4, 'All static identity fields collected');
for (let q in immutable) assert(q.seconds == 300, 'Static identity is not polled at antenna-mode cadence');
let reply = worker_command([ '/bin/sh', '-c', 'printf "{\\\"ok\\\":false,\\\"parts_confirmed\\\":1}"; exit 2' ], 1000);
assert(!reply.ok && json(reply.output).parts_confirmed == 1, 'Structured partial failure survives nonzero worker exit');
reply = worker_command([ '/bin/sh', '-c', 'exit 0' ], 1000);
assert(reply.ok && reply.output === '', 'Worker distinguishes a genuinely empty successful reply');
apply_sample(l860_cache, measurement, reply, 20000, 119);
assert(!cached_status_at(l860_cache, l860, 21000).telemetry.sources.cell_measurement.stale,
	'A genuine worker empty success reaches the cache as a fresh empty measurement');
reply = worker_command([ '/bin/sh', '-c', 'head -c 262145 /dev/zero' ], 1000);
assert(!reply.ok && reply.exit_code === 0 && reply.output === '', 'Successful child with oversized output is a capture failure, not an empty success');
apply_sample(l860_cache, measurement, reply, 22000, 121);
seen = cached_status_at(l860_cache, l860, 23000);
assert(seen.telemetry.sources.cell_measurement.stale && seen.telemetry.sources.cell_measurement.error == 'query_failed' &&
	seen.telemetry.sources.cell_measurement.monotonic_ms == 20000, 'Discarded oversized worker output cannot refresh an empty measurement');
let rpc = readfile('package/vtmodem/files/usr/share/rpcd/ucode/vtmodem');
assert(index(rpc, 'return cached_status();') >= 0 && index(rpc, 'function command(') < 0 && index(rpc, 'function sms_call(') < 0, 'HTTP status and SMS RPC have no synchronous modem execution path');
print('VTMODEM_COLLECTOR_TESTS_OK\n');
