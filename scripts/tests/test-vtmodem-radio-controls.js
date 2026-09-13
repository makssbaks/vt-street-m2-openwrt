#!/usr/bin/env node
'use strict';

// Fixture-only checks: these tests never connect to a router or modem.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
	'../../package/vtmodem/files/www/luci-static/resources/view/vtmodem/radio.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
const supported = [1, 2, 3, 4, 5, 7, 8, 12, 13, 14, 17, 18, 19, 20, 25,
	26, 28, 29, 30, 32, 34, 38, 39, 40, 41, 42, 46, 48, 66, 71];
function fixture(overrides = {}) {
	return {
		ok: true, supported: true, mode: {persist: 1, mode: 2},
		mode_support: {persist: [0, 1], modes: [0, 1, 2, 3, 4, 5, 6, 7]},
		bands_supported: {WCDMA: [1, 2, 8], LTE: supported.slice(), NR5G: [1, 3, 78]},
		bands: {WCDMA: {enabled: [1, 2, 8], disabled: []},
			LTE: {enabled: supported.filter(n => n !== 71), disabled: [71]},
			NR5G: {enabled: [1, 3, 78], disabled: []}},
		priority: [], lock: [], errors: [],
		tokens: {mode: 'mode-snapshot', priority: 'priority-snapshot', lock: 'lock-snapshot', bands: 'bands-snapshot'},
		...overrides
	};
}

function E(tag, attrs = {}, children = []) {
	return {
		tag, attrs, children: Array.isArray(children) ? children : [children],
		value: attrs.value || '', disabled: !!attrs.disabled, checked: !!attrs.checked, listeners: {},
		appendChild(node) { this.children.push(node); },
		replaceChildren(...nodes) { this.children = nodes; },
		addEventListener(event, handler) { this.listeners[event] = handler; },
		fire(event) { if (this.listeners[event]) this.listeners[event](); }
	};
}
function nodes(root) {
	if (!root || typeof root !== 'object') return [];
	if (Array.isArray(root)) return root.flatMap(nodes);
	return [root, ...(root.children || []).flatMap(nodes)];
}
function content(root) {
	if (root == null) return '';
	if (Array.isArray(root)) return root.map(content).join(' ');
	if (typeof root !== 'object') return String(root);
	return (root.children || []).map(content).join(' ');
}
function button(root, label) {
	const found = nodes(root).find(node => node.tag === 'button' && content(node) === label);
	assert(found, 'Missing button ' + label);
	return found;
}
function fields(root, tag) { return nodes(root).filter(node => node.tag === tag); }
function harness(options = {}) {
	const calls = [];
	let modal = null;
	const context = {
		E, _: value => value, L: {hasViewPermission: () => options.writable !== undefined ? options.writable : true},
		view: {extend: value => value},
		ui: {showModal: (title, children) => { modal = {title, children}; }, hideModal: () => { modal = null; }},
		rpc: {getBaseURL: () => '/ubus', getSessionID: () => '0123456789abcdef0123456789abcdef',
			getStatusText: code => 'ubus status ' + code},
		request: {post: (url, message, config) => {
			calls.push({url, message: plain(message), config: plain(config)});
			if (options.transport) return options.transport(url, message, config);
			const method = message.params[2];
			const answer = options[method] ? options[method](message.params[3]) :
				method === 'radio_status' ? fixture() : {ok: true, verified: true, restart_required: false};
			if (answer instanceof Error) return Promise.reject(answer);
			return Promise.resolve(answer).then(value => ({ok: true, status: 200,
				json: () => ({jsonrpc: '2.0', id: message.id, result: [0, value]})}));
		}}
	};
	vm.createContext(context);
	const helpers = vm.runInContext('(function() {' + source.slice(0, source.indexOf('return view.extend(')) +
		'; return { normalizeStatus, validateAction, radioRPC }; })()', context);
	const page = vm.runInContext('(function() {' + source + '})()', context);
	return {page, calls, helpers, modal: () => modal};
}

