'use strict';
import { readfile } from 'fs';
import { valid_request, snapshot, connection_request } from '../../package/vtmodem/files/usr/share/vtmodem/connection.uc';
let boot = '01234567-89ab-cdef-0123-456789abcdef';
function state() { return { proto: 't99w175qmi', up: true, pending: false, available: true, autostart: true,
	data: { qmi_generation: 'usb-test', cid_4: '17', pdh_4: '123' } }; }
function clone(v) { return json(sprintf('%J', v)); }
function harness() {
	let calls = [], records = {}, writes = [], raw = state(), changed_boot = boot;
	let write_ok = true, reserve_ok = true, command_ok = true;
	let io = {
		query: () => clone(raw), boot: () => changed_boot, now: () => 1000,
		read: id => records[id], reserve: () => reserve_ok,
		write: (id, r) => { if (!write_ok) return false; records[id] = clone(r); push(writes, clone(r)); return true; },
		command: m => {
			push(calls, m);
			if (m == 'down') { raw.up = false; raw.pending = false; raw.autostart = false; }
			if (m == 'up') { raw.pending = true; raw.autostart = true; }
			return command_ok;
		}, log: () => {}
	};
	return { io, calls, records, writes, raw,
		boot: v => changed_boot = v, storage: v => write_ok = v,
		capacity: v => reserve_ok = v, command: v => command_ok = v };
}
function req(h, action, id) { return { action, confirm: true,
	request_id: id ?? '0123456789abcdef0123456789abcdef', expected: snapshot(h.raw, boot).token }; }
let h = harness();
let s = connection_request({action: 'status'}, h.io);
assert(s.ok && s.up && s.interface == 'modem' && length(h.calls) == 0 && length(h.writes) == 0, 'Status has no mutation');
for (let raw in [null, {}, {...state(), proto:'qmi'}, {...state(), up:'true'}, {...state(), data: []}])
	assert(snapshot(raw, boot) === null, 'Incomplete/foreign protocol snapshots refused');
assert(snapshot(state(), '') === null, 'Missing boot identity prevents stale write protection bypass');
for (let bad in [null, {}, {...req(h,'connect'), confirm:false}, {...req(h,'reconnect'), action:'up;reboot'},
	{...req(h,'connect'), request_id:'../escape'}, {...req(h,'connect'), expected:[]}, {...req(h,'connect'), request_id:'A123456789abcdef0123456789abcdef'}]) {
	assert(!valid_request(bad), 'Malformed request rejected');
	assert(!connection_request(bad,h.io).accepted && !length(h.calls), 'Invalid request cannot run netifd');
}
let a = req(h,'reconnect');
let result = connection_request(a,h.io);
assert(result.ok && result.accepted && result.changed && result.down_ack && result.up_ack, 'Reconnect acknowledgements reported');
assert(join(',',h.calls) == 'down,up', 'Reconnect is exactly one server-side down/up pair');
assert(h.writes[0].result.outcome_unknown && h.writes[0].result.error_code == 'interrupted', 'Write-ahead receipt precedes execution');
connection_request(a,h.io);
assert(length(h.calls) == 2, 'Replay never reconnects a second time');
assert(connection_request({...a,action:'disconnect'},h.io).error_code == 'id_conflict', 'ID reuse cannot change action');
h = harness(); a = req(h,'reconnect'); h.raw.data.pdh_4 = '456';
assert(connection_request(a,h.io).error_code == 'stale' && !length(h.calls), 'Changed session rejects stale click');
h = harness(); a = req(h,'disconnect'); h.boot('ffffffff-89ab-cdef-0123-456789abcdef');
assert(connection_request(a,h.io).error_code == 'stale' && !length(h.calls), 'Reboot rejects old write token');
h = harness(); h.raw.available = false;
assert(connection_request(req(h,'connect'),h.io).error_code == 'unavailable' && !length(h.calls), 'No reset or forced availability');
assert(connection_request(req(h,'disconnect'),h.io).ok && join(',',h.calls) == 'down', 'Unavailable interface can still be explicitly stopped');
h = harness(); h.storage(false);
assert(connection_request(req(h,'disconnect'),h.io).error_code == 'storage_error' && !length(h.calls), 'Unrecorded mutation prohibited');
h = harness(); h.capacity(false);
assert(connection_request(req(h,'reconnect'),h.io).error_code == 'storage_full' && !length(h.calls), 'Recent receipts not evicted for another write');
h = harness(); result = connection_request(req(h,'connect'),h.io);
assert(result.ok && !result.changed && !length(h.calls), 'Already connected is a no-op');
h = harness(); h.raw.up=false; h.raw.autostart=false;
assert(!connection_request(req(h,'disconnect'),h.io).changed && !length(h.calls), 'Repeated stop is a no-op');
result = connection_request(req(h,'connect','1123456789abcdef0123456789abcdef'),h.io);
assert(result.ok && h.raw.autostart && h.raw.pending && join(',',h.calls)=='up', 'Connect uses only interface up');
h = harness(); h.command(false);
result = connection_request(req(h,'reconnect'),h.io);
assert(!result.ok && result.outcome_unknown && join(',',h.calls)=='down,up', 'Reconnect still requests up if down ack is lost; never claims success');
h = harness(); a=req(h,'reconnect');
h.io.command = method => { push(h.calls,method); die('simulated worker termination'); };
try { connection_request(a,h.io); } catch(e) {}
let count=length(h.calls);
result=connection_request(a,h.io);
assert(result.outcome_unknown && result.error_code=='interrupted' && length(h.calls)==count, 'Interrupted action is not replayed');
// The entire production RPC boundary uses an isolated fixed helper; LAN names,
// generic exec access and destructive modem commands are not caller inputs.
let source=readfile('package/vtmodem/files/usr/share/rpcd/ucode/vtmodem');
let begin=index(source,'function connection_call('), end=index(source,'const methods = {');
let boundary=loadstring('let calls=[]; function shellquote(s){return "["+s+"]";} function popen(cmd){push(calls,cmd);return {read:()=>"{\\"ok\\":true}",close:()=>0};}\n'+substr(source,begin,end-begin)+'\nreturn {call:connection_call,calls};',{raw_mode:true})();
assert(!boundary.call({action:'reconnect',confirm:false}).ok && !length(boundary.calls),'RPC refuses unconfirmed request');
assert(boundary.call({action:'status'}).ok && length(boundary.calls)==1,'RPC status launches fixed helper');
assert(index(boundary.calls[0],'/usr/libexec/vtmodem-connection ')==0,'Fixed launcher');
let acl=json(readfile('package/vtmodem/files/usr/share/rpcd/acl.d/luci-app-vtmodem.json'))['luci-app-vtmodem'];
assert(index(acl.read.ubus.vtmodem,'connection_status')>=0 && index(acl.read.ubus.vtmodem,'connection_action')<0 &&
	index(acl.write.ubus.vtmodem,'connection_action')>=0, 'Read permission cannot mutate session');
print('VTMODEM_CONNECTION_TESTS_OK\n');
