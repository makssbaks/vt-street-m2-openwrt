'use strict';
import { readfile } from 'fs';
import { validate_request, run_sms_job, public_job } from '../../package/vtmodem/files/usr/share/vtmodem/sms-jobs.uc';
let id = '0123456789abcdef0123456789abcdef';
assert(validate_request('list', { request_id: id }) == null, 'Valid list id');
for (let bad in [ '', '../x', 'a;touch /tmp/x', 'A23456789abcdef0123456789abcdef012' ])
	assert(validate_request('list', { request_id: bad }) != null, 'Reject non-filename id');
assert(validate_request('send', { request_id: id, phone: '+123456789', text: "it's a $literal; $(test)" }) == null, 'Message contents are data, not shell code');
assert(validate_request('send', { request_id: id, phone: '+1;reboot', text: 'test' }) != null, 'Recipient validated');
assert(validate_request('send', { request_id: id, phone: '+123', text: 'a' + chr(0) + 'b' }) != null, 'Embedded NUL cannot be truncated silently by process argv');
assert(validate_request('send', { request_id: id, phone: '+123', text: sprintf('%16384s', '') }) != null, 'Text bound matches C byte buffer limit');
let parts = [ { id: 5, fingerprint: '0011AB' }, { id: 6, fingerprint: 'FF22' } ];
assert(validate_request('delete', { request_id: id, messages: parts }) == null, 'Delete binds ids to exact PDU fingerprints');
assert(validate_request('delete', { request_id: id, messages: [ { id: 5, fingerprint: 'AA' } ] }) != null, 'One-byte fingerprint rejected like the C helper');
let max_fingerprint = '';
for (let n = 0; n < 512; n++) max_fingerprint += 'AA';
assert(validate_request('delete', { request_id: id, messages: [ { id: 5, fingerprint: max_fingerprint } ] }) == null, 'Maximum 512-byte fingerprint is valid');
for (let bad in [ '', 'A', 'AAA', 'aa', 'AAZZ', max_fingerprint + 'AA' ])
	assert(validate_request('delete', { request_id: id, messages: [ { id: 5, fingerprint: bad } ] }) != null, 'Malformed fingerprint rejected without unsupported regexp syntax');
assert(validate_request('delete', { request_id: id, messages: [ parts[0], parts[0] ] }) != null, 'Duplicate indexes rejected');
let m = { type: 't99w175', generation: '1-1:4', at_port: '/dev/t99w175-at' };
let job = { id, kind: 'send', state: 'queued', generation: m.generation, args: { phone: '+12345', text: 'test' } };
let calls = [];
let result = run_sms_job(job, m, (argv, deadline) => { push(calls, { argv, deadline }); return { ok: false, output: '{"ok":false,"parts_total":2,"parts_confirmed":1,"failed_part":2,"outcome_unknown":true}' }; }, () => 0);
assert(result.parts_confirmed == 1 && result.outcome_unknown && length(calls) == 1, 'Partial send is never retried and preserves confirmed/unknown outcome');
assert(calls[0].argv[2] == '240000' && calls[0].deadline == 240250, 'Send has one total deadline plus small supervisor margin');
job.kind = 'delete'; job.args = { messages: parts }; calls = [];
result = run_sms_job(job, m, (argv, deadline) => {
	push(calls, argv);
	return length(calls) == 1 ? { ok: true, output: '{"ok":true}' } :
		{ ok: false, output: '{"ok":false,"code":"message_changed","error":"Message changed","outcome_unknown":false}' };
}, () => 0);
assert(!result.ok && result.deleted == 1 && result.total == 2 && !result.outcome_unknown, 'Partial deletion reports exactly confirmed parts');
assert(calls[0][6] == '5' && calls[0][7] == '0011AB', 'Worker sends exact PDU to atomic compare-and-delete helper');
calls = [];
result = run_sms_job(job, { ...m, generation: '1-1:5' }, (argv) => push(calls, argv), () => 0);
assert(!result.ok && !result.outcome_unknown && length(calls) == 0, 'Queued job does not execute on a replacement modem');
job.kind = 'send';
result = run_sms_job(job, m, () => ({ ok: false, output: '' }), () => 0);
assert(!result.ok && result.outcome_unknown, 'Missing write result stays unknown, never retry_safe');
let pub = public_job({ id, kind: 'send', state: 'running', args: { phone: 'private', text: 'private' }, result: null });
assert(pub.args == null && pub.state == 'running', 'Polling does not expose stored request contents');

