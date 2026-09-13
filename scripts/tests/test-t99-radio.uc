'use strict';

import { readfile } from 'fs';
import { parse_temperature, parse_ca, parse_cells } from '../../package/vtmodem/files/usr/share/vtmodem/t99-radio.uc';

let temperature = parse_temperature(readfile('scripts/tests/fixtures/t99-temp.txt'));
assert(temperature.tsens_c === 29 && temperature.pa_c === 30 && temperature.skin_c === 28, 'All three actual temperature sensors');
temperature = parse_temperature('PA: 0C\r\nSkin Sensor: -2.5C\r\nTSENS: NA\r\n');
assert(temperature.pa_c === 0 && temperature.skin_c === -2.5 && temperature.tsens_c === null, 'Temperature zero, fraction, CRLF and NA');
assert(parse_temperature('ERROR').tsens_c === null && parse_temperature(null).pa_c === null, 'Errors and absent output are not zero Celsius');

let carriers = parse_ca(readfile('scripts/tests/fixtures/t99-ca.txt'));
assert(length(carriers) === 2, 'Actual PCC + SCC');
assert(carriers[0].role === 'pcc' && carriers[0].band === 3 && carriers[0].bandwidth_mhz === 15.0, 'Actual primary B3 / 15 MHz');
assert(carriers[1].role === 'scc1' && carriers[1].band === 1 && carriers[1].bandwidth_mhz === 10.0, 'Actual secondary B1 / 10 MHz');
assert(length(parse_ca('ERROR')) === 0 && length(parse_ca(null)) === 0, 'Missing CA has no fabricated carrier or off-state');
carriers = parse_ca('PCC info: Band is LTE_B1, Band_width is 1.4 MHz\nSCC1 info: Band is NR_N78, Band_width is 100 MHz\nNR serving information :\nPCC info: Band is LTE_B3, Band_width is 20 MHz\n');
assert(length(carriers) === 1 && carriers[0].bandwidth_mhz === 1.4, 'LTE CA only, with fractional bandwidth');

let debug = readfile('scripts/tests/fixtures/t99-debug.txt');
let radio = parse_cells(debug);
assert(radio.cell_id === 118667785 && radio.tac === 1446 && radio.tx_power_dbm === 12.0, 'Actual LTE metadata');
assert(length(radio.antenna_rsrp_dbm) === 4 && radio.antenna_rsrp_dbm[0] === -106.6 && radio.antenna_rsrp_dbm[1] === -110.8 && radio.antenna_rsrp_dbm[2] === null && radio.antenna_rsrp_dbm[3] === null, 'Antenna NA is unknown, with original antenna order');
assert(length(radio.cells) === 2, 'Actual two LTE cell records');
let p = radio.cells[0];
let s = radio.cells[1];
assert(p.role === 'primary' && p.band === 3 && p.bandwidth_mhz === 15.0 && p.earfcn === 1275 && p.pci === 213, 'Primary cell identity');
assert(p.rsrp_dbm === -106.7 && p.rsrq_db === -16.5 && p.rssi_dbm === -69.9 && p.snr_db === 2.4, 'Primary float measurements');
assert(s.role === 'secondary' && s.band === 1 && s.bandwidth_mhz === 10.0 && s.earfcn === 550 && s.pci === 224, 'Secondary cell identity');
assert(s.rsrp_dbm === -111.6 && s.rsrq_db === -17.3 && s.rssi_dbm === -75.2 && s.snr_db === 12.4, 'Secondary float measurements remain scoped');

radio = parse_cells(debug + 'scell: lte_band:7 lte_band_width:20.0MHz\nchannel:0 pci:0\nlte_rsrp:NA,rsrq:-10.5dB\nlte_rssi:-90dBm,lte_snr:0.0dB\n');
assert(length(radio.cells) === 3 && radio.cells[1].band === 1 && radio.cells[2].band === 7, 'Repeated scell lines create separate records');
s = radio.cells[2];
assert(s.rsrp_dbm === null && s.rsrq_db === -10.5 && s.snr_db === 0.0 && s.earfcn === 0 && s.pci === 0, 'Unknown secondary RSRP is not inherited; numeric zero survives');

radio = parse_cells(debug + 'RAT:NR5G\nlte_cell_id:999\npcell: nr_band:78 nr_band_width:100MHz\nchannel:640000 pci:99\nlte_rsrp:-80dBm,rsrq:-5dB\n');
assert(length(radio.cells) === 2 && radio.cell_id === 118667785 && radio.cells[1].earfcn === 550 && radio.cells[1].rsrq_db === -17.3, 'RAT boundary prevents NR from overwriting LTE metadata or last cell');
radio = parse_cells(debug + 'scell: nr_band:78 nr_band_width:100MHz\nchannel:640000 pci:99\nlte_rsrp:-80dBm,rsrq:-5dB\n');
assert(length(radio.cells) === 2 && radio.cells[1].earfcn === 550 && radio.cells[1].rsrq_db === -17.3, 'Non-LTE cell header clears current record without a RAT line');
radio = parse_cells(debug + 'NR5G:\nchannel:640000 pci:99\nlte_rsrp:-80dBm,rsrq:-5dB\n');
assert(length(radio.cells) === 2 && radio.cells[1].earfcn === 550, 'NR section label prevents generic field reassignment');
radio = parse_cells('RAT:NR5G\npcell: nr_band:78\nchannel:640000 pci:99\n');
assert(length(radio.cells) === 0 && radio.cell_id === null, 'NR-only output is not LTE');
radio = parse_cells('RAT:LTE\npcell: lte_band:3 lte_band_width:NAMHz\nlte_rsrp:-90dB,rsrq:-5dBm\nlte_snr:NA\n');
assert(radio.cells[0].bandwidth_mhz === null && radio.cells[0].rsrp_dbm === null && radio.cells[0].rsrq_db === null && radio.cells[0].snr_db === null, 'Reject unknown values and wrong units');
radio = parse_cells(null);
assert(length(radio.cells) === 0 && radio.cell_id === null && radio.tac === null && radio.tx_power_dbm === null && radio.antenna_rsrp_dbm === null, 'No fabricated fields for absent output');

print('T99_RADIO_TESTS_OK\n');
