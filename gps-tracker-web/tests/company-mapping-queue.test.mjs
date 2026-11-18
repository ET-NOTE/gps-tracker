import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as rq from '@tanstack/react-query';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

async function setup(){
 const calls=[];
 const api={};for(const key of ['companySubjectMappings','subjectLocations'])api[key]=(arg,signal)=>new Promise((resolve,reject)=>calls.push({key,arg,signal,resolve,reject}));
 const context=vm.createContext({console,crypto:webcrypto});
 const exportsOf=value=>new vm.SyntheticModule(Object.keys(value),function(){for(const[k,v]of Object.entries(value))this.setExport(k,v);},{context});
 async function load(file,queue){
  const source=await readFile(new URL('../src/components/'+file,import.meta.url),'utf8');
  const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await m.link(name=>name==='./CompanyMappingQueue'?queue:exportsOf(name==='./PersonalProvisionQueue'?{usePersonalProvisionQueue:()=>null,PersonalProvisionTools:()=>null}:name==='./CompanyBindingPicker'?{CompanyBindingPicker:()=>null}:name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?rq:name.endsWith('.css')?{}:{api}));await m.evaluate();return m;
 }
 const queue=await load('CompanyMappingQueue.jsx'),panel=await load('SubjectProvision.jsx',queue);
 const client=new rq.QueryClient({defaultOptions:{queries:{retry:false}}});let renderer;
 await act(async()=>{renderer=create(React.createElement(rq.QueryClientProvider,{client},React.createElement(panel.namespace.CompanySubjectMappings)));});
 const run=async fn=>act(async()=>{fn();await new Promise(r=>setTimeout(r,15));});
 return {calls,renderer,client,run,text:()=>JSON.stringify(renderer.toJSON()),
  click:async name=>run(()=>renderer.root.findAllByType('button').find(b=>b.children.join('')===name).props.onClick()),
  resolve:async(n,data)=>run(()=>calls[n].resolve(data)),
  filter:async value=>run(()=>renderer.root.findAllByType('select')[0].props.onChange({target:{value}})),
  close:async()=>{await act(async()=>renderer.unmount());client.clear();}};
}
const row={id:9,revision:1,status:'confirmed',effective:true,has_successor:false,staff_id:1,subject_id:3,binding_id:2,vehicle_id:4,starts_at:'2026-11-10T00:00:00Z',ends_at:'2026-11-10T01:00:00Z'};
const page=(items=[row],next_before=null)=>({enabled:true,items,next_before,people:[{staff_id:1,subject_id:3,name:'합성 운전자'}],bindings:[{id:2,vehicle_id:4,device_id:7,starts_at:row.starts_at}]});
test('company pages preserve filter, go back and reset to newest without stale rows',async()=>{
 const h=await setup();assert.deepEqual({...h.calls[0].arg},{limit:50});
 await h.resolve(0,page([row],9));await h.click('연결 다음 페이지');assert.equal(h.calls[1].arg.before,9);
 assert.doesNotMatch(h.text(),/차량 #4/);await h.resolve(1,page([{...row,id:8}],8));
 await h.click('연결 이전 페이지');assert.equal(h.calls[2].arg.before,undefined);
 await h.resolve(2,page([row],9));await h.filter('revoked');assert.deepEqual({...h.calls[3].arg},{status:'revoked',limit:50});
 await h.resolve(3,page([{...row,status:'revoked'}],9));await h.click('연결 다음 페이지');assert.equal(h.calls[4].arg.status,'revoked');
 await h.close();assert(h.calls[4].signal.aborted);
});
test('filter navigation aborts location read and clears pending correction; late coordinates never return',async()=>{
 const h=await setup();await h.resolve(0,page());await h.click('연결 정정');assert.match(h.text(),/기존 연결 중지 및 정정 요청/);
 await h.click('확인된 기간 위치 조회');assert.equal(h.calls[1].key,'subjectLocations');
 await h.filter('revoked');assert(h.calls[1].signal.aborted);
 await h.resolve(1,{items:[{recorded_at:row.starts_at,lat:37.987654,lng:127.987654}]});
 await h.resolve(2,page([{...row,status:'revoked',effective:false}]));
 assert.doesNotMatch(h.text(),/37.987654|기존 연결 중지 및 정정 요청|확인된 기간 위치 조회/);
 await h.close();
});
test('refresh closes displayed coordinates; failed mapping refresh cannot retain authority or show empty state',async()=>{
 const h=await setup();await h.resolve(0,page());await h.click('확인된 기간 위치 조회');
 await h.resolve(1,{items:[{recorded_at:row.starts_at,lat:37.987654,lng:127.987654}]});assert.match(h.text(),/37.987654/);
 await h.click('연결 처음 / 새로고침');assert.doesNotMatch(h.text(),/37.987654/);
 await h.run(()=>h.calls[2].reject(Error('조회 실패')));assert.match(h.text(),/조회 실패/);assert.doesNotMatch(h.text(),/해당하는 연결이 없습니다/);
 await h.click('연결 처음 / 새로고침');await h.resolve(3,page([]));assert.match(h.text(),/선택한 상태에 해당하는 연결이 없습니다/);
 await h.close();
});
test('cancel aborts list and discards late data; explicit retry and unmount clear queries',async()=>{
 const h=await setup();await h.click('연결 목록 조회 취소');assert(h.calls[0].signal.aborted);
 await h.resolve(0,page());assert.doesNotMatch(h.text(),/차량 #4/);assert.match(h.text(),/연결 목록 조회를 취소했습니다/);
 await h.click('연결 처음 / 새로고침');await h.resolve(1,page());await h.click('확인된 기간 위치 조회');
 await h.close();assert(h.calls[2].signal.aborted);assert.equal(h.client.getQueryCache().getAll().length,0);
});
