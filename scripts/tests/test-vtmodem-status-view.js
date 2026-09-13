#!/usr/bin/env node
'use strict';

// Exercise the complete LuCI view, including its real handlers and both refresh
// streams. RPC, DOM and browser time are isolated; no router/modem is contacted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,
	'../../package/vtmodem/files/www/luci-static/resources/view/vtmodem/status.js'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
class Node {
	constructor(tag, attrs = {}, children = []) {
		this.tag = tag; this.attrs = attrs; this.children = children;
		this.isConnected = false; this.disabled = false; this.value = '';
	}
	get firstChild() { return this.children[0] || null; }
	appendChild(node) { this.children.push(node); return node; }
	removeChild(node) { this.children.splice(this.children.indexOf(node), 1); return node; }
	setAttribute(name, value) { this.attrs[name] = String(value); }
	get textContent() { return this.children.map(node => node instanceof Node ? node.textContent : node == null ? '' : String(node)).join(''); }
	set textContent(value) { this.children = [String(value)]; }
}
function element(tag, attrs, children) {
	return Array.isArray(tag) ? new Node(null, {}, attrs || []) : new Node(tag, attrs || {}, children || []);
}
function all(root, predicate = () => true) {
	if (!(root instanceof Node)) return [];
	return [...(predicate(root) ? [root] : []), ...root.children.flatMap(node => all(node, predicate))];
}
function one(root, predicate) { return all(root, predicate)[0]; }
function button(root, label) {
	const found = one(root, node => node.tag === 'button' && node.textContent === label);
	assert(found, 'Button not found: ' + label);
	return found;
}
function section(root, title) {
	const found = one(root, node => node.attrs.class === 'cbi-section' &&
		node.children[0] instanceof Node && node.children[0].textContent === title);
	assert(found, 'Section not found: ' + title);
	return found;
}
function eventTarget() {
	const listeners = new Map();
	return {
		listeners,
		addEventListener: (name, fn) => listeners.set(name, fn),
		removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
		emit: (name, value = {}) => { if (listeners.has(name)) listeners.get(name)(value); }
	};
}
function status(stamp, cellId = 118667785, rsrp = -107) {
	return { present: true, type: 't99w175', model: 'T99 fixture', sim_state: 'READY',
		qmi_signal: { rsrp_dbm: -108, rsrq_db: -17, snr_db: 3.6, rssi_dbm: -72 },
		qmi_radio: { band: 3, earfcn: 1275, bandwidth_mhz: 15 },
		t99_radio: { cell_id: cellId, cells: [{ role: 'primary', band: 3, earfcn: 1275, pci: 213,
			rsrp_dbm: rsrp, rsrq_db: -16.3, snr_db: 5.4 }] },
		telemetry: { sources: { qmi_signal: { monotonic_ms: stamp, updated_at: 1789300800 + stamp / 1000, age_seconds: 1 },
			t99_radio: { monotonic_ms: stamp, updated_at: 1789300800 + stamp / 1000, age_seconds: 1 } } } };
}
function traffic(stamp, rx = '2500000000', tx = '500000000') {
	return { ok: true, interface: 'wwan0', clock_synced: true,
		period: { day: '2026-09-13', month: '2026-09' },
		today: { rx_bytes: rx, tx_bytes: tx, total_bytes: (BigInt(rx) + BigInt(tx)).toString() },
		month: { rx_bytes: '13000000000', tx_bytes: '400000000', total_bytes: '13400000000' },
		total: { rx_bytes: '13000000000', tx_bytes: '400000000', total_bytes: '13400000000' },
		live: { rx_bytes: String(1000000000 + stamp * 1000), tx_bytes: String(100000000 + stamp * 250),
			monotonic_ms: stamp, ifindex: 5, boot_id: 'same-boot' } };
}
function harness(automatic = {}) {
	let now = 1000, nextTimer = 0;
	const timers = new Map(), queries = [], storage = new Map();
	const doc = eventTarget(), browser = eventTarget();
	doc.hidden = false; doc.documentElement = {};
	doc.createElementNS = (_, tag) => new Node(tag);
	browser.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; };
	browser.clearTimeout = id => timers.delete(id);
	browser.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
	browser.confirm = () => true;
	class Observer {
		static instances = [];
		constructor(fn) { this.fn = fn; this.connected = false; Observer.instances.push(this); }
		observe() { this.connected = true; }
		disconnect() { this.connected = false; }
		emit() { if (this.connected) this.fn(); }
	}
	class FakeDate extends Date {
		constructor(...args) { super(...(args.length ? args : [now])); }
		static now() { return now; }
	}
	const page = new Function('view', 'rpc', '_', 'E', 'document', 'window', 'MutationObserver', 'Date', source)(
		{ extend: value => value }, { declare: ({ method }) => (...args) => {
			const q = { ...deferred(), method, args, at: now };
			queries.push(q);
			if (automatic[method]) Promise.resolve().then(() => automatic[method](now, ...args)).then(q.resolve, q.reject);
			return q.promise;
		} }, value => value, element, doc, browser, Observer, FakeDate);
	const root = page.render({ status: status(now), completedAt: now });
	return { root, page, queries, timers, doc, browser, storage, automatic,
		now: () => now,
		queriesFor: method => queries.filter(q => q.method === method),
		mount: () => { root.isConnected = true; Observer.instances[0].emit(); },
		detach: () => { root.isConnected = false; Observer.instances[0].emit(); },
		observers: Observer.instances,
		advance: async ms => {
			const target = now + ms;
			let steps = 0;
			while (true) {
				const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				assert(++steps < 1000, 'Unexpected timer loop');
				now = due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
			}
			now = target; await flush();
		},
		period: value => {
			const select = one(root, node => node.tag === 'select' && node.attrs['aria-label'] === 'Автообновление');
			select.value = String(value); select.attrs.change({ target: select });
			return select;
		} };
}

