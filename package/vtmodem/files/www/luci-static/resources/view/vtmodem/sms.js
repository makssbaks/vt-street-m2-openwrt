'use strict';
'require view';
'require rpc';
'require ui';

var callSmsListStart = rpc.declare({
	object: 'vtmodem', method: 'sms_list_start', params: [ 'request_id' ], expect: {}, reject: true
});
var callSmsSendStart = rpc.declare({
	object: 'vtmodem', method: 'sms_send_start', params: [ 'phone', 'text', 'request_id' ], expect: {}, reject: true
});
var callSmsDeleteStart = rpc.declare({
	object: 'vtmodem', method: 'sms_delete_start', params: [ 'messages', 'request_id' ], expect: {}, reject: true
});
var callSmsJobStatus = rpc.declare({
	object: 'vtmodem', method: 'sms_job_status', params: [ 'job_id' ], expect: {}, reject: true
});
var pendingJobKey = 'vtmodem.sms.pending.v1';

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
			parts: [ { id: Number(m.id), fingerprint: m.fingerprint } ],
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
			separate(m, false, _('Некорректные данные составной SMS; часть показана отдельно.'));
			return;
		}
		var timestamp = Date.parse(m.time || '');
		if (!Number.isFinite(timestamp)) {
			separate(m, false, _('Неизвестно время составной SMS; часть показана отдельно.'));
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
				separate(p.message, false, _('Принадлежность частей неоднозначна; они показаны отдельно.'));
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
			parts: parts.map(function(p) {
				return { id: Number(p.message.id), fingerprint: p.message.fingerprint };
			}),
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
	var gsm = true, septets = 0, widths = [];
	for (var ch of value) {
		if (gsmBasic.indexOf(ch) >= 0) {
			septets += 1;
			widths.push(1);
		}
		else if (gsmExt.indexOf(ch) >= 0) {
			septets += 2;
			widths.push(2);
		}
		else {
			gsm = false;
			break;
		}
	}

	if (gsm) {
		var gs = septets <= 160 ? 1 : countSegments(widths, 153);
		return { encoding: 'GSM-7', segments: gs, units: septets };
	}

	var units = value.length;
	// The encoder keeps both an escape pair and a UTF-16 surrogate pair in
	// one segment. Dividing only the total units can undercount segments.
	widths = Array.from(value, function(ch) { return ch.length; });
	var us = units <= 70 ? 1 : countSegments(widths, 67);
	return { encoding: 'UCS-2', segments: us, units: units };
}

function countSegments(widths, limit) {
	var segments = 1, used = 0;
	widths.forEach(function(width) {
		if (used + width > limit) {
			segments++;
			used = 0;
		}
		used += width;
	});
	return segments;
}

function notice(kind, message) {
	return E('div', {
		'class': kind === 'error' ? 'alert-message error' : 'alert-message success',
		'style': 'margin:10px 0'
	}, [ message ]);
}

