import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('reconnect resubscribes, requests history repair and drops queued data after logout',async()=>{
  const sockets=[],timers=[],frames=[],events=[];
  class Socket {
    static OPEN=1;
    constructor(){this.readyState=1;this.sent=[];sockets.push(this);}
    send(s){this.sent.push(JSON.parse(s));}
    close(){this.onclose?.();}
  }
  const context=vm.createContext({WebSocket:Socket,window:new EventTarget(),location:{protocol:'https:',hostname:'dev-gps.serial.kr',host:'dev-gps.serial.kr'},document:{hidden:false},
    setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){},requestAnimationFrame:fn=>frames.push(fn),console});
  const module=new vm.SourceTextModule(await readFile(new URL('../src/ws.js',import.meta.url),'utf8'),{context});
  await module.link(spec=>{
    const exports=spec.includes('authSession')?{authScope:()=> 'session-a',AUTH_CHANGED:'changed'}:
      spec.includes('chatBus')?{chatBus:{publish(){}}}:
      {activeStorage:()=>({getItem:()=> 'test-token'}),tryRefresh:async()=> 'ok',isTokenExpiringSoon:()=>false};
    return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  });
  await module.evaluate();
  const client=new module.namespace.TrackerWS(e=>events.push(e),()=>{});
  client.subscribe([7]);client.connect();sockets[0].onopen();
  assert.deepEqual(sockets[0].sent[0],{action:'subscribe',device_ids:[7]});
  sockets[0].onclose();assert.equal(timers.length,1);await timers[0]();sockets[1].onopen();
  assert.deepEqual(sockets[1].sent[0],{action:'subscribe',device_ids:[7]});
  assert.equal(events.at(-1).type,'resync');
  sockets[0].onclose();assert.equal(timers.length,1,'an old socket cannot schedule another reconnect');
  sockets[1].onmessage({data:JSON.stringify({type:'location',device_id:7})});
  client.disconnect();frames[0]();assert.equal(events.length,1);
});
