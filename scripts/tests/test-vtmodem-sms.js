#!/usr/bin/env node
'use strict';

// No router, AT port or RPC connection is used by these tests.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname,
	'../../package/vtmodem/files/www/luci-static/resources/view/vtmodem/sms.js'), 'utf8');
const merge = vm.runInNewContext(source.slice(source.indexOf('function mergeMessages('),
	source.indexOf('var gsmBasic')) + '; mergeMessages', { _: value => value });
const plain = value => JSON.parse(JSON.stringify(value));
const part = (id, seq, body, time = '2026-09-13T10:00:00Z', overrides = {}) => ({
	id, concat_seq: seq, concat_total: 2, concat_ref: 7, dcs: 8,
	sender: 'beeline', text: body, time, ...overrides
});

let result = plain(merge([part(2, 2, 'зачислен. 😀'), part(1, 1, 'Платёж ')]));
assert.equal(result.length, 1);
assert.equal(result[0].sender, 'beeline');
assert.equal(result[0].text, 'Платёж зачислен. 😀');
assert.equal(result[0].complete, true);
assert.deepEqual(result[0].ids, [1, 2]);

result = plain(merge([
	part(1, 1, 'Платёж ', '2026-09-13T10:59:59Z'),
	part(2, 2, 'зачислен.', '2026-09-13T11:00:00Z')
]));
assert.equal(result.length, 1, 'The hour boundary must not split adjacent parts');
assert.equal(result[0].complete, true);
assert.equal(result[0].text, 'Платёж зачислен.');

for (const duplicateText of ['A', 'different text']) {
	result = plain(merge([part(1, 1, 'A'), part(2, 1, duplicateText), part(3, 2, 'B')]));
	assert.equal(result.length, 3, 'Duplicate sequences must not guess message ownership');
	assert(result.every(m => !m.complete && m.ids.length === 1 && /неоднозначна/.test(m.merge_warning)));
	assert.deepEqual(result.flatMap(m => m.ids).sort((a, b) => a - b), [1, 2, 3]);
}
result = plain(merge([part(1, 1, 'A'), part(2, 1, 'A')]));
assert(result.every(m => !m.complete), 'Two copies of part one are not a complete two-part SMS');

result = plain(merge([part(1, 1, 'A'), part(2, 3, 'invalid')]));
assert.equal(result.length, 2);
assert(result.every(m => !m.complete && m.ids.length === 1));
assert.match(result.find(m => m.ids[0] === 2).merge_warning, /Некорректные/);
for (const malformed of [{ concat_seq: 0 }, { concat_seq: 1.5 }, { concat_ref: null },
	{ concat_total: 256 }, { concat_total: 'bad' }, { dcs: 'bad' }]) {
	result = plain(merge([part(1, 1, 'A', undefined, malformed)]));
	assert.equal(result[0].complete, false);
	assert.match(result[0].merge_warning, /Некорректные/);
}

result = plain(merge([
	part(4, 2, 'text B', '2026-09-13T10:30:01Z'),
	part(1, 1, 'First: ', '2026-09-13T10:00:00Z'),
	part(3, 1, 'Second: ', '2026-09-13T10:30:00Z'),
	part(2, 2, 'text A', '2026-09-13T10:00:01Z')
]));
assert.equal(result.length, 2, 'A reused reference later in the hour is a separate message');
assert.deepEqual(result.map(m => m.text), ['Second: text B', 'First: text A']);
assert.deepEqual(result.map(m => m.ids), [[3, 4], [1, 2]]);
assert(result.every(m => m.complete));

result = plain(merge([
	part(1, 1, 'first', '2026-09-13T10:00:00Z'),
	part(2, 1, 'second', '2026-09-13T10:01:00Z'),
	part(3, 2, 'tail', '2026-09-13T10:01:01Z')
]));
assert.equal(result.length, 3, 'Overlapping reference reuse stays ambiguous');
assert(result.every(m => !m.complete && m.ids.length === 1));

