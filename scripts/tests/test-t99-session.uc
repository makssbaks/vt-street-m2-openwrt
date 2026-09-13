'use strict';

import { parse_session, parse_link } from '../../package/vtmodem/files/usr/share/vtmodem/t99-session.uc';

function session(value) { return parse_session(sprintf('%J', value)); }
function active() {
	return {
		up: true, pending: false, available: true,
		proto: 't99w175qmi', l3_device: 'wwan0',
		'ipv4-address': [{ address: '192.0.2.3', mask: 29 }],
		'dns-server': ['192.0.2.53', '2001:db8::53'],
		data: { cid_4: '17', pdh_4: '12345' }, password: 'not-forwarded'
	};
}

let result = session(active());
assert(result.up === true && result.pending === false && result.available === true && result.interface === 'wwan0', 'Active QMI session state');
assert(length(result.ipv4) === 1 && result.ipv4[0].address === '192.0.2.3' && result.ipv4[0].mask === 29, 'IPv4 address and mask');
assert(length(result.dns) === 2 && result.dns[1] === '2001:db8::53', 'IPv4 and IPv6 DNS preserved');
assert(length(keys(result)) === 6 && !exists(result, 'data') && !exists(result, 'password'), 'No packet handle, client ID or extra properties');

let value = active();
value.up = false;
result = session(value);
assert(result.up === false && result.interface === 'wwan0' && length(result.ipv4) === 0 && length(result.dns) === 0, 'Down session clears stale addresses and DNS');
result = session({ up: false, available: false });
assert(result.up === false && result.available === false && result.pending === null && result.interface === null, 'Unavailable session may omit protocol and device');
result = session({ up: false });
assert(result.pending === null && result.available === null, 'Omitted flags remain unknown');
result = session({ up: false, pending: true, available: true, proto: 't99w175qmi' });
assert(result.pending === true && result.interface === null, 'Pending session can lack L3 device');

for (let bad in [ null, '', '{', '[]', 'true', '{"up":null}', '{"up":1}', '{"pending":false}' ])
	assert(parse_session(bad) === null, 'Malformed session or absent up state rejected');
for (let flag in [ 'pending', 'available' ]) {
	value = active(); value[flag] = null;
	assert(session(value) === null, 'Explicit null flag is malformed');
	value[flag] = 'false';
	assert(session(value) === null, 'String flag is not a boolean');
}
for (let up in [ true, false ]) {
	value = active(); value.up = up; value.proto = 'dhcp';
	assert(session(value) === null, 'Wrong explicit protocol rejected');
	value = active(); value.up = up; value.l3_device = 'br-lan';
	assert(session(value) === null, 'Wrong explicit L3 device rejected');
}
assert(session({ up: true, l3_device: 'wwan0' }) === null && session({ up: true, proto: 't99w175qmi' }) === null, 'Up requires both expected identities');

value = active();
value['ipv4-address'] = [
	{ address: '0.0.0.0', mask: 0 }, { address: '255.255.255.255', mask: 32 },
	{ address: '256.1.2.3', mask: 24 }, { address: '1.2.3', mask: 24 },
	{ address: '01.2.3.4', mask: 24 }, { address: '192.0.2.1 ', mask: 24 },
	{ address: '192.0.2.1', mask: -1 }, { address: '192.0.2.1', mask: 33 },
	{ address: '192.0.2.1', mask: 24.5 }, { address: '192.0.2.1', mask: '24' },
	null, '192.0.2.1/24'
];
value['dns-server'] = [
	'192.0.2.53', '::', '::1', '2001:db8::53', '2001:db8:0:1:2:3:4:5',
	'::ffff:192.0.2.53', '2001:db8:0:0:0:0:192.0.2.53',
	'256.2.3.4', '1.2.3', 'dns.example', '192.0.2.53;id',
	'2001:db8:::53', '1::2::3', '12345::1', '1:2:3:4:5:6:7',
	'1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7:8::', 'fe80::1%wwan0',
	'::ffff:256.0.2.53', '', true, null
];
result = session(value);
assert(length(result.ipv4) === 2 && result.ipv4[0].mask === 0 && result.ipv4[1].mask === 32, 'Only real IPv4 addresses with whole masks 0..32 survive');
assert(length(result.dns) === 7 && result.dns[5] === '::ffff:192.0.2.53', 'DNS validates compressed, full and embedded IPv6; rejects malformed addresses');
value = active(); value['ipv4-address'] = 'wrong'; value['dns-server'] = {};
result = session(value);
assert(result.up === true && length(result.ipv4) === 0 && length(result.dns) === 0, 'Malformed optional arrays do not discard valid session state');

result = parse_link('Y\n', '65534\n', '0\n', '\n');
assert(result.raw_ip === true && result.mac === null, 'Confirmed Raw IP has no Ethernet MAC');
result = parse_link('N\n', '1\n', '6\n', '02:AA:BB:CC:DD:EE\n');
assert(result.raw_ip === false && result.mac === '02:aa:bb:cc:dd:ee', 'Confirmed Ethernet mode retains its real MAC');
for (let facts in [
	['Y', '1', '6', '02:aa:bb:cc:dd:ee'],
	['N', '65534', '0', ''],
	['Y', '65534', '0', '02:aa:bb:cc:dd:ee'],
	['Y', null, '0', ''], ['Y', '65534', null, ''],
	['N', '1', '6', ''], ['N', '1', '6', '02:aa:bb:cc:dd:xx'],
	['N', '1', '6', '02:aa:bb:cc:dd:ee;id'],
	[null, '65534', '0', ''], ['', '', '', '']
]) {
	result = parse_link(facts[0], facts[1], facts[2], facts[3]);
	assert(result.raw_ip === null && result.mac === null, 'Conflicting, missing or malformed sysfs facts remain unknown');
}

print('T99_SESSION_TESTS_OK\n');
