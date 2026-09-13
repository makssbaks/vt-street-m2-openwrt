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

const l860 = render({
	type: 'fibocom-l860',
	csq: '15,99',
	cesq: '99,99,255,255,20,60',
	temperature: '42.3',
	ca_state: 'existing AT result',
	qmi_signal: { rssi_dbm: -1, rsrp_dbm: -2, rsrq_db: -3, snr_db: 4 },
	qmi_radio: { band: 3, earfcn: 1275, bandwidth_mhz: 15 }
});
assert.deepEqual(values(l860, 'Signal'), {
	RSSI: '-83 dBm', RSRP: '-80 dBm', RSRQ: '-9.5 dB', Temperature: '42 °C'
});
assert.equal(values(l860, 'Radio / cell')['LTE CA state'], 'existing AT result');
assert.equal(Object.hasOwn(values(l860, 'Radio / cell'), 'LTE band'), false);
assert.equal(Object.hasOwn(values(l860, 'Radio / cell'), 'EARFCN'), false);
assert.equal(Object.hasOwn(values(l860, 'Radio / cell'), 'Channel bandwidth'), false);

console.log('VT Modem status fixtures passed: numeric QMI, partial fallback, unavailable data, L860.');
