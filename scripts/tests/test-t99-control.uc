'use strict';

import { readfile } from 'fs';
import { parse_mode, parse_mode_support, parse_supported, parse_bands, parse_priority,
	parse_lock, collect_control, apply_control } from '../../package/vtmodem/files/usr/share/vtmodem/t99-control.uc';

function fixture(name) { return readfile(`scripts/tests/fixtures/t99-control-${name}.txt`); }
function json(value) { return sprintf('%J', value); }
function equal(a, b, why) { assert(json(a) == json(b), why); }
let device = '/dev/t99w175-at';
let texts = {
	'AT^SLMODE?': fixture('mode'), 'AT^SLMODE=?': fixture('mode-support'),
	'AT^SLBAND=?': fixture('supported'), 'AT^BAND_PREF?': fixture('bands'),
	'AT^BAND_PRI?': fixture('priority'), 'AT^LTE_LOCK?': fixture('lock'),
	'AT+CFUN?': '+CFUN: 1\n'
};

equal(parse_mode(texts['AT^SLMODE?']), { persist: 1, mode: 2 }, 'Actual LTE-only persistent mode');
equal(parse_mode_support(texts['AT^SLMODE=?']), { persist: [0, 1], modes: [0, 1, 2, 3, 4, 5, 6, 7] }, 'Actual supported mode ranges');
let caps = parse_supported(texts['AT^SLBAND=?']);
assert(length(caps.LTE) == 30 && index(caps.LTE, 71) >= 0 && index(caps.NR5G, 79) >= 0, 'All actual capabilities');
let bands = parse_bands(texts['AT^BAND_PREF?']);
assert(length(bands.LTE.enabled) == 29 && bands.LTE.disabled[0] == 71, 'Actual LTE band state');
equal(bands.WCDMA.disabled, [], 'Explicit empty disable list remains known empty');
equal(parse_priority(texts['AT^BAND_PRI?']), [], 'Confirmed priority unset');
assert(parse_priority('') === null && parse_priority('OK\r\n') === null, 'Empty transport data never confirms unset priority');
assert(parse_priority('^BAND_PRI:') === null, 'Truncated priority field stays unknown');
equal(parse_priority('^BAND_PRI: Band priority file does not exist'), [], 'Prefixed missing priority file means unset');
equal(parse_lock(texts['AT^LTE_LOCK?']), [], 'Confirmed lock unset');
equal(parse_lock('^LTE_LOCK:(213,1275),'), [{ pci: 213, earfcn: 1275 }], 'Actual GC.004 trailing comma');
equal(parse_lock('^LTE_LOCK:(213,1275),(224,550),'), [{ pci: 213, earfcn: 1275 }, { pci: 224, earfcn: 550 }], 'Trailing comma on multiple pairs');
for (let malformed in ['^LTE_LOCK:(213,1275),,', '^LTE_LOCK:(213,1275),ERROR', '^LTE_LOCK:(213,1275),()'])
	assert(parse_lock(malformed) === null, 'Trailing comma does not allow extra tokens');
equal(parse_lock('^LTE_LOCK: (213,1275), (224,550)'), [{ pci: 213, earfcn: 1275 }, { pci: 224, earfcn: 550 }], 'Documented parenthesized lock pairs');
equal(parse_lock('^LTE_LOCK: ( 213 , 1275 ) , (224, 550)'), [{ pci: 213, earfcn: 1275 }, { pci: 224, earfcn: 550 }], 'Whitespace allowed only around valid pair tokens');
equal(parse_lock('^LTE_LOCK:0,0,503,262143'), [{ pci: 0, earfcn: 0 }, { pci: 503, earfcn: 262143 }], 'Flat pairs and boundary values');
for (let parser in [parse_mode, parse_mode_support, parse_supported, parse_bands, parse_lock]) {
	assert(parser('ERROR') === null && parser('') === null && parser(null) === null, 'Missing/malformed results never imply empty settings');
}
assert(parse_priority('ERROR') === null && parse_priority(null) === null, 'Priority transport/modem errors stay unknown');
assert(parse_mode('^SLMODE:1,8') === null && parse_mode('^SLMODE:1,2\n^SLMODE:1,3') === null, 'Out-of-range and conflicting mode rejected');
assert(parse_mode_support('^SLMODE:(0-1),(0-9)') === null, 'Unknown modes not silently enabled');
assert(parse_supported(replace(texts['AT^SLBAND=?'], 'LTE,(1,2', 'LTE,(1,1')) === null, 'Duplicated capability entries rejected');
assert(parse_bands(replace(texts['AT^BAND_PREF?'], 'LTE,Disable Bands:71,', 'LTE,Disable Bands:1,71,')) === null, 'Contradictory enabled/disabled state rejected');
assert(parse_bands(replace(texts['AT^BAND_PREF?'], 'WCDMA,Disable Bands:', 'WCDMA,Enable Bands:')) === null, 'Missing/duplicate band section rejected');
assert(parse_priority('^BAND_PRI:1,1') === null, 'Duplicated priority remains malformed');
equal(parse_priority('AT^BAND_PRI?\r\nBand priority file does not exist\r\nOK'), [], 'Exact query echo can be ignored');
for (let raw in ['^LTE_LOCK:', '^LTE_LOCK: (213,1275),garbage', '^LTE_LOCK:504,1', '^LTE_LOCK:1,262144', '^LTE_LOCK:1,2,1,2'])
	assert(parse_lock(raw) === null, 'Malformed, duplicate, or out-of-range lock rejected');

