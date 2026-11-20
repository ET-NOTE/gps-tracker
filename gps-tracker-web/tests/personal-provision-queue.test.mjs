import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as rq from '@tanstack/react-query';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

async function setup(kind='mappings'){
 const calls=[],mutations=[];
 const api={};
 for(const key of ['subjectMappingPage','provisionNoticePage'])api[key]=(arg,signal)=>new Promise((resolve,reject)=>calls.push({key,arg,signal,resolve,reject}));
 for(const key of ['subjectDecision','readProvisionNotice','retryProvisionNotice'])api[key]=(...args)=>new Promise((resolve,reject)=>mutations.push({key,args,resolve,reject}));
 const context=vm.createContext({console});
 const exportsOf=v=>new vm.SyntheticModule(Object.keys(v),function(){for(const[k,x]of Object.entries(v))this.setExport(k,x);},{context});
 async function load(file,queue){
  const source=await readFile(new URL('../src/components/'+file+'.jsx',import.meta.url),'utf8');
  const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await m.link(name=>name==='./PersonalProvisionQueue'?queue:exportsOf(name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?rq:name==='./CompanyMappingQueue'?{useCompanyMappingQueue:()=>null,CompanyMappingTools:()=>null,CompanyMappingLocations:()=>null}:name==='./CompanyBindingPicker'?{CompanyBindingPicker:()=>null}:name.endsWith('.css')?{}:{api}));await m.evaluate();return m;
 }
 const queue=await load('PersonalProvisionQueue'),panel=await load('SubjectProvision',queue);
 const client=new rq.QueryClient({defaultOptions:{queries:{retry:false}}});let renderer;
 await act(async()=>{renderer=create(React.createElement(rq.QueryClientProvider,{client},React.createElement(panel.namespace[kind==='mappings'?'SubjectMappings':'ProvisionNotices'])));});
 const run=async fn=>act(async()=>{fn();await new Promise(r=>setTimeout(r,15));});
 const button=name=>renderer.root.findAllByType('button').find(b=>b.children.join('')===name);
 return {calls,mutations,client,renderer,run,button,text:()=>JSON.stringify(renderer.toJSON()),
  click:name=>run(()=>button(name).props.onClick()),filter:value=>run(()=>renderer.root.findByType('select').props.onChange({target:{value}})),
  resolve:(n,data)=>run(()=>calls[n].resolve(data)),close:async()=>{await act(async()=>renderer.unmount());client.clear();}};
}
const row={id:201,revision:3,status:'pending',owner_id:1,vehicle_id:2,device_id:3,starts_at:'2026-11-10T00:00:00Z',ends_at:'2026-11-10T01:00:00Z'};
const page=(items=[row],next_before=null)=>({enabled:true,items,next_before,consent_version:'fleet-subject-v1',consent_text:'동의 내용'});
const notice={id:101,owner_id:1,vehicle_id:2,actor_id:1,delivery:'review',outcome:'prepared',started_at:row.starts_at,range_from:row.starts_at,range_until:row.ends_at,read_at:null};

test('personal mapping next/back/first preserve filter and discard stale rows',async()=>{
 const h=await setup();assert.deepEqual({...h.calls[0].arg},{limit:50});
 await h.resolve(0,page([row],201));await h.click('연결 요청 다음 페이지');assert.equal(h.calls[1].arg.before,201);assert(!h.button('본인 운행 확인 및 동의'));
 await h.resolve(1,page([{...row,id:151}],151));await h.click('연결 요청 이전 페이지');assert.equal(h.calls[2].arg.before,undefined);
 await h.resolve(2,page([row],201));await h.filter('confirmed');assert.deepEqual({...h.calls[3].arg},{limit:50,status:'confirmed'});
 await h.resolve(3,page([{...row,status:'confirmed'}],201));await h.click('연결 요청 다음 페이지');assert.equal(h.calls[4].arg.status,'confirmed');
 await h.resolve(4,page([]));assert(h.button('연결 요청 다음 페이지').props.disabled);await h.click('연결 요청 처음 / 새로고침');assert.equal(h.calls[5].arg.before,undefined);
 await h.close();assert(h.calls[5].signal.aborted);
});

