'use strict';
'require view';
'require rpc';

var callStatus = rpc.declare({
	object: 'vtmodem',
	method: 'status',
	expect: {},
	reject: true
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
		return _('Регистрация отключена');
	if (p.length >= 3 && p[2])
		return collapseOperator(unquote(p[2]));
	return p[0] === '0' ? _('Автоматически') : text(v);
}

function collapseOperator(value) {
	// Collapse only two exactly equal whole phrases separated by one space.
	var middle = (value.length - 1) / 2;
	return middle > 0 && middle % 1 === 0 && value.charAt(middle) === ' '
		&& value.substring(0, middle) === value.substring(middle + 1)
		? value.substring(0, middle) : value;
}

function simState(value) {
	var states = { 'READY': _('Готова'), 'SIM PIN': _('Требуется PIN'),
		'SIM PUK': _('Требуется PUK'), 'NOT INSERTED': _('Не установлена') };
	return states[value] || text(value);
}

function attachedState(value) {
	return value === 1 || value === '1' ? _('Зарегистрирован')
		: value === 0 || value === '0' ? _('Не зарегистрирован') : text(value);
}

function registrationName(v) {
	var p = csv(v), stat = p.length > 1 ? p[1] : '';
	var map = {
		'0': _('Не зарегистрирован'),
		'1': _('В домашней сети'),
		'2': _('Поиск сети'),
		'3': _('Регистрация отклонена'),
		'4': _('Неизвестно'),
		'5': _('В роуминге'),
		'6': _('Только SMS, домашняя сеть'),
		'7': _('Только SMS, роуминг'),
		'8': _('Только экстренные вызовы'),
		'9': _('CSFB не предпочтителен, домашняя сеть'),
		'10': _('CSFB не предпочтителен, роуминг')
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
		return String(Number(v.toFixed(1))) + (unit ? ' ' + unit : '');
	return fallback === undefined ? '-' : fallback;
}

function bandName(v) {
	var band = measurement(v);
	return band === '-' ? '-' : 'B' + band;
}

function carrierCombination(carriers) {
	if (!Array.isArray(carriers) || !carriers.length)
		return '-';
	return carriers.map(function(carrier) {
		return bandName(carrier.band) + ' / ' + measurement(carrier.bandwidth_mhz, 'MHz');
	}).join(' + ');
}

function antennaSignal(values) {
	if (!Array.isArray(values) || !values.length)
		return '-';
	return values.map(function(value, index) {
		return 'RX' + (index + 1) + ': ' + measurement(value, 'dBm');
	}).join('; ');
}

function carrierTable(cells) {
	if (!Array.isArray(cells) || !cells.length)
		return E('p', {}, [ _('Измерения несущих недоступны') ]);

	var labels = [ _('Несущая'), _('Диапазон'), _('Ширина канала'), _('EARFCN'), _('PCI'),
		_('RSRP'), _('RSRQ'), _('RSSI'), _('SNR') ];
	var secondary = 0;
	var rows = cells.map(function(cell) {
		var role = cell.role === 'primary' ? _('Основная')
			: cell.role === 'secondary' ? _('Дополнительная') + ' ' + (++secondary) : '-';
		var values = [ role, bandName(cell.band), measurement(cell.bandwidth_mhz, 'MHz'),
			measurement(cell.earfcn), measurement(cell.pci), measurement(cell.rsrp_dbm, 'dBm'),
			measurement(cell.rsrq_db, 'dB'), measurement(cell.rssi_dbm, 'dBm'),
			measurement(cell.snr_db, 'dB') ];
		return E('tr', { 'class': 'tr' }, values.map(function(value, index) {
			return E('td', { 'class': 'td', 'data-title': labels[index] }, [ value ]);
		}));
	});

	return E('div', { 'style': 'overflow-x:auto' }, [
		E('table', { 'class': 'table', 'style': 'white-space:nowrap' }, [
			E('tr', { 'class': 'tr table-titles' }, labels.map(function(label) {
				return E('th', { 'class': 'th', 'scope': 'col' }, [ label ]);
			}))
		].concat(rows))
	]);
}

function temperature(v) {
	var n = parseInt(v, 10);
	return isNaN(n) ? '-' : String(n) + ' °C';
}

function dataState(s) {
	if (String(s.attached || '') === '1') {
		if (String(s.data_channel || '').indexOf('1,') === 0)
			return _('Канал данных готов');
		return _('Регистрация в пакетной сети');
	}
	return _('Отключено');
}

function record(v) {
	return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

function sessionState(session) {
	if (session.up === true)
		return _('Подключено');
	if (session.available === false)
		return _('Недоступно');
	if (session.pending === true)
		return _('Подключение');
	if (session.up === false)
		return _('Отключено');
	return _('Неизвестно');
}

function sessionInterface(session) {
	return typeof session.interface === 'string' && /^[A-Za-z0-9_.:-]{1,15}$/.test(session.interface)
		? session.interface : '';
}

function sessionChannel(session) {
	var state = sessionState(session), iface = sessionInterface(session);
	return session.up === true ? state + ' (QMI' + (iface ? ' / ' + iface : '') + ')' : state;
}

function sessionAddresses(session) {
	if (!Array.isArray(session.ipv4))
		return [];
	return session.ipv4.filter(function(value) {
		value = record(value);
		return typeof value.address === 'string' && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value.address)
			&& value.address.split('.').every(function(octet) { return Number(octet) <= 255; })
			&& typeof value.mask === 'number' && value.mask % 1 === 0 && value.mask >= 0 && value.mask <= 32;
	}).map(function(value) { return value.address + '/' + value.mask; });
}

function sessionDNS(session) {
	return Array.isArray(session.dns) ? session.dns.filter(function(value) {
		return typeof value === 'string' && value.trim() !== '';
	}) : [];
}

function linkAddress(link) {
	if (link.raw_ip === true)
		return _('Не применяется (Raw IP)');
	return typeof link.mac === 'string' && /^(?:[0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(link.mac)
		? link.mac : '-';
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

function renderStatus(s) {
	s = s || {};

	if (!s.present) {
		return E([], [
			E('div', { 'class': 'cbi-section' }, [
				E('h3', {}, [ _('Модем не обнаружен') ]),
				E('p', {}, [ _('Поддерживаемый модем сейчас недоступен.') ])
			])
		]);
	}

	var isT99 = s.type === 't99w175';
	var t99Session = record(isT99 && s.t99_session);
	var t99Link = record(isT99 && s.t99_link);
	var summary = grid([
		card(_('SIM'), simState(s.sim_state), s.iccid ? _('ICCID определён') : ''),
		card(_('Оператор'), operatorName(s.operator)),
		card(_('Сеть'), registrationName(s.registration)),
		card(_('Передача данных'), isT99 ? sessionState(t99Session) : dataState(s),
			isT99 ? sessionInterface(t99Session) || '-' : s.data_interface || '-')
	]);

	var qmiSignal = isT99 && s.qmi_signal || {};
	var qmiRadio = isT99 && s.qmi_radio || {};
	var t99Temperature = isT99 && s.t99_temperature || {};
	var t99Radio = isT99 && s.t99_radio || {};
	var signalCards = [
		card(_('RSSI'), measurement(qmiSignal.rssi_dbm, 'dBm', rssi(s.csq))),
		card(_('RSRP'), measurement(qmiSignal.rsrp_dbm, 'dBm', rsrp(s.cesq))),
		card(_('RSRQ'), measurement(qmiSignal.rsrq_db, 'dB', rsrq(s.cesq)))
	];
	if (isT99)
		signalCards.push(card(_('SNR'), measurement(qmiSignal.snr_db, 'dB')));
	signalCards.push(isT99
		? card(_('Температура'), measurement(t99Temperature.tsens_c, '°C'),
			'TSENS; PA: ' + measurement(t99Temperature.pa_c, '°C') + '; '
			+ _('Корпус') + ': ' + measurement(t99Temperature.skin_c, '°C'))
		: card(_('Температура'), temperature(s.temperature)));
	var signal = grid(signalCards);

	var radioRows = [
		row(_('Регистрация LTE'), registrationName(s.registration)),
		row(_('Ответ CEREG'), s.registration, true)
	];
	if (isT99) {
		radioRows.push(
			row(_('Диапазон LTE'), bandName(qmiRadio.band)),
			row(_('EARFCN'), measurement(qmiRadio.earfcn)),
			row(_('Ширина канала'), measurement(qmiRadio.bandwidth_mhz, 'MHz')),
			row(_('Агрегация LTE'), carrierCombination(s.t99_ca)),
			row(_('Идентификатор соты'), measurement(t99Radio.cell_id)),
			row(_('TAC'), measurement(t99Radio.tac)),
			row(_('Мощность передачи'), measurement(t99Radio.tx_power_dbm, 'dBm')),
			row(_('RSRP по антеннам'), antennaSignal(t99Radio.antenna_rsrp_dbm))
		);
	}
	else {
		radioRows.push(
			row(_('Дополнительные измерения сигнала'), s.xcesq, true),
			row(_('Измерения соты'), s.cell_measurement, true),
			row(_('Агрегация LTE'), s.ca_state, true)
		);
	}
	radioRows.push(
		row(_('Регистрация в пакетной сети'), attachedState(s.attached)),
		row(_('Канал данных'), isT99 ? sessionChannel(t99Session) : s.data_channel, true)
	);
	if (isT99)
		radioRows.push(row(_('Адрес IPv4'), sessionAddresses(t99Session), true));
	var radio = E('table', { 'class': 'table' }, radioRows);

	var modem = E('table', { 'class': 'table' }, [
		row(_('Производитель'), s.manufacturer),
		row(_('Модель'), s.model),
		row(_('Прошивка модема'), s.firmware, true),
		row(_('IMEI'), s.imei, true),
		row(_('CFUN'), s.cfun, true),
		row(_('ICCID'), s.iccid, true),
		row(_('IMSI'), s.imsi, true),
		row(_('USB ID'), s.usb_id, true),
		row(_('Устройство USB'), s.usb_device, true),
		row(_('Порт AT'), s.at_port, true),
		row(_('Интерфейс данных'), s.data_interface, true),
		row(_('MAC интерфейса данных'), isT99 ? linkAddress(t99Link) : s.data_mac, true),
		row(_('Контексты PDP'), s.pdp_contexts, true),
		row(isT99 ? _('Серверы DNS') : _('Профили DNS'), isT99 ? sessionDNS(t99Session) : s.dns, true)
	]);

	return E([], [
		E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Обзор') ]),
			summary
		]),
		E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Сигнал') ]),
			signal
		]),
		E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Радиосеть и сота') ]),
			radio,
			isT99 ? carrierTable(t99Radio.cells) : ''
		]),
		E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, [ _('Сведения о модеме') ]),
			modem
		])
	]);
}

