'use strict';
'require view';
'require rpc';
'require ui';
'require request';

var radioRequestId = 0;

// rpc.declare() uses a global timeout. Radio queries have their own bounded
// helper and need a longer HTTP deadline without changing other LuCI requests.
function radioRPC(method, params) {
	return Promise.resolve().then(function() {
		var id = ++radioRequestId;
		var message = { jsonrpc: '2.0', id: id, method: 'call',
			params: [ rpc.getSessionID(), 'vtmodem', method, params || {} ] };
		return request.post(rpc.getBaseURL(), message, {
			timeout: 90000, nobatch: true, credentials: true
		}).then(function(response) {
			if (!response || !response.ok)
				throw new Error(_('Не удалось связаться с роутером. HTTP: ') + (response ? response.status : '?'));
			var reply = response.json();
			if (!reply || reply.jsonrpc !== '2.0' || reply.id !== id)
				throw new Error(_('Некорректный ответ роутера.'));
			if (reply.error) {
				if (reply.error.code === -32002)
					throw new Error(_('Сеанс входа истёк. Войдите в веб-интерфейс заново.'));
				throw new Error(errorText(reply.error));
			}
			if (!Array.isArray(reply.result) || reply.result.length < 2 || reply.result[0] !== 0)
				throw new Error(_('Ошибка запроса к модему: ') + (Array.isArray(reply.result) ? rpc.getStatusText(reply.result[0]) : _('Ответ отсутствует')));
			if (!reply.result[1] || typeof reply.result[1] !== 'object' || Array.isArray(reply.result[1]))
				throw new Error(_('Некорректные данные модема.'));
			return reply.result[1];
		});
	});
}

function callRadioStatus() { return radioRPC('radio_status', {}); }
function callRadioApply(action, value, expected, confirm) {
	return radioRPC('radio_apply', { action: action, value: value, expected: expected, confirm: confirm });
}

var modeNames = [ _('Автоматически'), _('Только 3G'), _('Только LTE'), _('3G + LTE'),
	_('Только 5G'), _('3G + 5G'), _('LTE + 5G'), _('3G + LTE + 5G') ];

