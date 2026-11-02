'use strict';
import { stat } from 'fs';
import { now, boot, read_json, write_json, run } from './io.uc';
import { cells, signals, general, same_identity, modem_path, external } from './core.uc';
const PATH='/var/run/vtcell/status.json';
function mm(path, args) {
	let argv=['/usr/bin/mmcli','--timeout=2','--output-json'];
	if (path) { push(argv,'--modem'); push(argv,path); }
	for (let arg in args) push(argv,arg);
	return run(argv);
}
function sample() {
	let out={ available:false, error:null, cells:[], signal:null, extra:null, modem:null };
	let path=modem_path(mm(null,['--list-modems']));
	if (!path) { out.error='Нужен один модем в ModemManager'; return out; }
	let before=general(mm(path,[]));
	if (!before) { out.error='ModemManager не ответил'; return out; }
	let cell=cells(mm(path,['--get-cell-info']));
	let cell_at=now();
	let signal=signals(mm(path,['--signal-get']));
	let after=general(mm(path,[]));
	if (!same_identity(before,after)) { out.error='Модем изменился во время опроса'; return out; }
	delete after.identity;
	out.modem=after;
	out.available=true;
	if (index(['registered','connected','connecting'],after.state) < 0) {
		out.error='Модем не зарегистрирован в сети'; return out;
	}
	out.cells=cell ?? [];
	out.cell_age_seconds=(now()-cell_at)/1000;
	out.signal=signal;
	if (cell == null) out.error='Модем не вернул сведения о сотах';
	let primary=null;
	for (let c in out.cells) if (c.serving && c.rat=='LTE' && c.ci != null) { primary=c; break; }
	let a='/tmp/5gmodem/tele.json', b='/tmp/5gmodem/tele_cell.json';
	let sa=stat(a), sb=stat(b), t=time();
	out.extra=external(read_json(a),read_json(b),sa ? t-sa.mtime : null,sb ? t-sb.mtime : null,primary,true);
	return out;
}
while (true) {
	let result;
	try { result=sample(); } catch(e) { result={available:false,error:'Ошибка сбора данных',cells:[]}; }
	result.boot=boot(); result.monotonic_ms=now(); result.updated_at=time();
	write_json(PATH,result);
	sleep(10000);
}
