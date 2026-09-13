'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname,
	'../../package/vtmodem/files/www/luci-static/resources/view/vtmodem/status.js'), 'utf8');

function element(tag, attrs, children) {
	return Array.isArray(tag)
		? { tag: null, attrs: {}, children: attrs || [] }
		: { tag, attrs: attrs || {}, children: children || [] };
}

const page = new Function('view', 'rpc', 'ui', '_', 'E', source)(
	{ extend: value => value },
	{ declare: () => () => Promise.resolve({}) },
	{ createHandlerFn: () => () => {} },
	value => value,
	element
);

function text(node) {
	if (node === null || node === undefined)
		return '';
	return typeof node === 'object' ? node.children.map(text).join('') : String(node);
}

function section(root, title) {
	return root.children.find(node => node && node.attrs &&
		node.attrs.class === 'cbi-section' && text(node.children[0]) === title).children[1];
}

function values(root, title) {
	return Object.fromEntries(section(root, title).children.map(node =>
		[ text(node.children[0]), text(node.children[1]) ]));
}

function signalNote(root, label) {
	const card = section(root, 'Signal').children.find(node => text(node.children[0]) === label);
	return text(card.children[2]);
}

function carrierRows(root) {
	const radioSection = root.children.find(node => node && node.attrs &&
		node.attrs.class === 'cbi-section' && text(node.children[0]) === 'Radio / cell');
	const carriers = radioSection.children[2];
	if (!carriers || carriers.tag !== 'div')
		return [];
	return carriers.children[0].children.slice(1).map(row => row.children.map(text));
}

function render(overrides) {
	return page.render(Object.assign({
		present: true,
		type: 't99w175',
		csq: '21,99',
		cesq: '99,99,255,255,15,45'
	}, overrides));
}

const measured = render({
	qmi_signal: { rssi_dbm: -71, rsrp_dbm: -107, rsrq_db: -16, snr_db: 3 },
	qmi_radio: { band: 3, earfcn: 1275, bandwidth_mhz: 15 }
});
assert.deepEqual(values(measured, 'Signal'), {
	RSSI: '-71 dBm', RSRP: '-107 dBm', RSRQ: '-16 dB', SNR: '3 dB', Temperature: '-'
});
const radio = values(measured, 'Radio / cell');
assert.equal(radio['LTE band'], 'B3');
assert.equal(radio.EARFCN, '1275');
assert.equal(radio['Channel bandwidth'], '15 MHz');
assert.equal(radio['LTE CA state'], '-');
assert.deepEqual(carrierRows(measured), []);

const carriers = render({
	qmi_signal: { rssi_dbm: -72, rsrp_dbm: -107, rsrq_db: -17, snr_db: 4.4000000000000004 },
	t99_temperature: { tsens_c: 29, pa_c: 30, skin_c: 28 },
	t99_ca: [
		{ role: 'pcc', band: 3, bandwidth_mhz: 15 },
		{ role: 'scc1', band: 1, bandwidth_mhz: 10 }
	],
	t99_radio: {
		cell_id: 118667785, tac: 1446, tx_power_dbm: 12,
		antenna_rsrp_dbm: [ -106.6, -110.8, null, null ],
		cells: [
			{ role: 'primary', band: 3, bandwidth_mhz: 15, earfcn: 1275, pci: 213,
				rsrp_dbm: -106.7, rsrq_db: -16.5, rssi_dbm: -69.9, snr_db: 2.4 },
			{ role: 'secondary', band: 1, bandwidth_mhz: 10, earfcn: 550, pci: 224,
				rsrp_dbm: -111.6, rsrq_db: -17.3, rssi_dbm: -75.2, snr_db: 12.4 }
		]
	}
});
assert.equal(values(carriers, 'Signal').SNR, '4.4 dB');
assert.equal(values(carriers, 'Signal').RSRP, '-107 dBm');
assert.equal(values(carriers, 'Signal').Temperature, '29 °C');
assert.equal(signalNote(carriers, 'Temperature'), 'TSENS; PA: 30 °C; Skin: 28 °C');
assert.equal(values(carriers, 'Radio / cell')['LTE CA state'], 'B3 / 15 MHz + B1 / 10 MHz');
assert.equal(values(carriers, 'Radio / cell')['Cell ID'], '118667785');
assert.equal(values(carriers, 'Radio / cell').TAC, '1446');
assert.equal(values(carriers, 'Radio / cell')['Transmit power'], '12 dBm');
assert.equal(values(carriers, 'Radio / cell')['Antenna RSRP'],
	'RX1: -106.6 dBm; RX2: -110.8 dBm; RX3: -; RX4: -');
assert.deepEqual(carrierRows(carriers), [
	[ 'Primary', 'B3', '15 MHz', '1275', '213', '-106.7 dBm', '-16.5 dB', '-69.9 dBm', '2.4 dB' ],
	[ 'Secondary 1', 'B1', '10 MHz', '550', '224', '-111.6 dBm', '-17.3 dB', '-75.2 dBm', '12.4 dB' ]
]);