function validStatus(value) {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		&& typeof value.present === 'boolean';
}

function requireStatus(value) {
	if (!validStatus(value))
		throw new Error(_('Модем вернул некорректный ответ.'));
	return value;
}

function errorText(error) {
	return error && typeof error.message === 'string' && error.message
		? error.message : typeof error === 'string' && error
			? error : _('Ошибка запроса статуса.');
}

function createRefreshController(options) {
	var interval = 30000, timer = null, pending = null;
	var started = false, stopped = false, suspended = false, busy = false;
	var initial = options.initial || {};
	var status = validStatus(initial.status) ? initial.status : null;
	var lastSuccess = status ? initial.completedAt : null;
	var error = initial.error ? errorText(initial.error) : null;

	function state() {
		return { status: status, lastSuccess: lastSuccess, error: error,
			busy: busy, interval: interval, stopped: stopped };
	}

	function notify() {
		if (!stopped)
			options.onState(state());
	}

	function clearTimer() {
		if (timer !== null) {
			options.clearTimer(timer);
			timer = null;
		}
	}

	function schedule() {
		clearTimer();
		if (started && !stopped && !suspended && !busy && interval && !options.isHidden())
			timer = options.setTimer(function() {
				timer = null;
				refresh();
			}, interval);
	}

	function refresh() {
		if (stopped || suspended || !started || options.isHidden())
			return Promise.resolve(false);
		if (busy)
			return pending;
		clearTimer();
		busy = true;
		// Keep this promise until transport settlement; no timeout race can
		// unlock another request while this one is still running.
		pending = Promise.resolve().then(options.query).then(function(value) {
			if (stopped)
				return false;
			status = requireStatus(value);
			lastSuccess = options.now();
			error = null;
			return true;
		}).catch(function(failure) {
			if (!stopped)
				error = errorText(failure);
			return false;
		}).then(function(success) {
			busy = false;
			pending = null;
			if (!stopped) {
				notify();
				schedule();
			}
			return success;
		});
		notify();
		return pending;
	}

	return {
		start: function() {
			if (started || stopped)
				return;
			started = true;
			notify();
			schedule();
		},
		refresh: refresh,
		setInterval: function(value) {
			if (stopped || [ 0, 10000, 30000, 60000 ].indexOf(value) === -1)
				return false;
			interval = value;
			notify();
			schedule();
			return true;
		},
		visibilityChanged: function() {
			if (!started || stopped || suspended)
				return;
			clearTimer();
			if (!options.isHidden() && interval)
				refresh();
		},
		suspend: function() {
			suspended = true;
			clearTimer();
		},
		resume: function() {
			if (stopped || !suspended)
				return;
			suspended = false;
			if (interval)
				refresh();
		},
		stop: function() {
			stopped = true;
			clearTimer();
		},
		state: state
	};
}

