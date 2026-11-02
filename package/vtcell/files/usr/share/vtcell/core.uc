'use strict';

// MM 1.22 / 1.24 JSON output. Cell identifiers in mmcli cell-info are HEX,
// including strings containing only digits. Never apply LTE eNB math to NR.
function number(value, low, high) {
	if (type(value) == 'string') {
		if (!match(value, /^-?[0-9]+(\.[0-9]+)?$/)) return null;
		value = +value;
	}
	return (type(value) == 'int' || type(value) == 'double') && value >= low && value <= high ? value : null;
}
function hex(value, high) {
	if (type(value) != 'string' || !match(value, /^[0-9a-fA-F]{1,9}$/)) return null;
	let n = int(value, 16);
	return n >= 0 && n <= high ? n : null;
}
function lte_band(earfcn) {
	// Common bands used by the intended RU networks. Unknown stays unknown.
	for (let b in [[1,0,599],[2,600,1199],[3,1200,1949],[4,1950,2399],
		[5,2400,2649],[7,2750,3449],[8,3450,3799],[20,6150,6449],
		[28,9210,9659],[38,37750,38249],[40,38650,39649],[41,39650,41589]])
		if (earfcn != null && earfcn >= b[1] && earfcn <= b[2]) return b[0];
	return null;
}
function parse_cell(line) {
	if (type(line) != 'string' || length(line) > 4096) return null;
	let f = {};
	for (let pair in split(line, ', ')) {
		let m = match(pair, /^([^:]+):[ \t]*(.*)$/);
		if (m) f[m[1]] = m[2];
	}
	if (index(['lte', '5gnr'], f['cell type']) < 0 || index(['yes', 'no'], f.serving) < 0) return null;
	let lte = f['cell type'] == 'lte';
	let cell = {
		rat: lte ? 'LTE' : 'NR', serving: f.serving == 'yes',
		plmn: match(f['operator id'] ?? '', /^[0-9]{5,6}$/) ? f['operator id'] : null,
		pci: hex(f['physical ci'], lte ? 503 : 1007),
		ci: hex(f.ci, lte ? 268435455 : 68719476735),
		tac: hex(f.tac, 16777215),
		channel: number(lte ? f.earfcn : f.nrarfcn, 0, lte ? 262143 : 3279165),
		rsrp: number(f.rsrp, -160, -20), rsrq: number(f.rsrq, -50, 20),
		ta: number(f['timing advance'], 0, 2147483647),
		band: null, enb: null, sector: null,
		role: f['serving cell type'] ?? null
	};
	if (lte) {
		cell.band = lte_band(cell.channel);
		if (cell.ci != null) { cell.enb = int(cell.ci / 256); cell.sector = cell.ci % 256; }
	}
	return cell;
}
function cells(data) {
	let raw = data?.modem?.generic?.['cell-info'];
	if (type(raw) != 'array' || length(raw) > 128) return null;
	let result = [];
	for (let entry in raw) {
		let cell = parse_cell(entry);
		if (cell) push(result, cell);
	}
	return result;
}
function signals(data) {
	let raw = data?.modem?.signal, result = {};
	for (let rat in ['lte', '5g']) {
		let s = raw?.[rat];
		result[rat] = { rssi: number(s?.rssi, -160, -10), rsrp: number(s?.rsrp, -160, -20),
			rsrq: number(s?.rsrq, -50, 20), snr: number(s?.snr, -40, 60) };
	}
	result.refresh_seconds = number(raw?.refresh?.rate, 0, 3600);
	return result;
}
function general(data) {
	let g = data?.modem?.generic, n = data?.modem?.['3gpp'];
	if (type(g) != 'object') return null;
	function text(v) { return type(v) == 'string' && v != '--' ? substr(v, 0, 256) : null; }
	return { manufacturer: text(g.manufacturer), model: text(g.model), firmware: text(g.revision),
		state: text(g.state), operator: text(n?.['operator-name']), plmn: text(n?.['operator-code']),
		registration: text(n?.['registration-state']), modes: text(g['current-modes']),
		technologies: type(g['access-technologies']) == 'array' ? g['access-technologies'] : [],
		ports: type(g.ports) == 'array' ? g.ports : [],
		// Kept only in private collector memory for hot-unplug/SIM-change checks.
		identity: [g.device, g['device-identifier'], g.sim, n?.imei],
		bands: type(g['current-bands']) == 'array' ? g['current-bands'] : [] };
}
function same_identity(a, b) {
	return a != null && b != null && sprintf('%J', a.identity) == sprintf('%J', b.identity);
}
function modem_path(data) {
	let a = data?.['modem-list'];
	return type(a) == 'array' && length(a) == 1 && type(a[0]) == 'string' &&
		match(a[0], /^\/org\/freedesktop\/ModemManager1\/Modem\/[0-9]+$/) ? a[0] : null;
}
function external(tele, detail, age, detail_age, serving, present) {
	// Public telemetry and local cell companion are atomically written separately.
	// Require coherent identity + nearby mtimes before associating AT data with
	// an MM cell. No direct AT polling, guessing CA from enabled bands, or zeros.
	if (!present || type(tele) != 'object' || type(detail) != 'object' ||
		age == null || detail_age == null || age < 0 || detail_age < 0 ||
		age > 45 || detail_age > 45 || age-detail_age > 2 || detail_age-age > 2 || !serving ||
		serving.rat != 'LTE' || serving.ci == null || serving.pci == null || serving.channel == null ||
		number(detail.cid,0,268435455) != serving.ci || number(detail.pci,0,503) != serving.pci ||
		number(detail.earfcn,0,262143) != serving.channel) return null;
	let ca = type(tele.ca) == 'string' && match(tele.ca, /^[Bn][0-9]{1,3}(\+[Bn][0-9]{1,3}){1,15}$/) ? tele.ca : null;
	return { age_seconds: max(age, detail_age), ca, snr: number(tele.sinr,-40,60),
		temperature: number(tele.temp,-40,130), source: '5G Modem / AT' };
}
function expose(cache, now, boot) {
	if (type(cache) != 'object' || cache.boot != boot || type(cache.monotonic_ms) != 'int')
		return { available: false, stale: true, error: 'Ожидание данных ModemManager' };
	let age = (now - cache.monotonic_ms) / 1000;
	if (age < 0 || age > 35)
		return { available: false, stale: true, age_seconds: max(0,age), error: 'Данные устарели' };
	cache.age_seconds = age;
	cache.stale = false;
	if (cache.extra) {
		cache.extra.age_seconds += age;
		if (cache.extra.age_seconds > 45) cache.extra = null;
	}
	return cache;
}
export { number, hex, lte_band, parse_cell, cells, signals, general, same_identity, modem_path, external, expose };
