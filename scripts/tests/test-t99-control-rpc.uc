'use strict';
import { readfile } from 'fs';

let source = readfile('package/vtmodem/files/usr/share/rpcd/ucode/vtmodem');
let begin = index(source, 'function radio_call('), end = index(source, 'const methods = {');
assert(begin >= 0 && end > begin, 'Locate actual radio RPC boundary');
let prelude = 'let calls = []; let reply = { output: "{\\"ok\\":true,\\"supported\\":true}", rc: 0 };\n' +
	'function shellquote(s) { return "[" + s + "]"; }\n' +
	'function popen(cmd) { push(calls, cmd); return { read: () => reply.output, close: () => reply.rc }; }\n';
let rpc = loadstring(prelude + substr(source, begin, end - begin) +
	'\nreturn { call: radio_call, calls, reply };', { raw_mode: true })();
let modem = { type: 't99w175', at_port: '/dev/t99w175-at' };
for (let m in [ null, { type: 'fibocom-l860' } ]) {
	let r = rpc.call(m, { action: 'status' });
	assert(r.ok === false && r.supported === false, 'Unsupported modems rejected');
}
for (let args in [
	{ action: 'mode', value: '1,2', expected: '{}', confirm: false },
	{ action: 'mode', value: '1,2', expected: '{}', confirm: 'true' },
	{ action: 'reset', value: '', expected: '{}', confirm: true },
	{ action: 'bands', value: [], expected: '{}', confirm: true },
	{ action: 'lock', value: '213,1275', expected: '', confirm: true },
	{ action: 'mode', value: sprintf('%1025s', ''), expected: '{}', confirm: true },
	{ action: 'mode', value: '1,2', expected: sprintf('%8193s', ''), confirm: true }
]) {
	let r = rpc.call(modem, args);
	assert(r.ok === false && r.changed === false, 'Invalid/unconfirmed writes rejected before launcher');
}
assert(length(rpc.calls) === 0, 'No launcher called for rejected requests');
assert(rpc.call(modem, { action: 'status' }).ok === true, 'Read request reaches fixed helper');
assert(index(rpc.calls[0], '/usr/libexec/vtmodem-radio ') === 0, 'Fixed launcher only');

let change = { action: 'mode', value: '1,2', expected: '{}', confirm: true };
for (let malformed in [ '', '[]', 'null', '{broken', '{"ok":"true"}', sprintf('%32769s', '') ]) {
	rpc.reply.output = malformed;
	let r = rpc.call(modem, change);
	assert(r.ok === false && r.changed === true && r.verified === false, 'Uncertain result never reports unchanged/success');
}
rpc.reply.output = '{"ok":true}'; rpc.reply.rc = 1;
assert(rpc.call(modem, change).ok === false, 'Child failure cannot become a success');
rpc.reply.rc = 0; rpc.reply.output = '{"ok":false,"changed":false,"verified":false,"error":"busy"}';
assert(rpc.call(modem, change).changed === false, 'Known lock-busy refusal preserved');

let acl = json(readfile('package/vtmodem/files/usr/share/rpcd/acl.d/luci-app-vtmodem.json'))['luci-app-vtmodem'];
assert(index(acl.read.ubus.vtmodem, 'radio_status') >= 0, 'Read permission includes status');
assert(index(acl.read.ubus.vtmodem, 'radio_apply') < 0, 'Read permission cannot write radio');
assert(index(acl.write.ubus.vtmodem, 'radio_apply') >= 0, 'Write permission explicitly controls radio apply');
assert(index(acl.read.ubus.vtmodem, 'sms_list_start') >= 0 && index(acl.read.ubus.vtmodem, 'sms_job_status') >= 0 && index(acl.write.ubus.vtmodem, 'sms_send_start') >= 0 && index(acl.write.ubus.vtmodem, 'sms_delete_start') >= 0, 'Async SMS list/poll reads and send/delete writes remain separately authorized');
print('T99_CONTROL_RPC_TESTS_OK\n');
