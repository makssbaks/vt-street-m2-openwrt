'use strict';

import { readfile } from 'fs';
import { counter, add_bytes, valid_interface, modem_interface, parse_vnstat,
	monotonic_ms, live_counters, check_time_confirmation } from '../../package/vtmodem/files/usr/share/vtmodem/traffic.uc';

// Fixture follows the exact JSON v2 output contract in vnStat v2.13 dbjson.c.
// Timestamps use UTC; run this test with TZ=UTC.
const fixture = readfile('scripts/tests/fixtures/vnstat2-summary.json');
const now = 1789300800;
assert(check_time_confirmation(now, now) === null, 'Explicit matching browser/router clock accepted');
assert(check_time_confirmation(now + 120, now) === null, 'Two-minute confirmation tolerance');
assert(check_time_confirmation(now + 121, now) === 'clock_mismatch', 'Future mismatching clock rejected');
assert(check_time_confirmation(now - 121, now) === 'clock_mismatch', 'Past mismatching clock rejected');
for (let bad in [ null, '1789300800', true, 1789300800.5, 0, 253402300800 ])
	assert(check_time_confirmation(bad, now) === 'invalid_timestamp', 'Clock confirmation requires sane integer timestamp');
function parse(value, names) { return parse_vnstat(sprintf('%J', value), names ?? ['wwan0'], now); }
let source = json(fixture);
let result = parse_vnstat(fixture, ['wwan0'], now);
assert(result !== null, 'Official JSON v2 schema accepted');
assert(result.total.rx_bytes === '9007199254740993', 'Exact count above JavaScript safe integer');
assert(result.today.total_bytes === '3000000002', 'Current day selected by date, not array order');
assert(result.month.rx_bytes === '13000000001', 'Current month selected by date');
assert(result.period.day === '2026-09-13' && result.period.month === '2026-09', 'Explicit period keys');
assert(result.accounting_since === 1788998400, 'Accounting start uses creation timestamp');
assert(result.total.tx_bytes === '9876543210', 'LAN traffic excluded');
assert(counter('18446744073709551615') === '18446744073709551615', 'uint64 maximum accepted');
assert(add_bytes('18446744073709551615', '18446744073709551615') === '36893488147419103230', 'Sum cannot overflow uint64');
for (let bad in [ -1, 1.5, true, null, '', '01', '1e9', 'NaN', 'Infinity', '18446744073709551616' ])
	assert(counter(bad) === null, 'Invalid/fractional/overflow counter rejected');
for (let bad in [ 'br-lan', 'eth0', 'wwan0;reboot', '../../etc/shadow', 'wwan9999', '' ])
	assert(!valid_interface(bad), 'Only WWAN names accepted');
assert(modem_interface('{"up":true,"proto":"t99w175qmi","l3_device":"wwan1"}') === 'wwan1', 'Actual modem L3 device');
assert(modem_interface('{"up":false,"proto":"t99w175qmi","l3_device":"wwan0"}') === null, 'Stale down session ignored');
assert(modem_interface('{"up":true,"proto":"dhcp","l3_device":"wwan0"}') === null, 'Unrelated interface protocol rejected');
assert(modem_interface('{"up":true,"proto":"t99w175qmi","l3_device":"br-lan"}') === null, 'LAN cannot be enrolled');

source.interfaces[0].traffic.day = [source.interfaces[0].traffic.day[0]];
source.interfaces[0].traffic.month = [source.interfaces[0].traffic.month[0]];
result = parse(source);
assert(result.today.total_bytes === '0' && result.month.total_bytes === '0', 'Yesterday and previous month never shown as current');
source = json(fixture);
let second = json(sprintf('%J', source.interfaces[0]));
second.name = 'wwan1';
second.traffic.total = { rx: 7, tx: 8 };
second.traffic.day = [];
second.traffic.month = [];
push(source.interfaces, second);
result = parse(source, ['wwan0', 'wwan1']);
assert(result.total.rx_bytes === '9007199254741000', 'Explicitly enrolled interfaces accumulated exactly once');
assert(parse(source, ['wwan0', 'wwan2']) === null, 'Missing enrolled interface is not silently zero');
push(source.interfaces, source.interfaces[0]);
assert(parse(source) === null, 'Duplicate interface rejected');
for (let bad in [ '', '{', '[]', 'null', '{"jsonversion":"1","interfaces":[]}' ])
	assert(parse_vnstat(bad, ['wwan0'], now) === null, 'Malformed or unsupported schema rejected');
for (let bad in [-1, 0.5, 'garbage', null]) {
	source = json(fixture); source.interfaces[0].traffic.total.rx = bad;
	assert(parse(source) === null, 'Bad totals rejected instead of rendered as real traffic');
}
source = json(fixture); push(source.interfaces[0].traffic.day, source.interfaces[0].traffic.day[1]);
assert(parse(source) === null, 'Duplicate day row rejected');

let files = {
	'/sys/class/net/wwan1/ifindex': '15\n',
	'/sys/class/net/wwan1/statistics/rx_bytes': '18446744073709551615\n',
	'/sys/class/net/wwan1/statistics/tx_bytes': '9007199254740993\n',
	'/proc/sys/kernel/random/boot_id': '01234567-89ab-cdef-0123-456789abcdef\n',
	'/proc/uptime': '1234.56 999.00\n'
};
function reader(path) { return files[path] ?? null; }
result = live_counters('wwan1', reader);
assert(result.rx_bytes === '18446744073709551615' && result.monotonic_ms === 1234560, 'Fresh exact live counters with monotonic clock');
assert(result.ifindex === 15 && result.boot_id === '01234567-89ab-cdef-0123-456789abcdef', 'Reset/reboot identity exposed for safe rate deltas');
let calls = 0;
assert(live_counters('wwan1', function(path) {
	if (path == '/sys/class/net/wwan1/ifindex') return sprintf('%d', ++calls);
	return reader(path);
}) === null, 'Interface recreation while sampling rejected');
files['/sys/class/net/wwan1/statistics/rx_bytes'] = null;
assert(live_counters('wwan1', reader) === null, 'Removed interface gives unavailable, not zero traffic');
assert(live_counters('br-lan', reader) === null, 'Live stats never query LAN');
assert(monotonic_ms('17 0\n') === 17000 && monotonic_ms('bad') === null, 'Monotonic clock parser');
printf('VT_TRAFFIC_TESTS_OK\n');
