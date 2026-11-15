import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as rq from '@tanstack/react-query';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

async function setup(admin=false){
  const calls=[];let latest;
  const api={};for(const key of ['privacyRequestPage','adminPrivacyRequests'])api[key]=(params,signal)=>new Promise((resolve,reject)=>calls.push({key,params,signal,resolve,reject}));
  const context=vm.createContext({console});
  const exportsOf=value=>new vm.SyntheticModule(Object.keys(value),function(){for(const [k,v]of Object.entries(value))this.setExport(k,v);},{context});
  const source=await readFile(new URL('../src/components/RightsQueue.jsx',import.meta.url),'utf8');
  const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await m.link(name=>exportsOf(name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?rq:{api}));await m.evaluate();
  const client=new rq.QueryClient({defaultOptions:{queries:{retry:false}}});
  function Probe(){latest=m.namespace.useRightsQueue(admin);return React.createElement(m.namespace.RightsQueueTools,{queue:latest,admin,kinds:{access:'열람'},statuses:{received:'접수',cancelled:'취소'}});}
  let renderer;await act(async()=>{renderer=create(React.createElement(rq.QueryClientProvider,{client},React.createElement(Probe)));});
  const flush=()=>new Promise(resolve=>setTimeout(resolve,15));
  return {calls,get value(){return latest;},renderer,
    run:async fn=>act(async()=>{fn();await flush();}),
    resolve:async(index,data)=>act(async()=>{calls[index].resolve(data);await flush();}),
    close:async()=>{await act(async()=>renderer.unmount());client.clear();}};
}
const result=(id,next=null)=>({items:[{id}],next,as_of:'2026-11-15T00:00:00Z'});
test('personal page navigation keeps time, refresh returns to first and filters reset cursor',async()=>{
  const h=await setup();assert.equal(h.calls[0].key,'privacyRequestPage');assert.deepEqual({...h.calls[0].params},{});
  await h.resolve(0,result(101,52));await h.run(()=>h.value.next());
  assert.equal(h.calls[1].params.before,52);assert.equal(h.calls[1].params.as_of,result(1).as_of);
  await h.resolve(1,result(51,2));await h.run(()=>h.value.previous());assert.equal(h.calls[2].params.before,undefined);
  await h.resolve(2,result(101,52));await h.run(()=>h.value.change('status','cancelled'));
  assert.equal(h.calls[3].params.status,'cancelled');assert.equal(h.calls[3].params.as_of,undefined);assert.equal(h.value.state.pages.length,1);
  await h.resolve(3,result(100));await h.run(()=>h.value.reload());assert.equal(h.calls.length,5);assert.equal(h.value.data,undefined);
  await h.close();assert.equal(h.calls[4].signal.aborted,true);
});
test('admin due filter includes all open statuses and combines assignment; errors never show stale rows',async()=>{
  const h=await setup(true);assert.equal(h.calls[0].params.status,'received');
  await h.run(()=>h.value.change('due','overdue'));assert.equal(h.calls[0].signal.aborted,true);assert.equal(h.calls[1].params.status,undefined);
  await h.run(()=>h.value.change('assignment','mine'));assert.equal(h.calls[2].params.assignment,'mine');assert.equal(h.calls[2].params.due,'overdue');
  await h.resolve(2,result(7));await h.resolve(0,result(999));assert.equal(h.value.data.items[0].id,7);
  await h.run(()=>h.value.reload());await h.run(()=>h.calls[3].reject(Error('조회 실패')));
  assert.equal(h.value.data,undefined);assert.equal(h.value.error.message,'조회 실패');
  assert.match(JSON.stringify(h.renderer.toJSON()),/조회 실패/);assert.doesNotMatch(JSON.stringify(h.renderer.toJSON()),/해당하는 요청이 없습니다/);
  await h.close();
});
test('cancel aborts active request, ignores late result, and can restart explicitly',async()=>{
  const h=await setup();await h.run(()=>h.value.cancel());assert.equal(h.calls[0].signal.aborted,true);
  await h.resolve(0,result(9));assert.equal(h.value.data,undefined);assert.equal(h.value.state.paused,true);
  await h.run(()=>h.value.reload());await h.resolve(1,{...result(0),items:[]});assert.equal(h.value.data.items.length,0);
  assert.match(JSON.stringify(h.renderer.toJSON()),/선택한 조건에 해당하는 요청이 없습니다/);
  await h.close();
});
