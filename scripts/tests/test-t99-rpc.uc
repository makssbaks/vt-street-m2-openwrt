'use strict';

import { readfile } from 'fs';
import { parse_temperature, parse_ca, parse_cells } from '../../package/vtmodem/files/usr/share/vtmodem/t99-radio.uc';

// Exercise the actual RPC boundary validators without starting rpcd or any
// modem commands. The fixed helper process remains outside this pure test.
let source = readfile('package/vtmodem/files/usr/share/rpcd/ucode/vtmodem');
let begin = index(source, 'function telemetry_number(');
let end = index(source, 'function find_usb(');
assert(begin >= 0 && end > begin, 'Locate the actual RPC telemetry boundary');
let boundary = loadstring(substr(source, begin, end - begin) + '\nreturn { decode: decode_t99_status };', { raw_mode: true })();

let payload = {
	qmi_signal: { rssi_dbm: -71, rsrp_dbm: -107, rsrq_db: -16.5, snr_db: 0 },
	qmi_radio: { band: 3, earfcn: 1275, bandwidth_mhz: 15 },
	t99_temperature: parse_temperature(readfile('scripts/tests/fixtures/t99-temp.txt')),
	t99_ca: parse_ca(readfile('scripts/tests/fixtures/t99-ca.txt')),
	t99_radio: parse_cells(readfile('scripts/tests/fixtures/t99-debug.txt'))
};
let decoded = boundary.decode(sprintf('%J', payload));
assert(decoded.qmi_signal.rsrp_dbm === -107 && decoded.qmi_signal.snr_db === 0, 'Signal and zero cross RPC unchanged');
assert(decoded.qmi_radio.earfcn === 1275 && decoded.t99_temperature.tsens_c === 29, 'Radio and temperature reach RPC response');
assert(length(decoded.t99_ca) === 2 && decoded.t99_ca[1].role === 'scc1' && decoded.t99_ca[1].band === 1, 'Two carriers with validated roles');
assert(decoded.t99_radio.cells[0].pci === 213 && decoded.t99_radio.cells[1].rsrq_db === -17.3, 'Separate primary and secondary measurements survive RPC');
assert(decoded.t99_radio.antenna_rsrp_dbm[0] === -106.6 && decoded.t99_radio.antenna_rsrp_dbm[2] === null, 'Antenna null is preserved');

payload.qmi_signal.rsrp_dbm = 'not a number';
decoded = boundary.decode(sprintf('%J', payload));
assert(decoded.qmi_signal === null && decoded.qmi_radio.band === 3 && decoded.t99_temperature.pa_c === 30 && length(decoded.t99_ca) === 2, 'Malformed signal does not discard other sources');
payload.t99_temperature.tsens_c = [];
decoded = boundary.decode(sprintf('%J', payload));
assert(decoded.t99_temperature === null && decoded.t99_radio.cells[0].band === 3 && decoded.t99_ca[0].role === 'pcc', 'Malformed temperature leaves valid cells and carriers');
payload.t99_ca[1].role = 'nr';
decoded = boundary.decode(sprintf('%J', payload));
assert(decoded.t99_ca === null && decoded.t99_radio.cells[1].role === 'secondary', 'Unrecognized carrier role rejected independently');
payload.t99_radio.cells[1].role = 'nr';
decoded = boundary.decode(sprintf('%J', payload));
assert(decoded.t99_radio === null && decoded.qmi_radio.band === 3, 'Unrecognized cell role rejected independently');

decoded = boundary.decode('{"qmi_signal":{"rssi_dbm":-71},"t99_ca":{},"t99_radio":{"cells":"bad"}}');
assert(decoded.qmi_signal.rssi_dbm === -71 && decoded.qmi_signal.rsrp_dbm === null && decoded.t99_ca === null && decoded.t99_radio === null, 'Invalid array shape rejected; missing measurements remain null');
decoded = boundary.decode('{"qmi_radio":{"band":3},"t99_radio":{"cells":[],"antenna_rsrp_dbm":[-106,"NA"]}}');
assert(decoded.qmi_radio.band === 3 && decoded.t99_radio === null, 'String antenna values cannot enter numeric telemetry');
decoded = boundary.decode('{"qmi_signal":{"rssi_dbm":-71},"t99_temperature":{"tsens_c":1e309}}');
assert(decoded.qmi_signal.rssi_dbm === -71 && decoded.t99_temperature === null, 'Reject non-finite numeric overflow without losing valid signal');
decoded = boundary.decode('{"t99_ca":[],"t99_radio":{"cells":[],"antenna_rsrp_dbm":null},"extra":"ignored"}');
assert(type(decoded.t99_ca) === 'array' && length(decoded.t99_ca) === 0 && decoded.t99_radio.cell_id === null && decoded.extra === null, 'Unknown carrier array stays empty; extra fields are not forwarded');

for (let input in [ null, '', '[]', 'null', '{broken' ]) {
	decoded = boundary.decode(input);
	assert(decoded.qmi_signal === null && decoded.t99_temperature === null && decoded.t99_ca === null && decoded.t99_radio === null, 'Malformed envelope rejected');
}
decoded = boundary.decode(sprintf('%s%8193s', '{"qmi_signal":{"rssi_dbm":-71}}', ''));
assert(decoded.qmi_signal === null && decoded.t99_radio === null, '8192 byte envelope cap remains enforced');

print('T99_RPC_TESTS_OK\n');