result = plain(merge([
	part(1, 1, 'A', '2026-09-13T10:00:00Z', { concat_total: 3 }),
	part(2, 2, 'B', '2026-09-13T10:09:00Z', { concat_total: 3 }),
	part(3, 3, 'C', '2026-09-13T10:18:00Z', { concat_total: 3 })
]));
assert.equal(result.length, 3, 'Chained arrivals must not create an arbitrary window split');
assert(result.every(m => !m.complete));

for (const overrides of [{ dcs: 0 }, { sender: 'other' }, { concat_ref: 8 }, { time: '' }]) {
	result = plain(merge([part(1, 1, 'A'), part(2, 2, 'B', undefined, overrides)]));
	assert.equal(result.length, 2, 'Different DCS/sender/ref or unknown time must not merge');
	assert(result.every(m => !m.complete));
}
result = plain(merge([part(1, 1, 'A', undefined, { concat_ref: 0 }),
	part(2, 2, 'B', undefined, { concat_ref: 0 })]));
assert.equal(result[0].complete, true, 'Reference zero is valid');
result = plain(merge([part(1, 1, 'A', undefined, { concat_total: 3 }),
	part(3, 3, 'C', undefined, { concat_total: 3 })]));
assert.equal(result[0].complete, false);
assert.equal(result[0].parts_count, 2);
assert.deepEqual(result[0].ids, [1, 3]);
result = plain(merge([{ id: 9, sender: 'Билайн', time: '', text: 'Обычное SMS' }]));
assert.equal(result[0].complete, true);
assert.equal(result[0].sender, 'Билайн');
assert.equal(result[0].text, 'Обычное SMS');

const estimate = vm.runInNewContext(source.slice(source.indexOf('var gsmBasic'),
	source.indexOf('function notice(')) + '; smsEstimate');
for (const [body, encoding, segments, units] of [
	['', 'GSM-7', 1, 0], ['a'.repeat(160), 'GSM-7', 1, 160],
	['a'.repeat(161), 'GSM-7', 2, 161], ['^'.repeat(80), 'GSM-7', 1, 160],
	['a'.repeat(152) + '^'.repeat(77), 'GSM-7', 3, 306],
	['я'.repeat(70), 'UCS-2', 1, 70], ['я'.repeat(71), 'UCS-2', 2, 71],
	['я'.repeat(66) + '😀'.repeat(34), 'UCS-2', 3, 134],
	['😀'.repeat(35), 'UCS-2', 1, 70], ['😀'.repeat(67), 'UCS-2', 3, 134]
])
	assert.deepEqual(plain(estimate(body)), { encoding, segments, units });