// Execute the actual filesystem coordinator with an in-memory atomic mkdir and
// JSON-file adapter. No target paths, modem operations or messages are touched.
let source = readfile('package/vtmodem/files/usr/share/vtmodem/sms-jobs.uc');
let body = substr(source, index(source, 'const JOB_DIR'), index(source, 'export {') - index(source, 'const JOB_DIR'));
let harness = loadstring(`
const CACHE_DIR = '/test';
let files = {}, dirs = { '/test/jobs': true }, tick = 1000, held = false;
function monotonic_ms() { return tick; }
function read_json(p) { return files[p] == null ? null : json(files[p]); }
function write_json(p, v) { files[p] = sprintf('%J', v); return true; }
function open(p, mode) { let owner = false; return { lock: () => { if (held) return false; held = true; owner = true; return true; }, close: () => { if (owner) held = false; return true; } }; }
function mkdir(p) { if (dirs[p]) return false; dirs[p] = true; return true; }
function rmdir(p) { delete dirs[p]; return true; }
function unlink(p) { delete files[p]; return true; }
function access(p) { return dirs[p] === true || files[p] != null; }
function glob(p) { return filter(keys(files), key => index(key, '/test/jobs/') == 0 && length(key) == 48); }
` + body + `
return { start: sms_start, status: sms_job_status, recover: recover_interrupted_job, orphan: recover_orphaned_claim,
 finish: finish_job, read: read_json, write: write_json, dirs, hold: v => held = v,
 heartbeat: () => write_json('/test/heartbeat.json', { monotonic_ms: tick }) };
`, { raw_mode: true })();
harness.heartbeat();
let req = { request_id: id, phone: '+12345', text: 'original' };
let accepted = harness.start('send', req, m);
assert(accepted.ok && accepted.state == 'queued' && accepted.job_id == id, 'Start only publishes a queued request');
let repeated = harness.start('send', { ...req, text: 'changed' }, m);
assert(repeated.ok && repeated.job_id == id && harness.read('/test/jobs/' + id + '.json').args.text == 'original', 'Request replay retrieves the same job without rewriting or resending its contents');
let busy = harness.start('send', { ...req, request_id: '1123456789abcdef0123456789abcdef' }, m);
assert(!busy.ok && busy.retry_safe && busy.error_code == 'busy', 'A second request is rejected before acceptance');
let started = harness.read('/test/jobs/' + id + '.json'); started.state = 'running';
harness.write('/test/jobs/' + id + '.json', started);
harness.recover();
let recovered = harness.status(id);
assert(recovered.ok && recovered.state == 'done' && recovered.result.outcome_unknown, 'Process restart turns running writes into unknown outcome and never replays them');
repeated = harness.start('send', req, null);
assert(repeated.ok && repeated.state == 'done' && repeated.result.outcome_unknown, 'A duplicate completed request stays deduplicated even without a modem');
let missing = harness.status('2123456789abcdef0123456789abcdef');
assert(!missing.ok && missing.error_code == 'not_found' && missing.retry_safe === false, 'Missing/expired write outcome never authorizes retry');
harness.hold(true);
let publishing = harness.start('send', { ...req, request_id: '4123456789abcdef0123456789abcdef' }, m);
assert(!publishing.ok && publishing.retry_safe === false, 'Concurrent publication cannot incorrectly promise a same-id request was never accepted');
harness.dirs['/test/jobs/active'] = true;
harness.orphan();
assert(harness.dirs['/test/jobs/active'], 'Recovery never removes a claim while start holds the transaction mutex');
harness.hold(false);
let orphan = { id: '3123456789abcdef0123456789abcdef', kind: 'send', state: 'queued', args: req };
harness.write('/test/jobs/' + orphan.id + '.json', orphan);
harness.orphan();
assert(!harness.dirs['/test/jobs/active'] && harness.status(orphan.id).result.outcome_unknown === false,
	'Live collector recovers rpcd-crash orphan claim before execution without restarting service');
let completed = harness.read('/test/jobs/' + id + '.json');
assert(completed.args === null && completed.result.outcome_unknown, 'Completed writes strip recipient, text and fingerprints while preserving deduplication outcome');
for (let n = 100; n < 164; n++) harness.write('/test/jobs/' + sprintf('%032x', n) + '.json',
	{ id: sprintf('%032x', n), kind: 'send', state: 'done', finished_ms: 1000, result: { ok: true } });
let full = harness.start('send', { ...req, request_id: '5123456789abcdef0123456789abcdef' }, m);
assert(!full.ok && full.retry_safe && full.error_code == 'storage_full', 'Record cap refuses before executing or evicting recent deduplication history');
print('VTMODEM_SMS_JOB_TESTS_OK\n');

