'use strict';

import { access, basename, dirname, glob, readfile, open, writefile, rename, chmod } from 'fs';

const CACHE_DIR = '/var/run/vtmodem';
function monotonic_ms() {
	let now = clock(true);
	return now[0] * 1000 + int(now[1] / 1000000);
}
function read_json(path, limit) {
	let fd = open(path, 'r');
	if (!fd) return null;
	let out = fd.read((limit ?? 131072) + 1) ?? '';
	fd.close();
	if (length(out) > (limit ?? 131072)) return null;
	try { return json(out); } catch (e) { return null; }
}
function write_json(path, value) {
	let out = sprintf('%J\n', value);
	let temp = path + '.new';
	return writefile(temp, out) === length(out) && chmod(temp, 0600) && rename(temp, path);
}
function telemetry_number(value) {
	return (type(value) == 'int' || type(value) == 'double') &&
		value >= -1.7976931348623157e308 && value <= 1.7976931348623157e308;
}

function qmi_fields(value, names) {
	if (value == null)
		return null;
	if (type(value) != 'object')
		return false;

	let result = {};
	for (let name in names) {
		let v = value[name];
		if (v != null && !telemetry_number(v))
			return false;
		result[name] = v ?? null;
	}
	return result;
}

function t99_carriers(value) {
	if (value == null)
		return null;
	if (type(value) != 'array' || length(value) > 32)
		return false;
	let carriers = [];
	for (let entry in value) {
		if (type(entry) != 'object' || type(entry.role) != 'string' ||
			!match(entry.role, /^(pcc|scc[1-9][0-9]*)$/))
			return false;
		let carrier = qmi_fields(entry, [ 'band', 'bandwidth_mhz' ]);
		if (carrier === false)
			return false;
		carrier.role = entry.role;
		push(carriers, carrier);
	}
	return carriers;
}

function t99_cells(value) {
	if (value == null)
		return null;
	let radio = qmi_fields(value, [ 'cell_id', 'tac', 'tx_power_dbm' ]);
	if (radio === false || type(value.cells) != 'array' || length(value.cells) > 32)
		return false;
	radio.cells = [];
	for (let entry in value.cells) {
		if (type(entry) != 'object' || (entry.role != 'primary' && entry.role != 'secondary'))
			return false;
		let cell = qmi_fields(entry, [ 'band', 'bandwidth_mhz', 'earfcn', 'pci',
			'rsrp_dbm', 'rsrq_db', 'rssi_dbm', 'snr_db' ]);
		if (cell === false)
			return false;
		cell.role = entry.role;
		push(radio.cells, cell);
	}
	radio.antenna_rsrp_dbm = null;
	if (value.antenna_rsrp_dbm != null) {
		if (type(value.antenna_rsrp_dbm) != 'array' || length(value.antenna_rsrp_dbm) > 16)
			return false;
		radio.antenna_rsrp_dbm = [];
		for (let antenna in value.antenna_rsrp_dbm) {
			if (antenna != null && !telemetry_number(antenna))
				return false;
			push(radio.antenna_rsrp_dbm, antenna);
		}
	}
	return radio;
}

function t99_sim_id(value) {
	if (value == null)
		return null;
	return type(value) == 'string' && match(value, /^[0-9]{19,20}$/) ? value : false;
}