let calls = [], budget = 0;
function record(argv, timeout_ms) {
	assert(argv[0] == '/usr/bin/vt-at' && argv[1] == '-t' && argv[3] == device && length(argv) == 5, 'Fixed executable and argument vector');
	assert((argv[2] == '3000' && timeout_ms == 3500) || (argv[2] == '10000' && timeout_ms == 10500), 'Both timeout layers bounded');
	budget += timeout_ms;
	assert(budget <= 55000, 'Conservative per-action budget');
	push(calls, argv[4]);
}
function reset() { calls = []; budget = 0; }
function read_runner(argv, timeout_ms) {
	record(argv, timeout_ms);
	assert(texts[argv[4]] != null, 'Read-only runner cannot execute a write');
	return { ok: true, output: texts[argv[4]] };
}
let status = collect_control(device, read_runner);
assert(status.ok && status.supported && length(status.errors) == 0 && length(calls) == 6, 'Six actual read/test queries collected');
equal(status.tokens.mode, json(status.mode), 'Mode token exact');
equal(status.tokens.bands, json(status.bands), 'Band stale token includes every technology');
reset();
assert(collect_control('/dev/ttyUSB2', read_runner).supported === false && length(calls) == 0, 'Device alias must be validated before any command');
reset();
let failed = collect_control(device, (argv, timeout_ms) => {
	record(argv, timeout_ms);
	return argv[4] == 'AT^LTE_LOCK?' ? { ok: false, output: texts[argv[4]] } : { ok: true, output: texts[argv[4]] };
});
assert(failed.lock === null && failed.tokens.lock === null && length(failed.errors) == 1, 'Failed query ignores even apparently useful output');

reset();
let missing_priority = collect_control(device, (argv, t) => {
	record(argv, t);
	return { ok: true, output: argv[4] == 'AT^BAND_PRI?' ? '' : texts[argv[4]] };
});
assert(missing_priority.priority === null && missing_priority.tokens.priority === null &&
	missing_priority.diagnostics.priority.code == 'unrecognized_response', 'Unknown priority remains non-writable and diagnosed');

function args(action, value, expected) { return { action, value, expected: json(expected), confirm: true }; }
function reject_without_query(request) {
	reset(); let result = apply_control(device, request, read_runner);
	assert(result.ok === false && result.changed === false && length(calls) == 0, 'Invalid input cannot issue even a query');
}
reject_without_query({ action: 'mode', value: '1,2', expected: status.tokens.mode, confirm: false });
reject_without_query(args('mode', '1,2; reboot', status.mode));
reject_without_query(args('mode', '1,9', status.mode));
reject_without_query(args('priority', '1,1', []));
reject_without_query(args('priority', '1,3$(reboot)', []));
reject_without_query(args('lock', '504,1275', []));
reject_without_query(args('lock', '1,2,3', []));
reject_without_query(args('unlock', '1,2', []));
reject_without_query(args('bands', '', bands));
reject_without_query(args('bands', '1,1', bands));
reject_without_query(args('reset', '', null));
reset();
let result = apply_control(device, args('priority', '1,3', [7]), read_runner);
assert(result.ok === false && result.changed === false && length(calls) == 1, 'Stale guard stops before capability checks or writes');
reset();
result = apply_control(device, args('priority', '200', []), read_runner);
assert(result.ok === false && result.changed === false && length(calls) == 2, 'Unsupported band refused before write');
reset();
result = apply_control(device, args('mode', '1,2', status.mode), read_runner);
assert(result.ok && !result.changed && result.verified && length(calls) == 4, 'Mode no-op performs safety reads but no write');

