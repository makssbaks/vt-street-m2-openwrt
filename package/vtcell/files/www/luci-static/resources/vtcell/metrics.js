'use strict';
'require baseclass';
var limits = {
 rsrp: { min:-140, max:-65, cuts:[-110,-100,-90], unit:'dBm', title:'RSRP', note:'Мощность опорного сигнала' },
 rsrq: { min:-25, max:-3, cuts:[-20,-15,-10], unit:'dB', title:'RSRQ', note:'Качество опорного сигнала' },
 snr:  { min:-10, max:30, cuts:[0,10,20], unit:'dB', title:'SNR / SINR', note:'Отношение сигнала к шуму' },
 rssi: { min:-110, max:-50, cuts:[-95,-85,-75], unit:'dBm', title:'RSSI', note:'Общая принимаемая мощность' }
};
function reading(key, value) {
 var spec=limits[key], valid=typeof value==='number' && Number.isFinite(value);
 if (!spec) return null;
 var level=valid ? spec.cuts.filter(function(v){return value>=v;}).length : -1;
 return { title:spec.title, unit:spec.unit, note:spec.note, value:valid?value:null,
  text:valid?String(Math.round(value*10)/10):'—', level:level,
  percent:valid?Math.max(0,Math.min(100,(value-spec.min)/(spec.max-spec.min)*100)):0,
  label:level<0?'Нет данных':['Слабый','Средний','Хороший','Отличный'][level] };
}
function primary(data) {
 return (Array.isArray(data.cells)?data.cells:[]).find(function(c){return c.serving && c.rat==='LTE' && c.ci!=null;}) ||
  (Array.isArray(data.cells)?data.cells:[]).find(function(c){return c.serving;}) || null;
}
function snapshot(data) {
 data=data||{}; var c=primary(data), s=(data.signal||{})[c && c.rat==='NR'?'5g':'lte']||{}, extra=data.extra||{};
 var known=data.available && !data.stale;
 // RSRP/RSRQ from a requested cell sample outrank the cached Signal interface.
 return { cell:known?c:null,
  rsrp:known?(c && c.rsrp!=null?c.rsrp:s.rsrp):null,
  rsrq:known?(c && c.rsrq!=null?c.rsrq:s.rsrq):null,
  snr:known?(s.snr!=null?s.snr:extra.snr!=null?extra.snr:null):null, rssi:known?(s.rssi!=null?s.rssi:null):null,
  snrSource:s.snr!=null?'ModemManager · SNR':extra.snr!=null?'5G Modem · SNR/SINR':'Модем пока не сообщает',
  ca:known?extra.ca:null, temperature:known?extra.temperature:null };
}
return baseclass.extend({reading:reading, primary:primary, snapshot:snapshot});
