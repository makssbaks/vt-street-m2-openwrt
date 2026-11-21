#!/usr/bin/env node
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const src=fs.readFileSync(path.join(__dirname,'../../package/vtmodem/files/www/luci-static/resources/vtmodem/connection.js'),'utf8');
const state=(changes={})=>({ok:true,supported:true,interface:'modem',up:true,pending:false,available:true,autostart:true,token:'initial-token',session_key:'one',...changes});
function harness(replies={},writable=true) {
 const calls=[],timers=new Map(); let tid=0,modal=null;
 function E(tag,attrs={},children=[]) {return {tag,attrs,children,disabled:false,
  get textContent(){return this.children.map(c=>typeof c==='object'?c.textContent:String(c)).join('');},
  set textContent(v){this.children=[String(v)];}};}
 const context={E,_:x=>x,Uint8Array,L:{hasViewPermission:()=>writable},
  baseclass:{extend:x=>x},ui:{showModal:(title,children)=>{modal=E('modal',{},children);},hideModal:()=>{modal=null;}},
  window:{crypto:{getRandomValues:b=>b.fill(1)},setTimeout:(fn,ms)=>{timers.set(++tid,{fn,ms});return tid;},clearTimeout:id=>timers.delete(id)},
  rpc:{declare:({method,nobatch})=>(...args)=>{assert.equal(nobatch,true);calls.push({method,args});const r=replies[method]?replies[method](...args):state();return r instanceof Error?Promise.reject(r):Promise.resolve(r);}}};
 vm.createContext(context); const module=vm.runInContext('(function(){'+src+'})()',context),panel=module.create();panel.update({type:'t99w175'});
 return {panel,calls,timers,modal:()=>modal,
  tick:async()=>{const next=timers.entries().next().value;assert(next);timers.delete(next[0]);next[1].fn();await flush();}};
}
function all(n){return typeof n==='object'&&n?[n,...(n.children||[]).flatMap(all)]:[];}
function button(n,t){const b=all(n).find(n=>n.tag==='button'&&n.textContent===t);assert(b,'Missing '+t);return b;}
async function flush(){for(let i=0;i<40;i++)await Promise.resolve();}
(async()=>{
 let h=harness();
 assert.equal(h.calls.length,0,'Rendering does not send network writes or poll independently');
 assert.match(h.panel.node.textContent,/Мобильное соединение/);
 await button(h.panel.node,'Переподключить').attrs.click();
 assert.equal(h.calls.length,1);assert(h.modal());
 assert.match(h.modal().textContent,/Мобильный интернет прервётся/);
 assert.match(h.modal().textContent,/LAN, SMS, частоты/);
 const cancelled=button(h.modal(),'Подтвердить');
 await button(h.modal(),'Отмена').attrs.click();await cancelled.attrs.click();
 assert.equal(h.calls.length,1,'Cancelled confirmation cannot later execute stale action');
 h=harness({},false);await button(h.panel.node,'Переподключить').attrs.click();
 assert.equal(h.calls.length,0,'Read-only users cannot write');assert(button(h.panel.node,'Включить интернет').disabled);
 let resolve; h=harness({connection_action:()=>new Promise(r=>resolve=r)});
 await button(h.panel.node,'Переподключить').attrs.click();
 const confirm=button(h.modal(),'Подтвердить');const changing=confirm.attrs.click();await flush();
 await confirm.attrs.click();await button(h.panel.node,'Переподключить').attrs.click();
 assert.deepEqual(h.calls.map(x=>x.method),['connection_status','connection_action']);
 assert.equal(h.calls[1].args[0],'reconnect');assert.equal(h.calls[1].args[1],'initial-token');assert.equal(h.calls[1].args[3],true);
 assert.match(h.calls[1].args[2],/^[0-9a-f]{32}$/);
 resolve({ok:true,changed:true,state:state({session_key:'two'})});await changing;
 assert.match(h.panel.node.textContent,/Проверьте открытие сайтов/);assert.equal(h.timers.size,0);
 assert(!button(h.panel.node,'Переподключить').disabled);
 // Lost action replies never cause a second mutation and do not report success.
 h=harness({connection_action:()=>new Error('lost reply')});
 await button(h.panel.node,'Отключить интернет').attrs.click();await button(h.modal(),'Подтвердить').attrs.click();
 assert.match(h.panel.node.textContent,/Повторная команда автоматически не отправлялась/);
 assert.equal(h.calls.filter(c=>c.method==='connection_action').length,1);
 await button(h.panel.node,'Проверить соединение').attrs.click();
 assert.equal(h.calls.filter(c=>c.method==='connection_action').length,1);
 // A same-up snapshot after reconnect is not a new session. Polls are read-only and bounded.
 h=harness({connection_action:()=>({ok:true,changed:true,state:state()})});
 await button(h.panel.node,'Переподключить').attrs.click();await button(h.modal(),'Подтвердить').attrs.click();
 assert.equal(h.timers.size,1);
 for(let i=0;i<29;i++)await h.tick();
 assert.equal(h.timers.size,0);assert.match(h.panel.node.textContent,/пока не подтверждено/);
 assert.equal(h.calls.filter(c=>c.method==='connection_action').length,1);
 // Disconnect confirms runtime Stop rather than a transient down state with autostart=true.
 let reads=0;
 h=harness({connection_status:()=>++reads===1?state():state({up:false,autostart:false}),
 connection_action:()=>({ok:true,changed:true,state:state({up:false})})});
 await button(h.panel.node,'Отключить интернет').attrs.click();await button(h.modal(),'Подтвердить').attrs.click();
 assert.equal(h.timers.size,1);await h.tick();assert.match(h.panel.node.textContent,/LAN и SMS не отключались/);
 // Detaching the page stops observations, never cancels/repeats the server-side up.
 h=harness({connection_action:()=>({ok:true,changed:true,state:state({up:false,pending:true})})});
 await button(h.panel.node,'Переподключить').attrs.click();await button(h.modal(),'Подтвердить').attrs.click();
 h.panel.stop();assert.equal(h.timers.size,0);await button(h.panel.node,'Включить интернет').attrs.click();
 assert.equal(h.calls.filter(c=>c.method==='connection_action').length,1);
 // Hidden tab cannot release the mutation lock until an outstanding response completes.
 h=harness({connection_action:()=>new Promise(r=>resolve=r)});
 await button(h.panel.node,'Переподключить').attrs.click();const pending=button(h.modal(),'Подтвердить').attrs.click();await flush();
 h.panel.suspend();h.panel.resume();await button(h.panel.node,'Включить интернет').attrs.click();
 assert.equal(h.calls.filter(c=>c.method==='connection_action').length,1);
 resolve({ok:true,changed:true,state:state({session_key:'two'})});await pending;
 // Malformed/foreign interface state is never writable, and errors are rendered as text.
 for(const value of [null,{ok:true},{...state(),interface:'lan'},state({up:'true'})]) {
  h=harness({connection_status:()=>value});await button(h.panel.node,'Переподключить').attrs.click();
  assert.equal(h.modal(),null);assert.equal(h.calls.length,1);
 }
 console.log('VTMODEM_CONNECTION_UI_TESTS_OK');
})().catch(e=>{console.error(e);process.exitCode=1;});
