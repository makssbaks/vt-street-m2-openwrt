'use strict';

// These parsers consume complete, successful vt-at replies. Missing values
// remain unknown; in particular an empty CA reply never means CA is disabled.
function parse_temperature(out) {
	let result = { tsens_c: null, pa_c: null, skin_c: null };
	for (let line in split(out ?? '', '\n')) {
		let m = match(trim(line), /^(PA|Skin Sensor|TSENS):[ \t]*(-?[0-9]+(\.[0-9]+)?)[ \t]*C$/);
		if (!m)
			continue;
		let key = m[1] == 'PA' ? 'pa_c' : (m[1] == 'TSENS' ? 'tsens_c' : 'skin_c');
		result[key] = +m[2];
	}
	return result;
}

function parse_ca(out) {
	let carriers = [];
	let lte = true;
	for (let line in split(out ?? '', '\n')) {
		line = trim(line);
		if (match(line, /serving information[ \t]*:$/)) {
			lte = match(line, /^LTE[ \t]+serving information[ \t]*:$/) != null;
			continue;
		}
		let m = match(line, /^(PCC|SCC[0-9]+) info:[ \t]*Band is LTE_B([0-9]+),[ \t]*Band_width is ([0-9]+(\.[0-9]+)?)[ \t]*MHz$/);
		if (lte && m)
			push(carriers, { role: lc(m[1]), band: +m[2], bandwidth_mhz: +m[3] });
	}
	return carriers;
}

function parse_cells(out) {
	let result = {
		cells: [], cell_id: null, tac: null, tx_power_dbm: null,
		antenna_rsrp_dbm: null
	};
	let lte = false;
	let cell = null;
	for (let line in split(out ?? '', '\n')) {
		line = trim(line);
		let m = match(line, /^RAT:[ \t]*(.*)$/);
		if (m) {
			lte = trim(m[1]) == 'LTE';
			cell = null;
			continue;
		}
		// Do not let a following NR or other technology section overwrite
		// the last LTE cell, even if that section uses generic field names.
		if (match(line, /^(NR|NR5G|5G|WCDMA|GSM)(:|[ \t])/)) {
			lte = false;
			cell = null;
			continue;
		}
		m = match(line, /^(pcell|scell[0-9]*):/);
		if (m) {
			cell = null;
			let b = match(line, /(^|[ \t])lte_band:([0-9]+)([ \t]|$)/);
			if (!lte || !b)
				continue;
			cell = {
				role: m[1] == 'pcell' ? 'primary' : 'secondary',
				band: +b[2], bandwidth_mhz: null, earfcn: null, pci: null,
				rsrp_dbm: null, rsrq_db: null, rssi_dbm: null, snr_db: null
			};
			let width = match(line, /(^|[ \t])lte_band_width:([0-9]+(\.[0-9]+)?)MHz([ \t]|$)/);
			if (width)
				cell.bandwidth_mhz = +width[2];
			push(result.cells, cell);
			continue;
		}
		if (!lte)
			continue;
		m = match(line, /^lte_cell_id:([0-9]+)$/);
		if (m)
			result.cell_id = +m[1];
		m = match(line, /^lte_tac:([0-9]+)$/);
		if (m)
			result.tac = +m[1];
		m = match(line, /^lte_tx_pwr:(-?[0-9]+(\.[0-9]+)?)dBm$/);
		if (m)
			result.tx_power_dbm = +m[1];
		m = match(line, /^lte_ant_rsrp:rx_diversity:[0-9]+[ \t]*\(([^)]*)\)$/);
		if (m) {
			let antennas = [];
			for (let value in split(m[1], ',')) {
				let a = match(trim(value), /^(-?[0-9]+(\.[0-9]+)?)dBm$/);
				push(antennas, a ? +a[1] : null);
			}
			result.antenna_rsrp_dbm = antennas;
		}
		if (!cell)
			continue;
		m = match(line, /(^|[ \t,])channel:([0-9]+)([ \t,]|$)/);
		if (m)
			cell.earfcn = +m[2];
		m = match(line, /(^|[ \t,])pci:([0-9]+)([ \t,]|$)/);
		if (m)
			cell.pci = +m[2];
		m = match(line, /(^|[ \t,])lte_rsrp:(-?[0-9]+(\.[0-9]+)?)dBm([ \t,]|$)/);
		if (m)
			cell.rsrp_dbm = +m[2];
		m = match(line, /(^|[ \t,])rsrq:(-?[0-9]+(\.[0-9]+)?)dB([ \t,]|$)/);
		if (m)
			cell.rsrq_db = +m[2];
		m = match(line, /(^|[ \t,])lte_rssi:(-?[0-9]+(\.[0-9]+)?)dBm([ \t,]|$)/);
		if (m)
			cell.rssi_dbm = +m[2];
		m = match(line, /(^|[ \t,])lte_snr:(-?[0-9]+(\.[0-9]+)?)dB([ \t,]|$)/);
		if (m)
			cell.snr_db = +m[2];
	}
	return result;
}

function parse_iccid(out) {
	for (let line in split(out ?? '', '\n')) {
		let m = match(trim(line), /^ICCID:[ \t]*([0-9]{19}[Ff]?|[0-9]{20})$/);
		if (!m)
			continue;
		// EFICCID uses BCD with F padding (ETSI TS 102 221 section 13.2).
		// This modem prints the padding nibble after a 19-digit identifier.
		return replace(m[1], /[Ff]$/, '');
	}
	return null;
}

// The caller supplies the bounded runner from the isolated status process.
// Only verified read queries and the two supported AT device paths are used.
function t99_at_status(device, run) {
	let result = { t99_temperature: null, t99_ca: null, t99_radio: null, t99_iccid: null };
	if (device != '/dev/t99w175-at' && device != '/dev/ttyUSB2')
		return result;
	let queries = [
		[ 't99_temperature', 'AT^TEMP?', parse_temperature ],
		[ 't99_ca', 'AT^CA_INFO?', parse_ca ],
		[ 't99_radio', 'AT^DEBUG?', parse_cells ],
		[ 't99_iccid', 'AT+ICCID', parse_iccid ]
	];
	for (let query in queries) {
		try {
			let reply = run([ '/usr/bin/vt-at', '-t', '3000', device, query[1] ], 3500);
			if (reply.ok)
				result[query[0]] = query[2](reply.output);
		}
		catch (e) {
			// Failure of one optional query must not discard other readings.
		}
	}
	return result;
}

// Separate exports are required by the OpenWrt build 49 ucode compiler.
export { parse_temperature, parse_ca, parse_cells, parse_iccid, t99_at_status };
