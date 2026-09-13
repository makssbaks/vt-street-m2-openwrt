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
let rpc = readfile('package/vtmodem/files/usr/share/rpcd/ucode/vtmodem');
assert(index(rpc, 'return cached_status();') >= 0 && index(rpc, 'function command(') < 0 && index(rpc, 'function sms_call(') < 0, 'HTTP status and SMS RPC have no synchronous modem execution path');
print('VTMODEM_COLLECTOR_TESTS_OK\n');