async function bothStreamsAndOff() {
	const h = harness();
	assert.equal(h.timers.size, 0, 'No polling before the real view is mounted');
	h.mount();
	assert.equal(h.timers.size, 2);
	h.period(0);
	assert.equal(h.timers.size, 0, 'Off cancels both the modem and traffic timers');
	await h.advance(120000);
	assert.equal(h.queries.length, 0);
	h.doc.hidden = true; h.doc.emit('visibilitychange');
	h.doc.hidden = false; h.doc.emit('visibilitychange');
	h.browser.emit('pagehide', { persisted: true }); h.browser.emit('pageshow', { persisted: true });
	await flush();
	assert.equal(h.queries.length, 0, 'Visibility and BFCache cannot override manual-only mode');
	const pending = button(h.root, 'Обновить').attrs.click(); await flush();
	assert.deepEqual(h.queries.map(q => q.method).sort(), ['status', 'traffic_status']);
	h.queriesFor('status')[0].resolve(status(h.now()));
	h.queriesFor('traffic_status')[0].resolve(traffic(h.now()));
	await pending;
	assert.match(section(h.root, 'Трафик модема').textContent, /2\.500 ГБ/);
	assert.equal(h.timers.size, 0, 'Manual refresh does not re-enable periodic polling');
	h.period(30000);
	assert.equal(h.timers.size, 2);
	h.detach();
	assert.equal(h.timers.size, 0);
}

async function independentTraffic() {
	const h = harness({ traffic_status: now => traffic(now) });
	h.mount();
	await h.advance(30000);
	assert.equal(h.queriesFor('status').length, 1);
	assert.equal(h.queriesFor('traffic_status').length, 6);
	assert.equal(button(h.root, 'Обновление…').disabled, true);
	await h.advance(20000);
	assert.equal(h.queriesFor('status').length, 1, 'Slow modem status never overlaps another modem query');
	assert.equal(h.queriesFor('traffic_status').length, 10, 'Traffic does not wait for the modem or AT port');
	assert.match(section(h.root, 'Трафик модема').textContent, /8 Мбит\/с/);
	h.queriesFor('status')[0].reject(new Error('status delayed')); await flush();
	assert.match(h.root.textContent, /status delayed/);
	assert.match(section(h.root, 'Трафик модема').textContent, /8 Мбит\/с/);
	h.detach();
}

