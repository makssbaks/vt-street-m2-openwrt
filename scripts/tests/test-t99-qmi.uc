'use strict';

import { readfile } from 'fs';
import { parse_signal, parse_radio, run_command, t99_qmi_status } from '../../package/vtmodem/files/usr/share/vtmodem/qmi.uc';

let signal = parse_signal(readfile('scripts/tests/fixtures/t99-signal.txt'));
assert(signal.rssi_dbm === -71, 'RSSI');
assert(signal.rsrp_dbm === -107, 'RSRP must survive the later 5G n/a section');
assert(signal.rsrq_db === -16, 'RSRQ');
assert(signal.snr_db === 3.0, 'SNR');

let radio = parse_radio(readfile('scripts/tests/fixtures/t99-radio.txt'));
assert(radio.band === 3 && radio.earfcn === 1275 && radio.bandwidth_mhz === 15, 'B3 / EARFCN 1275 / 15 MHz');

signal = parse_signal("LTE:\n RSSI: 'n/a'\n RSRP: 'n/a'\n RSRQ: '-12.5 dB'\n SNR: '0.0 dB'\n5G:\n RSRP: '-90 dBm'\n SNR: '20.0 dB'\n");
assert(signal.rssi_dbm === null && signal.rsrp_dbm === null, 'Missing LTE values stay unknown');
assert(signal.rsrq_db === -12.5 && signal.snr_db === 0.0, 'Preserve fractions and zero');
assert(parse_signal('error: device unavailable').rsrp_dbm === null, 'Errors are not measurements');
assert(parse_signal("5G:\n RSRP: '-90 dBm'\n").rsrp_dbm === null, 'Do not label NR values as LTE');
assert(parse_signal("LTE:\n RSRP: '-100 dB'\n").rsrp_dbm === null, 'Reject incorrect units');
assert(parse_radio('').band === null, 'Empty radio output');
assert(parse_radio("Band Information:\n Radio Interface: 'umts'\n Active Band Class: 'eutran-3'\n Active Channel: '100'\n").band === null, 'Ignore other radio interfaces');
radio = parse_radio("Band Information:\n Radio Interface: 'lte'\n Active Band Class: 'eutran-1'\n Active Channel: '0'\nBandwidth:\n Radio Interface: 'lte'\n Bandwidth: '1.4'\n");
assert(radio.band === 1 && radio.earfcn === 0 && radio.bandwidth_mhz === 1.4, 'EARFCN zero and fractional bandwidth');

let capture = run_command(['/bin/sh', '-c', 'printf %s "$1"', 'capture', "literal ' $() ; text"], 1000);
assert(capture.ok && capture.output == "literal ' $() ; text", 'Bounded capture and shell quoting');
capture = run_command(['/bin/sh', '-c', 'echo partial; exit 2'], 1000);
assert(!capture.ok && capture.exit_code == 2 && capture.output == '', 'Discard failed command output');
capture = run_command(['/bin/sh', '-c', 'exec sleep 2'], 100);
assert(!capture.ok && capture.exit_code == -9 && capture.output == '', 'Kill and reap a timed-out query');
assert(t99_qmi_status('').qmi_signal === null, 'No control device: no query');

print('T99_QMI_TESTS_OK\n');