function record(value) {
	return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function integer(value, min, max) {
	return typeof value === 'number' && isFinite(value) && value % 1 === 0 && value >= min && value <= max;
}

function integerList(value, min, max, limit) {
	if (!Array.isArray(value) || value.length > limit)
		return null;
	var seen = {};
	return value.every(function(item) {
		if (!integer(item, min, max) || seen[item])
			return false;
		seen[item] = true;
		return true;
	}) ? value.slice() : null;
}

function token(value) {
	return typeof value === 'string' && value.length > 0 && value.length <= 16384 ? value : null;
}

function errorText(value) {
	if (typeof value === 'string')
		return value;
	value = record(value);
	return String(value.error || value.message || _('Неизвестная ошибка'));
}

function normalizeStatus(value) {
	value = record(value);
	var mode = record(value.mode), support = record(value.mode_support);
	var out = {
		ok: value.ok === true, supported: value.supported === true,
		mode: integer(mode.persist, 0, 1) && integer(mode.mode, 0, 7) ? mode : null,
		mode_support: {
			persist: integerList(support.persist, 0, 1, 2),
			modes: integerList(support.modes, 0, 7, 8)
		},
		bands_supported: {}, bands: {}, tokens: {},
		priority: integerList(value.priority, 1, 256, 15), lock: null,
		errors: Array.isArray(value.errors) ? value.errors.map(errorText) : []
	};
	if (value.error)
		out.errors.push(errorText(value.error));
	if (!out.ok && !out.errors.length)
		out.errors.push(_('Не удалось прочитать настройки модема.'));
	[ 'mode', 'bands', 'priority', 'lock' ].forEach(function(key) {
		out.tokens[key] = token(record(value.tokens)[key]);
	});
	[ 'WCDMA', 'LTE', 'NR5G' ].forEach(function(technology) {
		var known = integerList(record(value.bands_supported)[technology], 1, 256, 256);
		out.bands_supported[technology] = known && known.length ? known : null;
		var band = record(record(value.bands)[technology]);
		var enabled = integerList(band.enabled, 1, 256, 256);
		var disabled = integerList(band.disabled, 1, 256, 256);
		out.bands[technology] = enabled && disabled && enabled.every(function(n) {
			return disabled.indexOf(n) < 0;
		}) ? { enabled: enabled, disabled: disabled } : null;
	});
	if (Array.isArray(value.lock) && value.lock.length <= 8) {
		var seen = {};
		if (value.lock.every(function(cell) {
			cell = record(cell);
			var key = cell.pci + ',' + cell.earfcn;
			if (!integer(cell.pci, 0, 503) || !integer(cell.earfcn, 0, 262143) || seen[key])
				return false;
			seen[key] = true;
			return true;
		}))
			out.lock = value.lock.map(function(cell) { return { pci: cell.pci, earfcn: cell.earfcn }; });
	}
	return out;
}

function bandsComplete(status) {
	var known = status.bands_supported.LTE, current = status.bands.LTE;
	return known && current && known.length === current.enabled.length + current.disabled.length &&
		current.enabled.concat(current.disabled).every(function(n) { return known.indexOf(n) >= 0; });
}

function validateAction(action, input, status) {
	if (!status.ok || !status.supported)
		throw new Error(_('Сначала прочитайте настройки модема.'));
	var key = action === 'unlock' ? 'lock' : action;
	if (!status.tokens[key])
		throw new Error(_('Нет проверенного состояния для изменения этой настройки.'));
	var value, list, known = status.bands_supported.LTE;
	if (action === 'mode') {
		if (typeof input !== 'string' || !/^[01],[0-7]$/.test(input) || !status.mode)
			throw new Error(_('Выберите режим сети и способ сохранения.'));
		list = input.split(',').map(Number);
		if (!status.mode_support.persist || !status.mode_support.modes ||
			status.mode_support.persist.indexOf(list[0]) < 0 || status.mode_support.modes.indexOf(list[1]) < 0)
			throw new Error(_('Выбранный режим не подтверждён модемом.'));
		if (list[1] !== 2 && (status.lock === null || status.lock.length))
			throw new Error(_('Для смены режима сначала прочитайте и снимите фиксацию соты.'));
		value = list.join(',');
	}
	else if (action === 'bands' || action === 'priority') {
		if (typeof input !== 'string' || !/^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(input))
			throw new Error(_('Укажите номера диапазонов через запятую.'));
		list = integerList(input.split(',').map(Number), 1, 256, action === 'priority' ? 15 : 30);
		if (!list || !list.length || !known || list.some(function(n) { return known.indexOf(n) < 0; }))
			throw new Error(_('Укажите поддерживаемые диапазоны без повторов; для приоритета — не более 15.'));
		if (action === 'bands' && !bandsComplete(status) || action === 'priority' && status.priority === null)
			throw new Error(_('Текущее состояние диапазонов не прочитано полностью.'));
		if (action === 'bands') {
			if (status.lock === null)
				throw new Error(_('Сначала прочитайте состояние фиксации соты.'));
			if (status.lock.length)
				throw new Error(_('Сначала снимите фиксацию соты.'));
			if (list.length > 15 && list.some(function(n) { return status.bands.LTE.enabled.indexOf(n) < 0; }))
				throw new Error(_('За один шаг можно включить не более 15 выбранных диапазонов. Сначала выберите меньший набор.'));
			list.sort(function(a, b) { return a - b; });
		}
		value = list.join(',');
	}
	else if (action === 'lock') {
		if (typeof input !== 'string' || !input.trim() || status.lock === null)
			throw new Error(_('Укажите хотя бы одну соту: PCI, EARFCN.'));
		list = input.trim().split(/\r?\n/);
		var cells = [], seen = {};
		if (list.length > 8)
			throw new Error(_('Можно указать не более восьми сот.'));
		list.forEach(function(line) {
			if (!/^\s*\d+\s*,\s*\d+\s*$/.test(line))
				throw new Error(_('Каждая строка должна содержать одну пару PCI, EARFCN.'));
			var pair = line.split(',').map(Number), key = pair.join(',');
			if (!integer(pair[0], 0, 503) || !integer(pair[1], 0, 262143) || seen[key])
				throw new Error(_('PCI: 0–503; EARFCN: 0–262143. Повторы сот не допускаются.'));
			seen[key] = true;
			cells.push(key);
		});
		value = cells.join(',');
	}
	else if (action === 'unlock') {
		if (input !== '' || status.lock === null || !status.lock.length)
			throw new Error(_('Нет прочитанной фиксации соты для снятия.'));
		value = '';
	}
	else
		throw new Error(_('Неизвестное действие.'));
	return { action: action, value: value, expected: status.tokens[key] };
}

function bandText(list, technology) {
	return list === null ? _('Не прочитано') : list.length ? list.map(function(n) {
		return (technology === 'NR5G' ? 'n' : 'B') + n;
	}).join(', ') : _('Нет');
}

function notice(kind, message) {
	return E('div', { 'class': 'alert-message ' + kind, 'style': 'overflow-wrap:anywhere' }, [ message ]);
}

return view.extend({
	load: function() {
		return callRadioStatus().catch(function(error) {
			return { ok: false, error: errorText(error) };
		});
	},

	render: function(initial) {
		var status, controls = [], dirty = {}, busy = false, stale = false;
		var writable = L.hasViewPermission() === true;
		var root = E('div'), result = E('div', { 'role': 'status', 'aria-live': 'polite' });
		var body = E('div'), refresh;
		root.appendChild(E('h2', {}, [ _('VT Modem — Радио') ]));
		root.appendChild(E('p', {}, [ _('Режим сети, диапазоны LTE и фиксация соты. Изменения выполняются только после подтверждения.') ]));
		root.appendChild(result);
		root.appendChild(body);

		function sync() {
			controls.forEach(function(control) {
				control.node.disabled = busy || stale || !writable || !control.available;
			});
			refresh.disabled = busy;
		}

		function register(node, available, section) {
			controls.push({ node: node, available: !!available });
			if (section) {
				[ 'input', 'change' ].forEach(function(event) {
					node.addEventListener(event, function() { dirty[section] = true; });
				});
			}
			return node;
		}

		function setMessage(kind, message) {
			result.replaceChildren(notice(kind, message));
		}

		function dialog(title, contents, onConfirm) {
			var submitted = false;
			busy = true;
			sync();
			// LuCI's Escape handler clicks the first button in .right: Cancel.
			var cancel = E('button', { 'class': 'btn', 'type': 'button', 'click': function() {
				if (submitted)
					return;
				ui.hideModal();
				busy = false;
				sync();
			} }, [ _('Отмена') ]);
			var apply = E('button', { 'class': 'btn cbi-button-action', 'type': 'button', 'click': function() {
				if (submitted)
					return;
				submitted = true;
				cancel.disabled = true;
				apply.disabled = true;
				ui.hideModal();
				return onConfirm();
			} }, [ _('Подтвердить') ]);
			ui.showModal(title, contents.concat([ E('div', {
				'class': 'right', 'style': 'display:flex; flex-wrap:wrap; justify-content:flex-end; gap:8px'
			}, [ cancel, apply ]) ]));
		}

		function applyAction(action, input, description) {
			if (busy || stale || !writable)
				return;
			var request;
			try { request = validateAction(action, input, status); }
			catch (error) { setMessage('error', errorText(error)); return; }
			var warning = _('Мобильный интернет может прерваться. Если подключение к этой странице идёт через модем, доступ к ней также может пропасть.');
			var contents = [ E('p', {}, [ description ]), notice('warning', warning) ];
			if (action === 'bands') {
				var selected = request.value.split(',').map(Number);
				contents.push(E('p', {}, [ _('Будут отключены: ') + bandText(status.bands.LTE.enabled.filter(function(n) {
					return selected.indexOf(n) < 0;
				}), 'LTE') ]));
			}
			if (action === 'priority' || action === 'lock' || action === 'unlock')
				contents.push(E('p', {}, [ _('Для применения потребуется отдельная перезагрузка модема. Эта страница не перезагружает модем автоматически.') ]));
			if (action === 'lock')
				contents.push(E('p', {}, [ _('Фиксация соты переводит модем в режим LTE. Ошибочные PCI или EARFCN могут лишить его связи.') ]));
			dialog(_('Подтвердите изменение радио'), contents, function() {
				setMessage('warning', _('Настройка отправляется. Дождитесь результата; не повторяйте действие.'));
				return callRadioApply(request.action, request.value, request.expected, true).then(function(response) {
					response = record(response);
					stale = true;
					if (response.ok === true && response.verified === true) {
						delete dirty[action];
						var message = response.changed === false
							? _('Настройка уже имеет выбранное значение; изменение не потребовалось. Перед следующим действием нажмите «Прочитать настройки».')
							: _('Настройка сохранена и проверена повторным чтением. Перед следующим изменением нажмите «Прочитать настройки».');
						if (response.restart_required === true)
							message += ' ' + _('Для её применения ещё требуется перезагрузка модема; автоматически она не выполнялась.');
						setMessage('success', message);
					}
					else {
						var reason = errorText(response.error || _('Повторное чтение не подтвердило результат.'));
						var outcome = response.changed === false
							? _('Изменение не выполнено.')
							: _('Настройки могли измениться.');
						setMessage('error', reason + ' ' + outcome + ' ' + _('Черновик сохранён. Прочитайте настройки заново перед повторной попыткой.'));
					}
				}).catch(function(error) {
					stale = true;
					setMessage('error', errorText(error) + ' ' + _('Ответ не получен: настройки могли измениться. Черновик сохранён. Прочитайте настройки заново; автоматического повтора нет.'));
				}).finally(function() { busy = false; sync(); });
			});
		}

		function read() {
			busy = true;
			sync();
			setMessage('warning', _('Чтение настроек модема…'));
			return callRadioStatus().then(function(response) {
				var next = normalizeStatus(response);
				if (!next.ok || !next.supported) {
					stale = true;
					setMessage('error', next.errors.join(' ') || _('Не удалось прочитать настройки. Черновик сохранён.'));
					return;
				}
				stale = false;
				dirty = {};
				draw(response);
				setMessage(next.errors.length ? 'warning' : 'success', next.errors.length
					? _('Часть настроек недоступна; соответствующие действия отключены.') : _('Настройки прочитаны.'));
			}).catch(function(error) {
				stale = true;
				setMessage('error', errorText(error) + ' ' + _('Не удалось обновить настройки. Черновик сохранён.'));
			}).finally(function() { busy = false; sync(); });
		}

		refresh = E('button', { 'class': 'btn', 'type': 'button', 'click': function() {
			if (busy)
				return;
			if (Object.keys(dirty).length) {
				dialog(_('Прочитать настройки заново?'), [ E('p', {}, [ _('Несохранённые правки будут заменены настройками, прочитанными из модема.') ]) ], read);
				return;
			}
			return read();
		} }, [ _('Прочитать настройки') ]);
		root.appendChild(E('div', { 'class': 'cbi-page-actions' }, [ refresh ]));

		function field(label, node, hint) {
			return E('div', { 'style': 'margin:12px 0' }, [
				E('label', { 'style': 'display:block; font-weight:600; margin-bottom:6px' }, [ label, node ]),
				hint ? E('p', { 'class': 'cbi-value-description' }, [ hint ]) : ''
			]);
		}

		function section(title, children) {
			return E('section', { 'class': 'cbi-section', 'style': 'padding:16px; margin:16px 0; overflow-wrap:anywhere' },
				[ E('h3', {}, [ title ]) ].concat(children));
		}

		function button(label, available, action, getInput, describe) {
			return register(E('button', { 'type': 'button', 'class': 'btn cbi-button-action', 'click': function() {
				if (!available)
					return;
				var value = getInput();
				return applyAction(action, value, describe(value));
			} }, [ label ]), available);
		}

		function draw(raw) {
			status = normalizeStatus(raw);
			controls = [];
			body.replaceChildren();
			if (!writable)
				body.appendChild(notice('warning', _('У этой учётной записи доступ только для чтения.')));
			if (!status.supported)
				body.appendChild(notice('warning', _('Управление радио T99W175 недоступно.')));
			status.errors.forEach(function(error) { body.appendChild(notice('error', error)); });
			var ready = status.ok && status.supported;
			var modeReady = ready && status.mode && status.mode_support.modes && status.mode_support.persist &&
				status.mode_support.modes.indexOf(status.mode.mode) >= 0 && status.mode_support.persist.indexOf(status.mode.persist) >= 0 && status.tokens.mode;
			var inputStyle = 'display:block; width:100%; max-width:520px; margin-top:6px; box-sizing:border-box';
			var modeInput = register(E('select', { 'class': 'cbi-input-select', 'style': inputStyle },
				(status.mode_support.modes || []).map(function(n) { return E('option', { 'value': String(n) }, [ modeNames[n] ]); })), modeReady, 'mode');
			var persistInput = register(E('select', { 'class': 'cbi-input-select', 'style': inputStyle },
				(status.mode_support.persist || []).map(function(n) { return E('option', { 'value': String(n) }, [
					n === 1 ? _('Сохранить в модеме') : _('До перезагрузки модема')
				]); })), modeReady, 'mode');
			modeInput.value = status.mode ? String(status.mode.mode) : '';
			persistInput.value = status.mode ? String(status.mode.persist) : '';
			body.appendChild(section(_('Режим сети'), [
				E('p', {}, [ _('Сейчас: ') + (status.mode ? modeNames[status.mode.mode] : _('Не прочитано')) ]),
				field(_('Новый режим'), modeInput), field(_('Сохранение'), persistInput),
				button(_('Изменить режим'), modeReady, 'mode', function() { return persistInput.value + ',' + modeInput.value; }, function(value) {
					var parts = value.split(',');
					return _('Режим сети: ') + modeNames[Number(parts[1])] + '. ' + (parts[0] === '1' ? _('Сохранить в модеме.') : _('До перезагрузки модема.'));
				})
			]));

			var bandReady = ready && bandsComplete(status) && status.lock !== null && !status.lock.length && status.tokens.bands;
			var checks = [], techLabels = { WCDMA: '3G', LTE: 'LTE', NR5G: '5G' };
			var bandRows = [ 'WCDMA', 'LTE', 'NR5G' ].map(function(tech) {
				var current = status.bands[tech];
				return E('div', { 'style': 'margin-bottom:12px' }, [
					E('strong', {}, [ techLabels[tech] ]),
					E('div', {}, [ _('Поддерживаются: ') + bandText(status.bands_supported[tech], tech) ]),
					E('div', {}, [ _('Разрешены: ') + bandText(current ? current.enabled : null, tech) ]),
					E('div', {}, [ _('Отключены: ') + bandText(current ? current.disabled : null, tech) ])
				]);
			});
			var checkGrid = E('div', { 'style': 'display:grid; grid-template-columns:repeat(auto-fit,minmax(80px,1fr)); gap:10px; margin:14px 0' },
				(status.bands_supported.LTE || []).map(function(band) {
					var checkbox = register(E('input', { 'type': 'checkbox', 'value': String(band) }), bandReady, 'bands');
					checkbox.checked = !!status.bands.LTE && status.bands.LTE.enabled.indexOf(band) >= 0;
					checks.push(checkbox);
					return E('label', { 'style': 'display:flex; align-items:center; gap:6px' }, [ checkbox, 'B' + band ]);
				}));
			body.appendChild(section(_('Диапазоны'), bandRows.concat([
				E('h4', {}, [ _('Разрешённые диапазоны LTE') ]), checkGrid,
				status.lock === null ? notice('warning', _('Для изменения диапазонов нужно прочитать состояние фиксации соты.')) : status.lock.length ? notice('warning', _('Сначала снимите фиксацию соты.')) : '',
				E('p', {}, [ _('Оставьте хотя бы один диапазон. Доступная агрегация зависит от сети оператора.') ]),
				button(_('Сохранить диапазоны LTE'), bandReady, 'bands', function() {
					return checks.filter(function(check) { return check.checked; }).map(function(check) { return check.value; }).join(',');
				}, function(value) { return _('Разрешить LTE: ') + value.split(',').map(function(n) { return 'B' + n; }).join(', ') + '. ' + _('Остальные поддерживаемые диапазоны LTE будут отключены.'); })
			])));

			var priorityReady = ready && status.priority !== null && status.bands_supported.LTE && status.tokens.priority;
			var priorityInput = register(E('input', { 'type': 'text', 'class': 'cbi-input-text', 'style': inputStyle, 'placeholder': '3,1,7', 'maxlength': 100 }), priorityReady, 'priority');
			priorityInput.value = status.priority ? status.priority.join(',') : '';
			body.appendChild(section(_('Приоритет поиска LTE'), [
				E('p', {}, [ _('Сейчас: ') + (status.priority === null ? _('Не прочитано') : status.priority.length ? bandText(status.priority, 'LTE') : _('Не задан')) ]),
				field(_('Диапазоны в порядке поиска'), priorityInput, _('До 15 номеров через запятую. Приоритет поиска не гарантирует выбор основной несущей (PCC).')),
				E('p', {}, [ _('После изменения потребуется отдельная перезагрузка модема.') ]),
				button(_('Сохранить приоритет'), priorityReady, 'priority', function() { return priorityInput.value; }, function(value) {
					return _('Порядок поиска LTE: ') + value + '. ' + _('Это не гарантирует выбор основной несущей (PCC).');
				})
			]));

			var lockReady = ready && status.lock !== null && status.tokens.lock;
			var lockInput = register(E('textarea', { 'class': 'cbi-input-textarea', 'style': inputStyle, 'rows': 4, 'placeholder': '213,1275', 'maxlength': 160 }), lockReady, 'lock');
			lockInput.value = status.lock ? status.lock.map(function(cell) { return cell.pci + ',' + cell.earfcn; }).join('\n') : '';
			body.appendChild(section(_('Фиксация соты LTE'), [
				E('p', {}, [ _('Сейчас: ') + (status.lock === null ? _('Не прочитано') : status.lock.length ? status.lock.map(function(cell) { return 'PCI ' + cell.pci + ', EARFCN ' + cell.earfcn; }).join('; ') : _('Не задана')) ]),
				field(_('Соты: PCI, EARFCN'), lockInput, _('Одна пара на строку, не более восьми. Снятие фиксации выполняется отдельной кнопкой.')),
				E('p', {}, [ _('Фиксация включает режим LTE. После изменения или снятия потребуется отдельная перезагрузка модема.') ]),
				E('div', { 'style': 'display:flex; flex-wrap:wrap; gap:8px' }, [
					button(_('Сохранить фиксацию'), lockReady, 'lock', function() { return lockInput.value; }, function(value) { return _('Зафиксировать соты LTE: ') + value.trim().replace(/\r?\n/g, '; ') + '.'; }),
					button(_('Снять фиксацию'), lockReady && status.lock.length, 'unlock', function() { return ''; }, function() { return _('Снять текущую фиксацию соты LTE.'); })
				])
			]));
		}

		draw(initial);
		sync();
		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
