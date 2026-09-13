'use strict';
'require view';
'require rpc';
'require ui';

var callStatus = rpc.declare({
	object: 'vtmodem',
	method: 'status',
	expect: {}
});

function text(v) {
	if (v === null || v === undefined || v === '')
		return '-';
	if (Array.isArray(v))
		return v.length ? v.join('\n') : '-';
	return String(v);
}

function csv(v) {
	if (v === null || v === undefined || v === '')
		return [];
	return String(v).split(',').map(function(x) { return x.trim(); });
}

function unquote(v) {
	v = text(v);
	if (v.length >= 2 && v.charAt(0) === '"' && v.charAt(v.length - 1) === '"')
		return v.substring(1, v.length - 1);
	return v;
}

function operatorName(v) {
	var p = csv(v);
	if (!p.length)
		return '-';
	if (p[0] === '2')
		return _('Deregistered');
	if (p.length >= 3 && p[2])
		return unquote(p[2]);
	return p[0] === '0' ? _('Automatic') : text(v);
}

function registrationName(v) {
	var p = csv(v), stat = p.length > 1 ? p[1] : '';
	var map = {
		'0': _('Not registered'),
		'1': _('Registered (home)'),
		'2': _('Searching'),
		'3': _('Registration denied'),
		'4': _('Unknown'),
		'5': _('Registered (roaming)'),
		'6': _('SMS only (home)'),
		'7': _('SMS only (roaming)'),
		'8': _('Emergency only'),
		'9': _('CSFB not preferred (home)'),
		'10': _('CSFB not preferred (roaming)')
	};
	return map[stat] || '-';
}

function rssi(v) {
	var p = csv(v), n = p.length ? parseInt(p[0], 10) : NaN;
	if (isNaN(n) || n === 99 || n < 0 || n > 31)
		return '-';
	return String(-113 + (2 * n)) + ' dBm';
}

function rsrq(v) {
	var p = csv(v), n = p.length > 4 ? parseInt(p[4], 10) : NaN;
	if (isNaN(n) || n === 255 || n < 0 || n > 34)
		return '-';
	return String(-19.5 + (0.5 * n)) + ' dB';
}

function rsrp(v) {
	var p = csv(v), n = p.length > 5 ? parseInt(p[5], 10) : NaN;
	if (isNaN(n) || n === 255 || n < 0 || n > 97)
		return '-';
	return String(-140 + n) + ' dBm';
}

function measurement(v, unit, fallback) {
	if (typeof v === 'number' && isFinite(v))
		return String(v) + (unit ? ' ' + unit : '');
	return fallback === undefined ? '-' : fallback;
}

function temperature(v) {
	var n = parseInt(v, 10);
	return isNaN(n) ? '-' : String(n) + ' °C';
}

function dataState(s) {
	if (String(s.attached || '') === '1') {
		if (String(s.data_channel || '').indexOf('1,') === 0)
			return _('Data channel ready');
		return _('Packet attached');
	}
	return _('Disconnected');
}

function row(label, value, mono) {
	var rendered;

	if (Array.isArray(value)) {
		rendered = value.length ? value.map(function(v) {
			return E('div', { 'class': mono ? 'text-monospace' : '' }, [ text(v) ]);
		}) : [ '-' ];
	}
	else {
		rendered = [ E('span', { 'class': mono ? 'text-monospace' : '' }, [ text(value) ]) ];
	}

	return E('tr', {}, [
		E('td', { 'style': 'width:32%; font-weight:600' }, [ label ]),
		E('td', {}, rendered)
	]);
}

function card(label, value, note) {
	return E('div', {
		'style': 'border:1px solid rgba(127,127,127,.35); border-radius:8px; padding:14px; min-height:78px'
	}, [
		E('div', { 'style': 'font-size:.86rem; opacity:.7; margin-bottom:6px' }, [ label ]),
		E('div', { 'style': 'font-size:1.22rem; font-weight:600; line-height:1.25' }, [ text(value) ]),
		note ? E('div', { 'style': 'font-size:.82rem; opacity:.65; margin-top:5px' }, [ text(note) ]) : ''
	]);
}

