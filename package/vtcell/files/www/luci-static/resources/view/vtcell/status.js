'use strict';
'require view';
'require rpc';
'require poll';
'require vtcell.metrics as metrics';
var status=rpc.declare({object:'vtcell',method:'status',expect:{},reject:true});
function val(v) { return v===null || v===undefined || v===''?'—':String(v); }
function badge(label,value) { return E('div',{class:'vtc-fact'},[E('small',{},label),E('strong',{},val(value))]); }
function metric(key,value,note) {
 var m=metrics.reading(key,value);
 return E('div',{class:'vtc-metric vtc-level-'+m.level},[
  E('div',{class:'vtc-metric-head'},[E('strong',{},m.title),E('span',{},m.label)]),
  E('div',{class:'vtc-number'},[m.text,E('small',{},m.unit)]),
  E('div',{class:'vtc-track',role:'meter','aria-label':m.title,'aria-valuemin':'0','aria-valuemax':'100','aria-valuenow':m.value===null?null:String(m.percent)},
   E('div',{style:'width:'+m.percent+'%'})),
  E('small',{class:'vtc-note'},note||m.note)
 ]);
}
function table(cells) {
 var labels=['Роль','Сеть','Диапазон','PCI','Канал','RSRP, dBm','RSRQ, dB','Cell ID'];
 var body=[E('tr',{},labels.map(function(x){return E('th',{},x);}))];
 (cells||[]).forEach(function(c){
  body.push(E('tr',{class:c.serving?'vtc-serving':''},[c.serving?'Обслуживает':'Соседняя',c.rat,
   c.band?'B'+c.band:null,c.pci,c.channel,c.rsrp,c.rsrq,c.ci].map(function(x){return E('td',{},val(x));})));
 });
 return E('div',{class:'vtc-scroll'},E('table',{class:'vtc-table'},body));
}
function graph(samples) {
 if (samples.length<2) return E('p',{class:'vtc-muted'},'График появится после двух обновлений. История хранится только пока открыта страница.');
 function svg(tag,attrs,text) {
  var e=document.createElementNS('http://www.w3.org/2000/svg',tag);
  Object.keys(attrs||{}).forEach(function(k){e.setAttribute(k,attrs[k]);});
  if(text!==undefined)e.textContent=text;
  return e;
 }
 var root=svg('svg',{viewBox:'0 0 720 170',role:'img','aria-label':'RSRP текущей соты за время наблюдения'});
 [-120,-100,-80].forEach(function(v){var y=145-(v+140)/80*130; root.appendChild(svg('line',{x1:48,y1:y,x2:700,y2:y,stroke:'currentColor',opacity:'.12'}));root.appendChild(svg('text',{x:4,y:y+4,fill:'currentColor','font-size':12},String(v)));});
 var begin=samples[0].at, span=Math.max(1000,samples[samples.length-1].at-begin);
 var points=samples.map(function(s){return (48+(s.at-begin)/span*652).toFixed(1)+','+(145-(s.value+140)/80*130).toFixed(1);}).join(' ');
 root.appendChild(svg('polyline',{points:points,fill:'none',stroke:'#009e8c','stroke-width':3,'stroke-linejoin':'round'}));
 root.appendChild(svg('text',{x:48,y:165,fill:'currentColor','font-size':12},'RSRP, dBm · текущая сота'));
 return root;
}
function renderData(data,samples) {
 var m=metrics.snapshot(data), c=m.cell||{}, info=data.modem||{}, band=c.band?'B'+c.band:c.rat==='NR'?'NR':'—';
 var healthy=data.available && !data.stale;
 var state={connected:'Подключён',registered:'Зарегистрирован',connecting:'Подключается',searching:'Поиск сети',enabled:'Модем включён'};
 return E('div',{class:'vtc-dashboard'},[
  E('div',{class:'vtc-heading'},[
   E('div',{},[E('div',{class:'vtc-eyebrow'},'WH3000 PRO · МОБИЛЬНАЯ СЕТЬ'),E('h2',{},'Сигнал и соты'),E('p',{},'Измерения модема и состояние сети')]),
   E('a',{class:'btn cbi-button',href:L.url('admin/modem/5gmodem/detail')},'Настройки модема и SMS')]),
  E('div',{class:'vtc-network'},[
   E('div',{},[E('strong',{class:'vtc-operator'},val(info.operator)),E('span',{class:'vtc-pill'},healthy?val(c.rat):'Нет актуальных данных')]),
   E('p',{},(state[info.state]||val(info.state))+' · '+val(info.plmn)+' · '+band+' · PCI '+val(c.pci)),
   E('small',{},data.updated_at?'Панель обновлена: '+new Date(data.updated_at*1000).toLocaleTimeString()+' · '+Math.round(data.age_seconds||0)+' с назад':'Ожидание первого опроса')]),
  data.error?E('div',{class:'alert-message warning'},data.error):'',
  E('div',{class:'vtc-metrics'},[metric('rsrp',m.rsrp),metric('rsrq',m.rsrq),metric('snr',m.snr,m.snrSource),metric('rssi',m.rssi,'ModemManager · общая мощность')]),
  E('p',{class:'vtc-muted'},'Цвета — ориентиры для сравнения. Высокий уровень сигнала сам по себе не гарантирует скорость.'),
  E('div',{class:'vtc-facts'},[
   badge('eNB / сектор',c.rat==='LTE' && c.enb!=null?c.enb+' / '+c.sector:null),badge('Cell ID',c.ci),badge('TAC',c.tac),
   badge(c.rat==='NR'?'NR-ARFCN':'EARFCN',c.channel),badge('Агрегация · 5G Modem',m.ca||'Данные не получены'),badge('Температура модема',m.temperature!=null?m.temperature+' °C':null)]),
  data.extra?E('p',{class:'vtc-muted'},'Дополнительные измерения: '+data.extra.source+' · '+Math.round(data.extra.age_seconds)+' с. Сопоставлены по Cell ID, PCI и EARFCN.'):
   E('p',{class:'vtc-muted'},'Агрегация и SNR/SINR появятся, когда модем сообщит их и данные будут сопоставлены с текущей сотой.'),
  E('div',{class:'vtc-panel'},[E('h3',{},'Соты в ответе модема'),table(healthy?data.cells:[]),E('p',{class:'vtc-muted'},'«—» означает отсутствие данных. PCI соседних сот не позволяет определить их диапазон без номера канала.')]),
  E('div',{class:'vtc-panel'},[E('h3',{},'Изменение сигнала'),graph(samples)]),
  E('details',{class:'vtc-panel'},[E('summary',{},'Модем и разрешённые диапазоны'),
   E('p',{},val(info.model)),E('p',{},val(info.firmware)),E('p',{},'Режим: '+val(info.modes)),
   E('p',{},'Разрешены: '+(info.bands||[]).join(', ')),E('p',{class:'vtc-muted'},'Этот список описывает настройки модема. Активная агрегация показывается отдельно.')])
 ]);
}
return view.extend({
 load:function(){return status().catch(function(){return {available:false,error:'Не удалось прочитать данные'};});},
 render:function(initial){
  var host=E('div'), samples=[], key=null, stamp=null;
  var root=E('div',{},[E('link',{rel:'stylesheet',href:L.resource('vtcell/style.css')}),host]);
  function update(data){
   var m=metrics.snapshot(data), c=m.cell, next=c?[c.rat,c.plmn,c.ci,c.channel,c.pci].join('/'):'unavailable';
   if(next!==key){samples=[];key=next;stamp=null;}
   if(m.rsrp!=null && data.monotonic_ms!==stamp){stamp=data.monotonic_ms;samples.push({at:stamp,value:m.rsrp});while(samples.length>60)samples.shift();}
   host.replaceChildren(renderData(data,samples));
  }
  update(initial);
  poll.add(function(){return status().then(update).catch(function(){update({available:false,stale:true,error:'Связь с роутером потеряна. Старые уровни скрыты.'});});},5);
  return root;
 },handleSaveApply:null,handleSave:null,handleReset:null
});