async function lifecycle() {
	const h = harness(); h.mount();
	h.doc.hidden = true; h.doc.emit('visibilitychange');
	assert.equal(h.timers.size, 0);
	await h.advance(120000); assert.equal(h.queries.length, 0);
	h.doc.hidden = false; h.doc.emit('visibilitychange'); await flush();
	assert.deepEqual(h.queries.map(q => q.method).sort(), ['status', 'traffic_status']);
	h.queriesFor('status')[0].resolve(status(h.now()));
	h.queriesFor('traffic_status')[0].resolve(traffic(h.now())); await flush();
	assert.equal(h.timers.size, 2);
	h.browser.emit('pagehide', { persisted: true });
	assert.equal(h.timers.size, 0);
	await h.advance(60000); assert.equal(h.queries.length, 2);
	h.browser.emit('pageshow', { persisted: true }); await flush();
	assert.equal(h.queries.length, 4);
	const before = h.root.textContent;
	h.detach();
	assert.equal(h.doc.listeners.size, 0); assert.equal(h.browser.listeners.size, 0);
	assert.equal(h.observers[0].connected, false);
	h.queriesFor('status')[1].resolve({ ...status(h.now()), model: 'DO NOT RENDER' });
	h.queriesFor('traffic_status')[1].resolve(traffic(h.now(), '999000000000')); await flush();
	assert.equal(h.root.textContent, before, 'Late results cannot alter a detached view');
	await h.advance(120000); assert.equal(h.queries.length, 4); assert.equal(h.timers.size, 0);

	const away = harness(); away.mount();
	away.browser.emit('pagehide', { persisted: false });
	assert.equal(away.timers.size, 0);
	assert.equal(away.doc.listeners.size, 0); assert.equal(away.browser.listeners.size, 0);
	await away.advance(120000); assert.equal(away.queries.length, 0);
}

async function alignment() {
	let cell = 118667785;
	const h = harness({ status: now => status(now, cell, -107 + (now - 1000) / 5000),
		traffic_status: now => traffic(now) });
	h.mount();
	h.period(10000);
	await button(h.root, 'Начать наведение').attrs.click(); await flush();
	const select = one(h.root, node => node.tag === 'select');
	assert.equal(select.disabled, true); assert.equal(select.value, '5000');
	assert.equal(button(h.root, 'Сохранить замер').disabled, true, 'One sample cannot establish a comparison');
	await h.advance(5000);
	const area = section(h.root, 'Наведение антенны');
	assert.equal(all(area, node => node.tag === 'svg').length, 3, 'All three metric graphs render with real SVG nodes');
	assert.equal(all(area, node => node.tag === 'polyline').length, 3);
	assert.equal(button(h.root, 'Сохранить замер').disabled, false);
	one(h.root, node => node.tag === 'input' && node.attrs['aria-label'] === 'Название замера').value = 'У окна';
	button(h.root, 'Сохранить замер').attrs.click();
	let saved = JSON.parse(h.storage.get('vtmodem.antenna.samples.v1'));
	assert.equal(saved.length, 1); assert.equal(saved[0].label, 'У окна');
	assert.equal(saved[0].count, 2); assert.equal(saved[0].rsrp, -106.5);
	assert.match(area.textContent, /У окна/);

	cell = 1234;
	await h.advance(5000);
	assert.equal(button(h.root, 'Сохранить замер').disabled, true, 'New cell needs its own measurements');
	assert.equal(all(area, node => node.tag === 'polyline').length, 6, 'Cell changes break every graph line');
	await h.advance(5000);
	assert.equal(button(h.root, 'Сохранить замер').disabled, false);

	// Browser elapsed time must age a previously fresh server sample while a
	// newer RPC is still pending. Clicking an old enabled control cannot save it.
	h.automatic.status = null;
	await h.advance(20000);
	button(h.root, 'Сохранить замер').attrs.click();
	saved = JSON.parse(h.storage.get('vtmodem.antenna.samples.v1'));
	assert.equal(saved.length, 1, 'Stalled transport cannot turn an old reading into a fresh saved sample');
	h.queriesFor('status').at(-1).reject(new Error('modem timeout')); await flush();
	assert.equal(button(h.root, 'Сохранить замер').disabled, true);
	assert.match(area.textContent, /Ожидание свежих измерений/);
	assert.match(area.textContent, /У окна/, 'Saved comparison survives a refresh error');
	await button(h.root, 'Завершить наведение').attrs.click();
	assert.equal(select.disabled, false); assert.equal(select.value, '10000');
	h.detach();

	// Entering from Off is temporary: stopping alignment restores Off for both.
	const off = harness({ status: now => status(now), traffic_status: now => traffic(now) });
	off.mount(); off.period(0);
	await button(off.root, 'Начать наведение').attrs.click(); await flush();
	assert.equal(one(off.root, node => node.tag === 'select').value, '5000');
	await button(off.root, 'Завершить наведение').attrs.click();
	assert.equal(one(off.root, node => node.tag === 'select').value, '0');
	assert.equal(off.timers.size, 0); off.detach();
}