function transaction(request, responses) {
	reset(); let i = 0;
	let result = apply_control(device, request, (argv, timeout_ms) => {
		record(argv, timeout_ms);
		let step = responses[i++];
		assert(step != null && argv[4] == step[0], `Unexpected command ${argv[4]}`);
		return type(step[1]) == 'string' ? { ok: true, output: step[1] } : step[1];
	});
	assert(i == length(responses), 'All expected commands executed exactly once');
	return result;
}
let prefix = [ ['AT^SLMODE?', texts['AT^SLMODE?']], ['AT^SLMODE=?', texts['AT^SLMODE=?']] ];
result = transaction(args('mode', '1,0', status.mode), [
	prefix[0], prefix[1], ['AT^LTE_LOCK?', '^LTE_LOCK:(213,1275)']
]);
assert(!result.ok && !result.changed, 'Existing lock blocks non-LTE mode before CFUN or write');
result = transaction(args('mode', '1,0', status.mode), [
	prefix[0], prefix[1], ['AT^LTE_LOCK?', texts['AT^LTE_LOCK?']], ['AT+CFUN?', '+CFUN: 0']
]);
assert(!result.ok && !result.changed, 'CFUN other than full mode blocks change, never auto-enables modem');
result = transaction(args('mode', '0,0', status.mode), [
	prefix[0], prefix[1], ['AT^LTE_LOCK?', texts['AT^LTE_LOCK?']], ['AT+CFUN?', '+CFUN: 1'],
	['AT^SLMODE=0,0', ''], ['AT^SLMODE?', '^SLMODE:0,0']
]);
assert(result.ok && result.changed && result.verified && !result.restart_required, 'Mode one write then exact readback');
result = transaction(args('priority', '7,1,3', []), [
	['AT^BAND_PRI?', texts['AT^BAND_PRI?']], ['AT^SLBAND=?', texts['AT^SLBAND=?']],
	['AT^BAND_PRI=7,1,3', ''], ['AT^BAND_PRI?', '^BAND_PRI:7,1,3']
]);
assert(result.ok && result.verified && result.restart_required, 'Priority order preserved and stored state distinguished from active radio');
result = transaction(args('priority', '1,3', []), [
	['AT^BAND_PRI?', texts['AT^BAND_PRI?']], ['AT^SLBAND=?', texts['AT^SLBAND=?']],
	['AT^BAND_PRI=1,3', { ok: false, output: '' }], ['AT^BAND_PRI?', '^BAND_PRI:1,3']
]);
assert(!result.ok && result.changed && !result.verified && result.restart_required, 'Write timeout remains uncertain even with matching readback; no automatic retry');
result = transaction(args('lock', '213,1275,224,550', []), [
	['AT^LTE_LOCK?', texts['AT^LTE_LOCK?']], ['AT^LTE_LOCK=213,1275,224,550', ''],
	['AT^LTE_LOCK?', '^LTE_LOCK:(213,1275),(224,550)']
]);
assert(result.ok && result.verified && result.restart_required, 'Lock write and parenthesized readback verified without reset');
result = transaction(args('unlock', '', [{ pci: 213, earfcn: 1275 }]), [
	['AT^LTE_LOCK?', '^LTE_LOCK:(213,1275)'], ['AT^LTE_LOCK', ''], ['AT^LTE_LOCK?', 'unexpected']
]);
assert(!result.ok && result.changed && !result.verified, 'Post-write parse failure cannot claim unchanged');

