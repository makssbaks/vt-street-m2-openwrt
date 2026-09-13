'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname,
	'../../package/vtmodem/files/www/luci-static/resources/view/vtmodem/status.js'), 'utf8');
const pureSource = source.slice(0, source.lastIndexOf('\nreturn view.extend(')) + '\nreturn { render: renderStatus };';

function element(tag, attrs, children) {
	return Array.isArray(tag)
		? { tag: null, attrs: {}, children: attrs || [] }
		: { tag, attrs: attrs || {}, children: children || [] };
}

const page = new Function('view', 'rpc', 'ui', '_', 'E', pureSource)(
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
	const card = section(root, 'Сигнал').children.find(node => text(node.children[0]) === label);
	return text(card.children[2]);
}

function carrierRows(root) {
	const radioSection = root.children.find(node => node && node.attrs &&
		node.attrs.class === 'cbi-section' && text(node.children[0]) === 'Радиосеть и сота');
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
assert.deepEqual(values(measured, 'Сигнал'), {
	RSSI: '-71 dBm', RSRP: '-107 dBm', RSRQ: '-16 dB', SNR: '3 dB', 'Температура': '-'
});
const radio = values(measured, 'Радиосеть и сота');
assert.equal(radio['Диапазон LTE'], 'B3');
assert.equal(radio.EARFCN, '1275');
assert.equal(radio['Ширина канала'], '15 MHz');
assert.equal(radio['Агрегация LTE'], '-');
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
assert.equal(values(carriers, 'Сигнал').SNR, '4.4 dB');
assert.equal(values(carriers, 'Сигнал').RSRP, '-107 dBm');
assert.equal(values(carriers, 'Сигнал')['Температура'], '29 °C');
assert.equal(signalNote(carriers, 'Температура'), 'TSENS; PA: 30 °C; Корпус: 28 °C');
assert.equal(values(carriers, 'Радиосеть и сота')['Агрегация LTE'], 'B3 / 15 MHz + B1 / 10 MHz');
assert.equal(values(carriers, 'Радиосеть и сота')['Идентификатор соты'], '118667785');
assert.equal(values(carriers, 'Радиосеть и сота').TAC, '1446');
assert.equal(values(carriers, 'Радиосеть и сота')['Мощность передачи'], '12 dBm');
assert.equal(values(carriers, 'Радиосеть и сота')['RSRP по антеннам'],
	'RX1: -106.6 dBm; RX2: -110.8 dBm; RX3: -; RX4: -');
assert.deepEqual(carrierRows(carriers), [
	[ 'Основная', 'B3', '15 MHz', '1275', '213', '-106.7 dBm', '-16.5 dB', '-69.9 dBm', '2.4 dB' ],
	[ 'Дополнительная 1', 'B1', '10 MHz', '550', '224', '-111.6 dBm', '-17.3 dB', '-75.2 dBm', '12.4 dB' ]
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
assert.equal(values(partialCarriers, 'Сигнал')['Температура'], '-');
assert.equal(signalNote(partialCarriers, 'Температура'), 'TSENS; PA: 0 °C; Корпус: 28.5 °C');
assert.equal(values(partialCarriers, 'Радиосеть и сота')['Агрегация LTE'], '-');
assert.equal(values(partialCarriers, 'Радиосеть и сота')['Идентификатор соты'], '-');
assert.equal(values(partialCarriers, 'Радиосеть и сота')['Мощность передачи'], '0 dBm');
assert.deepEqual(carrierRows(partialCarriers), [
	[ 'Основная', 'B3', '1.4 MHz', '0', '0', '-', '0 dB', '-', '-' ]
]);

const unavailable = render({ t99_temperature: null, t99_ca: null, t99_radio: null });
assert.equal(values(unavailable, 'Сигнал')['Температура'], '-');
assert.equal(values(unavailable, 'Радиосеть и сота')['Агрегация LTE'], '-');
assert.deepEqual(carrierRows(unavailable), []);
assert.match(text(unavailable), /Измерения несущих недоступны/);

const partial = render({
	qmi_signal: { rssi_dbm: -70.5, rsrp_dbm: null, rsrq_db: 0, snr_db: 0 },
	qmi_radio: { band: null, earfcn: 0, bandwidth_mhz: 1.4 }
});
assert.deepEqual(values(partial, 'Сигнал'), {
	RSSI: '-70.5 dBm', RSRP: '-95 dBm', RSRQ: '0 dB', SNR: '0 dB', 'Температура': '-'
});
assert.equal(values(partial, 'Радиосеть и сота')['Диапазон LTE'], '-');
assert.equal(values(partial, 'Радиосеть и сота').EARFCN, '0');
assert.equal(values(partial, 'Радиосеть и сота')['Ширина канала'], '1.4 MHz');

for (const missing of [ {}, { qmi_signal: null, qmi_radio: null }, {
	qmi_signal: { rssi_dbm: '0', rsrp_dbm: Infinity, rsrq_db: NaN, snr_db: null },
	qmi_radio: { band: NaN, earfcn: '1275', bandwidth_mhz: Infinity }
} ]) {
	const fallback = render(missing);
	assert.deepEqual(values(fallback, 'Сигнал'), {
		RSSI: '-71 dBm', RSRP: '-95 dBm', RSRQ: '-12 dB', SNR: '-', 'Температура': '-'
	});
	assert.equal(values(fallback, 'Радиосеть и сота')['Диапазон LTE'], '-');
	assert.equal(values(fallback, 'Радиосеть и сота').EARFCN, '-');
	assert.equal(values(fallback, 'Радиосеть и сота')['Ширина канала'], '-');
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
assert.equal(values(connected, 'Обзор')['Передача данных'], 'Подключено');
assert.equal(values(connected, 'Радиосеть и сота')['Канал данных'], 'Подключено (QMI / wwan0)');
assert.equal(values(connected, 'Радиосеть и сота')['Адрес IPv4'], '10.169.86.163/29');
assert.equal(values(connected, 'Сведения о модеме')['Серверы DNS'], '85.249.22.248');
assert.equal(values(connected, 'Сведения о модеме')['MAC интерфейса данных'], 'Не применяется (Raw IP)');
assert.equal(values(connected, 'Сведения о модеме').ICCID, '8901234567890123456');
assert.equal(Object.hasOwn(values(connected, 'Сведения о модеме'), 'Профили DNS'), false);
assert.doesNotMatch(text(connected), /stale DNS profile|old AT value/);

for (const [ state, expected ] of [
	[ { up: false, pending: false, available: true }, 'Отключено' ],
	[ { up: false, pending: true, available: true }, 'Подключение' ],
	[ { up: false, pending: true, available: false }, 'Недоступно' ],
	[ { up: false, pending: null, available: null }, 'Отключено' ],
	[ null, 'Неизвестно' ],
	[ {}, 'Неизвестно' ],
	[ { up: 'true', pending: 'true', available: 'false' }, 'Неизвестно' ]
]) {
	const statePage = render({ attached: '1', data_channel: '1,AT channel', t99_session: state });
	assert.equal(values(statePage, 'Обзор')['Передача данных'], expected);
	assert.equal(values(statePage, 'Радиосеть и сота')['Канал данных'], expected);
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
	assert.equal(values(malformedPage, 'Обзор')['Передача данных'], 'Неизвестно');
	assert.equal(values(malformedPage, 'Радиосеть и сота')['Канал данных'], 'Неизвестно');
	assert.equal(values(malformedPage, 'Радиосеть и сота')['Адрес IPv4'], '-');
	assert.equal(values(malformedPage, 'Сведения о модеме')['Серверы DNS'], '-');
	assert.equal(values(malformedPage, 'Сведения о модеме')['MAC интерфейса данных'], '-');
	assert.doesNotMatch(text(malformedPage), /\[object Object\]|stale DNS profile|Packet attachedwwan0/);
}

for (const [ link, expected ] of [
	[ { raw_ip: false, mac: '02:85:2f:d9:04:8e' }, '02:85:2f:d9:04:8e' ],
	[ { raw_ip: null, mac: '02:85:2F:D9:04:8E' }, '02:85:2F:D9:04:8E' ],
	[ { raw_ip: true, mac: '02:85:2f:d9:04:8e' }, 'Не применяется (Raw IP)' ],
	[ { raw_ip: 'true', mac: null }, '-' ],
	[ { raw_ip: false, mac: 'invalid' }, '-' ],
	[ { raw_ip: false, mac: [] }, '-' ],
	[ { raw_ip: false, mac: null }, '-' ]
]) {
	assert.equal(values(render({ t99_link: link }), 'Сведения о модеме')['MAC интерфейса данных'], expected);
}

const partialSession = render({ t99_session: {
	up: true, interface: 'invalid interface',
	ipv4: [ { address: '0.0.0.0', mask: 0 } ], dns: [ '2001:db8::53', null, '85.249.22.248' ]
} });
assert.equal(values(partialSession, 'Радиосеть и сота')['Канал данных'], 'Подключено (QMI)');
assert.equal(values(partialSession, 'Радиосеть и сота')['Адрес IPv4'], '0.0.0.0/0');
assert.equal(values(partialSession, 'Сведения о модеме')['Серверы DNS'], '2001:db8::5385.249.22.248');

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
assert.deepEqual(values(l860, 'Сигнал'), {
	RSSI: '-83 dBm', RSRP: '-80 dBm', RSRQ: '-9.5 dB', 'Температура': '42 °C'
});
assert.equal(values(l860, 'Радиосеть и сота')['Агрегация LTE'], 'existing AT result');
assert.equal(Object.hasOwn(values(l860, 'Радиосеть и сота'), 'Диапазон LTE'), false);
assert.equal(Object.hasOwn(values(l860, 'Радиосеть и сота'), 'EARFCN'), false);
assert.equal(Object.hasOwn(values(l860, 'Радиосеть и сота'), 'Ширина канала'), false);
assert.deepEqual(carrierRows(l860), []);
assert.equal(signalNote(l860, 'Температура'), '');
assert.equal(values(l860, 'Обзор')['Передача данных'], 'Канал данных готов');
assert.equal(values(l860, 'Радиосеть и сота')['Канал данных'], '1,existing AT channel');
assert.equal(Object.hasOwn(values(l860, 'Радиосеть и сота'), 'Адрес IPv4'), false);
assert.equal(values(l860, 'Сведения о модеме')['MAC интерфейса данных'], '00:11:22:33:44:55');
assert.equal(values(l860, 'Сведения о модеме')['Профили DNS'], 'existing DNS profile');
assert.equal(Object.hasOwn(values(l860, 'Сведения о модеме'), 'Серверы DNS'), false);

// Collapse only exact repeated whole operator phrases; preserve names that
// merely contain repeated words or differ in spacing/case.
for (const [ raw, expected ] of [
	[ 'beeline beeline', 'beeline' ],
	[ 'Test Mobile Test Mobile', 'Test Mobile' ],
	[ 'beeline Beeline', 'beeline Beeline' ],
	[ 'Test Mobile', 'Test Mobile' ],
	[ 'beeline  beeline', 'beeline  beeline' ],
	[ 'beeline beeline beeline', 'beeline beeline beeline' ]
]) {
	assert.equal(values(render({ operator: '0,0,"' + raw + '"' }), 'Обзор')['Оператор'], expected);
}
assert.equal(values(render({ sim_state: 'READY' }), 'Обзор').SIM, 'Готова');
assert.equal(values(render({ sim_state: 'SIM PIN' }), 'Обзор').SIM, 'Требуется PIN');
for (const [ raw, expected ] of [ [ 0, 'Не зарегистрирован' ], [ '0', 'Не зарегистрирован' ],
	[ 1, 'Зарегистрирован' ], [ '1', 'Зарегистрирован' ], [ null, '-' ], [ 'unexpected', 'unexpected' ] ]) {
	assert.equal(values(render({ attached: raw }), 'Радиосеть и сота')['Регистрация в пакетной сети'], expected);
}

console.log('VT Modem status fixtures passed: QMI rounding, T99 radio/session/link details, partial and malformed data, L860.');
