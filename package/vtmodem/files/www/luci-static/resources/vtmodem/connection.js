'use strict';
'require baseclass';
'require rpc';
'require ui';

var getState = rpc.declare({ object: 'vtmodem', method: 'connection_status', expect: {}, reject: true, nobatch: true });
var change = rpc.declare({ object: 'vtmodem', method: 'connection_action',
	params: [ 'action', 'expected', 'request_id', 'confirm' ], expect: {}, reject: true, nobatch: true });
function requestId() {
	var bytes = new Uint8Array(16);
	if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(bytes);
	else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	return Array.from(bytes, function(b) { return b.toString(16).padStart(2, '0'); }).join('');
}
function validState(s) {
	return s && s.ok === true && s.supported === true && s.interface === 'modem' &&
		[ 'up', 'pending', 'available', 'autostart' ].every(function(k) { return typeof s[k] === 'boolean'; }) &&
		typeof s.token === 'string' && s.token.length > 0 && s.token.length <= 4096 &&
		typeof s.session_key === 'string';
}
function create() {
	var writable = L.hasViewPermission() === true, supported = false, busy = false, stopped = false;
	var timer = null, suspended = false, modalOpen = false, requestPending = false;
	var buttons = [], caption = E('p', { 'role': 'status', 'aria-live': 'polite' });
	var refresh = E('button', { 'class': 'btn', 'type': 'button', 'click': read }, [ _('Проверить соединение') ]);
	function message(kind, text) { caption.className = 'alert-message ' + kind; caption.textContent = text; }
	function sync() {
		buttons.forEach(function(b) { b.disabled = stopped || busy || !writable || !supported; });
		refresh.disabled = stopped || busy;
	}
	function summary(s) {
		if (s.up) return _('Сессия передачи данных поднята. Доступность сайтов отдельно не проверялась.');
		if (s.pending) return _('Устанавливается соединение с оператором…');
		return s.autostart ? _('Сессия не поднята. Ожидание модема или сети оператора.') : _('Мобильное соединение отключено.');
	}
	function stopTimer() { if (timer !== null) window.clearTimeout(timer); timer = null; }
	function read() {
		if (stopped || busy) return Promise.resolve();
		busy = true; requestPending = true; sync();
		return getState().then(function(s) {
			if (stopped) return;
			if (!validState(s)) throw new Error(s && s.error || _('Состояние соединения не прочитано.'));
			supported = true; message(s.up ? 'success' : 'warning', summary(s));
		}).catch(function(e) { if (!stopped) message('warning', String(e.message || e)); })
		.finally(function() { requestPending = false; busy = false; sync(); });
	}
	function observe(action, before, initial) {
		var remaining = 30, sawDown = !before.up, deadline = Date.now() + 90000;
		function sample(s) {
			if (stopped || suspended) { busy = false; sync(); return; }
			if (!validState(s)) throw new Error(s && s.error || _('Не удалось проверить состояние соединения.'));
			if (!s.up) sawDown = true;
			var done = action === 'disconnect' ? !s.up && !s.pending && !s.autostart :
				s.up && (action === 'connect' || sawDown || s.session_key !== before.session_key);
			if (done) {
				message('success', action === 'disconnect' ? _('Мобильное соединение отключено. LAN и SMS не отключались.') :
					_('Сессия передачи данных поднята. Проверьте открытие сайтов; ограничения оператора эта кнопка не снимает.'));
				busy = false; sync(); return;
			}
			if (--remaining <= 0 || Date.now() >= deadline) {
				message('warning', _('Команда отправлена, но ожидаемое состояние пока не подтверждено. Нажмите «Проверить соединение». Автоматического повтора нет.'));
				busy = false; sync(); return;
			}
			message('warning', _('Ожидание изменения сессии… Роутер и USB-модем не перезагружаются.'));
			timer = window.setTimeout(function() {
				timer = null;
				requestPending = true;
				getState().then(function(s) { requestPending = false; sample(s); }).catch(failed);
			}, 2000);
		}
		function failed(e) {
			requestPending = false;
			if (!stopped) message('warning', _('Не удалось подтвердить результат. Переподключение автоматически не повторяется. ') + String(e.message || e));
			busy = false; sync();
		}
		try { sample(initial); } catch (e) { failed(e); }
	}
	function start(action) {
		if (stopped || busy || !writable || !supported) return Promise.resolve();
		busy = true; requestPending = true; stopTimer(); sync();
		return getState().then(function(before) {
			requestPending = false;
			if (stopped || suspended) { busy = false; sync(); return; }
			if (!validState(before)) throw new Error(before && before.error || _('Сначала прочитайте состояние соединения.'));
			var submitted = false, id = requestId();
			var cancel = E('button', { 'class': 'btn', 'type': 'button', 'click': function() {
				if (submitted) return;
				submitted = true;
				ui.hideModal(); modalOpen = false; busy = false; sync();
			} }, [ _('Отмена') ]);
			var confirm = E('button', { 'class': 'btn cbi-button-action', 'type': 'button', 'click': function() {
				if (submitted || stopped) return Promise.resolve();
				submitted = true; cancel.disabled = true; confirm.disabled = true;
				ui.hideModal(); modalOpen = false;
				message('warning', _('Команда отправляется. Не повторяйте нажатие.'));
				requestPending = true;
				return change(action, before.token, id, true).then(function(r) {
					requestPending = false;
					if (stopped) return;
					if (!r || r.ok !== true) throw new Error(r && r.error || _('Ответ на команду не получен.'));
					if (r.changed === false) {
						message('success', _('Соединение уже в выбранном состоянии. ') + (validState(r.state) ? summary(r.state) : ''));
						busy = false; sync(); return;
					}
					observe(action, before, r.state);
				}).catch(function(e) {
					requestPending = false;
					if (!stopped) message('warning', String(e.message || e) + ' ' + _('Нажмите «Проверить соединение». Повторная команда автоматически не отправлялась.'));
					busy = false; sync();
				});
			} }, [ _('Подтвердить') ]);
			var titles = { connect: _('Включить мобильный интернет?'), disconnect: _('Отключить мобильный интернет?'), reconnect: _('Переподключить мобильный интернет?') };
			modalOpen = true;
			ui.showModal(titles[action], [
				E('p', {}, [ action === 'connect' ? _('Будет запущено подключение modem.') :
					_('Мобильный интернет прервётся. При удалённом доступе через этот канал связь с роутером также пропадёт.') ]),
				E('p', {}, [ _('Меняется только сессия modem. LAN, SMS, частоты, фиксация соты и питание USB не изменяются.') ]),
				E('p', {}, [ _('Отключение действует до ручного включения или перезагрузки роутера; настройка автозапуска не перезаписывается.') ]),
				E('div', { 'class': 'right' }, [ cancel, confirm ])
			]);
		}).catch(function(e) { requestPending = false; if (!stopped) message('warning', String(e.message || e)); busy = false; sync(); });
	}
	[ [ 'connect', _('Включить интернет') ], [ 'disconnect', _('Отключить интернет') ],
		[ 'reconnect', _('Переподключить') ] ].forEach(function(item) {
		buttons.push(E('button', { 'class': 'btn cbi-button-action', 'type': 'button',
			'click': function() { return start(item[0]); } }, [ item[1] ]));
	});
	var node = E('div', { 'class': 'cbi-section' }, [ E('h3', {}, [ _('Мобильное соединение') ]),
		E('div', { 'style': 'display:flex;flex-wrap:wrap;gap:8px' }, buttons.concat([ refresh ])), caption,
		E('p', { 'style': 'opacity:.75' }, [ writable ?
			_('«Переподключить» завершает текущую сессию и запускает новую, без перезагрузки роутера. Это не проверка доступности интернета.') :
			_('Управление соединением доступно только пользователю с правами записи.') ]) ]);
	sync();
	return { node: node,
		update: function(data) { supported = !!data && data.type === 't99w175'; sync(); },
		stop: function() { stopped = true; stopTimer(); if (modalOpen) ui.hideModal(); modalOpen = false; sync(); },
		suspend: function() { suspended = true; stopTimer(); if (!modalOpen && !requestPending) busy = false; sync(); },
		resume: function() { suspended = false; sync(); }
	};
}
return baseclass.extend({ create: create });