// Request outcomes are simulated; no router, SMS recipient or AT port is used.
function harness(replies = {}, store = new Map()) {
	const calls = [], notifications = [], confirmations = [], timers = new Map();
	let nextTimer = 0, nextId = 0, confirmValue = true;
	function E(tag, attrs = {}, children = []) {
		return { tag, attrs, children, value: '', disabled: false, events: {}, textContent: '',
			appendChild(node) { this.children.push(node); },
			replaceChildren(...nodes) { this.children = nodes; },
			addEventListener(name, fn) { this.events[name] = fn; } };
	}
	const context = {
		E, _: value => value,
		confirm: message => { confirmations.push(message); return confirmValue; },
		setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
		clearTimeout: id => timers.delete(id),
		view: { extend: value => value },
		rpc: { declare: ({ method }) => (...args) => {
			calls.push({ method, args: plain(args) });
			const answer = replies[method] ? replies[method](...args) : { ok: true };
			return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
		} },
		ui: { createHandlerFn: (_, fn) => fn, addNotification: (_, node, kind) => notifications.push({ node, kind }) },
		window: {
			crypto: { getRandomValues: bytes => { bytes.fill(0); bytes[15] = ++nextId; } },
			sessionStorage: { getItem: key => store.get(key) || null,
				setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) }
		}
	};
	vm.createContext(context);
	vm.runInContext("String.format = function(t,...args) { let i = 0; return t.replace(/%[sd]/g, () => String(args[i++])); };", context);
	const page = vm.runInContext('(function() {' + source + '})()', context);
	return { page, calls, notifications, confirmations, store, timers,
		confirm: value => { confirmValue = value; },
		tick: async ms => {
			const found = Array.from(timers.entries()).find(([, timer]) => timer.ms === ms);
			assert(found, 'Expected timer ' + ms);
			timers.delete(found[0]); found[1].fn(); await flush();
		} };
}
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
function nodes(root) {
	if (!root || typeof root !== 'object')
		return [];
	return [root, ...(root.children || []).flatMap(nodes)];
}
function content(root) {
	if (root == null)
		return '';
	if (typeof root !== 'object')
		return String(root);
	return root.textContent || (root.children || []).map(content).join(' ');
}
function button(root, label) {
	return nodes(root).find(node => node.tag === 'button' && content(node) === label);
}
function compose(tree, message = 'Тестовое сообщение') {
	const phone = nodes(tree).find(node => node.tag === 'input');
	const body = nodes(tree).find(node => node.tag === 'textarea');
	phone.value = '+70000000000'; body.value = message;
	body.events.input();
	return { phone, body };
}
const id1 = '00000000000000000000000000000001';
const inbox = { supported: true, ok: true, messages: [
	part(5, 1, 'A', undefined, { fingerprint: '0011' }),
	part(6, 2, 'B', undefined, { fingerprint: '0022' })
] };
const empty = { supported: true, ok: true, messages: [] };
const success = { ok: true, encoding: 'UCS-2', parts_total: 2, parts_confirmed: 2 };
const done = result => ({ ok: true, state: 'done', result });
const running = { ok: true, state: 'running' };
const pendingKey = 'vtmodem.sms.pending.v1';

