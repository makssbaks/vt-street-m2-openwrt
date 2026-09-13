'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname,
	'../../package/vtmodem/files/www/luci-static/resources/view/vtmodem/status.js'), 'utf8');
const declarations = [];
const helpers = new Function('rpc', '_', source.slice(0, source.lastIndexOf('\nreturn view.extend(')) +
	'\nreturn { createRefreshController, bindRefreshLifecycle, validStatus };')(
	{ declare: options => { declarations.push(options); return () => Promise.resolve({ present: true }); } },
	value => value);
assert.deepEqual(declarations, [ { object: 'vtmodem', method: 'status', expect: {}, reject: true } ]);

function deferred() {
	let resolve, reject;
	const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}
async function flush() {
	for (let index = 0; index < 12; index++)
		await Promise.resolve();
}
function clock() {
	let now = 1000, nextId = 0;
	const timers = new Map();
	return {
		now: () => now, timers,
		setTimer: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
		clearTimer: id => timers.delete(id),
		advance: async milliseconds => {
			now += milliseconds;
			for (const [ id, timer ] of Array.from(timers)) {
				if (timer.at <= now && timers.has(id)) {
					timers.delete(id);
					timer.fn();
				}
			}
			await flush();
		}
	};
}
function harness(initial = { status: { present: true, model: 'first' }, completedAt: 500 }) {
	const time = clock(), queries = [], states = [];
	let hidden = false;
	const controller = helpers.createRefreshController({
		initial, query: () => { const query = deferred(); queries.push(query); return query.promise; },
		now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer,
		isHidden: () => hidden, onState: state => states.push(state)
	});
	return { controller, time, queries, states,
		hide: () => { hidden = true; controller.visibilityChanged(); },
		show: () => { hidden = false; controller.visibilityChanged(); } };
}
function eventTarget() {
	const listeners = new Map();
	return { listeners,
		addEventListener: (name, fn) => listeners.set(name, fn),
		removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
		emit: (name, event = {}) => { if (listeners.has(name)) listeners.get(name)(event); }
	};
}
function observerType() {
	return class FakeObserver {
		static instances = [];
		constructor(callback) { this.callback = callback; this.connected = false; this.constructor.instances.push(this); }
		observe() { this.connected = true; }
		disconnect() { this.connected = false; }
		emit() { if (this.connected) this.callback(); }
	};
}

