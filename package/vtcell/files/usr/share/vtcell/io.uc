'use strict';
import { open, readfile, mkstemp, writefile, rename, chmod } from 'fs';
function now() { let c=clock(true); return c[0]*1000+int(c[1]/1000000); }
function read_json(path, limit) {
	let f=open(path,'r'); if (!f) return null;
	let s=f.read((limit ?? 131072)+1); f.close();
	try { return length(s ?? '') <= (limit ?? 131072) ? json(s) : null; } catch(e) { return null; }
}
function write_json(path, data) {
	let s=sprintf('%J\n',data), tmp=path+'.new';
	return writefile(tmp,s) == length(s) && chmod(tmp,0600) && rename(tmp,path);
}
function run(argv) {
	let f=mkstemp(); if (!f) return null;
	let a=[]; for (let v in argv) push(a,"'"+replace(v,"'","'\\''")+"'");
	let out=null;
	try {
		let rc=system('LC_ALL=C exec '+join(' ',a)+' >/proc/self/fd/'+f.fileno()+' 2>/dev/null',3500);
		f.seek(0); let s=f.read(131073) ?? '';
		if (rc == 0 && length(s) <= 131072) out=json(s);
	} catch(e) {}
	f.close(); return out;
}
function boot() { return trim(readfile('/proc/sys/kernel/random/boot_id') ?? ''); }
export { now, read_json, write_json, run, boot };