(async () => {
	let h = harness({ sms_delete_start: () => done({ ok: false, deleted: 1, total: 2, error: 'part unavailable' }) });
	let tree = h.page.render(inbox);
	assert.equal(button(tree, 'Удалить').disabled, false);
	await button(tree, 'Удалить').attrs.click();
	assert.deepEqual(h.calls[0], { method: 'sms_delete_start', args: [
		[{ id: 5, fingerprint: '0011' }, { id: 6, fingerprint: '0022' }], id1
	] }, 'One identity-protected job owns all multipart deletions');
	assert.match(content(tree), /Подтверждено удалений: 1 из 2.*part unavailable.*Обновите/);
	assert.equal(button(tree, 'Удалить').disabled, true);
	await button(tree, 'Удалить').attrs.click();
	assert.equal(h.calls.length, 1, 'Even invoking an old handler cannot repeat stale IDs');
	assert.equal(h.store.size, 0);

	h = harness({ sms_delete_start: () => new Error('transport gone'),
		sms_job_status: () => ({ ok: false, error_code: 'not_found', error: 'not found', retry_safe: false }) });
	tree = h.page.render(inbox);
	await button(tree, 'Удалить').attrs.click();
	assert.deepEqual(h.calls.map(c => c.method), ['sms_delete_start', 'sms_job_status']);
	assert.equal(button(tree, 'Удалить').disabled, true);
	assert.equal(button(tree, 'Отправить SMS').disabled, true);
	assert.match(content(tree), /Результат операции пока неизвестен/);
	assert.equal(h.store.size, 1, 'Unknown deletion remains resumable');

	h = harness({ sms_delete_start: () => done({ ok: true, deleted: 2, total: 2 }),
		sms_list_start: () => done({ ...empty, messages: [{ id: 5, sender: 'new', text: 'new SMS', fingerprint: 'ABCD' }] }) });
	tree = h.page.render(inbox);
	const staleDelete = button(tree, 'Удалить');
	await staleDelete.attrs.click();
	assert.equal(staleDelete.disabled, true);
	await button(tree, 'Обновить список').attrs.click();
	assert.match(content(tree), /new SMS/);
	assert.equal(button(tree, 'Удалить').disabled, false);
	assert.deepEqual(h.calls.map(c => c.method), ['sms_delete_start', 'sms_list_start']);
	await staleDelete.attrs.click();
	assert.equal(h.calls.length, 2, 'A detached stale DOM handler must remain invalid after a refresh');

	for (const malformed of [undefined, '', 'aa11', 'GG', 'A', 'AA'.repeat(513)]) {
		h = harness();
		tree = h.page.render({ ...empty, messages: [{ id: 1, text: 'old backend', fingerprint: malformed }] });
		assert.equal(button(tree, 'Удалить').disabled, true);
		await button(tree, 'Удалить').attrs.click();
		assert.equal(h.calls.length, 0, 'No unguarded legacy delete fallback');
	}

	h = harness();
	tree = h.page.render({ supported: true, ok: false, error: 'Unable to read SIM memory' });
	assert.match(content(tree), /Unable to read SIM memory/);
	assert(!content(tree).includes('Сообщений нет.'), 'A read failure is not an empty inbox');
	tree = h.page.render({ supported: false, error: 'SMS not supported' });
	assert.match(content(tree), /SMS not supported/);
	assert.equal(button(tree, 'Отправить SMS'), undefined);

	for (const answer of [{ ok: false, error: 'Send rejected', parts_total: 2, parts_confirmed: 0 },
		{ ok: false, error: 'second part failed', parts_total: 2, parts_confirmed: 1, failed_part: 2, outcome_unknown: false },
		{ ok: false, error: 'timeout', parts_total: 2, parts_confirmed: 1, failed_part: 2, outcome_unknown: true }, success]) {
		h = harness({ sms_send_start: () => done(answer) });
		tree = h.page.render(empty);
		const { body } = compose(tree);
		await button(tree, 'Отправить SMS').attrs.click();
		assert.deepEqual(h.calls[0], { method: 'sms_send_start', args: ['+70000000000', 'Тестовое сообщение', id1] });
		assert.equal(button(tree, 'Отправить SMS').disabled, false);
		assert.equal(h.store.size, 0);
		if (answer.ok) {
			assert.match(content(tree), /Принято модемом: 2 из 2.*UCS-2/);
			assert.equal(body.value, '');
		} else {
			assert.match(content(tree), new RegExp(answer.error));
			assert.equal(body.value, 'Тестовое сообщение');
			assert.match(content(tree), new RegExp('Подтверждено частей: ' + answer.parts_confirmed + ' из 2'));
			if (answer.outcome_unknown) assert.match(content(tree), /последней части неизвестен/);
			if (answer.parts_confirmed) {
				assert.match(content(tree), /дубликаты/);
				h.confirm(false);
				await button(tree, 'Отправить SMS').attrs.click();
				assert.equal(h.calls.length, 1, 'Retry after partial send needs an explicit fresh decision');
			}
		}
	}

	// Sending is a single mutation, while all later requests only observe it.
	h = harness({ sms_send_start: () => running, sms_job_status: () => done(success) });
	tree = h.page.render(empty);
	const draft = compose(tree);
	let pending = button(tree, 'Отправить SMS').attrs.click();
	await flush();
	assert.equal(button(tree, 'Отправить SMS').disabled, true);
	await button(tree, 'Отправить SMS').attrs.click();
	assert.equal(h.calls.length, 1, 'No second write while the job runs');
	draft.body.value = 'Новый черновик'; draft.body.events.input();
	assert.match(content(tree), /Кодировка: UCS-2/);
	await h.tick(2000); await pending;
	assert.equal(draft.body.value, 'Новый черновик', 'Completion cannot erase text composed during the job');
	assert.deepEqual(h.calls.map(c => c.method), ['sms_send_start', 'sms_job_status']);
	assert.equal(h.calls[1].args[0], id1);

	// Even editing back to identical text advances the draft revision.
	h = harness({ sms_send_start: () => running, sms_job_status: () => done(success) });
	tree = h.page.render(empty);
	const same = compose(tree);
	pending = button(tree, 'Отправить SMS').attrs.click(); await flush();
	same.body.value = 'new'; same.body.events.input();
	same.body.value = 'Тестовое сообщение'; same.body.events.input();
	await h.tick(2000); await pending;
	assert.equal(same.body.value, 'Тестовое сообщение');

	// A lost start reply is recovered using the preselected ID, never re-sent.
	h = harness({ sms_send_start: () => new Error('lost response'), sms_job_status: () => done(success) });
	tree = h.page.render(empty); compose(tree);
	await button(tree, 'Отправить SMS').attrs.click();
	assert.deepEqual(h.calls.map(c => c.method), ['sms_send_start', 'sms_job_status']);
	assert.equal(h.calls[1].args[0], id1);
	assert.match(content(tree), /Принято модемом/);

	// A start transport that never resolves has a bounded wait too.
	h = harness({ sms_send_start: () => new Promise(() => {}), sms_job_status: () => done(success) });
	tree = h.page.render(empty); compose(tree);
	pending = button(tree, 'Отправить SMS').attrs.click(); await flush();
	await h.tick(10000); await pending;
	assert.deepEqual(h.calls.map(c => c.method), ['sms_send_start', 'sms_job_status']);

	// Observing a long operation is bounded; manual observation does not retry writes.
	h = harness({ sms_send_start: () => running, sms_job_status: () => running });
	tree = h.page.render(empty); compose(tree);
	pending = button(tree, 'Отправить SMS').attrs.click(); await flush();
	for (let i = 0; i < 89; i++) await h.tick(2000);
	await pending;
	assert.match(content(tree), /Автоматическая проверка приостановлена/);
	assert.equal(h.calls.filter(c => c.method === 'sms_send_start').length, 1);
	assert.equal(button(tree, 'Отправить SMS').disabled, true);
	assert.equal(h.timers.size, 0);

	const store = h.store;
	assert.deepEqual(JSON.parse(store.get(pendingKey)), { id: id1, kind: 'send' });
	assert(!store.get(pendingKey).includes('Тест'), 'No phone/text is saved in browser job metadata');
	h = harness({ sms_job_status: () => done(success) }, store);
	tree = h.page.render(empty);
	const resumedDraft = compose(tree, 'Не удалять');
	await flush();
	assert.deepEqual(h.calls.map(c => c.method), ['sms_job_status'], 'Reload resumes observation only');
	assert.equal(resumedDraft.body.value, 'Не удалять');
	assert.equal(store.size, 0);

	// A reboot clears /var/run job history. A stale browser resume record must
	// be forgotten without repeating the write; delete resumes refresh inbox.
	const staleDeleteStore = new Map([[pendingKey, JSON.stringify({ id: id1, kind: 'delete' })]]);
	h = harness({
		sms_job_status: () => ({ ok: false, error_code: 'not_found', retry_safe: false, error: 'expired' }),
		sms_list_start: () => done(empty)
	}, staleDeleteStore);
	tree = h.page.render(inbox); await flush();
	assert.deepEqual(h.calls.map(c => c.method), ['sms_job_status', 'sms_list_start']);
	assert.equal(staleDeleteStore.size, 0, 'Expired resumed delete is removed from sessionStorage');
	assert.match(content(tree), /больше не хранится.*не повторялась автоматически/);
	assert.equal(h.calls.filter(c => c.method === 'sms_delete_start').length, 0);

	const staleSendStore = new Map([[pendingKey, JSON.stringify({ id: id1, kind: 'send' })]]);
	h = harness({ sms_job_status: () => ({ ok: false, error_code: 'not_found', retry_safe: false, error: 'expired' }) }, staleSendStore);
	tree = h.page.render(empty); await flush();
	assert.equal(staleSendStore.size, 0, 'Expired resumed send is removed from sessionStorage');
	assert.equal(button(tree, 'Отправить SMS').disabled, false);
	compose(tree, 'После перезагрузки');
	h.confirm(false);
	await button(tree, 'Отправить SMS').attrs.click();
	assert.equal(h.calls.filter(c => c.method === 'sms_send_start').length, 0, 'Unknown old send requires explicit retry confirmation');

	// A late result from an old view must not erase a newer view's resume ID.
	h = harness({ sms_send_start: () => running, sms_job_status: () => done(success) });
	tree = h.page.render(empty); compose(tree);
	pending = button(tree, 'Отправить SMS').attrs.click(); await flush();
	const newer = { id: 'f'.repeat(32), kind: 'send' };
	h.store.set(pendingKey, JSON.stringify(newer));
	await h.tick(2000); await pending;
	assert.deepEqual(JSON.parse(h.store.get(pendingKey)), newer);

	// Unknown outcomes do not silently release the send button.
	h = harness({ sms_send_start: () => running, sms_job_status: () => new Error('timeout') });
	tree = h.page.render(empty); compose(tree);
	pending = button(tree, 'Отправить SMS').attrs.click(); await flush();
	await h.tick(2000); await pending;
	assert.match(content(tree), /Результат операции пока неизвестен.*timeout/);
	assert.equal(button(tree, 'Отправить SMS').disabled, true);
	assert.equal(h.store.size, 1);
	h.confirm(false);
	await button(tree, 'Завершить наблюдение').attrs.click();
	assert.equal(button(tree, 'Отправить SMS').disabled, true);
	h.confirm(true);
	await button(tree, 'Завершить наблюдение').attrs.click();
	assert.equal(button(tree, 'Отправить SMS').disabled, false);
	assert.equal(h.store.size, 0);
	h.confirm(false);
	await button(tree, 'Отправить SMS').attrs.click();
	assert.equal(h.calls.filter(c => c.method === 'sms_send_start').length, 1);

	// A rejected start is explicitly safe to correct; it is never auto-retried.
	h = harness({ sms_send_start: () => ({ ok: false, error: 'busy', retry_safe: true }) });
	tree = h.page.render(empty); compose(tree);
	await button(tree, 'Отправить SMS').attrs.click();
	assert.equal(button(tree, 'Отправить SMS').disabled, false);
	assert.equal(h.store.size, 0);
	assert.equal(h.calls.length, 1);

	// A concurrent publisher cannot prove that this ID was rejected. Resolve
	// the outcome by observation rather than releasing or repeating the write.
	h = harness({ sms_send_start: () => ({ ok: false, error_code: 'publishing', retry_safe: false }),
		sms_job_status: () => done(success) });
	tree = h.page.render(empty); compose(tree);
	await button(tree, 'Отправить SMS').attrs.click();
	assert.deepEqual(h.calls.map(c => c.method), ['sms_send_start', 'sms_job_status']);
	assert.equal(h.calls[1].args[0], id1);
	assert.match(content(tree), /Принято модемом/);

	// Initial list fetch is asynchronous and returns messages without reloading LuCI.
	h = harness({ sms_list_start: () => running, sms_job_status: () => done(inbox) });
	assert.deepEqual(plain(await h.page.load()), {});
	tree = h.page.render({}); await flush();
	assert.match(content(tree), /Чтение сообщений/);
	assert.equal(button(tree, 'Отправить SMS').disabled, true);
	await h.tick(2000);
	assert.match(content(tree), /AB/);
	assert.equal(button(tree, 'Удалить').disabled, false);
	assert.equal(button(tree, 'Отправить SMS').disabled, false);
	assert.deepEqual(h.calls.map(c => c.method), ['sms_list_start', 'sms_job_status']);

	console.log('VT_MODEM_SMS_TESTS_OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