function requestId() {
	var bytes = new Uint8Array(16);
	if (window.crypto && window.crypto.getRandomValues)
		window.crypto.getRandomValues(bytes);
	else {
		// This ID only provides retry identity; it is not an access token.
		for (var i = 0; i < bytes.length; i++)
			bytes[i] = Math.floor(Math.random() * 256);
	}
	return Array.from(bytes, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function storedJob() {
	try {
		var j = JSON.parse(window.sessionStorage.getItem(pendingJobKey));
		return j && /^(send|delete)$/.test(j.kind) && /^[0-9a-f]{32}$/.test(j.id) ? j : null;
	}
	catch (e) { return null; }
}

function saveJob(j, expectedId) {
	try {
		if (j)
			window.sessionStorage.setItem(pendingJobKey, JSON.stringify({ id: j.id, kind: j.kind }));
		else {
			// A view left open during navigation may finish after a newer view
			// has started another job. Never erase that newer resume record.
			var current = storedJob();
			if (!expectedId || current && current.id === expectedId)
				window.sessionStorage.removeItem(pendingJobKey);
		}
	}
	catch (e) { /* Storage may be disabled; the current view still tracks the job. */ }
}

function validParts(parts) {
	return Array.isArray(parts) && parts.length > 0 && parts.every(function(p) {
		return Number.isInteger(p.id) && p.id >= 0 &&
			typeof p.fingerprint === 'string' && p.fingerprint.length >= 2 &&
			p.fingerprint.length <= 1024 && p.fingerprint.length % 2 === 0 &&
			/^[0-9A-F]+$/.test(p.fingerprint);
	});
}

function sendOutcome(r) {
	var total = Number(r.parts_total || r.segments || r.parts || 0);
	var confirmed = Number(r.parts_confirmed || (r.ok ? total : 0));
	if (r.ok)
		return String.format(_('Принято модемом: %d из %d частей, %s. Это не отчёт о доставке получателю.'),
			confirmed, total, text(r.encoding));
	var details = total ? String.format(_('Подтверждено частей: %d из %d. '), confirmed, total) : '';
	if (r.outcome_unknown)
		details += _('Результат последней части неизвестен. ');
	if (confirmed > 0 || r.outcome_unknown)
		details += _('Повторная отправка всего сообщения может создать дубликаты. ');
	return details + text(r.error || _('Не удалось отправить SMS.'));
}

return view.extend({
	// Rendering must not wait on a modem operation or the AT lock.
	load: function() { return {}; },

	render: function(data) {
		var self = this;
		data = data || {};
		var root = E('div');
		root.appendChild(E('h2', {}, [ _('VT Modem — SMS') ]));
		root.appendChild(E('div', { 'class': 'cbi-map-descr' }, [
			_('Приём и отправка SMS через модем. Длинный текст автоматически разделяется на части.')
		]));
		if (data.supported === false) {
			root.appendChild(notice('error', text(data.error || _('SMS недоступны для этого модема.'))));
			return root;
		}

		var active = null, reading = false, listInvalid = false, deleteButtons = [], inboxGeneration = 0;
		var draftVersion = 0, lastSend = null;
		var phone = E('input', {
			'class': 'cbi-input-text', 'type': 'tel', 'placeholder': '+7…',
			'style': 'width:100%; max-width:420px'
		});
		var body = E('textarea', {
			'class': 'cbi-input-textarea', 'placeholder': _('Текст SMS'), 'rows': 7,
			'style': 'width:100%; min-height:140px; resize:vertical'
		});
		var estimate = E('div', { 'style': 'font-size:.85rem; opacity:.7; margin-top:6px' });
		var resultBox = E('div'), jobBox = E('div'), inboxContent = E('div');

		function updateEstimate() {
			var e = smsEstimate(body.value || '');
			estimate.textContent = String.format(_('Кодировка: %s · частей: %d'), e.encoding, e.segments);
		}
		body.addEventListener('input', function() { draftVersion++; updateEstimate(); });
		phone.addEventListener('input', function() { draftVersion++; });

		function controls() {
			sendButton.disabled = !!active || reading;
			refreshButton.disabled = !!active || reading;
			deleteButtons.forEach(function(entry) {
				entry.button.disabled = !!active || reading || listInvalid || !entry.valid;
			});
		}

		function invalidateInbox() {
			listInvalid = true;
			inboxGeneration++;
			controls();
		}

		function pauseJob(j, reason) {
			if (active !== j)
				return;
			jobBox.replaceChildren(notice('error', reason));
			jobBox.appendChild(E('button', {
				'class': 'btn cbi-button-action',
				'click': ui.createHandlerFn(self, function() { return watchJob(j); })
			}, [ _('Проверить результат') ]));
			jobBox.appendChild(E('button', {
				'class': 'btn', 'style': 'margin-left:10px',
				'click': ui.createHandlerFn(self, function() {
					if (!confirm(_('Результат операции неизвестен. Завершить наблюдение? Это не отменит операцию на модеме. Повторная отправка может создать дубликаты.')))
						return;
					active = null;
					saveJob(null, j.id);
					jobBox.replaceChildren(notice('error', _('Наблюдение завершено. Результат операции остался неизвестен.')));
					if (j.kind === 'send')
						lastSend = { phone: j.phone, text: j.text, uncertain: true };
					controls();
				})
			}, [ _('Завершить наблюдение') ]));
		}

		function finishJob(j, r) {
			if (active !== j)
				return;
			r = r || {};
			active = null;
			saveJob(null, j.id);
			jobBox.replaceChildren();
			if (j.kind === 'send') {
				resultBox.replaceChildren(notice(r.ok ? 'success' : 'error', sendOutcome(r)));
				lastSend = { phone: j.phone, text: j.text,
					uncertain: !r.ok && (Number(r.parts_confirmed) > 0 || r.outcome_unknown === true) };
				// The user may compose another message while the first job runs.
				// A resumed job has no draft snapshot and never clears this form.
				if (r.ok && j.draftVersion === draftVersion && j.phone === phone.value.trim() && j.text === body.value) {
					body.value = '';
					updateEstimate();
				}
			}
			else {
				var message = r.ok ? _('SMS удалено. Обновите список сообщений.') :
					String.format(_('Удаление остановлено. Подтверждено удалений: %d из %d. %s Обновите список перед следующей попыткой.'),
						Number(r.deleted || 0), Number(r.total || j.total || 0), text(r.error || ''));
				if (r.outcome_unknown)
					message += ' ' + _('Результат последнего удаления неизвестен.');
				resultBox.replaceChildren(notice(r.ok ? 'success' : 'error', message));
			}
			controls();
		}

		function timedRpc(request) {
			// A transport deadline does not cancel the modem job. A timed-out
			// mutation is recovered by its ID, never by repeating the start.
			return new Promise(function(resolve, reject) {
				var timer = setTimeout(function() { reject(new Error(_('Истекло время ожидания ответа роутера.'))); }, 10000);
				Promise.resolve().then(request).then(function(r) { clearTimeout(timer); resolve(r); },
					function(e) { clearTimeout(timer); reject(e); });
			});
		}

		function timedStatus(id) {
			return timedRpc(function() { return callSmsJobStatus(id); });
		}

		function watchJob(j, initial) {
			if (active !== j || j.watching)
				return Promise.resolve();
			j.watching = true;
			var polls = 0, deadline = Date.now() + 180000;
			jobBox.replaceChildren(notice('success', _('Операция выполняется на модеме. Можно продолжать редактировать черновик.')));
			function step(r) {
				if (active !== j)
					return;
				if (r && r.ok === true && r.state === 'done' && r.result && typeof r.result === 'object') {
					finishJob(j, r.result);
					return;
				}
				if (r && r.ok === true && (r.state === 'running' || r.state === 'queued')) {
					if (++polls >= 90 || Date.now() >= deadline) {
						pauseJob(j, _('Операция ещё выполняется. Автоматическая проверка приостановлена; проверьте результат позже. Повторная отправка не запускалась.'));
						return;
					}
					return new Promise(function(resolve) { setTimeout(resolve, 2000); })
						.then(function() { return active === j ? timedStatus(j.id).then(step) : null; });
				}
				if (j.resumed === true && r && r.ok === false && r.error_code === 'not_found') {
					active = null;
					saveJob(null, j.id);
					if (j.kind === 'send')
						lastSend = { phone: null, text: null, uncertain: true };
					jobBox.replaceChildren(notice('error', _('Результат предыдущей операции больше не хранится после перезапуска или очистки роутера. Операция не повторялась автоматически.')));
					controls();
					if (j.kind === 'delete')
						return refreshInbox();
					return;
				}
				pauseJob(j, _('Результат операции пока неизвестен. ') + text(r && r.error || _('Задание не найдено. Повторная отправка не запускалась.')));
			}
			return (initial ? Promise.resolve(initial).then(step) : timedStatus(j.id).then(step))
				.catch(function(e) { pauseJob(j, _('Результат операции пока неизвестен. ') + text(e && e.message || e)); })
				.finally(function() { j.watching = false; });
		}

		function startWrite(j, start) {
			if (active || reading)
				return Promise.resolve();
			active = j;
			saveJob(j);
			controls();
			return timedRpc(start).then(function(r) {
				if (r && r.ok === false && r.retry_safe === true) {
					active = null;
					saveJob(null, j.id);
					jobBox.replaceChildren(notice('error', text(r.error || _('Операция не запущена.'))));
					controls();
					return;
				}
				// A concurrent publication cannot prove this ID was rejected.
				// Resolve any ambiguous start reply with a read of that same ID.
				return watchJob(j, r && r.ok === true ? r : null);
			}).catch(function() {
				// The request might have reached the router before the transport
				// failed. The known request ID allows a read-only outcome check.
				return watchJob(j);
			});
		}

		var sendButton = E('button', {
			'class': 'btn cbi-button-action',
			'click': ui.createHandlerFn(this, function() {
				if (active || reading)
					return;
				var p = (phone.value || '').trim(), t = body.value || '';
				resultBox.replaceChildren();
				if (!p || !t) {
					resultBox.appendChild(notice('error', _('Укажите номер получателя и текст SMS.')));
					return;
				}
				if (lastSend && lastSend.uncertain &&
					(lastSend.text == null || lastSend.text === t && lastSend.phone === p) &&
					!confirm(_('Часть предыдущей SMS могла быть отправлена. Отправить этот текст снова? Получатель может получить дубликаты.')))
					return;
				var j = { kind: 'send', id: requestId(), phone: p, text: t, draftVersion: draftVersion };
				return startWrite(j, function() { return callSmsSendStart(p, t, j.id); });
			})
		}, [ _('Отправить SMS') ]);

		root.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Новое сообщение') ]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('Номер получателя') ]),
				E('div', { 'class': 'cbi-value-field' }, [ phone ])
			]),
			E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, [ _('Сообщение') ]),
				E('div', { 'class': 'cbi-value-field' }, [ body, estimate ])
			]),
			E('div', { 'class': 'cbi-page-actions' }, [ sendButton ]), resultBox, jobBox
		]));

		function drawInbox(r) {
			var generation = ++inboxGeneration;
			deleteButtons = [];
			inboxContent.replaceChildren();
			if (!r || r.ok !== true) {
				listInvalid = true;
				inboxContent.appendChild(notice('error', text(r && r.error || _('Не удалось прочитать SMS.'))));
				return;
			}
			listInvalid = false;
			var merged = mergeMessages(r.messages || []);
			if (!merged.length) {
				inboxContent.appendChild(E('p', {}, [ _('Сообщений нет.') ]));
				return;
			}
			var table = E('table', { 'class': 'table' }, [
				E('tr', { 'class': 'tr table-titles' }, [
					E('th', { 'class': 'th' }, [ _('Отправитель') ]),
					E('th', { 'class': 'th' }, [ _('Дата') ]),
					E('th', { 'class': 'th' }, [ _('Сообщение') ]), E('th', { 'class': 'th' }, [ '' ])
				])
			]);
			merged.forEach(function(m) {
				var msg = m.text, valid = validParts(m.parts);
				if (m.merge_warning)
					msg += '\n[' + m.merge_warning + ']';
				else if (!m.complete)
					msg += String.format(_(' [получено частей: %d/%d]'), m.parts_count, m.total);
				var del = E('button', {
					'class': 'btn cbi-button-negative',
					'title': valid ? '' : _('Для безопасного удаления обновите список после обновления SMS-службы.'),
					'click': ui.createHandlerFn(self, function() {
						if (active || reading || listInvalid || generation !== inboxGeneration || !valid || !confirm(_('Удалить это SMS?')))
							return;
						invalidateInbox();
						var j = { kind: 'delete', id: requestId(), total: m.parts.length };
						return startWrite(j, function() { return callSmsDeleteStart(m.parts, j.id); });
					})
				}, [ _('Удалить') ]);
				deleteButtons.push({ button: del, valid: valid });
				table.appendChild(E('tr', { 'class': 'tr' }, [
					E('td', { 'class': 'td', 'style': 'white-space:nowrap' }, [ text(m.sender) ]),
					E('td', { 'class': 'td', 'style': 'white-space:nowrap' }, [ text(m.time) ]),
					E('td', { 'class': 'td', 'style': 'white-space:pre-wrap; word-break:break-word' }, [ msg ]),
					E('td', { 'class': 'td right' }, [ del ])
				]));
			});
			inboxContent.appendChild(table);
		}

		function refreshInbox() {
			if (active || reading)
				return Promise.resolve();
			reading = true;
			invalidateInbox();
			inboxContent.replaceChildren(E('p', {}, [ _('Чтение сообщений…') ]));
			var id = requestId(), polls = 0, deadline = Date.now() + 60000;
			function step(r) {
				if (r && r.ok === true && r.state === 'done') {
					drawInbox(r.result);
					return;
				}
				if (r && r.ok === true && (r.state === 'queued' || r.state === 'running') && ++polls < 30 && Date.now() < deadline)
					return new Promise(function(resolve) { setTimeout(resolve, 2000); })
						.then(function() { return timedStatus(id).then(step); });
				throw new Error(text(r && r.error || _('Чтение ещё не завершилось. Обновите список позже.')));
			}
			return timedRpc(function() { return callSmsListStart(id); }).then(step).catch(function(e) {
				drawInbox({ ok: false, error: text(e && e.message || e) });
			}).finally(function() { reading = false; controls(); });
		}

		var refreshButton = E('button', {
			'class': 'btn cbi-button-action', 'click': ui.createHandlerFn(this, refreshInbox)
		}, [ _('Обновить список') ]);
		root.appendChild(E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Входящие') ]), inboxContent,
			E('div', { 'class': 'right', 'style': 'margin-top:10px' }, [ refreshButton ])
		]));
		updateEstimate();
		var resumed = storedJob();
		if (Array.isArray(data.messages) || data.ok === false)
			drawInbox(data);
		if (resumed) {
			resumed.resumed = true;
			active = resumed;
			invalidateInbox();
			watchJob(resumed);
		}
		else if (!Array.isArray(data.messages) && data.ok !== false)
			refreshInbox();
		controls();
		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
