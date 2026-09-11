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

return view.extend({
	load: function() {
		return callStatus();
	},

	render: function(s) {
		s = s || {};

		var table = E('table', { 'class': 'table' }, [
			row(_('Detected'), s.present ? _('Yes') : _('No')),
			row(_('USB ID'), s.usb_id, true),
			row(_('USB device'), s.usb_device, true),
			row(_('AT port'), s.at_port, true),
			row(_('Data interface'), s.data_interface, true),
			row(_('Data MAC'), s.data_mac, true)
		]);

		if (s.present) {
			table.appendChild(row(_('Manufacturer'), s.manufacturer));
			table.appendChild(row(_('Model'), s.model));
			table.appendChild(row(_('Firmware'), s.firmware, true));
			table.appendChild(row(_('IMEI'), s.imei, true));
			table.appendChild(row(_('CFUN'), s.cfun, true));
			table.appendChild(row(_('SIM state'), s.sim_state));
			table.appendChild(row(_('ICCID'), s.iccid, true));
			table.appendChild(row(_('IMSI'), s.imsi, true));
			table.appendChild(row(_('Packet attached'), s.attached, true));
			table.appendChild(row(_('Data channel'), s.data_channel, true));
			table.appendChild(row(_('PDP contexts'), s.pdp_contexts, true));
			table.appendChild(row(_('DNS profiles'), s.dns, true));
		}

		return E([], [
			E('h2', {}, [ _('VT Modem') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Vendor-independent modem status for VT-STREET-M2. This first revision is read-only and supports Fibocom L860-GL-16.')
			]),
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Modem status') ]),
				table
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