function bindRefreshLifecycle(root, controller, doc, page, Observer) {
	var mounted = false, disposed = false;
	var observer = new Observer(checkAttachment);

	function dispose() {
		if (disposed)
			return;
		disposed = true;
		observer.disconnect();
		doc.removeEventListener('visibilitychange', onVisibility);
		page.removeEventListener('pagehide', onPageHide);
		page.removeEventListener('pageshow', onPageShow);
		controller.stop();
	}

	function checkAttachment() {
		if (disposed)
			return;
		if (root.isConnected) {
			if (!mounted) {
				mounted = true;
				controller.start();
			}
		}
		else if (mounted)
			dispose();
	}

	function onVisibility() {
		checkAttachment();
		if (mounted && !disposed)
			controller.visibilityChanged();
	}

	function onPageHide(event) {
		if (event.persisted)
			controller.suspend();
		else
			dispose();
	}

	function onPageShow(event) {
		checkAttachment();
		if (event.persisted && mounted && !disposed)
			controller.resume();
	}

	// LuCI attaches the returned root only after render() has completed.
	observer.observe(doc.documentElement, { childList: true, subtree: true });
	doc.addEventListener('visibilitychange', onVisibility);
	page.addEventListener('pagehide', onPageHide);
	page.addEventListener('pageshow', onPageShow);
	checkAttachment();
	return dispose;
}