async function retainedValuesAndErrors() {
	const h = harness(); h.mount(); h.period(0);
	let pending = button(h.root, 'Обновить').attrs.click(); await flush();
	h.queriesFor('status').at(-1).resolve({ ...status(h.now()), model: 'KEEP THIS MODEM' });
	h.queriesFor('traffic_status').at(-1).resolve(traffic(h.now())); await pending;
	await h.advance(5000);
	pending = button(h.root, 'Обновить').attrs.click(); await flush();
	h.queriesFor('status').at(-1).resolve({ ...status(h.now()), model: 'KEEP THIS MODEM' });
	h.queriesFor('traffic_status').at(-1).resolve(traffic(h.now())); await pending;
	assert.match(section(h.root, 'Трафик модема').textContent, /8 Мбит\/с/);
	pending = button(h.root, 'Обновить').attrs.click(); await flush();
	h.queriesFor('status').at(-1).reject(new Error('modem read error'));
	h.queriesFor('traffic_status').at(-1).reject(new Error('traffic read error')); await pending;
	assert.match(h.root.textContent, /KEEP THIS MODEM/);
	assert.match(h.root.textContent, /modem read error/);
	assert.match(section(h.root, 'Трафик модема').textContent, /2\.500 ГБ/);
	assert.doesNotMatch(section(h.root, 'Трафик модема').textContent, /8 Мбит\/с/, 'Failed refresh clears the old live speed');
	assert.match(section(h.root, 'Трафик модема').textContent, /Не удалось обновить счётчик/);
	assert.equal(button(h.root, 'Обновить').disabled, false);
	pending = button(h.root, 'Обновить').attrs.click(); await flush();
	h.queriesFor('status').at(-1).resolve(status(h.now()));
	h.queriesFor('traffic_status').at(-1).resolve(traffic(h.now(), '3000000000')); await pending;
	assert.doesNotMatch(h.root.textContent, /modem read error|Не удалось обновить счётчик/);
	assert.match(section(h.root, 'Трафик модема').textContent, /3\.000 ГБ/);
	assert.doesNotMatch(section(h.root, 'Трафик модема').textContent, /8 Мбит\/с/, 'After an error the rate needs a new baseline');
	h.detach();
}

(async () => {
	await bothStreamsAndOff(); await independentTraffic(); await lifecycle();
	await alignment(); await retainedValuesAndErrors();
	console.log('VT_MODEM_STATUS_VIEW_TESTS_OK: actual view, dual polling, off/manual, independent traffic, lifecycle, SVG/snapshots, freshness and errors');
})().catch(error => { console.error(error); process.exitCode = 1; });
