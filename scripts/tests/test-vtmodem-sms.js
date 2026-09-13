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
	assert(result.every(m => !m.complete && m.ids.length === 1 && /Ambiguous/.test(m.merge_warning)));
	assert.deepEqual(result.flatMap(m => m.ids).sort((a, b) => a - b), [1, 2, 3]);
}
result = plain(merge([part(1, 1, 'A'), part(2, 1, 'A')]));
assert(result.every(m => !m.complete), 'Two copies of part one are not a complete two-part SMS');

result = plain(merge([part(1, 1, 'A'), part(2, 3, 'invalid')]));
assert.equal(result.length, 2);
assert(result.every(m => !m.complete && m.ids.length === 1));
assert.match(result.find(m => m.ids[0] === 2).merge_warning, /Invalid/);
for (const malformed of [{ concat_seq: 0 }, { concat_seq: 1.5 }, { concat_ref: null },
	{ concat_total: 256 }, { concat_total: 'bad' }, { dcs: 'bad' }]) {
	result = plain(merge([part(1, 1, 'A', undefined, malformed)]));
	assert.equal(result[0].complete, false);
	assert.match(result[0].merge_warning, /Invalid/);
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

function harness(replies = {}) {
	const calls = [], notifications = [];
	let reloads = 0;
	function E(tag, attrs = {}, children = []) {
		return { tag, attrs, children, value: '', disabled: false,
			appendChild(node) { this.children.push(node); },
			replaceChildren(...nodes) { this.children = nodes; },
			addEventListener() {} };
	}
	const context = {
		E, _: value => value, confirm: () => true,
		view: { extend: value => value },
		rpc: { declare: ({ method }) => (...args) => {
			calls.push({ method, args });
			const answer = replies[method] ? replies[method](...args) : { ok: true };
			return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
		} },
		ui: { createHandlerFn: (_, fn) => fn, addNotification: (_, node, kind) => notifications.push({ node, kind }) },
		window: { location: { reload: () => reloads++ } }
	};
	vm.createContext(context);
	vm.runInContext("String.format = function(t,...args) { let i = 0; return t.replace(/%[sd]/g, () => String(args[i++])); };", context);
	const page = vm.runInContext('(function() {' + source + '})()', context);
	return { page, calls, notifications, reloads: () => reloads };
}
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
	return (root.children || []).map(content).join(' ');
}
function button(root, label) {
	return nodes(root).find(node => node.tag === 'button' && content(node) === label);
}
const inbox = { supported: true, ok: true, messages: [part(5, 1, 'A'), part(6, 2, 'B')] };

(async () => {
	let h = harness({ sms_delete: () => ({ ok: false, error: 'modem busy' }) });
	let tree = h.page.render(inbox);
	await button(tree, 'Delete').attrs.click();
	assert.deepEqual(h.calls.map(c => c.args), [[5]], 'A backend failure must stop later deletes');
	assert.equal(h.reloads(), 0);
	assert.equal(h.notifications.length, 1);
	assert.match(content(h.notifications[0].node), /modem busy.*Deleted 0 of 2/);
	assert.equal(button(tree, 'Delete').disabled, false);

	h = harness({ sms_delete: id => id === 5 ? { ok: true } : { ok: false, error: 'part unavailable' } });
	tree = h.page.render(inbox);
	await button(tree, 'Delete').attrs.click();
	assert.deepEqual(h.calls.map(c => c.args), [[5], [6]]);
	assert.equal(h.reloads(), 0);
	assert.match(content(h.notifications[0].node), /part unavailable.*Deleted 1 of 2.*Refresh/);

	h = harness({ sms_delete: () => new Error('RPC unavailable') });
	tree = h.page.render(inbox);
	await button(tree, 'Delete').attrs.click();
	assert.deepEqual(h.calls.map(c => c.args), [[5]]);
	assert.equal(h.reloads(), 0);
	assert.match(content(h.notifications[0].node), /RPC unavailable/);

	h = harness();
	tree = h.page.render(inbox);
	await button(tree, 'Delete').attrs.click();
	assert.deepEqual(h.calls.map(c => c.args), [[5], [6]]);
	assert.equal(h.reloads(), 1);
	assert.equal(h.notifications.length, 0);

	h = harness();
	tree = h.page.render({ supported: true, ok: false, error: 'Unable to read SIM memory' });
	assert.match(content(tree), /Unable to read SIM memory/);
	assert(!content(tree).includes('No messages.'), 'Read failure must not look like an empty inbox');
	tree = h.page.render({ supported: false, error: 'SMS not supported' });
	assert.match(content(tree), /SMS not supported/);
	assert.equal(button(tree, 'Send SMS'), undefined);

	for (const answer of [{ ok: false, error: 'Send rejected' }, new Error('Send RPC unavailable'),
		{ ok: true, encoding: 'UCS-2', segments: 2 }]) {
		h = harness({ sms_send: () => answer });
		tree = h.page.render({ supported: true, ok: true, messages: [] });
		const phone = nodes(tree).find(node => node.tag === 'input');
		const body = nodes(tree).find(node => node.tag === 'textarea');
		phone.value = '+70000000000';
		body.value = 'Тестовое сообщение';
		await button(tree, 'Send SMS').attrs.click();
		assert.deepEqual(h.calls[0], { method: 'sms_send', args: ['+70000000000', 'Тестовое сообщение'] });
		assert.equal(button(tree, 'Send SMS').disabled, false);
		if (answer.ok) {
			assert.match(content(tree), /SMS sent: UCS-2, 2 segment/);
			assert.equal(body.value, '');
		} else {
			assert.match(content(tree), answer instanceof Error ? /Send RPC unavailable/ : /Send rejected/);
			assert.equal(body.value, 'Тестовое сообщение');
		}
	}
	console.log('VT_MODEM_SMS_TESTS_OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
