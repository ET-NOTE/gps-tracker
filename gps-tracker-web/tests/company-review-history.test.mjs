import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import * as React from 'react';import * as jsx from 'react/jsx-runtime';
import * as rq from '@tanstack/react-query';import {create,act} from 'react-test-renderer';import {transform} from 'esbuild';
async function setup(){
 const calls=[],context=vm.createContext({console});
 const api={adminCompanyReviewEvents:(id,params,signal)=>new Promise((resolve,reject)=>calls.push({id,params,signal,resolve,reject}))};
 const of=v=>new vm.SyntheticModule(Object.keys(v),function(){for(const[k,x]of Object.entries(v))this.setExport(k,x);},{context});
 const source=await readFile(new URL('../src/components/CompanyReviewHistory.jsx',import.meta.url),'utf8');
 const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(name=>of(name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?rq:{api}));await m.evaluate();
 const client=new rq.QueryClient({defaultOptions:{queries:{retry:false}}});let renderer;
 const panel=id=>React.createElement(rq.QueryClientProvider,{client},React.createElement(m.namespace.CompanyReviewHistory,{requestId:id,reviews:[{id:7,category:'files'},{id:8,category:'files'}],statuses:{identity_pending:'본인 범위 확인',in_review:'검토 중',verified:'담당자 처리 확인',restricted:'제한 사유 안내'},categories:{files:'첨부자료'}}));
 await act(async()=>{renderer=create(panel(12));});
 const run=async fn=>act(async()=>{fn();await new Promise(r=>setTimeout(r,25));});
 const button=name=>renderer.root.findAllByType('button').find(b=>b.children.join('')===name);
 return {calls,renderer,client,run,button,text:()=>JSON.stringify(renderer.toJSON()),click:name=>run(()=>button(name).props.onClick()),
 resolve:(n,data)=>run(()=>calls[n].resolve(data)),filter:(i,v)=>run(()=>renderer.root.findAllByType('select')[i].props.onChange({target:{value:v}})),
 change:id=>run(()=>renderer.update(panel(id))),close:async()=>{await act(async()=>renderer.unmount());client.clear();}};
}
const row={id:107,review_id:7,actor_id:3,revision:4,created_at:'2026-11-17T00:00:00Z',state:{status:'restricted',identity:'confirmed',category:'files',from_at:'2026-11-01',until_at:'2026-11-02',due_at:'2026-11-17',internal_reason:'검토 범위 변경',identity_evidence:'본인근거',evidence_reference:'처리근거',outcome:'limited',public_message:'당시 안내'}};
const page=(items=[row],next=null)=>({items,next});
test('history opens lazily; pages retain status/review filters; close aborts and reopen starts fresh',async()=>{
 const h=await setup();assert.equal(h.calls.length,0);await h.click('검토 변경 이력 보기');await h.resolve(0,page([row],58));
 await h.click('변경 이력 다음 페이지');assert.equal(h.calls[1].params.before,58);await h.resolve(1,page([{...row,id:57}],8));
 await h.click('변경 이력 이전 페이지');assert.equal(h.calls[2].params.before,undefined);await h.resolve(2,page());
 await h.filter(0,'verified');await h.resolve(3,page());await h.filter(1,'7');assert.deepEqual({...h.calls[4].params},{status:'verified',review_id:'7'});
 await h.resolve(4,page([row],58));await h.click('변경 이력 다음 페이지');assert.deepEqual({...h.calls[5].params},{before:58,status:'verified',review_id:'7'});
 await h.click('검토 변경 이력 닫기');assert(h.calls[5].signal.aborted);await h.resolve(5,page([{...row,state:{...row.state,internal_reason:'LATE'}}]));assert.doesNotMatch(h.text(),/LATE/);
 await h.click('검토 변경 이력 보기');assert.deepEqual({...h.calls[6].params},{});await h.close();assert(h.calls[6].signal.aborted);
});
test('cancel removes stale rows, back from cancelled page restarts; failed refresh is not empty',async()=>{
 const h=await setup();await h.click('검토 변경 이력 보기');await h.resolve(0,page([row],58));await h.click('변경 이력 다음 페이지');
 await h.click('변경 이력 조회 취소');assert(h.calls[1].signal.aborted);await h.resolve(1,page());assert.doesNotMatch(h.text(),/검토 범위 변경/);
 await h.click('변경 이력 이전 페이지');assert.equal(h.calls[2].params.before,undefined);await h.resolve(2,page());
 await h.click('변경 이력 처음 / 새로고침');assert.doesNotMatch(h.text(),/검토 범위 변경/);await h.run(()=>h.calls[3].reject(Error('접근 권한 변경')));
 assert.match(h.text(),/접근 권한 변경/);assert.doesNotMatch(h.text(),/해당하는 검토 변경 이력이 없습니다/);
 await h.filter(0,'restricted');await h.resolve(4,page([]));assert.match(h.text(),/해당하는 검토 변경 이력이 없습니다/);assert(h.button('변경 이력 다음 페이지').props.disabled);await h.close();
});
test('different parent request cancels old request and clears filters; a late response cannot cross scopes',async()=>{
 const h=await setup();await h.click('검토 변경 이력 보기');await h.resolve(0,page());await h.filter(1,'8');
 await h.change(99);assert(h.calls[1].signal.aborted);assert.equal(h.calls[2].id,99);assert.deepEqual({...h.calls[2].params},{});
 await h.resolve(1,page([{...row,state:{...row.state,internal_reason:'WRONG-REVIEW'}}]));assert.doesNotMatch(h.text(),/WRONG-REVIEW/);await h.resolve(2,page());await h.close();
});
test('recorded decisions are text snapshots, never actionable completion or raw inventory',async()=>{
 const h=await setup();await h.click('검토 변경 이력 보기');await h.resolve(0,page([{...row,state:{...row.state,internal_reason:'<script>alert(1)</script>',inventory:{secret:'PRIVATE-INVENTORY'},company_owner_id:'PRIVATE-OWNER'}}]));
 assert.match(h.text(),/당시 상태/);assert.match(h.text(),/현재 상태나 원본 자료의 정정·파기·전달 완료를 뜻하지 않습니다/);assert.match(h.text(),/본인근거|처리근거|당시 안내/);
 assert.equal(h.renderer.root.findAllByType('script').length,0);assert.equal(h.renderer.root.findAllByType('input').length,0);assert.doesNotMatch(h.text(),/PRIVATE-/);
 assert.equal(h.renderer.root.findAllByType('button').length,4);await h.close();
});