const partialCarriers = render({
	temperature: '42',
	t99_temperature: { tsens_c: null, pa_c: 0, skin_c: 28.5 },
	t99_ca: null,
	t99_radio: { tx_power_dbm: 0, cells: [
		{ role: 'primary', band: 3, bandwidth_mhz: 1.4, earfcn: 0, pci: 0,
			rsrp_dbm: null, rsrq_db: 0, rssi_dbm: NaN, snr_db: Infinity }
	] }
});
assert.equal(values(partialCarriers, 'Signal').Temperature, '-');
assert.equal(signalNote(partialCarriers, 'Temperature'), 'TSENS; PA: 0 °C; Skin: 28.5 °C');
assert.equal(values(partialCarriers, 'Radio / cell')['LTE CA state'], '-');
assert.equal(values(partialCarriers, 'Radio / cell')['Cell ID'], '-');
assert.equal(values(partialCarriers, 'Radio / cell')['Transmit power'], '0 dBm');
assert.deepEqual(carrierRows(partialCarriers), [
	[ 'Primary', 'B3', '1.4 MHz', '0', '0', '-', '0 dB', '-', '-' ]
]);

const unavailable = render({ t99_temperature: null, t99_ca: null, t99_radio: null });
assert.equal(values(unavailable, 'Signal').Temperature, '-');
assert.equal(values(unavailable, 'Radio / cell')['LTE CA state'], '-');
assert.deepEqual(carrierRows(unavailable), []);
assert.match(text(unavailable), /Carrier measurements unavailable/);

const partial = render({
	qmi_signal: { rssi_dbm: -70.5, rsrp_dbm: null, rsrq_db: 0, snr_db: 0 },
	qmi_radio: { band: null, earfcn: 0, bandwidth_mhz: 1.4 }
});
assert.deepEqual(values(partial, 'Signal'), {
	RSSI: '-70.5 dBm', RSRP: '-95 dBm', RSRQ: '0 dB', SNR: '0 dB', Temperature: '-'
});
assert.equal(values(partial, 'Radio / cell')['LTE band'], '-');
assert.equal(values(partial, 'Radio / cell').EARFCN, '0');
assert.equal(values(partial, 'Radio / cell')['Channel bandwidth'], '1.4 MHz');

for (const missing of [ {}, { qmi_signal: null, qmi_radio: null }, {
	qmi_signal: { rssi_dbm: '0', rsrp_dbm: Infinity, rsrq_db: NaN, snr_db: null },
	qmi_radio: { band: NaN, earfcn: '1275', bandwidth_mhz: Infinity }
} ]) {
	const fallback = render(missing);
	assert.deepEqual(values(fallback, 'Signal'), {
		RSSI: '-71 dBm', RSRP: '-95 dBm', RSRQ: '-12 dB', SNR: '-', Temperature: '-'
	});
	assert.equal(values(fallback, 'Radio / cell')['LTE band'], '-');
	assert.equal(values(fallback, 'Radio / cell').EARFCN, '-');
	assert.equal(values(fallback, 'Radio / cell')['Channel bandwidth'], '-');
}

const connectedSession = {
	up: true, pending: false, available: true, interface: 'wwan0',
	ipv4: [ { address: '10.169.86.163', mask: 29 } ], dns: [ '85.249.22.248' ]
};
const connected = render({
	attached: '0', data_channel: 'old AT value', dns: [ 'stale DNS profile' ],
	iccid: '8901234567890123456',
	t99_session: connectedSession,
	t99_link: { raw_ip: true, mac: null }
});
assert.equal(values(connected, 'Overview').Data, 'Connected');
assert.equal(values(connected, 'Radio / cell')['Data channel'], 'Connected (QMI / wwan0)');
assert.equal(values(connected, 'Radio / cell')['IPv4 address'], '10.169.86.163/29');
assert.equal(values(connected, 'Modem details')['DNS servers'], '85.249.22.248');
assert.equal(values(connected, 'Modem details')['Data MAC'], 'Not applicable (Raw IP)');
assert.equal(values(connected, 'Modem details').ICCID, '8901234567890123456');
assert.equal(Object.hasOwn(values(connected, 'Modem details'), 'DNS profiles'), false);
assert.doesNotMatch(text(connected), /stale DNS profile|old AT value/);

for (const [ state, expected ] of [
	[ { up: false, pending: false, available: true }, 'Disconnected' ],
	[ { up: false, pending: true, available: true }, 'Connecting' ],
	[ { up: false, pending: true, available: false }, 'Unavailable' ],
	[ { up: false, pending: null, available: null }, 'Disconnected' ],
	[ null, 'Unknown' ],
	[ {}, 'Unknown' ],
	[ { up: 'true', pending: 'true', available: 'false' }, 'Unknown' ]
]) {
	const statePage = render({ attached: '1', data_channel: '1,AT channel', t99_session: state });
	assert.equal(values(statePage, 'Overview').Data, expected);
	assert.equal(values(statePage, 'Radio / cell')['Data channel'], expected);
}