function t99_session_info(value) {
	if (value == null)
		return null;
	if (type(value) != 'object' || type(value.up) != 'bool' ||
		(value.pending != null && type(value.pending) != 'bool') ||
		(value.available != null && type(value.available) != 'bool') ||
		(value.interface != null && value.interface != 'wwan0') ||
		(value.up && value.interface != 'wwan0') ||
		type(value.ipv4) != 'array' || length(value.ipv4) > 32 ||
		type(value.dns) != 'array' || length(value.dns) > 16)
		return false;
	let session = {
		up: value.up, pending: value.pending ?? null,
		available: value.available ?? null, interface: value.interface ?? null,
		ipv4: [], dns: []
	};
	// The isolated session parser checks complete IP address semantics.
	// This boundary checks type, shape and bounds without importing it into rpcd.
	for (let entry in value.ipv4) {
		if (type(entry) != 'object' || type(entry.address) != 'string' ||
			length(entry.address) > 15 || !match(entry.address, /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) ||
			!telemetry_number(entry.mask) || entry.mask < 0 || entry.mask > 32 || int(entry.mask) != entry.mask)
			return false;
		push(session.ipv4, { address: entry.address, mask: int(entry.mask) });
	}
	for (let address in value.dns) {
		if (type(address) != 'string' || !length(address) || length(address) > 45 ||
			!match(address, /^[0-9a-fA-F:.]+$/) || (index(address, '.') < 0 && index(address, ':') < 0))
			return false;
		push(session.dns, address);
	}
	if (!session.up) {
		session.ipv4 = [];
		session.dns = [];
	}
	return session;
}

function t99_link_info(value) {
	if (value == null)
		return null;
	if (type(value) != 'object' || (value.raw_ip != null && type(value.raw_ip) != 'bool') ||
		(value.mac != null && (type(value.mac) != 'string' ||
			!match(value.mac, /^[0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5}$/))))
		return false;
	return { raw_ip: value.raw_ip ?? null, mac: value.raw_ip === true ? null : (value.mac ?? null) };
}

function decode_t99_status(out) {
	let result = {
		qmi_signal: null, qmi_radio: null, t99_temperature: null,
		t99_ca: null, t99_radio: null, t99_iccid: null,
		t99_session: null, t99_link: null
	};
	if (type(out) != 'string' || !length(out) || length(out) > 8192)
		return result;

	try {
		let parsed = json(out);
		if (type(parsed) != 'object')
			return result;
		let signal = qmi_fields(parsed.qmi_signal, [ 'rssi_dbm', 'rsrp_dbm', 'rsrq_db', 'snr_db' ]);
		let radio = qmi_fields(parsed.qmi_radio, [ 'band', 'earfcn', 'bandwidth_mhz' ]);
		let temperature = qmi_fields(parsed.t99_temperature, [ 'tsens_c', 'pa_c', 'skin_c' ]);
		let carriers = t99_carriers(parsed.t99_ca);
		let cells = t99_cells(parsed.t99_radio);
		let iccid = t99_sim_id(parsed.t99_iccid);
		let session = t99_session_info(parsed.t99_session);
		let link = t99_link_info(parsed.t99_link);
		// Each optional source is independent: malformed CA must not hide
		// valid signal measurements or temperatures returned in this reply.
		result.qmi_signal = signal === false ? null : signal;
		result.qmi_radio = radio === false ? null : radio;
		result.t99_temperature = temperature === false ? null : temperature;
		result.t99_ca = carriers === false ? null : carriers;
		result.t99_radio = cells === false ? null : cells;
		result.t99_iccid = iccid === false ? null : iccid;
		result.t99_session = session === false ? null : session;
		result.t99_link = link === false ? null : link;
	}
	catch (e) {
		return result;
	}
	return result;
}

function find_usb(vid_expected, pid_expected) {
	for (let p in glob('/sys/bus/usb/devices/*/idVendor')) {
		let d = dirname(p);
		let vid = lc(trim(readfile(p) ?? ''));
		let pid = lc(trim(readfile(`${d}/idProduct`) ?? ''));

		if (vid == vid_expected && pid == pid_expected)
			return basename(d);
	}
	return '';
}

function find_l860_data_if() {
	for (let p in glob('/sys/class/net/*/address')) {
		if (lc(trim(readfile(p) ?? '')) == '00:00:11:12:13:14')
			return basename(dirname(p));
	}
	return access('/sys/class/net/wwan0') ? 'wwan0' : '';
}

