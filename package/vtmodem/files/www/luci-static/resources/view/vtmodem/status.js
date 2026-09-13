'use strict';
'require view';
'require rpc';

var callStatus = rpc.declare({
	object: 'vtmodem',
	method: 'status',
	expect: {},
	reject: true
});

var callTraffic = rpc.declare({
	object: 'vtmodem', method: 'traffic_status', expect: {}, reject: true
});

var callConfirmTime = rpc.declare({
	object: 'vtmodem', method: 'traffic_confirm_time', params: [ 'timestamp' ], expect: {}, reject: true
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
		row(_('Версия VT Modem'), record(s.build).vtmodem_version),
		row(_('Исходники сборки'), record(s.build).source_commit, true),
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
			if (stopped || [ 0, 5000, 10000, 30000, 60000 ].indexOf(value) === -1)
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

// Counter arithmetic uses decimal strings so 64-bit counters are not rounded
// before subtraction. Number conversion is limited to the small interval delta.
function byteString(value) {
	if (typeof value !== 'string' || !/^[0-9]{1,20}$/.test(value))
		return null;
	value = value.replace(/^0+(?=\d)/, '');
	return value.length === 20 && value > '18446744073709551615' ? null : value;
}

function subtractBytes(after, before) {
	after = byteString(after); before = byteString(before);
	if (after === null || before === null || after.length < before.length ||
		(after.length === before.length && after < before))
		return null;
	var out = '', borrow = 0;
	for (var i = after.length - 1, j = before.length - 1; i >= 0; i--, j--) {
		var digit = Number(after[i]) - (j >= 0 ? Number(before[j]) : 0) - borrow;
		borrow = digit < 0 ? 1 : 0;
		out = String(digit + borrow * 10) + out;
	}
	return out.replace(/^0+(?=\d)/, '');
}

function gigabytes(value) {
	var digits = typeof value === 'string' && /^[0-9]{1,24}$/.test(value) ? value.replace(/^0+(?=\d)/, '') : null;
	if (digits === null)
		return '-';
	while (digits.length < 10) digits = '0' + digits;
	return digits.slice(0, -9) + '.' + digits.slice(-9, -6) + ' ' + _('ГБ');
}

function trafficRate(previous, current) {
	previous = record(previous); current = record(current);
	var a = record(previous.live), b = record(current.live);
	var elapsed = b.monotonic_ms - a.monotonic_ms;
	if (!previous.interface || previous.interface !== current.interface || !a.boot_id ||
		a.boot_id !== b.boot_id || a.ifindex !== b.ifindex || !Number.isFinite(elapsed) ||
		elapsed <= 0 || elapsed > 30000)
		return null;
	var rx = subtractBytes(b.rx_bytes, a.rx_bytes), tx = subtractBytes(b.tx_bytes, a.tx_bytes);
	if (rx === null || tx === null || Number(rx) > Number.MAX_SAFE_INTEGER || Number(tx) > Number.MAX_SAFE_INTEGER)
		return null;
	return { rx_mbps: Number(rx) * 8 / elapsed / 1000, tx_mbps: Number(tx) * 8 / elapsed / 1000 };
}

function renderTraffic(data, rate, confirmTime) {
	data = record(data);
	var labels = [ _('Период'), _('Принято'), _('Передано'), _('Всего') ];
	var period = record(data.period);
	var periods = [ [ _('Сегодня') + (period.day ? ' · ' + period.day : ''), data.today ], [ _('Этот месяц') + (period.month ? ' · ' + period.month : ''), data.month ],
		[ _('За весь период учёта'), data.total ] ];
	var rows = periods.map(function(period) {
		var counters = record(period[1]);
		return E('tr', { 'class': 'tr' }, [ period[0], gigabytes(counters.rx_bytes),
			gigabytes(counters.tx_bytes), gigabytes(counters.total_bytes) ].map(function(value, index) {
			return E('td', { 'class': 'td', 'data-title': labels[index] }, [ value ]);
		}));
	});
	return E('div', {}, [
		grid([ card(_('Скорость приёма'), measurement(rate && rate.rx_mbps, _('Мбит/с'))),
			card(_('Скорость передачи'), measurement(rate && rate.tx_mbps, _('Мбит/с'))),
			card(_('Принято интерфейсом'), gigabytes(record(data.live).rx_bytes), _('С момента создания интерфейса')),
			card(_('Передано интерфейсом'), gigabytes(record(data.live).tx_bytes), _('С момента создания интерфейса')) ]),
		E('table', { 'class': 'table' }, [ E('tr', { 'class': 'tr table-titles' },
			labels.map(function(label) { return E('th', { 'class': 'th', 'scope': 'col' }, [ label ]); })) ].concat(rows)),
		E('p', { 'style': 'opacity:.75' }, [ _('Интерфейс: '), text(data.interface), '. ',
			_('1 ГБ = 1 000 000 000 байт. Даты — по времени роутера. История обновляется после сохранения счётчиков, до 10 минут; текущая скорость — каждые 5 секунд. Учёт оператора может отличаться.') ]),
		data.accounting_since ? E('p', {}, [ _('Начало учёта: '), new Date(data.accounting_since * 1000).toLocaleString() ]) : '',
		data.updated_at ? E('p', {}, [ _('Последнее сохранение статистики: '), new Date(data.updated_at * 1000).toLocaleString() ]) : '',
		data.clock_synced === false ? E('div', { 'class': 'alert-message warning' }, [
			E('p', {}, [ _('История начнёт записываться после синхронизации или подтверждения времени. Трафик до этого момента в историю не попадёт. Текущие счётчики интерфейса доступны выше.') ]),
			E('p', {}, [ _('Время роутера: '), Number.isFinite(data.router_time) ? new Date(data.router_time * 1000).toLocaleString() : '-', '. ',
				_('Проверьте дату и время. Если они неверны, исправьте их в '),
				E('a', { 'href': '/cgi-bin/luci/admin/system/system' }, [ _('настройках системы') ]), '.' ]),
			confirmTime ? E('button', { 'class': 'btn', 'type': 'button', 'click': confirmTime }, [ _('Время верное — начать учёт') ]) : ''
		]) : '',
		data.stale ? E('p', { 'class': 'alert-message warning' }, [ _('История трафика давно не обновлялась. Показаны последние сохранённые значения.') ]) : '',
		data.ok === false ? E('p', { 'class': 'alert-message warning' }, [
			_('История трафика пока недоступна.') ]) : ''
	]);
}

function sourceInfo(status, name) {
	return record(record(record(status).telemetry).sources)[name] || {};
}

function telemetryMessage(status) {
	var telemetry = record(record(status).telemetry);
	if (!Object.keys(telemetry).length)
		return '';
	if (telemetry.busy === 'sms')
		return _('Выполняется операция SMS. Измерения сигнала временно приостановлены.');
	var sources = record(telemetry.sources);
	if (telemetry.stale || telemetry.error || Object.keys(sources).some(function(name) { return sources[name].stale || sources[name].error; }))
		return _('Часть измерений устарела или недоступна. Показаны последние полученные значения.');
	var signal = sourceInfo(status, 'qmi_signal');
	return typeof signal.age_seconds === 'number'
		? _('Возраст измерения сигнала: ') + Math.max(0, Math.floor(signal.age_seconds)) + ' ' + _('с') : '';
}

function alignmentSample(status, elapsedSeconds) {
	elapsedSeconds = elapsedSeconds === undefined ? 0 : Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : Infinity;
	function fresh(source) {
		return !source.stale && !source.error && Number.isFinite(source.monotonic_ms) &&
			Number.isFinite(source.age_seconds) && source.age_seconds + elapsedSeconds <= 15;
	}
	status = record(status);
	if (status.type !== 't99w175' || !status.present) return null;
	var cell = record(status.t99_radio);
	var main = (Array.isArray(cell.cells) ? cell.cells : []).filter(function(item) { return item.role === 'primary'; })[0] || {};
	var source = sourceInfo(status, 't99_radio');
	var signal = { rsrp_dbm: main.rsrp_dbm, rsrq_db: main.rsrq_db, snr_db: main.snr_db };
	var identity = [ cell.cell_id, main.band, main.earfcn, main.pci ];
	// Prefer one DEBUG response for both serving-cell identity and measurements;
	// a cached RF-band response must not label a newer QMI sample from another cell.
	var coherent = fresh(source) &&
		[ signal.rsrp_dbm, signal.rsrq_db, signal.snr_db ].every(Number.isFinite);
	if (!coherent) {
		source = sourceInfo(status, 'qmi_signal');
		signal = record(status.qmi_signal);
		identity = [];
	}
	if (!fresh(source) || source.monotonic_ms < 0 ||
		![ signal.rsrp_dbm, signal.rsrq_db, signal.snr_db ].every(Number.isFinite)) return null;
	var cellKey = identity.length && identity.every(Number.isFinite) ? identity.join('/') : null;
	return { stamp: source.monotonic_ms, at: Number(source.updated_at) * 1000,
		rsrp: signal.rsrp_dbm, rsrq: signal.rsrq_db, snr: signal.snr_db,
		cell: cellKey, label: cellKey ? bandName(main.band) + ' · EARFCN ' + main.earfcn +
			' · PCI ' + main.pci + ' · ' + _('Сота ') + cell.cell_id : _('Сота уточняется') };
}

function pushAlignment(samples, sample) {
	if (!sample || (samples.length && sample.stamp === samples[samples.length - 1].stamp))
		return false;
	if (samples.length && sample.stamp < samples[samples.length - 1].stamp)
		samples.splice(0); // Collector/boot monotonic epoch changed.
	samples.push(sample);
	while (samples.length > 120 || (samples.length && sample.stamp - samples[0].stamp > 600000))
		samples.shift();
	return true;
}

function alignmentSnapshot(samples, label) {
	var last = samples[samples.length - 1];
	if (!last || !last.cell)
		return null;
	var windowSamples = [];
	for (var i = samples.length - 1; i >= 0 && windowSamples.length < 6; i--) {
		if (samples[i].cell !== last.cell || last.stamp - samples[i].stamp > 30000 ||
			(i < samples.length - 1 && samples[i + 1].stamp - samples[i].stamp > 12000))
			break;
		windowSamples.unshift(samples[i]);
	}
	if (windowSamples.length < 2)
		return null;
	function median(key) {
		var values = windowSamples.map(function(item) { return item[key]; }).sort(function(a, b) { return a - b; });
		var mid = Math.floor(values.length / 2);
		return values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
	}
	return { label: String(label || '').trim().slice(0, 60) || _('Замер'), cell: last.cell,
		cell_label: last.label, at: last.at, count: windowSamples.length,
		rsrp: median('rsrp'), rsrq: median('rsrq'), snr: median('snr') };
}

function readSnapshots(storage) {
	try {
		var text = storage.getItem('vtmodem.antenna.samples.v1');
		if (!text || text.length > 12000) return [];
		var data = JSON.parse(text);
		return Array.isArray(data) ? data.slice(-6).filter(function(item) {
			return item && typeof item.label === 'string' && item.label.length <= 60 &&
				typeof item.cell === 'string' && item.cell.length < 100 &&
				typeof item.cell_label === 'string' && item.cell_label.length < 180 &&
				[ item.rsrp, item.rsrq, item.snr, item.at, item.count ].every(Number.isFinite);
		}) : [];
	}
	catch (error) { return []; }
}

function signalGraph(samples, key, title, unit) {
	if (samples.length < 2)
		return E('div', {}, [ E('strong', {}, [ title ]), E('p', {}, [ _('Ожидание новых измерений…') ]) ]);
	var values = samples.map(function(item) { return item[key]; });
	var low = Math.floor(Math.min.apply(null, values) - 1), high = Math.ceil(Math.max.apply(null, values) + 1);
	var begin = samples[0].stamp, span = Math.max(1, samples[samples.length - 1].stamp - begin);
	function node(tag, attrs, value) {
		var element = document.createElementNS('http://www.w3.org/2000/svg', tag);
		Object.keys(attrs || {}).forEach(function(name) { element.setAttribute(name, attrs[name]); });
		if (value !== undefined) element.textContent = value;
		return element;
	}
	var svg = node('svg', { viewBox: '0 0 360 130', role: 'img', 'aria-label': title + ' (' + unit + ')',
		style: 'display:block;width:100%;height:auto;color:inherit' });
	[ low, (low + high) / 2, high ].forEach(function(value) {
		var y = 100 - (value - low) / (high - low) * 85;
		svg.appendChild(node('line', { x1: 38, y1: y, x2: 352, y2: y, stroke: 'currentColor', 'stroke-opacity': '.15' }));
		svg.appendChild(node('text', { x: 34, y: y + 4, 'text-anchor': 'end', fill: 'currentColor', 'font-size': 10 },
			String(Number(value.toFixed(1)))));
	});
	var segments = [], segment = [];
	samples.forEach(function(sample, index) {
		if (index && (sample.cell !== samples[index - 1].cell || sample.stamp - samples[index - 1].stamp > 12000)) {
			segments.push(segment); segment = [];
		}
		segment.push((38 + (sample.stamp - begin) / span * 314).toFixed(1) + ',' +
			(100 - (sample[key] - low) / (high - low) * 85).toFixed(1));
	});
	segments.push(segment);
	segments.forEach(function(points) {
		svg.appendChild(node('polyline', { points: points.join(' '), fill: 'none', stroke: '#35b8d3',
			'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
	});
	svg.appendChild(node('text', { x: 38, y: 123, fill: 'currentColor', 'font-size': 10 }, '-' + Math.round(span / 1000) + ' ' + _('с')));
	svg.appendChild(node('text', { x: 352, y: 123, fill: 'currentColor', 'font-size': 10, 'text-anchor': 'end' }, _('Сейчас')));
	return E('div', {}, [ E('strong', {}, [ title + ' · ' + unit ]), svg ]);
}

function renderSnapshots(snapshots) {
	var labels = [ _('Замер'), _('Сота'), 'RSRP', 'RSRQ', 'SNR' ];
	return E('table', { 'class': 'table' }, [ E('tr', { 'class': 'tr table-titles' }, labels.map(function(label) {
		return E('th', { 'class': 'th', 'scope': 'col' }, [ label ]);
	})) ].concat(snapshots.map(function(sample) {
		return E('tr', { 'class': 'tr' }, [ sample.label + ' (' + sample.count + ')', sample.cell_label,
			measurement(sample.rsrp, 'dBm'), measurement(sample.rsrq, 'dB'), measurement(sample.snr, 'dB')
		].map(function(value, index) { return E('td', { 'class': 'td', 'data-title': labels[index] }, [ value ]); }));
	})));
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
		var telemetryNotice = E('p', { 'role': 'status', 'style': 'opacity:.8' });
		var trafficContent = E('div', {}, [ _('Статистика загружается…') ]);
		var trafficNotice = E('p', { 'role': 'status' });
		var lastTraffic = null, renderedTraffic = null;
		var samples = [], snapshots = [], alignmentEnabled = false, normalInterval = 30000;
		try { snapshots = readSnapshots(window.localStorage); } catch (error) { /* Storage is optional. */ }
		var alignmentContent = E('div');
		var snapshotContent = E('div', {}, [ renderSnapshots(snapshots) ]);
		var alignmentNotice = E('p', { 'role': 'status' });
		var snapshotName = E('input', { 'type': 'text', 'maxlength': '60', 'placeholder': _('Название положения антенны'),
			'aria-label': _('Название замера'), 'style': 'max-width:360px;width:100%' });
		var saveSample = E('button', { 'type': 'button', 'class': 'btn', 'click': function() {
			var saved = alignmentSnapshot(samples, snapshotName.value);
			if (!alignmentEnabled || !saved || !currentAlignment(controller.state()) || controller.state().error)
				return;
			snapshots.push(saved); snapshots = snapshots.slice(-6);
			replaceContent(snapshotContent, renderSnapshots(snapshots));
			try {
				window.localStorage.setItem('vtmodem.antenna.samples.v1', JSON.stringify(snapshots));
				alignmentNotice.textContent = _('Замер сохранён в этом браузере.');
			}
			catch (error) { alignmentNotice.textContent = _('Замер сохранён до закрытия страницы.'); }
		} }, [ _('Сохранить замер') ]);
		var alignButton = E('button', { 'type': 'button', 'class': 'btn cbi-button-action', 'click': function() {
			alignmentEnabled = !alignmentEnabled;
			if (alignmentEnabled) {
				normalInterval = controller.state().interval;
				samples = [];
				setPeriod(5000);
				controller.refresh();
			}
			else setPeriod(normalInterval);
			alignButton.textContent = alignmentEnabled ? _('Завершить наведение') : _('Начать наведение');
			autoSelect.disabled = alignmentEnabled;
			showAlignment(controller.state());
		} }, [ _('Начать наведение') ]);
		function replaceContent(node, child) {
			while (node.firstChild) node.removeChild(node.firstChild);
			node.appendChild(child);
		}
		function confirmTime(event) {
			var button = event.currentTarget;
			button.disabled = true;
			return callConfirmTime(Math.floor(Date.now() / 1000)).then(function(result) {
				if (!result || result.ok !== true) throw new Error(_('Время роутера отличается от времени браузера. Проверьте часы в настройках системы.'));
				return trafficController.refresh();
			}).catch(function(error) {
				trafficNotice.className = 'alert-message warning';
				trafficNotice.textContent = errorText(error);
			}).then(function() { button.disabled = false; });
		}
		function currentAlignment(state) {
			return alignmentSample(state.status, typeof state.lastSuccess === 'number' ? (Date.now() - state.lastSuccess) / 1000 : Infinity);
		}
		function setPeriod(value) {
			controller.setInterval(value);
			trafficController.setInterval(value === 0 ? 0 : 5000);
			if (!value && lastTraffic) { replaceContent(trafficContent, renderTraffic(lastTraffic, null, confirmTime)); lastTraffic = null; }
		}
		function showAlignment(state) {
			var sample = currentAlignment(state);
			if (alignmentEnabled && !state.error) pushAlignment(samples, sample);
			saveSample.disabled = !alignmentEnabled || !!state.error || !sample || !alignmentSnapshot(samples, '');
			if (!alignmentEnabled) {
				replaceContent(alignmentContent, E('p', {}, [ _('Во время наведения измерения отображаются каждые 5 секунд. Графики и замеры помогают сравнить положения антенны.') ]));
				return;
			}
			replaceContent(alignmentContent, E('div', {}, [
				E('p', {}, [ sample ? sample.label : _('Ожидание свежих измерений сигнала…') ]),
				grid([ card('RSRP', measurement(sample && sample.rsrp, 'dBm')), card('RSRQ', measurement(sample && sample.rsrq, 'dB')),
					card('SNR', measurement(sample && sample.snr, 'dB')) ]),
				grid([ signalGraph(samples, 'rsrp', 'RSRP', 'dBm'), signalGraph(samples, 'rsrq', 'RSRQ', 'dB'),
					signalGraph(samples, 'snr', 'SNR', 'dB') ])
			]));
		}
		var message = E('div', { 'role': 'status', 'aria-live': 'polite',
			'style': 'margin:10px 0' });
		var updated = E('span', { 'style': 'opacity:.8' });
		var refreshButton = E('button', { 'class': 'btn cbi-button-action',
			'type': 'button', 'click': function() {
				return Promise.all([ controller.refresh(), trafficController.refresh() ]).then(function(results) { return results[0]; });
			} }, [ _('Обновить') ]);
		var autoSelect = E('select', { 'style': 'width:auto', 'aria-label': _('Автообновление'),
			'change': function(event) { setPeriod(Number(event.target.value)); } }, [
			E('option', { 'value': '0' }, [ _('Выключено') ]),
			E('option', { 'value': '5000' }, [ _('Каждые 5 секунд') ]),
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
			]), message, telemetryNotice, content,
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('Трафик модема') ]), trafficNotice, trafficContent ]),
			E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('Наведение антенны') ]), alignButton, alignmentContent,
				E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:10px;align-items:center' }, [ snapshotName, saveSample ]),
				alignmentNotice, snapshotContent,
				E('p', { 'style': 'opacity:.75' }, [ _('Замер — медиана до 6 последних измерений одной соты. При смене соты или паузе линия графика прерывается. Сохранённые замеры остаются в этом браузере.') ])
			])
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
			telemetryNotice.textContent = telemetryMessage(state.status);
			showAlignment(state);
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
		var trafficController = createRefreshController({
			query: function() {
				return callTraffic().then(function(value) {
					if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean')
						throw new Error(_('Получен некорректный ответ счётчика трафика.'));
					return { present: true, traffic: value };
				});
			},
			now: function() { return Date.now(); },
			setTimer: function(fn, delay) { return window.setTimeout(fn, delay); },
			clearTimer: function(id) { window.clearTimeout(id); },
			isHidden: function() { return document.hidden; },
			onState: function(state) {
				trafficNotice.className = state.error ? 'alert-message warning' : '';
				trafficNotice.textContent = state.error ? _('Не удалось обновить счётчик. Показаны предыдущие значения; текущая скорость недоступна.') : '';
				if (state.error && lastTraffic) {
					replaceContent(trafficContent, renderTraffic(lastTraffic, null, confirmTime));
					lastTraffic = null;
				}
				if (state.status && state.status !== renderedTraffic) {
					var data = state.status.traffic;
					replaceContent(trafficContent, renderTraffic(data, trafficRate(lastTraffic, data), confirmTime));
					lastTraffic = data; renderedTraffic = state.status;
				}
			}
		});
		trafficController.setInterval(5000);
		showState(controller.state());
		// One page lifecycle suspends both independent request streams.
		var combined = {};
		[ 'start', 'stop', 'suspend', 'resume', 'visibilityChanged' ].forEach(function(method) {
			combined[method] = function() { controller[method](); trafficController[method](); };
		});
		bindRefreshLifecycle(root, combined, document, window, MutationObserver);
		return root;
	},

	handleSaveApply: null,
	handleSave: null,
	handleReset: null
});
