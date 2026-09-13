'use strict';

function ipv4_address(value) {
	if (type(value) != 'string')
		return false;
	let parts = split(value, '.');
	if (length(parts) != 4)
		return false;
	for (let part in parts)
		if (!match(part, /^(0|[1-9][0-9]{0,2})$/) || +part > 255)
			return false;
	return true;
}

function ipv6_address(value) {
	if (type(value) != 'string' || !match(value, /^[0-9a-fA-F:.]+$/))
		return false;
	// An embedded IPv4 suffix consumes two IPv6 groups. Scoped addresses
	// and host names are deliberately excluded from this display contract.
	if (index(value, '.') >= 0) {
		let parts = split(value, ':');
		if (length(parts) < 2 || !ipv4_address(pop(parts)))
			return false;
		value = join(':', parts) + ':0:0';
	}
	let halves = split(value, '::');
	if (length(halves) > 2)
		return false;
	let groups = 0;
	for (let half in halves) {
		if (!length(half))
			continue;
		for (let group in split(half, ':')) {
			if (!match(group, /^[0-9a-fA-F]{1,4}$/))
				return false;
			groups++;
		}
	}
	return length(halves) == 2 ? groups < 8 : groups == 8;
}

// Consume only the documented netifd state needed by this page. Client IDs,
// packet handles, credentials and unrelated interface properties are omitted.
function parse_session(out) {
	if (type(out) != 'string' || !length(out) || length(out) > 32768)
		return null;
	let source;
	try { source = json(out); }
	catch (e) { return null; }
	if (type(source) != 'object' || type(source.up) != 'bool')
		return null;
	for (let key in [ 'pending', 'available' ])
		if (exists(source, key) && type(source[key]) != 'bool')
			return null;
	if ((exists(source, 'proto') && source.proto != 't99w175qmi') ||
	    (exists(source, 'l3_device') && source.l3_device != 'wwan0'))
		return null;
	if (source.up && (source.proto != 't99w175qmi' || source.l3_device != 'wwan0'))
		return null;
	let result = {
		up: source.up,
		pending: exists(source, 'pending') ? source.pending : null,
		available: exists(source, 'available') ? source.available : null,
		interface: source.l3_device == 'wwan0' ? 'wwan0' : null,
		ipv4: [], dns: []
	};
	// A disconnected session can retain old addresses in diagnostic output.
	// Do not present those as addresses or DNS of an active connection.
	if (!source.up)
		return result;
	if (type(source['ipv4-address']) == 'array') {
		for (let entry in source['ipv4-address']) {
			if (type(entry) != 'object' || !ipv4_address(entry.address) ||
			    (type(entry.mask) != 'int' && type(entry.mask) != 'double') ||
			    entry.mask < 0 || entry.mask > 32 || entry.mask != int(entry.mask))
				continue;
			push(result.ipv4, { address: entry.address, mask: entry.mask });
		}
	}
	if (type(source['dns-server']) == 'array') {
		for (let address in source['dns-server'])
			if (ipv4_address(address) || ipv6_address(address))
				push(result.dns, address);
	}
	return result;
}

function link_text(value) {
	return type(value) == 'string' ? trim(value) : null;
}

// Require agreeing sysfs facts. A Raw IP device has no Ethernet address;
// reading an empty address must never produce an all-zero or fabricated MAC.
function parse_link(raw_ip_text, type_text, addr_len_text, address_text) {
	let raw = link_text(raw_ip_text);
	let arptype = link_text(type_text);
	let len = link_text(addr_len_text);
	let address = link_text(address_text);
	if (raw == 'Y' && arptype == '65534' && len == '0' &&
	    (address === null || address == ''))
		return { raw_ip: true, mac: null };
	if (raw == 'N' && arptype == '1' && len == '6' &&
	    address !== null && match(address, /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/))
		return { raw_ip: false, mac: lc(address) };
	return { raw_ip: null, mac: null };
}

export { parse_session, parse_link };
