import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import * as React from 'react';import * as jsx from 'react/jsx-runtime';
import * as rq from '@tanstack/react-query';import {create,act} from 'react-test-renderer';import {transform} from 'esbuild';
async function setup(){
 const calls=[],writes=[],context=vm.createContext({console});
 const api={adminCompanyReviews:async()=>({items:[],events:[]}),adminCompanyCandidatePage:(id,params,signal)=>new Promise((resolve,reject)=>calls.push({id,params,signal,resolve,reject})),createCompanyReview:(id,body)=>new Promise((resolve,reject)=>writes.push({id,body,resolve,reject}))};
 const of=v=>new vm.SyntheticModule(Object.keys(v),function(){for(const[k,x]of Object.entries(v))this.setExport(k,x);},{context});
 async function load(file,picker){const source=await readFile(new URL('../src/components/'+file+'.jsx',import.meta.url),'utf8');const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await m.link(name=>name==='./CompanyReviewCandidatePicker'?picker:of(name==='./PrivacyCompanyTask'?{AdminCompanyTasks:({children})=>children}:name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?rq:{api}));await m.evaluate();return m;}
 const picker=await load('CompanyReviewCandidatePicker'),panel=await load('PrivacyCompanyReview',picker);
 const client=new rq.QueryClient({defaultOptions:{queries:{retry:false}}});let renderer;
 const request=(id=12,revision=3)=>({id,revision,status:'in_review',kind:'access',due_at:'2099-01-01'});
 const render=(id,revision)=>React.createElement(rq.QueryClientProvider,{client},React.createElement(panel.namespace.AdminCompanyReviews,{request:request(id,revision),refresh:async()=>{}}));
 await act(async()=>{renderer=create(render());});
 const run=async fn=>act(async()=>{fn();await new Promise(r=>setTimeout(r,25));});
 const button=name=>renderer.root.findAllByType('button').find(b=>b.children.join('')===name);
 return {calls,writes,renderer,client,run,button,text:()=>JSON.stringify(renderer.toJSON()),click:name=>run(()=>button(name).props.onClick()),
 resolve:(n,data)=>run(()=>calls[n].resolve(data)),filter:v=>run(()=>renderer.root.findAllByType('select')[0].props.onChange({target:{value:v}})),
 search:async v=>{await run(()=>renderer.root.findByProps({maxLength:80}).props.onChange({target:{value:v}}));await run(()=>button('연결 단서 검색').props.onClick());},
 change:(id,revision)=>run(()=>renderer.update(render(id,revision))),close:async()=>{await act(async()=>renderer.unmount());client.clear();}};
}
const row={owner_id:2,staff_id:107,company_name:'과거 회사',currently_linked:false,first_observed:'2026-11-01',last_observed:'2026-11-02'};
const page=(items=[row],next=null)=>({items,next,more:!!next,identity_confirmed:false});
const choose='회사 #2 · 명단 #107 선택';
test('candidate pages use paired cursor, search/state reset first page and nested search never submits review',async()=>{
 const h=await setup();assert.equal(h.calls.length,0);await h.click('회사·명단 연결 찾기');await h.resolve(0,page([row],{owner_id:2,staff_id:50}));
 assert.equal(h.renderer.root.findAllByType('form').length,1);await h.click('연결 단서 다음 페이지');assert.deepEqual({...h.calls[1].params},{after_owner:2,after_staff:50});await h.resolve(1,page());
 await h.search('100%_');assert.deepEqual({...h.calls[2].params},{q:'100%_'});await h.resolve(2,page());await h.filter('unlinked');assert.deepEqual({...h.calls[3].params},{q:'100%_',linked:'unlinked'});
 await h.resolve(3,page([]));assert(h.button('연결 단서 다음 페이지').props.disabled);assert.match(h.text(),/회사가|회사 자료가 없다는 뜻은 아닙니다/);assert.equal(h.writes.length,0);await h.close();
});
test('search cancellation, errors and closing suppress stale choices; cancelled previous restarts',async()=>{
 const h=await setup();await h.click('회사·명단 연결 찾기');await h.resolve(0,page([row],{owner_id:2,staff_id:50}));await h.click('연결 단서 다음 페이지');await h.click('연결 단서 조회 취소');assert(h.calls[1].signal.aborted);
 await h.resolve(1,page());assert(!h.button(choose));await h.click('연결 단서 이전 페이지');assert.equal(h.calls[2].params.after_owner,undefined);
 await h.run(()=>h.calls[2].reject(Error('관리자 권한 변경')));assert.match(h.text(),/관리자 권한 변경/);assert.doesNotMatch(h.text(),/검색 조건에 맞는 연결 단서가 없습니다/);
 await h.click('연결 단서 처음 / 새로고침');await h.click('연결 단서 검색 닫기');assert(h.calls[3].signal.aborted);await h.resolve(3,page());assert(!h.button(choose));await h.close();
});
test('old candidate selection survives reopen/filter, posts inclusive KST scope and locks choices during submission',async()=>{
 const h=await setup();await h.click('회사·명단 연결 찾기');await h.resolve(0,page());await h.click(choose);assert.match(h.text(),/선택한 연결 단서:.*과거 회사/);assert.match(h.text(),/본인 범위는 별도로 확인/);
 await h.click('회사·명단 연결 찾기');await h.resolve(1,page([]));assert.match(h.text(),/선택한 연결 단서/);await h.click('연결 단서 검색 닫기');
 for(const [i,v]of ['2026-11-01','2026-11-02'].entries())await h.run(()=>h.renderer.root.findAllByProps({type:'date'})[i].props.onChange({target:{value:v}}));
 await h.run(()=>h.renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));const b=h.writes[0].body;assert.equal(b.company_owner_id,2);assert.equal(b.staff_id,107);assert.equal(b.from_at,'2026-10-31T15:00:00.000Z');assert.equal(b.until_at,'2026-11-02T15:00:00.000Z');assert.equal(b.identity,undefined);
 assert(h.button('별도 확인한 번호 입력').props.disabled);assert(h.button('선택 해제').props.disabled);await h.run(()=>h.writes[0].reject(Object.assign(Error('승인 또는 리비전 확인 필요'),{status:409})));assert.match(h.text(),/승인 또는 리비전 확인 필요/);await h.close();
});
test('switching requests discards selection and aborts old search; manual entry remains explicit',async()=>{
 const h=await setup();await h.click('회사·명단 연결 찾기');await h.resolve(0,page());await h.click(choose);await h.click('회사·명단 연결 찾기');
 await h.change(99,7);assert(h.calls[1].signal.aborted);assert.doesNotMatch(h.text(),/선택한 연결 단서/);assert(h.button('본인 범위 확인 항목 추가').props.disabled);
 await h.resolve(1,page());assert(!h.button(choose));await h.click('별도 확인한 번호 입력');assert.match(h.text(),/이름으로 자동 매칭하지 않습니다/);assert.equal(h.renderer.root.findAllByProps({type:'number'}).length,2);await h.close();
});
