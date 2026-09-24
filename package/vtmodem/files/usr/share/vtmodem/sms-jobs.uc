'use strict';

import { open, access, mkdir, rmdir, unlink, glob, chmod, readfile } from 'fs';
import { CACHE_DIR, read_json, write_json, monotonic_ms } from './telemetry-cache.uc';

const JOB_DIR = CACHE_DIR + '/jobs';
const ACTIVE_DIR = JOB_DIR + '/active';
const RETAIN_MS = 86400000;
const MAX_JOBS = 64;
function valid_id(id) { return type(id) == 'string' && match(id, /^[0-9a-f]{32}$/) != null; }
function refused(id, code, message) {
	return { ok: false, job_id: id, error_code: code, error: message, retry_safe: true };
}
function public_job(job) {
	return { ok: true, supported: true, job_id: job.id, state: job.state,
		kind: job.kind, created_at: job.created_at,
		result: job.state == 'done' ? job.result : null };
}
function validate_request(kind, args) {
	if (!valid_id(args?.request_id)) return 'A 32-digit hexadecimal request id is required';
	if (kind == 'list') return null;
	if (kind == 'send') {
		if (type(args.phone) != 'string' || !match(args.phone, /^\+?[0-9]{1,20}$/))
			return 'Invalid recipient number';
		if (type(args.text) != 'string' || !length(args.text) || length(args.text) >= 16384 || index(args.text, chr(0)) >= 0)
			return 'SMS text is empty or too large';
		return null;
	}
	if (kind != 'delete' || type(args.messages) != 'array' || !length(args.messages) || length(args.messages) > 64)
		return 'Select between 1 and 64 message parts';
	let seen = {};
	for (let m in args.messages) {
		if (type(m) != 'object' || type(m.id) != 'int' || m.id < 0 || m.id > 65535 ||
			type(m.fingerprint) != 'string' || length(m.fingerprint) < 4 ||
			length(m.fingerprint) > 1024 || length(m.fingerprint) % 2 != 0 ||
			!match(m.fingerprint, /^[0-9A-F]+$/) || seen[m.id])
			return 'Invalid or duplicated message identity; refresh the inbox';
		seen[m.id] = true;
	}
	return null;
}
function sms_job_status(id) {
	if (!valid_id(id)) return refused(id, 'invalid_request', 'Invalid job id');
	let job = read_json(JOB_DIR + '/' + id + '.json', 262144);
	if (type(job) != 'object' || job.id != id)
		return { ok: false, job_id: id, error_code: 'not_found', retry_safe: false,
			error: 'Job not found or expired; do not automatically repeat a write' };
	return public_job(job);
}
function prune_jobs(now) {
	let count = 0;
	for (let p in glob(JOB_DIR + '/*.json')) {
		let job = read_json(p, 262144);
		if (job?.state == 'done' && now - job.finished_ms > (job.kind == 'list' ? 300000 : RETAIN_MS))
			unlink(p);
		else count++;
	}
	return count;
}
function enqueue_sms(kind, args, modem) {
	let id = args?.request_id;
	let error = validate_request(kind, args);
	if (error) return refused(id, 'invalid_request', error);
	// Lookup precedes hardware checks and locking. A repeated transport request
	// always retrieves its prior outcome, including while the modem is absent.
	let existing = read_json(JOB_DIR + '/' + id + '.json', 262144);
	if (existing?.id == id) return public_job(existing);
	if (!modem || modem.type != 't99w175') return refused(id, 'unsupported', 'A connected T99W175 is required');
	let now = monotonic_ms();
	let heartbeat = read_json(CACHE_DIR + '/heartbeat.json');
	if (type(heartbeat?.monotonic_ms) != 'int' || now - heartbeat.monotonic_ms > 15000)
		return refused(id, access(ACTIVE_DIR) ? 'busy' : 'service_unavailable',
			access(ACTIVE_DIR) ? 'Another SMS operation is active' : 'Telemetry/SMS service is not ready');
	if (!mkdir(ACTIVE_DIR, 0700)) return refused(id, 'busy', 'Another SMS operation is active');
	// Another rpcd worker may have completed this same id between the first
	// lookup and our successful claim. Recheck while owning the claim.
	existing = read_json(JOB_DIR + '/' + id + '.json', 262144);
	if (existing?.id == id) { rmdir(ACTIVE_DIR); return public_job(existing); }
	// All rpcd starts are serialized with this atomic directory claim, while
	// the sole service worker exclusively finishes and releases an accepted job.
	if (prune_jobs(now) >= MAX_JOBS) {
		rmdir(ACTIVE_DIR);
		return refused(id, 'storage_full', 'Job history is full; retry after old records expire');
	}
	let job = { id, kind, state: 'queued', generation: modem.generation,
		device: modem.at_port, created_at: time(), created_ms: now, args,
		result: null };
	if (!write_json(JOB_DIR + '/' + id + '.json', job)) {
		rmdir(ACTIVE_DIR);
		return refused(id, 'storage_error', 'Unable to save the request');
	}
	if (!write_json(ACTIVE_DIR + '/request.json', { id })) {
		unlink(JOB_DIR + '/' + id + '.json');
		rmdir(ACTIVE_DIR);
		return refused(id, 'storage_error', 'Unable to queue the request');
	}
	return public_job(job);
}
function transaction_lock() {
	let fd = open(JOB_DIR + '/enqueue.lock', 'w');
	if (fd && fd.lock('xn')) return fd;
	if (fd) fd.close();
	return null;
}
function sms_start(kind, args, modem) {
	let error = validate_request(kind, args);
	if (error) return refused(args?.request_id, 'invalid_request', error);
	let old = read_json(JOB_DIR + '/' + args.request_id + '.json', 262144);
	if (old?.id == args.request_id) return public_job(old);
	if (!access(JOB_DIR)) return refused(args.request_id, 'service_unavailable', 'Telemetry/SMS service is not ready');
	let lock = transaction_lock();
	if (!lock) return { ok: false, job_id: args.request_id, error_code: 'publishing', retry_safe: false,
		error: 'A concurrent request may still be publishing; check this job id before retrying' };
	let result;
	try { result = enqueue_sms(kind, args, modem); }
	catch (e) {
		let accepted = read_json(JOB_DIR + '/' + args.request_id + '.json', 262144);
		result = accepted?.id == args.request_id ? public_job(accepted) :
			refused(args.request_id, 'storage_error', 'Unable to save the request');
	}
	lock.close();
	return result;
}
function finish_job(job, result) {
	job.state = 'done'; job.result = result; job.finished_ms = monotonic_ms();
	// Erase message text, phone and full fingerprints from terminal requests.
	// Results remain private until garbage collection; list results contain SMS.
	job.args = null;
	if (!write_json(JOB_DIR + '/' + job.id + '.json', job)) return false;
	unlink(ACTIVE_DIR + '/request.json');
	rmdir(ACTIVE_DIR);
	return true;
}
function uncertain_result(kind, error) {
	return { ok: false, supported: true, error, outcome_unknown: kind != 'list' };
}
function recover_job_state(interrupted) {
	// This runs only after the singleton service lock was acquired. A job that
	// reached running can never be replayed following a process restart.
	let active = read_json(ACTIVE_DIR + '/request.json');
	if (valid_id(active?.id)) {
		let job = read_json(JOB_DIR + '/' + active.id + '.json', 262144);
		if (interrupted && job?.state == 'running') finish_job(job, uncertain_result(job.kind, 'Worker interrupted; inspect the result before retrying'));
		else if (job?.state == 'done') {
			unlink(ACTIVE_DIR + '/request.json'); rmdir(ACTIVE_DIR);
		}
	}
	else if (access(ACTIVE_DIR)) {
		// A crash between record publication and active-id publication must not
		// leave a queued operation that a later process might silently execute.
		for (let p in glob(JOB_DIR + '/*.json')) {
			let job = read_json(p, 262144);
			if (job?.state == 'queued') finish_job(job, { ok: false, supported: true,
				outcome_unknown: false, error: 'Request interrupted before execution' });
		}
		unlink(ACTIVE_DIR + '/request.json.new'); rmdir(ACTIVE_DIR);
	}
}
function recover_jobs(interrupted) {
	// The enqueue mutex is an OS flock, released on rpcd exit. It prevents
	// cleanup from racing a live start between mkdir and request publication.
	let lock = transaction_lock();
	if (!lock) return;
	try { recover_job_state(interrupted); } catch (e) {}
	lock.close();
}
function recover_interrupted_job() { recover_jobs(true); }
function recover_orphaned_claim() { recover_jobs(false); }
function maintain_jobs() {
	let lock = transaction_lock();
	if (!lock) return;
	try { prune_jobs(monotonic_ms()); } catch (e) {}
	lock.close();
}
function active_job() {
	let active = read_json(ACTIVE_DIR + '/request.json');
	return valid_id(active?.id) ? read_json(JOB_DIR + '/' + active.id + '.json', 262144) : null;
}
function run_sms_job(job, modem, runner, now) {
	if (job.state != 'queued') return uncertain_result(job.kind, 'This request has already started');
	if (!modem || modem.generation != job.generation || modem.type != 't99w175')
		return { ok: false, supported: true, outcome_unknown: false, error: 'Modem changed before the request started' };
	let timeout = job.kind == 'send' ? 240000 : 20000;
	let deadline = now() + timeout;
	function call(args) {
		let remaining = deadline - now();
		if (remaining < 100) return { ok: false, outcome_unknown: false, error: 'SMS operation deadline reached' };
		let argv = [ '/usr/bin/vt-sms', '-t', sprintf('%d', remaining), '-d', modem.at_port ];
		for (let arg in args) push(argv, arg);
		let reply = runner(argv, remaining + 250);
		try {
			let result = json(reply.output);
			if (type(result) == 'object' && type(result.ok) == 'bool') {
				if (!reply.ok && result.ok) return uncertain_result(job.kind, 'Worker exit did not confirm success');
				return result;
			}
		} catch (e) {}
		return uncertain_result(job.kind, 'No complete result from SMS worker');
	}
	if (job.kind == 'list') return call([ 'list' ]);
	if (job.kind == 'send') return call([ 'send', job.args.phone, job.args.text ]);
	let result = { ok: true, deleted: 0, total: length(job.args.messages), outcome_unknown: false };
	for (let m in job.args.messages) {
		let part = call([ 'delete', sprintf('%d', m.id), m.fingerprint ]);
		if (!part.ok) {
			result.ok = false; result.error = part.error ?? 'Message part could not be deleted';
			result.error_code = part.error_code ?? part.code;
			result.outcome_unknown = part.outcome_unknown === true;
			break;
		}
		result.deleted++;
	}
	return result;
}
export { JOB_DIR, ACTIVE_DIR, valid_id, validate_request, public_job, sms_start,
	sms_job_status, active_job, finish_job, recover_interrupted_job, recover_orphaned_claim, maintain_jobs, run_sms_job };
