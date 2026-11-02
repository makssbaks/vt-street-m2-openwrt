'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const source=fs.readFileSync(path.join(root,'package/vtcell/files/www/luci-static/resources/vtcell/metrics.js'),'utf8');
const m=vm.runInNewContext('(function(){'+source+'})()',{baseclass:{extend:x=>x}});
for(const value of [null,undefined,'',NaN,Infinity,'-95']) {
 assert.equal(m.reading('rsrp',value).value,null);
 assert.equal(m.reading('rsrp',value).level,-1);
}
assert.equal(m.reading('snr',0).text,'0');
assert.equal(m.reading('rsrp',-82).level,3);
assert.equal(m.reading('rsrq',-9).level,3);
assert.equal(m.reading('rsrp',-110).level,1);
assert.equal(m.reading('rsrp',-200).percent,0);
assert.equal(m.reading('rsrp',0).percent,100);
let data={available:true,stale:false,cells:[{rat:'LTE',serving:true,ci:1,rsrp:-82,rsrq:-9}],signal:{lte:{rssi:-95,snr:0,rsrp:-100}},extra:{snr:14}};
assert.equal(m.snapshot(data).rsrp,-82);
assert.equal(m.snapshot(data).snr,0);
assert.equal(m.snapshot({...data,stale:true}).rsrp,null);
assert.equal(m.snapshot({...data,available:false}).rssi,null);
assert.equal(m.snapshot({...data,signal:null,extra:null}).snr,null);
const ui=fs.readFileSync(path.join(root,'package/vtcell/files/www/luci-static/resources/view/vtcell/status.js'),'utf8');
new Function(ui); // LuCI modules intentionally return at top level.
assert(!ui.includes('innerHTML'));
console.log('VT_CELL_JS_TESTS_OK');