test('cancel and filter abort reads; late rows do not revive consent and cache is removed',async()=>{
 const h=await setup();await h.click('연결 요청 조회 취소');assert(h.calls[0].signal.aborted);
 await h.resolve(0,page());assert.match(h.text(),/조회를 취소했습니다/);assert(!h.button('본인 운행 확인 및 동의'));
 await h.click('연결 요청 처음 / 새로고침');await h.filter('revoked');assert(h.calls[1].signal.aborted);
 await h.resolve(1,page());assert(!h.button('본인 운행 확인 및 동의'));await h.resolve(2,page([]));
 await h.close();assert.equal(h.client.getQueryCache().getAll().length,0);
});

test('old-page consent is locked through mutation/refetch; failed revalidation hides stale actions',async()=>{
 const h=await setup();await h.resolve(0,page([row],201));await h.click('연결 요청 다음 페이지');await h.resolve(1,page([{...row,id:17}]));
 await h.click('본인 운행 확인 및 동의');assert.equal(h.mutations[0].args[0],17);assert.deepEqual({...h.mutations[0].args[1]},{action:'confirmed',revision:3,consent_version:'fleet-subject-v1'});
 assert(h.renderer.root.findByType('select').props.disabled);assert(h.button('연결 요청 이전 페이지').props.disabled);
 await h.run(()=>h.mutations[0].reject(Error('변경된 요청입니다')));assert.equal(h.calls[2].arg.before,201);assert(!h.button('본인 운행 확인 및 동의'));
 await h.run(()=>h.calls[2].reject(Error('재조회 실패')));assert.match(h.text(),/변경된 요청입니다/);assert.match(h.text(),/재조회 실패/);assert(!h.button('본인 운행 확인 및 동의'));assert.doesNotMatch(h.text(),/확인할 연결 요청이 없습니다/);
 await h.click('연결 요청 처음 / 새로고침');await h.resolve(3,{...page([{...row,status:'confirmed'}]),enabled:false});assert.equal(h.button('이 연결의 제공 동의 철회').props.disabled,false);
 await h.click('이 연결의 제공 동의 철회');assert.equal(h.mutations[1].args[1].action,'revoked');await h.run(()=>h.mutations[1].resolve({}));await h.resolve(4,page([{...row,status:'revoked'}]));assert(!h.button('이 연결의 제공 동의 철회'));await h.close();
});

test('unread notices paginate without auto-reading; acknowledge/retry preserve current filter and page',async()=>{
 const h=await setup('notices');await h.resolve(0,page([notice],101));assert.equal(h.mutations.length,0);
 await h.filter('unread');assert.deepEqual({...h.calls[1].arg},{limit:50,read_state:'unread'});await h.resolve(1,page([notice],101));
 await h.click('제공 내역 다음 페이지');await h.resolve(2,page([{...notice,id:51}],51));await h.click('내역 확인 완료');assert.equal(h.mutations[0].key,'readProvisionNotice');assert.equal(h.mutations[0].args[0],51);
 await h.run(()=>h.mutations[0].resolve({}));assert.equal(h.calls[3].arg.before,101);assert.equal(h.calls[3].arg.read_state,'unread');assert(!h.button('내역 확인 완료'));
 await h.resolve(3,page([{...notice,id:50}]));await h.click('푸시 다시 요청');assert.equal(h.mutations[1].key,'retryProvisionNotice');
 await h.run(()=>h.mutations[1].reject(Error('재시도 대기 상태가 아닙니다')));await h.resolve(4,page([{...notice,id:50,delivery:'provider_accepted'}]));
 assert.match(h.text(),/재시도 대기 상태가 아닙니다/);assert(!h.button('푸시 다시 요청'));assert.match(h.text(),/푸시 서버 접수/);
 await h.click('제공 내역 이전 페이지');assert.equal(h.calls[5].arg.before,undefined);await h.close();assert(h.calls[5].signal.aborted);
});

test('notice refetch failure is not an empty inbox; cancel/retry resumes only explicitly',async()=>{
 const h=await setup('notices');await h.resolve(0,page([notice]));await h.click('제공 내역 처음 / 새로고침');
 await h.run(()=>h.calls[1].reject(Error('일시 오류')));assert.match(h.text(),/일시 오류/);assert.doesNotMatch(h.text(),/표시할 제공 내역이 없습니다/);assert(!h.button('내역 확인 완료'));
 await h.click('제공 내역 처음 / 새로고침');await h.click('제공 내역 조회 취소');assert(h.calls[2].signal.aborted);await h.resolve(2,page([notice]));assert(!h.button('내역 확인 완료'));
 await h.click('제공 내역 처음 / 새로고침');await h.resolve(3,page([]));assert.match(h.text(),/표시할 제공 내역이 없습니다/);await h.close();
});