(async () => {
	let h = harness();
	let s = h.helpers.normalizeStatus(fixture());
	let validate = (action, value, status = s) => h.helpers.validateAction(action, value, status);
	assert.deepEqual(plain(validate('mode', '1,2')), {action: 'mode', value: '1,2', expected: 'mode-snapshot'});
	assert.equal(validate('priority', ' 3, 1,7 ').value, '3,1,7');
	assert.equal(validate('bands', '7,1,3').value, '1,3,7', 'Allowed band order is canonical');
	assert.equal(validate('lock', '213,1275\n224,550').value, '213,1275,224,550');
	assert.equal(validate('lock', '0,0\n503,262143').value, '0,0,503,262143');
	assert.throws(() => validate('unlock', ''), /Нет прочитанной фиксации/);
	for (const [action, values] of Object.entries({
		mode: ['2,2', '1,8', '1,2;reboot', '1,2\n', '', 2],
		priority: ['', '3,,1', '3,3', '0', '256', '1.5', '3;reboot', '3\n1', '3,$(reboot)', supported.slice(0, 16).join(',')],
		bands: ['', '3,3', '0', '256', '1.5', '3,1;reboot', supported.join(',')],
		lock: ['', '213', '213,1275,224,550', '504,1275', '1,262144', '-1,0', '1,1.5',
			'1,2\n1,2', '1,2\n\n3,4', '1,2;reboot', '1,2\nAT^RESET', Array.from({length: 9}, (_, i) => i + ',1275').join('\n')]
	})) {
		for (const value of values)
			assert.throws(() => validate(action, value), undefined, action + ' must reject ' + value);
	}
	assert.throws(() => validate('__proto__', '1'), /Неизвестное действие|Нет проверенного/);
	assert.equal(validate('bands', supported.filter(n => n !== 71).join(',')).value.split(',').length, 29,
		'A large subset of currently enabled bands is allowed');
	assert.equal(validate('bands', '1,3,71').value, '1,3,71', 'A small enable list is allowed');
	let locked = h.helpers.normalizeStatus(fixture({lock: [{pci: 213, earfcn: 1275}]}));
	assert.throws(() => validate('bands', '1,3', locked), /снимите фиксацию/);
	assert.throws(() => validate('mode', '1,0', locked), /снимите фиксацию/);
	assert.equal(validate('mode', '1,2', locked).value, '1,2');
	assert.equal(validate('unlock', '', locked).expected, 'lock-snapshot');
	assert.throws(() => validate('unlock', '213,1275', locked));
	let unknownLock = h.helpers.normalizeStatus(fixture({lock: null}));
	assert.throws(() => validate('mode', '1,0', unknownLock));
	assert.throws(() => validate('bands', '1,3', unknownLock));

	for (const malformed of [null, {}, [], {ok: true, supported: true},
		fixture({mode: {persist: '1', mode: '2'}, lock: [{pci: 1, earfcn: null}], priority: ['1']})]) {
		const parsed = h.helpers.normalizeStatus(malformed);
		assert.equal(parsed.mode, null);
		assert.equal(parsed.lock, null);
		assert.equal(parsed.priority, null);
	}
	assert.equal(h.helpers.normalizeStatus(fixture({lock: [{pci: 1, earfcn: 2}, {pci: 1, earfcn: 2}]})).lock, null);
	assert.equal(h.helpers.normalizeStatus(fixture({priority: [1, 1]})).priority, null);
	assert.throws(() => validate('mode', '1,2', h.helpers.normalizeStatus(fixture({tokens: {}}))));

	let tree = h.page.render(fixture());
	assert.equal(h.calls.length, 0, 'Rendering never writes or reads automatically');
	assert.match(content(tree), /Сейчас: Только LTE/);
	assert.match(content(tree), /Сейчас: Не задан/);
	assert.equal(fields(tree, 'input').filter(node => node.attrs.type === 'checkbox' && node.checked).length, 29);
	assert.equal(button(tree, 'Снять фиксацию').disabled, true);
	assert.equal(button(tree, 'Сохранить диапазоны LTE').disabled, false);
	await h.page.load();
	assert.equal(h.calls[0].message.params[2], 'radio_status');
	assert.deepEqual(h.calls[0].message.params[3], {});
	assert.equal(h.calls[0].message.params[0], '0123456789abcdef0123456789abcdef');
	assert.equal(h.calls[0].url, '/ubus');
	assert.deepEqual(h.calls[0].config, {timeout: 90000, nobatch: true, credentials: true});

	// Opening or cancelling a modal never issues a write. All mutation controls
	// are disabled while it is open; LuCI's Escape path targets Cancel first.
	await button(tree, 'Изменить режим').attrs.click();
	assert(h.modal());
	assert.match(content(h.modal()), /Мобильный интернет может прерваться/);
	assert.equal(fields(h.modal(), 'button')[0], button(h.modal(), 'Отмена'));
	assert(fields(tree, 'button').every(node => node.disabled));
	assert.equal(h.calls.length, 1);
	await button(h.modal(), 'Отмена').attrs.click();
	assert.equal(h.modal(), null);
	assert.equal(button(tree, 'Изменить режим').disabled, false);
	assert.equal(h.calls.length, 1);

	let resolveApply;
	h = harness({radio_apply: () => new Promise(resolve => { resolveApply = resolve; })});
	tree = h.page.render(fixture());
	const mode = fields(tree, 'select')[0];
	mode.value = '6'; mode.fire('change');
	await button(tree, 'Изменить режим').attrs.click();
	const confirm = button(h.modal(), 'Подтвердить');
	const applying = confirm.attrs.click();
	await Promise.resolve();
	assert.equal(h.calls.length, 1);
	assert.deepEqual(h.calls[0].message.params.slice(1), ['vtmodem', 'radio_apply',
		{action: 'mode', value: '1,6', expected: 'mode-snapshot', confirm: true}]);
	await confirm.attrs.click();
	await button(tree, 'Изменить режим').attrs.click();
	assert.equal(h.calls.length, 1, 'Repeated clicks cannot duplicate an in-flight write');
	resolveApply({ok: true, verified: true, restart_required: true});
	await applying;
	assert.match(content(tree), /сохранена и проверена повторным чтением/);
	assert.match(content(tree), /требуется перезагрузка модема/);
	assert.equal(button(tree, 'Изменить режим').disabled, true, 'The snapshot is stale after a write');
	assert.equal(button(tree, 'Прочитать настройки').disabled, false);
	assert.equal(h.calls.length, 1, 'No automatic read, retry, or reboot');
	await button(tree, 'Прочитать настройки').attrs.click();
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[1].message.params[2], 'radio_status');
	assert.equal(button(tree, 'Изменить режим').disabled, false);

	h = harness({radio_apply: () => ({ok: true, verified: true, changed: false})});
	tree = h.page.render(fixture());
	await button(tree, 'Изменить режим').attrs.click();
	await button(h.modal(), 'Подтвердить').attrs.click();
	assert.match(content(tree), /изменение не потребовалось/);
	assert(!content(tree).includes('сохранена и проверена'), 'A no-op must not claim a new write');

	// Keep failed drafts and do not confuse a transport timeout with no change.
	for (const response of [new Error('Timeout'), {ok: false, error: '<img src=x onerror=alert(1)>', changed: null},
		{ok: true, verified: false}, {ok: true}]) {
		h = harness({radio_apply: () => response});
		tree = h.page.render(fixture());
		let input = fields(tree, 'input').find(node => node.attrs.type === 'text');
		input.value = '3,1'; input.fire('input');
		await button(tree, 'Сохранить приоритет').attrs.click();
		assert.match(content(h.modal()), /основной несущей/);
		await button(h.modal(), 'Подтвердить').attrs.click();
		assert.equal(h.calls.length, 1);
		assert.match(content(tree), /настройки могли измениться|Настройки могли измениться/);
		assert.equal(input.value, '3,1');
		assert.equal(button(tree, 'Сохранить приоритет').disabled, true);
		assert.equal(nodes(tree).some(node => node.tag === 'img'), false, 'Errors are text, not HTML');
		await button(tree, 'Прочитать настройки').attrs.click();
		assert.match(content(h.modal()), /Несохранённые правки/);
		await button(h.modal(), 'Отмена').attrs.click();
		assert.equal(input.value, '3,1');
		assert.equal(h.calls.length, 1);
	}

	h = harness(); tree = h.page.render(fixture());
	let checks = fields(tree, 'input').filter(node => node.attrs.type === 'checkbox');
	checks.forEach(node => { node.checked = ['1', '3'].includes(node.value); });
	await button(tree, 'Сохранить диапазоны LTE').attrs.click();
	assert.match(content(h.modal()), /Разрешить LTE: B1, B3/);
	assert.match(content(h.modal()), /Будут отключены: B2, B4/);
	await button(h.modal(), 'Подтвердить').attrs.click();
	assert.deepEqual(h.calls[0].message.params[3], {action: 'bands', value: '1,3', expected: 'bands-snapshot', confirm: true});
	h = harness(); tree = h.page.render(fixture());
	checks = fields(tree, 'input').filter(node => node.attrs.type === 'checkbox');
	checks.forEach(node => { node.checked = true; });
	await button(tree, 'Сохранить диапазоны LTE').attrs.click();
	assert.equal(h.modal(), null);
	assert.equal(h.calls.length, 0);
	assert.match(content(tree), /Сначала выберите меньший набор/);

	for (const writable of [false, null]) {
		h = harness({writable}); tree = h.page.render(fixture());
		assert.match(content(tree), /только для чтения/);
		assert(fields(tree, 'button').filter(node => content(node) !== 'Прочитать настройки').every(node => node.disabled));
		await button(tree, 'Изменить режим').attrs.click();
		assert.equal(h.modal(), null);
		await button(tree, 'Прочитать настройки').attrs.click();
		assert.deepEqual(h.calls.map(call => call.message.params[2]), ['radio_status']);
	}
	h = harness(); tree = h.page.render(fixture({priority: null, errors: [{error: 'Priority read timed out'}]}));
	assert.match(content(tree), /Priority read timed out/);
	assert.equal(button(tree, 'Сохранить приоритет').disabled, true);
	assert.equal(button(tree, 'Изменить режим').disabled, false);
	assert.equal(button(tree, 'Сохранить фиксацию').disabled, false);
	tree = h.page.render(fixture({lock: null}));
	assert.equal(button(tree, 'Сохранить диапазоны LTE').disabled, true);
	assert.equal(button(tree, 'Сохранить фиксацию').disabled, true);
	assert.equal(button(tree, 'Сохранить приоритет').disabled, false);
	tree = h.page.render(fixture({lock: [{pci: 213, earfcn: 1275}]}));
	assert.match(content(tree), /Сначала снимите фиксацию соты/);
	assert.equal(button(tree, 'Снять фиксацию').disabled, false);
	await button(tree, 'Снять фиксацию').attrs.click();
	await button(h.modal(), 'Подтвердить').attrs.click();
	assert.equal(h.calls[0].message.params[3].action, 'unlock');
	assert.equal(h.calls[0].message.params[3].value, '');
	tree = h.page.render({ok: false, error: 'Read timed out'});
	assert.match(content(tree), /Read timed out/);
	assert(fields(tree, 'button').filter(node => content(node) !== 'Прочитать настройки').every(node => node.disabled));

	// Validate HTTP, JSON-RPC, ubus and payload failures at the dedicated
	// transport boundary; every failed call issues exactly one HTTP request.
	for (const transport of [
		() => Promise.reject(new Error('Network timeout')),
		() => Promise.resolve({ok: false, status: 403}),
		() => Promise.resolve({ok: true, json: () => { throw new Error('Invalid JSON'); }}),
		(_, message) => Promise.resolve({ok: true, json: () => ({jsonrpc: '2.0', id: 'wrong', result: [0, {}]})}),
		(_, message) => Promise.resolve({ok: true, json: () => ({jsonrpc: '2.0', id: message.id, error: {code: -32002, message: 'Access denied'}})}),
		(_, message) => Promise.resolve({ok: true, json: () => ({jsonrpc: '2.0', id: message.id, result: [6]})}),
		(_, message) => Promise.resolve({ok: true, json: () => ({jsonrpc: '2.0', id: message.id, result: [0, null]})})
	]) {
		h = harness({transport});
		await assert.rejects(h.helpers.radioRPC('radio_status', {}));
		assert.equal(h.calls.length, 1);
	}
	console.log('VT_MODEM_RADIO_CONTROLS_TESTS_OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