async function schedulerTests() {
	// Default interval starts only when attached. A slow request never overlaps
	// a timer/manual request; the next delay starts at transport settlement.
	const h = harness();
	assert.equal(h.time.timers.size, 0);
	h.controller.start();
	await h.time.advance(30000);
	assert.equal(h.queries.length, 1);
	const running = h.controller.refresh();
	assert.strictEqual(h.controller.refresh(), running);
	await h.time.advance(120000);
	assert.equal(h.queries.length, 1);
	assert.equal(h.time.timers.size, 0);
	h.queries[0].resolve({ present: true, model: 'second' });
	assert.equal(await running, true);
	assert.equal(h.controller.state().lastSuccess, h.time.now());
	assert.equal([...h.time.timers.values()][0].at, h.time.now() + 30000);
	await h.time.advance(29999);
	assert.equal(h.queries.length, 1);
	await h.time.advance(1);
	assert.equal(h.queries.length, 2);
	h.controller.stop();
	h.queries[1].resolve({ present: true });
	await flush();

	// Transport and malformed responses preserve both the previous values and
	// their timestamp; recovery clears the error, absence is a valid result.
	const recovery = harness();
	recovery.controller.start();
	const original = recovery.controller.state().status;
	for (const invalid of [ {}, null, [], { present: 'false' }, { present: 0 } ]) {
		const result = recovery.controller.refresh();
		await flush();
		recovery.queries.at(-1).resolve(invalid);
		assert.equal(await result, false);
		assert.strictEqual(recovery.controller.state().status, original);
		assert.equal(recovery.controller.state().lastSuccess, 500);
		assert.match(recovery.controller.state().error, /некорректный ответ/);
	}
	let result = recovery.controller.refresh();
	await flush();
	recovery.queries.at(-1).reject(new Error('RPC timeout'));
	assert.equal(await result, false);
	assert.equal(recovery.controller.state().error, 'RPC timeout');
	await recovery.time.advance(10);
	result = recovery.controller.refresh();
	await flush();
	recovery.queries.at(-1).resolve({ present: false });
	assert.equal(await result, true);
	assert.deepEqual(recovery.controller.state().status, { present: false });
	assert.equal(recovery.controller.state().error, null);
	assert.equal(recovery.controller.state().lastSuccess, recovery.time.now());
	result = recovery.controller.refresh();
	await flush();
	recovery.queries.at(-1).resolve({ present: true, model: 'reconnected' });
	await result;
	assert.equal(recovery.controller.state().status.model, 'reconnected');
	recovery.controller.stop();

	// Off means manual-only, including after hidden or BFCache transitions.
	const off = harness();
	off.controller.start();
	assert.equal(off.controller.setInterval(0), true);
	await off.time.advance(300000);
	off.hide(); off.show();
	off.controller.suspend(); off.controller.resume();
	await flush();
	assert.equal(off.queries.length, 0);
	result = off.controller.refresh();
	await flush();
	assert.equal(off.queries.length, 1);
	off.queries[0].resolve({ present: true }); await result;
	assert.equal(off.time.timers.size, 0);
	for (const invalid of [ -1, 1, 20000, '30000', NaN, null, undefined, Infinity ]) {
		assert.equal(off.controller.setInterval(invalid), false);
		assert.equal(off.controller.state().interval, 0);
	}
	for (const valid of [ 10000, 30000, 60000 ]) {
		assert.equal(off.controller.setInterval(valid), true);
		assert.equal([...off.time.timers.values()][0].at, off.time.now() + valid);
		assert.equal(off.queries.length, 1);
	}
	off.controller.stop();

	// Hidden pages produce no future requests; resume performs one refresh.
	// If an earlier request is still pending, resume coalesces that request.
	const visibility = harness();
	visibility.controller.start(); visibility.hide();
	await visibility.time.advance(120000);
	assert.equal(await visibility.controller.refresh(), false);
	assert.equal(visibility.queries.length, 0);
	visibility.show(); await flush();
	assert.equal(visibility.queries.length, 1);
	visibility.hide(); visibility.show(); await flush();
	assert.equal(visibility.queries.length, 1);
	visibility.hide();
	visibility.queries[0].reject(new Error('hidden failure')); await flush();
	assert.equal(visibility.controller.state().error, 'hidden failure');
	assert.equal(visibility.controller.state().status.model, 'first');
	assert.equal(visibility.time.timers.size, 0);
	await visibility.time.advance(120000);
	assert.equal(visibility.queries.length, 1);
	visibility.show(); await flush();
	assert.equal(visibility.queries.length, 2);
	visibility.queries[1].resolve({ present: true }); await flush();
	assert.equal(visibility.controller.state().error, null);
	assert.equal(visibility.time.timers.size, 1);
	visibility.controller.stop();

	// Initial failure remains an error state with retry scheduling, never an
	// invented modem-absent state. Disposal ignores in-flight completions.
	const failed = harness({ error: 'initial failure' });
	failed.controller.start();
	assert.equal(failed.controller.state().status, null);
	assert.equal(failed.controller.state().lastSuccess, null);
	assert.equal(failed.controller.state().error, 'initial failure');
	await failed.time.advance(30000);
	assert.equal(failed.queries.length, 1);
	const stateCount = failed.states.length;
	failed.controller.stop();
	failed.queries[0].resolve({ present: true, model: 'too late' }); await flush();
	assert.equal(failed.states.length, stateCount);
	assert.equal(failed.controller.state().status, null);
	assert.equal(failed.controller.state().lastSuccess, null);
	assert.equal(failed.time.timers.size, 0);
	assert.equal(await failed.controller.refresh(), false);
	assert.equal(failed.controller.setInterval(10000), false);
	failed.controller.start(); failed.show(); failed.controller.resume();
	await failed.time.advance(120000);
	assert.equal(failed.queries.length, 1);
}

async function lifecycleTests() {
	const h = harness(), doc = eventTarget(), page = eventTarget(), Observer = observerType();
	doc.documentElement = {};
	const root = { isConnected: false };
	helpers.bindRefreshLifecycle(root, h.controller, doc, page, Observer);
	assert.equal(h.time.timers.size, 0);
	root.isConnected = true; Observer.instances[0].emit();
	assert.equal(h.time.timers.size, 1);
	Observer.instances[0].emit();
	assert.equal(h.time.timers.size, 1);
	page.emit('pagehide', { persisted: true });
	assert.equal(h.time.timers.size, 0);
	await h.time.advance(120000);
	assert.equal(h.queries.length, 0);
	page.emit('pageshow', { persisted: true }); await flush();
	assert.equal(h.queries.length, 1);
	root.isConnected = false; Observer.instances[0].emit();
	assert.equal(h.controller.state().stopped, true);
	assert.equal(Observer.instances[0].connected, false);
	assert.equal(doc.listeners.size, 0);
	assert.equal(page.listeners.size, 0);
	const count = h.states.length;
	h.queries[0].resolve({ present: true }); await flush();
	assert.equal(h.states.length, count);
	assert.equal(h.time.timers.size, 0);

	const away = harness(), awayDoc = eventTarget(), awayPage = eventTarget(), AwayObserver = observerType();
	awayDoc.documentElement = {};
	helpers.bindRefreshLifecycle({ isConnected: true }, away.controller, awayDoc, awayPage, AwayObserver);
	away.controller.setInterval(0);
	awayPage.emit('pagehide', { persisted: true });
	awayPage.emit('pageshow', { persisted: true }); await flush();
	assert.equal(away.queries.length, 0);
	const manual = away.controller.refresh(); await flush();
	assert.equal(away.queries.length, 1);
	away.queries[0].resolve({ present: true }); await manual;
	assert.equal(away.time.timers.size, 0);
	const lateFailure = away.controller.refresh(); await flush();
	awayPage.emit('pagehide', { persisted: false });
	const finalStateCount = away.states.length;
	away.queries[1].reject(new Error('detached query failed'));
	assert.equal(await lateFailure, false);
	assert.equal(away.states.length, finalStateCount);
	assert.equal(away.controller.state().error, null);
	assert.equal(away.controller.state().stopped, true);
	assert.equal(awayDoc.listeners.size, 0);
	assert.equal(awayPage.listeners.size, 0);
	assert.equal(AwayObserver.instances[0].connected, false);
}

