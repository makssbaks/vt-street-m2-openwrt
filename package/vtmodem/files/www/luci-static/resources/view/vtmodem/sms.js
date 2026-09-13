'use strict';
'require view';
'require rpc';
'require ui';

var callSmsList = rpc.declare({
	object: 'vtmodem',
	method: 'sms_list',
	expect: {}
});

var callSmsSend = rpc.declare({
	object: 'vtmodem',
	method: 'sms_send',
	params: [ 'phone', 'text' ],
	expect: {}
});

var callSmsDelete = rpc.declare({
	object: 'vtmodem',
	method: 'sms_delete',
	params: [ 'id' ],
	expect: {}
});

function text(v) {
	return (v === null || v === undefined || v === '') ? '-' : String(v);
}

function mergeMessages(messages) {
	var groups = Object.create(null), out = [];
	var windowMs = 10 * 60 * 1000;

	function integer(v, min, max) {
		return v !== null && v !== undefined && v !== '' &&
			Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max;
	}

	function separate(m, complete, reason) {
		out.push({
			sender: m.sender || '', time: m.time || '', text: m.text || '',
			ids: [ Number(m.id) ], complete: complete, parts_count: 1,
			total: Number(m.concat_total || 0), merge_warning: reason || ''
		});
	}

	(Array.isArray(messages) ? messages : []).forEach(function(m) {
		if (!m || typeof(m) !== 'object')
			return;
		var total = Number(m.concat_total || 0);
		var seq = Number(m.concat_seq || 0);
		if (total === 0 && seq === 0 || total === 1 && seq === 1) {
			separate(m, true);
			return;
		}
		if (!integer(m.concat_total, 2, 255) || !integer(m.concat_seq, 1, total) ||
			!integer(m.concat_ref, 0, 65535) ||
			(m.dcs != null && !integer(m.dcs, 0, 255))) {
			separate(m, false, _('Invalid multipart metadata; part shown separately.'));
			return;
		}
		var timestamp = Date.parse(m.time || '');
		if (!Number.isFinite(timestamp)) {
			separate(m, false, _('Unknown multipart timestamp; part shown separately.'));
			return;
		}
		var key = JSON.stringify([ m.sender || '', Number(m.concat_ref), total,
			m.dcs == null ? null : Number(m.dcs) ]);
		if (!groups[key])
			groups[key] = [];
		groups[key].push({ message: m, seq: seq, timestamp: timestamp });
	});

	function finish(parts) {
		if (!parts.length)
			return;
		var total = Number(parts[0].message.concat_total);
		var seen = Object.create(null), ambiguous = false;
		parts.forEach(function(p) {
			if (seen[p.seq])
				ambiguous = true;
			seen[p.seq] = true;
		});
		// Do not guess which message owns a repeated sequence/reference, even
		// when duplicate text looks identical. Each uncertain part keeps its ID.
		// Chained arrivals spanning the window are also kept separate rather
		// than split at an arbitrary point which could mix two real messages.
		if (ambiguous || parts[parts.length - 1].timestamp - parts[0].timestamp > windowMs) {
			parts.forEach(function(p) {
				separate(p.message, false, _('Ambiguous multipart parts; shown separately.'));
			});
			return;
		}
		var first = parts[0].message;
		parts.sort(function(a, b) { return a.seq - b.seq; });
		var complete = true;
		for (var i = 1; i <= total; i++)
			if (!seen[i])
				complete = false;
		out.push({
			sender: first.sender || '', time: first.time || '',
			text: parts.map(function(p) { return p.message.text || ''; }).join(''),
			ids: parts.map(function(p) { return Number(p.message.id); }),
			complete: complete, parts_count: parts.length, total: total
		});
	}

	Object.keys(groups).forEach(function(k) {
		var sorted = groups[k].sort(function(a, b) {
			return a.timestamp - b.timestamp || Number(a.message.id) - Number(b.message.id);
		});
		var parts = [];
		sorted.forEach(function(p) {
			if (parts.length && p.timestamp - parts[parts.length - 1].timestamp > windowMs) {
				finish(parts);
				parts = [];
			}
			parts.push(p);
		});
		finish(parts);
	});

	out.sort(function(a, b) {
		var ta = Date.parse(a.time || '') || 0;
		var tb = Date.parse(b.time || '') || 0;
		if (ta !== tb)
			return tb - ta;
		return Math.max.apply(null, b.ids) - Math.max.apply(null, a.ids);
	});

	return out;
}

var gsmBasic = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
var gsmExt = "\f^{}\\[~]|€";

function smsEstimate(value) {
	var gsm = true, septets = 0;
	for (var ch of value) {
		if (gsmBasic.indexOf(ch) >= 0)
			septets += 1;
		else if (gsmExt.indexOf(ch) >= 0)
			septets += 2;
		else {
			gsm = false;
			break;
		}
	}

	if (gsm) {
		var gs = septets <= 160 ? 1 : Math.ceil(septets / 153);
		return { encoding: 'GSM-7', segments: gs, units: septets };
	}

	var units = value.length;
	var us = units <= 70 ? 1 : Math.ceil(units / 67);
	return { encoding: 'UCS-2', segments: us, units: units };
}

function notice(kind, message) {
	return E('div', {
		'class': kind === 'error' ? 'alert-message error' : 'alert-message success',
		'style': 'margin:10px 0'
	}, [ message ]);
}

