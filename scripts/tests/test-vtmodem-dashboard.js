'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../package/vtmodem/files/www/luci-static/resources/view/vtmodem/status.js'), 'utf8');
const helper = new Function('rpc', '_', source.slice(0, source.lastIndexOf('\nreturn view.extend(')) +
 '\nreturn { byteString, subtractBytes, gigabytes, trafficRate, alignmentSample, pushAlignment, alignmentSnapshot, readSnapshots, telemetryMessage };')(
 { declare: () => () => Promise.resolve({}) }, value => value);

assert.equal(helper.gigabytes('1000000000'), '1.000 ГБ');
assert.equal(helper.gigabytes('1048576000'), '1.048 ГБ');
assert.equal(helper.gigabytes('1'), '0.000 ГБ');
assert.equal(helper.gigabytes('0'), '0.000 ГБ');
assert.equal(helper.gigabytes('36893488147419103230'), '36893488147.419 ГБ');
assert.equal(helper.gigabytes('18446744073709551615'), '18446744073.709 ГБ');
for (const invalid of [ null, undefined, -1, 1, '-1', '1e9', '1.5', '18446744073709551616', 'x' ])
 assert.equal(helper.byteString(invalid), null);
assert.equal(helper.subtractBytes('18446744073709551000', '18446744073708551000'), '1000000');
assert.equal(helper.subtractBytes('3', '40'), null);
assert.equal(helper.subtractBytes('100', '100'), '0');
const first = { interface: 'wwan0', live: { rx_bytes: '18446744073700000000', tx_bytes: '9007199254740990', boot_id: 'a', ifindex: 4, monotonic_ms: 10000 } };
const second = { interface: 'wwan0', live: { rx_bytes: '18446744073701000000', tx_bytes: '9007199255740990', boot_id: 'a', ifindex: 4, monotonic_ms: 15000 } };
assert.deepEqual(helper.trafficRate(first, second), { rx_mbps: 1.6, tx_mbps: 1.6 });
for (const change of [ { ifindex: 5 }, { boot_id: 'b' }, { monotonic_ms: 10000 }, { monotonic_ms: 45000 }, { rx_bytes: '0' }, { tx_bytes: '0' } ])
 assert.equal(helper.trafficRate(first, { ...second, live: { ...second.live, ...change } }), null);
assert.equal(helper.trafficRate(first, { ...second, interface: 'wwan1' }), null);

function status(stamp, cellId = 118667785) {
 return { present: true, type: 't99w175', qmi_signal: { rsrp_dbm: -108, rsrq_db: -17, snr_db: 3.6 },
  qmi_radio: { band: 7, earfcn: 3200 }, // stale band deliberately differs from DEBUG
  t99_radio: { cell_id: cellId, cells: [{ role: 'primary', band: 3, earfcn: 1275, pci: 213, rsrp_dbm: -107.5, rsrq_db: -16.3, snr_db: 5.4 }] },
  telemetry: { sources: { qmi_signal: { monotonic_ms: stamp, updated_at: 1789056945, age_seconds: 1 },
   t99_radio: { monotonic_ms: stamp, updated_at: 1789056945, age_seconds: 1 } } } };
}
const samples = [];
assert.equal(helper.pushAlignment(samples, helper.alignmentSample(status(10000))), true);
assert.equal(helper.pushAlignment(samples, helper.alignmentSample(status(10000))), false);
assert.equal(samples[0].rsrp, -107.5);
assert.match(samples[0].label, /B3.*1275.*213/);
assert.equal(helper.alignmentSnapshot(samples, 'один'), null);
helper.pushAlignment(samples, helper.alignmentSample(status(15000)));
assert.equal(helper.alignmentSnapshot(samples, 'антенна').count, 2);
assert.equal(helper.alignmentSnapshot(samples, 'антенна').rsrp, -107.5);
helper.pushAlignment(samples, helper.alignmentSample(status(20000, 999)));
assert.equal(helper.alignmentSnapshot(samples, 'смена соты'), null);
helper.pushAlignment(samples, helper.alignmentSample(status(25000, 999)));
assert.equal(helper.alignmentSnapshot(samples, 'новая сота').count, 2);
helper.pushAlignment(samples, helper.alignmentSample(status(60000, 999)));
assert.equal(helper.alignmentSnapshot(samples, 'пауза'), null);
helper.pushAlignment(samples, helper.alignmentSample(status(1000)));
assert.equal(samples.length, 1);
for (let i = 1; i <= 140; i++) helper.pushAlignment(samples, helper.alignmentSample(status(1000 + i * 5000)));
assert.equal(samples.length, 120);
let stale = status(900000);
stale.telemetry.sources.t99_radio.stale = true;
stale.telemetry.sources.qmi_signal.error = 'timeout';
assert.equal(helper.alignmentSample(stale), null);
stale.telemetry.sources.qmi_signal.error = null;
const fallback = helper.alignmentSample(stale);
assert.equal(fallback.cell, null);
assert.equal(fallback.rsrp, -108);
assert.equal(helper.alignmentSnapshot([fallback, {...fallback, stamp: 905000}], 'unknowncell'), null);
stale.telemetry.sources.qmi_signal.age_seconds = 16;
assert.equal(helper.alignmentSample(stale), null);
assert.equal(helper.alignmentSample(status(1000), 16), null);
const oldDebug = status(1000);
oldDebug.telemetry.sources.t99_radio.age_seconds = 16;
assert.equal(helper.alignmentSample(oldDebug).cell, null);
assert.equal(helper.alignmentSample(oldDebug).rsrp, -108);
assert.equal(helper.alignmentSample({ ...status(1000), present: false }), null);
assert.match(helper.telemetryMessage({ telemetry: { busy: 'sms' } }), /приостановлены/);
assert.match(helper.telemetryMessage({ telemetry: { stale: true } }), /устарела/);
assert.deepEqual(helper.readSnapshots({getItem: () => 'broken'}), []);
assert.deepEqual(helper.readSnapshots({getItem: () => { throw new Error('denied'); }}), []);
assert.deepEqual(helper.readSnapshots({getItem: () => JSON.stringify([{ label:'x', cell:'1', cell_label:'B3', rsrp:null, rsrq:-10, snr:3, at:1, count:2 }])}), []);
console.log('VT_MODEM_DASHBOARD_TESTS_OK: 64-bit deltas, decimalGB, resets, coherent cells, stale/dedup samples, bounded snapshots');