function detect_modem() {
	let usb = find_usb('8087', '095a');
	if (length(usb) && access('/dev/ttyACM0')) {
		return {
			type: 'fibocom-l860',
			usb_id: '8087:095a',
			usb_device: usb,
			generation: usb + ':' + trim(readfile('/sys/bus/usb/devices/' + usb + '/devnum') ?? ''),
			at_port: '/dev/ttyACM0',
			control_device: '',
			data_interface: find_l860_data_if()
		};
	}

	usb = find_usb('05c6', '9025');
	let t99_at = access('/dev/t99w175-at') ? '/dev/t99w175-at' : (access('/dev/ttyUSB2') ? '/dev/ttyUSB2' : '');
	if (length(usb) && length(t99_at)) {
		return {
			type: 't99w175',
			usb_id: '05c6:9025',
			usb_device: usb,
			generation: usb + ':' + trim(readfile('/sys/bus/usb/devices/' + usb + '/devnum') ?? ''),
			at_port: t99_at,
			control_device: access('/dev/cdc-wdm0') ? '/dev/cdc-wdm0' : '',
			data_interface: access('/sys/class/net/wwan0') ? 'wwan0' : ''
		};
	}

	return null;
}


function empty_status(m) {
	return { present: m != null, type: m?.type ?? '', usb_id: m?.usb_id ?? '',
		usb_device: m?.usb_device ?? '', at_port: m?.at_port ?? '',
		control_device: m?.control_device ?? '', data_interface: m?.data_interface ?? '',
		data_mac: '', sms_supported: m?.type == 't99w175', manufacturer: '', model: '',
		firmware: '', imei: '', cfun: '', sim_state: '', iccid: '', imsi: '', operator: '',
		registration: '', registration_cs: '', attached: '', csq: '', cesq: '',
		pdp_contexts: [], xcesq: '', cell_measurement: '', ca_state: '', temperature: '',
		data_channel: '', dns: [], qmi_signal: null, qmi_radio: null,
		t99_temperature: null, t99_ca: null, t99_radio: null, t99_session: null, t99_link: null };
}
function cached_status_at(cache, m, now) {
	let valid = type(cache) == 'object' && cache.generation == (m?.generation ?? '') &&
		type(cache.status) == 'object' && type(cache.sources) == 'object' &&
		type(cache.monotonic_ms) == 'int' && now >= cache.monotonic_ms;
	let s = valid ? cache.status : empty_status(m);
	let sources = {};
	let has_sample = false;
	if (valid) for (let key, src in cache.sources) {
		let timestamp_valid = type(src?.monotonic_ms) == 'int' && src.monotonic_ms >= 0 && src.monotonic_ms <= now;
		let max_age_valid = (type(src?.max_age) == 'int' || type(src?.max_age) == 'double') && src.max_age > 0;
		let age = timestamp_valid ? (now - src.monotonic_ms) / 1000 : null;
		if (timestamp_valid) has_sample = true;
		sources[key] = { monotonic_ms: timestamp_valid ? src.monotonic_ms : null, updated_at: timestamp_valid ? src.updated_at : null,
			age_seconds: age, stale: age == null || !max_age_valid || age > src.max_age || src.error != null,
			error: !timestamp_valid || !max_age_valid ? (src?.error ?? 'missing_sample') : (src.error ?? null) };
	}
	// A stale data-session cache must never claim an active connection.
	if (!sources.t99_session || sources.t99_session.stale) s.t99_session = null;
	let age = valid ? max(0, (now - cache.monotonic_ms) / 1000) : null;
	s.telemetry = { sample_id: valid ? cache.monotonic_ms : null,
		monotonic_ms: valid ? cache.monotonic_ms : null, updated_at: valid ? cache.updated_at : null,
		age_seconds: age, stale: !valid || !has_sample || age > 15 || cache.busy != null,
		error: !m ? 'modem_absent' : (!valid || !has_sample ? 'starting' : (age > 15 ? 'collector_stale' : null)),
		busy: valid ? cache.busy : null, sources };
	return s;
}
function cached_status() {
	let status = cached_status_at(read_json(CACHE_DIR + '/status.json'), detect_modem(), monotonic_ms());
	status.build = read_json('/etc/vt-build.json', 8192);
	return status;
}
export { CACHE_DIR, monotonic_ms, read_json, write_json, detect_modem, empty_status,
	decode_t99_status, cached_status_at, cached_status };