// Lightweight DOM verifies rendered recovery, retained values and toolbar
// behavior using the actual view wrapper, in addition to the controller tests.
class Node {
	constructor(tag, attrs, children) {
		this.tag = tag; this.attrs = attrs || {}; this.children = children || [];
		this.isConnected = false;
	}
	get firstChild() { return this.children[0]; }
	appendChild(node) { this.children.push(node); return node; }
	removeChild(node) { this.children.splice(this.children.indexOf(node), 1); }
	get textContent() { return this.children.map(node => node instanceof Node ? node.textContent : String(node)).join(''); }
	set textContent(value) { this.children = [ String(value) ]; }
}
function element(tag, attrs, children) {
	return Array.isArray(tag) ? new Node(null, {}, attrs) : new Node(tag, attrs, children);
}
function findNode(root, predicate) {
	if (!(root instanceof Node)) return null;
	if (predicate(root)) return root;
	for (const child of root.children) {
		const result = findNode(child, predicate);
		if (result) return result;
	}
	return null;
}
async function viewTests() {
	const time = clock(), doc = eventTarget(), pageWindow = eventTarget(), Observer = observerType(), queries = [];
	doc.hidden = false; doc.documentElement = {};
	pageWindow.setTimeout = time.setTimer; pageWindow.clearTimeout = time.clearTimer;
	const page = new Function('view', 'rpc', '_', 'E', 'document', 'window', 'MutationObserver', source)(
		{ extend: value => value },
		{ declare: () => () => { const query = deferred(); queries.push(query); return query.promise; } },
		value => value, element, doc, pageWindow, Observer);
	let loaded = page.load(); await flush();
	queries[0].reject(new Error('first RPC failed'));
	const initial = await loaded;
	assert.deepEqual(initial, { error: 'first RPC failed' });
	const root = page.render(initial);
	assert.match(root.textContent, /Автообновление/);
	assert.match(root.textContent, /Не удалось обновить данные/);
	assert.match(root.textContent, /Данные модема пока не получены/);
	assert.doesNotMatch(root.textContent, /Модем не обнаружен/);
	root.isConnected = true; Observer.instances[0].emit();
	const button = findNode(root, node => node.tag === 'button');
	let done = button.attrs.click(); await flush();
	queries[1].resolve({ present: true, model: 'T99 test fixture' }); await done;
	assert.match(root.textContent, /T99 test fixture/);
	assert.match(root.textContent, /Последнее успешное обновление/);
	assert.doesNotMatch(root.textContent, /Не удалось обновить данные/);
	done = button.attrs.click(); await flush();
	assert.equal(button.disabled, true);
	queries[2].reject(new Error('later RPC failed')); await done;
	assert.equal(button.disabled, false);
	assert.match(root.textContent, /Показаны последние полученные значения/);
	assert.match(root.textContent, /T99 test fixture/);
	done = button.attrs.click(); await flush();
	queries[3].resolve({ present: false }); await done;
	assert.match(root.textContent, /Модем не обнаружен/);
	assert.doesNotMatch(root.textContent, /T99 test fixture|последние полученные значения/);
	assert.match(root.textContent, /Автообновление/);
	pageWindow.emit('pagehide', { persisted: false });

	loaded = page.load(); await flush();
	queries[4].resolve({});
	assert.match((await loaded).error, /некорректный ответ/);
}

(async function() {
	await schedulerTests();
	await lifecycleTests();
	await viewTests();
	console.log('VT_MODEM_STATUS_REFRESH_TESTS_OK');
})().catch(error => { console.error(error); process.exitCode = 1; });