return view.extend({
	load: function() {
		return Promise.resolve().then(callStatus).then(function(value) {
			return { status: requireStatus(value), completedAt: Date.now() };
		}).catch(function(error) {
			return { error: errorText(error) };
		});
	},

	render: function(initial) {
		var content = E('div');
		var message = E('div', { 'role': 'status', 'aria-live': 'polite',
			'style': 'margin:10px 0' });
		var updated = E('span', { 'style': 'opacity:.8' });
		var refreshButton = E('button', { 'class': 'btn cbi-button-action',
			'type': 'button', 'click': function() { return controller.refresh(); } }, [ _('Обновить') ]);
		var autoSelect = E('select', { 'style': 'width:auto', 'aria-label': _('Автообновление'),
			'change': function(event) { controller.setInterval(Number(event.target.value)); } }, [
			E('option', { 'value': '0' }, [ _('Выключено') ]),
			E('option', { 'value': '10000' }, [ _('Каждые 10 секунд') ]),
			E('option', { 'value': '30000', 'selected': 'selected' }, [ _('Каждые 30 секунд') ]),
			E('option', { 'value': '60000' }, [ _('Каждые 60 секунд') ])
		]);
		var root = E('div', { 'class': 'vtmodem-status' }, [
			E('h2', {}, [ _('VT Modem — Статус') ]),
			E('div', { 'class': 'cbi-map-descr' }, [
				_('Модем, SIM-карта, радиосеть и подключение VT-STREET-M2.')
			]),
			E('div', { 'style': 'display:flex; flex-wrap:wrap; align-items:center; gap:10px; margin:16px 0' }, [
				E('label', {}, [ _('Автообновление'), ' ', autoSelect ]), refreshButton, updated
			]), message, content
		]);
		var renderedStatus;

		function showState(state) {
			refreshButton.disabled = state.busy;
			refreshButton.textContent = state.busy ? _('Обновление…') : _('Обновить');
			autoSelect.value = String(state.interval);
			updated.textContent = state.lastSuccess === null || state.lastSuccess === undefined
				? _('Успешных обновлений пока нет')
				: _('Последнее успешное обновление: ') + new Date(state.lastSuccess).toLocaleString();
			message.className = state.error ? 'alert-message warning' : '';
			message.textContent = state.error
				? _('Не удалось обновить данные. ') + (state.status
					? _('Показаны последние полученные значения. ') : '') + state.error : '';
			if (renderedStatus !== state.status) {
				while (content.firstChild)
					content.removeChild(content.firstChild);
				content.appendChild(state.status ? renderStatus(state.status)
					: E('p', {}, [ _('Данные модема пока не получены.') ]));
				renderedStatus = state.status;
			}
		}

		var controller = createRefreshController({
			initial: initial,
			query: callStatus,
			now: function() { return Date.now(); },
			setTimer: function(fn, delay) { return window.setTimeout(fn, delay); },
			clearTimer: function(id) { window.clearTimeout(id); },
			isHidden: function() { return document.hidden; },
			onState: showState
		});
		showState(controller.state());
		bindRefreshLifecycle(root, controller, document, window, MutationObserver);
		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