return view.extend({
	load: function() {
		return callSmsList();
	},

	render: function(data) {
		var self = this;
		data = data || {};

		var root = E('div');
		root.appendChild(E('h2', {}, [ _('VT Modem — SMS') ]));
		root.appendChild(E('div', { 'class': 'cbi-map-descr' }, [
			_('Compose and receive SMS through the modem. Long messages are automatically encoded and split into multipart SMS.')
		]));

		if (data.supported === false) {
			root.appendChild(E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('SMS unavailable') ]),
				E('p', {}, [ text(data.error || _('The current modem does not expose the T99W175 SMS backend.')) ])
			]));
			return root;
		}

		var phone = E('input', {
			'class': 'cbi-input-text',
			'type': 'tel',
			'placeholder': '+7…',
			'style': 'width:100%; max-width:420px'
		});
		var body = E('textarea', {
			'class': 'cbi-input-textarea',
			'placeholder': _('SMS text'),
			'rows': 7,
			'style': 'width:100%; min-height:140px; resize:vertical'
		});
		var estimate = E('div', {
			'style': 'font-size:.85rem; opacity:.7; margin-top:6px'
		}, [ _('Encoding: auto') ]);
		var resultBox = E('div');

		function updateEstimate() {
			var e = smsEstimate(body.value || '');
			estimate.textContent = String.format(_('Estimated: %s · %d segment(s)'), e.encoding, e.segments);
		}
		body.addEventListener('input', updateEstimate);

		var sendButton = E('button', {
			'class': 'btn cbi-button-action',
			'click': ui.createHandlerFn(this, function() {
				var p = (phone.value || '').trim();
				var t = body.value || '';
				resultBox.replaceChildren();
				if (!p || !t) {
					resultBox.appendChild(notice('error', _('Phone number and SMS text are required.')));
					return;
				}
				sendButton.disabled = true;
				return callSmsSend(p, t).then(function(r) {
					r = r || {};
					if (!r.ok)
						resultBox.appendChild(notice('error', text(r.error || _('SMS send failed.'))));
					else {
						resultBox.appendChild(notice('success', String.format(
							_('SMS sent: %s, %d segment(s).'), text(r.encoding), Number(r.segments || 1))));
						body.value = '';
						updateEstimate();
					}
				}).catch(function(e) {
					resultBox.appendChild(notice('error', text(e)));
				}).finally(function() {
					sendButton.disabled = false;
				});
			})
		}, [ _('Send SMS') ]);

		root.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Compose') ]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('Phone number') ]),
				E('div', { 'class': 'cbi-value-field' }, [ phone ])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('Message') ]),
				E('div', { 'class': 'cbi-value-field' }, [ body, estimate ])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [ sendButton ]),
			resultBox
		]));

		var inbox = E('div', { 'class': 'cbi-section' });
		inbox.appendChild(E('h3', {}, [ _('Inbox') ]));

		if (!data.ok) {
			inbox.appendChild(notice('error', text(data.error || _('Unable to read SMS messages.'))));
		}
		else {
			var merged = mergeMessages(data.messages || []);
			if (!merged.length) {
				inbox.appendChild(E('p', {}, [ _('No messages.') ]));
			}
			else {
				var table = E('table', { 'class': 'table' }, [
					E('tr', { 'class': 'tr table-titles' }, [
						E('th', { 'class': 'th' }, [ _('Sender') ]),
						E('th', { 'class': 'th' }, [ _('Date') ]),
						E('th', { 'class': 'th' }, [ _('Message') ]),
						E('th', { 'class': 'th' }, [ '' ])
					])
				]);

				merged.forEach(function(m) {
					var msg = m.text;
					if (m.merge_warning)
						msg += '\n[' + m.merge_warning + ']';
					else if (!m.complete)
						msg += String.format(_(' [multipart incomplete: %d/%d]'), m.parts_count, m.total);
					var del = E('button', {
						'class': 'btn cbi-button-negative',
						'click': ui.createHandlerFn(self, function() {
							if (!confirm(_('Delete this SMS?')))
								return;
							del.disabled = true;
							var deleted = 0;
							var chain = Promise.resolve();
							m.ids.forEach(function(id) {
								chain = chain.then(function() {
									return callSmsDelete(id).then(function(r) {
										if (!r || r.ok !== true)
											throw new Error(text(r && r.error || _('SMS deletion failed.')));
										deleted++;
									});
								});
							});
							return chain.then(function() { window.location.reload(); })
								.catch(function(e) {
									ui.addNotification(null, E('p', {}, [ String.format(
										_('SMS deletion stopped: %s. Deleted %d of %d part(s). Refresh the inbox before retrying.'),
										text(e && e.message || e), deleted, m.ids.length) ]), 'error');
								})
								.finally(function() { del.disabled = false; });
						})
					}, [ _('Delete') ]);
					table.appendChild(E('tr', { 'class': 'tr' }, [
						E('td', { 'class': 'td', 'style': 'white-space:nowrap' }, [ text(m.sender) ]),
						E('td', { 'class': 'td', 'style': 'white-space:nowrap' }, [ text(m.time) ]),
						E('td', { 'class': 'td', 'style': 'white-space:pre-wrap; word-break:break-word' }, [ msg ]),
						E('td', { 'class': 'td right' }, [ del ])
					]));
				});
				inbox.appendChild(table);
			}
		}

		inbox.appendChild(E('div', { 'class': 'right', 'style': 'margin-top:10px' }, [
			E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(this, function() { window.location.reload(); })
			}, [ _('Refresh') ])
		]));
		root.appendChild(inbox);
		updateEstimate();
		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