function band_text(enabled, other_changed) {
	let disabled = [];
	for (let band in caps.LTE) if (index(enabled, band) < 0) push(disabled, band);
	return 'WCDMA,Enable Bands:' + join(',', other_changed ? [1] : bands.WCDMA.enabled) + '\n' +
		'WCDMA,Disable Bands:\nLTE,Enable Bands:' + join(',', enabled) + '\n' +
		'LTE,Disable Bands:' + join(',', disabled) + '\nNR5G,Enable Bands:' + join(',', bands.NR5G.enabled) + '\n' +
		'NR5G,Disable Bands:71\n';
}
let mid = [1, 3, 29, 30, 32, 34, 38, 39, 40, 41, 42, 46, 48, 66];
result = transaction(args('bands', '3,1', bands), [
	['AT^BAND_PREF?', texts['AT^BAND_PREF?']], ['AT^SLBAND=?', texts['AT^SLBAND=?']], ['AT^LTE_LOCK?', texts['AT^LTE_LOCK?']],
	['AT^BAND_PREF=LTE,1,2,4,5,7,8,12,13,14,17,18,19,20,25,26,28', ''], ['AT^BAND_PREF?', band_text(mid)],
	['AT^BAND_PREF=LTE,1,29,30,32,34,38,39,40,41,42,46,48,66', ''], ['AT^BAND_PREF?', band_text([1, 3])]
]);
assert(result.ok && result.verified && result.changed && !result.restart_required, 'Actual 29-to-2 selection uses only two bounded disable writes and needs no reboot');
equal(result.current.LTE.enabled, [1, 3], 'Final desired set exact');
result = transaction(args('bands', '1,3', bands), [
	['AT^BAND_PREF?', texts['AT^BAND_PREF?']], ['AT^SLBAND=?', texts['AT^SLBAND=?']], ['AT^LTE_LOCK?', '^LTE_LOCK: (213,1275)']
]);
assert(!result.ok && !result.changed, 'Active cell lock blocks band writes');
let subset = parse_bands(band_text([1]));
let initial = parse_bands(band_text([1, 7]));
result = transaction(args('bands', '1,3', initial), [
	['AT^BAND_PREF?', band_text([1, 7])], ['AT^SLBAND=?', texts['AT^SLBAND=?']], ['AT^LTE_LOCK?', texts['AT^LTE_LOCK?']],
	['AT^BAND_PREF=LTE,2,1,3', ''], ['AT^BAND_PREF?', band_text([1, 3])]
]);
assert(result.ok && result.verified && !result.restart_required, 'GC.004 operation 2 replaces the LTE enabled set exactly');
result = transaction(args('bands', '1,3', subset), [
	['AT^BAND_PREF?', band_text([1])], ['AT^SLBAND=?', texts['AT^SLBAND=?']], ['AT^LTE_LOCK?', texts['AT^LTE_LOCK?']],
	['AT^BAND_PREF=LTE,2,1,3', ''], ['AT^BAND_PREF?', band_text([1, 3, 7])]
]);
assert(!result.ok && result.changed && !result.verified, 'Unexpected added band stops transaction without cleanup writes');
result = transaction(args('bands', '1,3', subset), [
	['AT^BAND_PREF?', band_text([1])], ['AT^SLBAND=?', texts['AT^SLBAND=?']], ['AT^LTE_LOCK?', texts['AT^LTE_LOCK?']],
	['AT^BAND_PREF=LTE,2,1,3', { ok: false, output: '' }], ['AT^BAND_PREF?', band_text([1, 3])]
]);
assert(!result.ok && result.changed && !result.verified && !result.restart_required, 'Band write timeout stops despite matching readback without recommending a reboot');
result = transaction(args('bands', '1,3', bands), [
	['AT^BAND_PREF?', texts['AT^BAND_PREF?']], ['AT^SLBAND=?', texts['AT^SLBAND=?']], ['AT^LTE_LOCK?', texts['AT^LTE_LOCK?']],
	['AT^BAND_PREF=LTE,1,2,4,5,7,8,12,13,14,17,18,19,20,25,26,28', ''], ['AT^BAND_PREF?', band_text([3])]
]);
assert(!result.ok && result.changed && !result.verified, 'Losing a desired band stops before next disable chunk');
let too_many = join(',', caps.LTE);
result = transaction(args('bands', too_many, bands), [
	['AT^BAND_PREF?', texts['AT^BAND_PREF?']], ['AT^SLBAND=?', texts['AT^SLBAND=?']], ['AT^LTE_LOCK?', texts['AT^LTE_LOCK?']]
]);
assert(!result.ok && !result.changed, 'Missing enabled band plus desired list over 15 is rejected before any write');
reset();
result = apply_control(device, args('lock', '1,2', []), (argv, timeout_ms) => { record(argv, timeout_ms); die('simulated runner failure'); });
assert(!result.ok && !result.changed && length(calls) == 1, 'Runner exception during preflight becomes a refusal');

print('T99_CONTROL_TESTS_OK\n');