for (const malformed of [ null, false, 42, 'invalid', [], [ connectedSession ], {
	up: null, pending: null, available: null, interface: { name: 'wwan0' },
	ipv4: [ null, false, 'bad', [], { address: '10.0.0.1', mask: '24' },
		{ address: '999.0.0.1', mask: 24 }, { address: '10.0.0.1', mask: 33 },
		{ address: '10.0.0.1', mask: 1.5 }, { address: 'bad', mask: 24 } ],
	dns: [ null, false, {}, [], '' ]
} ]) {
	const malformedPage = render({
		attached: '1', data_interface: 'wwan0', dns: [ 'stale DNS profile' ],
		data_mac: '00:11:22:33:44:55', t99_session: malformed, t99_link: malformed
	});
	assert.equal(values(malformedPage, 'Overview').Data, 'Unknown');
	assert.equal(values(malformedPage, 'Radio / cell')['Data channel'], 'Unknown');
	assert.equal(values(malformedPage, 'Radio / cell')['IPv4 address'], '-');
	assert.equal(values(malformedPage, 'Modem details')['DNS servers'], '-');
	assert.equal(values(malformedPage, 'Modem details')['Data MAC'], '-');
	assert.doesNotMatch(text(malformedPage), /\[object Object\]|stale DNS profile|Packet attachedwwan0/);
}

for (const [ link, expected ] of [
	[ { raw_ip: false, mac: '02:85:2f:d9:04:8e' }, '02:85:2f:d9:04:8e' ],
	[ { raw_ip: null, mac: '02:85:2F:D9:04:8E' }, '02:85:2F:D9:04:8E' ],
	[ { raw_ip: true, mac: '02:85:2f:d9:04:8e' }, 'Not applicable (Raw IP)' ],
	[ { raw_ip: 'true', mac: null }, '-' ],
	[ { raw_ip: false, mac: 'invalid' }, '-' ],
	[ { raw_ip: false, mac: [] }, '-' ],
	[ { raw_ip: false, mac: null }, '-' ]
]) {
	assert.equal(values(render({ t99_link: link }), 'Modem details')['Data MAC'], expected);
}

const partialSession = render({ t99_session: {
	up: true, interface: 'invalid interface',
	ipv4: [ { address: '0.0.0.0', mask: 0 } ], dns: [ '2001:db8::53', null, '85.249.22.248' ]
} });
assert.equal(values(partialSession, 'Radio / cell')['Data channel'], 'Connected (QMI)');
assert.equal(values(partialSession, 'Radio / cell')['IPv4 address'], '0.0.0.0/0');
assert.equal(values(partialSession, 'Modem details')['DNS servers'], '2001:db8::5385.249.22.248');

const l860 = render({
	type: 'fibocom-l860',
	csq: '15,99',
	cesq: '99,99,255,255,20,60',
	temperature: '42.3',
	ca_state: 'existing AT result',
	qmi_signal: { rssi_dbm: -1, rsrp_dbm: -2, rsrq_db: -3, snr_db: 4 },
	qmi_radio: { band: 3, earfcn: 1275, bandwidth_mhz: 15 },
	t99_temperature: { tsens_c: 29, pa_c: 30, skin_c: 28 },
	t99_ca: [ { role: 'pcc', band: 3, bandwidth_mhz: 15 } ],
	t99_radio: { cells: [ { role: 'primary', band: 3, bandwidth_mhz: 15 } ] },
	attached: '1', data_channel: '1,existing AT channel', data_interface: 'wwan1',
	data_mac: '00:11:22:33:44:55', dns: [ 'existing DNS profile' ],
	t99_session: { up: false, pending: true, available: false, dns: [ 'wrong DNS' ] },
	t99_link: { raw_ip: true, mac: null }
});
assert.deepEqual(values(l860, 'Signal'), {
	RSSI: '-83 dBm', RSRP: '-80 dBm', RSRQ: '-9.5 dB', Temperature: '42 °C'
});
assert.equal(values(l860, 'Radio / cell')['LTE CA state'], 'existing AT result');
assert.equal(Object.hasOwn(values(l860, 'Radio / cell'), 'LTE band'), false);
assert.equal(Object.hasOwn(values(l860, 'Radio / cell'), 'EARFCN'), false);
assert.equal(Object.hasOwn(values(l860, 'Radio / cell'), 'Channel bandwidth'), false);
assert.deepEqual(carrierRows(l860), []);
assert.equal(signalNote(l860, 'Temperature'), '');
assert.equal(values(l860, 'Overview').Data, 'Data channel ready');
assert.equal(values(l860, 'Radio / cell')['Data channel'], '1,existing AT channel');
assert.equal(Object.hasOwn(values(l860, 'Radio / cell'), 'IPv4 address'), false);
assert.equal(values(l860, 'Modem details')['Data MAC'], '00:11:22:33:44:55');
assert.equal(values(l860, 'Modem details')['DNS profiles'], 'existing DNS profile');
assert.equal(Object.hasOwn(values(l860, 'Modem details'), 'DNS servers'), false);

console.log('VT Modem status fixtures passed: QMI rounding, T99 radio/session/link details, partial and malformed data, L860.');