function grid(children) {
	return E('div', {
		'style': 'display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px; margin:12px 0 20px'
	}, children);
}

return view.extend({
	load: function() {
		return callStatus();
	},

	render: function(s) {
		s = s || {};

		if (!s.present) {
			return E([], [
				E('h2', {}, [ _('VT Modem') ]),
				E('div', { 'class': 'cbi-section' }, [
					E('h3', {}, [ _('Modem not detected') ]),
					E('p', {}, [ _('No supported modem is currently available.') ])
				])
			]);
		}

		var summary = grid([
			card(_('SIM'), s.sim_state || '-', s.iccid ? _('ICCID detected') : ''),
			card(_('Operator'), operatorName(s.operator)),
			card(_('Network'), registrationName(s.registration)),
			card(_('Data'), dataState(s), s.data_interface || '-')
		]);

		var isT99 = s.type === 't99w175';
		var qmiSignal = isT99 && s.qmi_signal || {};
		var qmiRadio = isT99 && s.qmi_radio || {};
		var signalCards = [
			card(_('RSSI'), measurement(qmiSignal.rssi_dbm, 'dBm', rssi(s.csq))),
			card(_('RSRP'), measurement(qmiSignal.rsrp_dbm, 'dBm', rsrp(s.cesq))),
			card(_('RSRQ'), measurement(qmiSignal.rsrq_db, 'dB', rsrq(s.cesq)))
		];
		if (isT99)
			signalCards.push(card(_('SNR'), measurement(qmiSignal.snr_db, 'dB')));
		signalCards.push(card(_('Temperature'), temperature(s.temperature)));
		var signal = grid(signalCards);

		var radioRows = [
			row(_('LTE registration'), registrationName(s.registration)),
			row(_('Raw CEREG'), s.registration, true)
		];
		if (isT99) {
			var band = measurement(qmiRadio.band);
			radioRows.push(
				row(_('LTE band'), band === '-' ? '-' : 'B' + band),
				row(_('EARFCN'), measurement(qmiRadio.earfcn)),
				row(_('Channel bandwidth'), measurement(qmiRadio.bandwidth_mhz, 'MHz'))
			);
		}
		radioRows.push(
			row(_('Extended signal'), s.xcesq, true),
			row(_('Cell measurement'), s.cell_measurement, true),
			row(_('LTE CA state'), s.ca_state, true),
			row(_('Packet attached'), s.attached, true),
			row(_('Data channel'), s.data_channel, true)
		);
		var radio = E('table', { 'class': 'table' }, radioRows);

		var modem = E('table', { 'class': 'table' }, [
			row(_('Manufacturer'), s.manufacturer),
			row(_('Model'), s.model),
			row(_('Firmware'), s.firmware, true),
			row(_('IMEI'), s.imei, true),
			row(_('CFUN'), s.cfun, true),
			row(_('ICCID'), s.iccid, true),
			row(_('IMSI'), s.imsi, true),
			row(_('USB ID'), s.usb_id, true),
			row(_('USB device'), s.usb_device, true),
			row(_('AT port'), s.at_port, true),
			row(_('Data interface'), s.data_interface, true),
			row(_('Data MAC'), s.data_mac, true),
			row(_('PDP contexts'), s.pdp_contexts, true),
			row(_('DNS profiles'), s.dns, true)
		]);

		return E([], [
			E('h2', {}, [ _('VT Modem') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Modem, SIM, radio and data-session status for VT-STREET-M2.')
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Overview') ]),
				summary
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Signal') ]),
				signal
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Radio / cell') ]),
				radio
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Modem details') ]),
				modem
			]),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button-action',
					'click': ui.createHandlerFn(this, function() { window.location.reload(); })
				}, [ _('Refresh') ])
			])
		]);
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
