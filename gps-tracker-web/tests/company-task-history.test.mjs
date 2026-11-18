import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';
import {readFile} from 'node:fs/promises';import * as React from 'react';import * as jsx from 'react/jsx-runtime';
import * as rq from '@tanstack/react-query';import {create,act} from 'react-test-renderer';import {transform} from 'esbuild';
async function setup(){
 const calls=[],context=vm.createContext({console});
 const api={adminCompanyTaskEvents:(id,params,signal)=>new Promise((resolve,reject)=>calls.push({id,params,signal,resolve,reject}))};
 const of=v=>new vm.SyntheticModule(Object.keys(v),function(){for(const[k,x]of Object.entries(v))this.setExport(k,x);},{context});
 const source=await readFile(new URL('../src/components/CompanyTaskHistory.jsx',import.meta.url),'utf8');
 const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(name=>of(name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?rq:{api}));await m.evaluate();
 const client=new rq.QueryClient({defaultOptions:{queries:{retry:false}}});let renderer;
 const panel=id=>React.createElement(rq.QueryClientProvider,{client},React.createElement(m.namespace.CompanyTaskHistory,{reviewId:id,tasks:[{id:7},{id:8}]}));
 await act(async()=>{renderer=create(panel(12));});
 const run=async fn=>act(async()=>{fn();await new Promise(r=>setTimeout(r,25));});
 const button=name=>renderer.root.findAllByType('button').find(b=>b.children.join('')===name);
 return {calls,renderer,client,run,button,text:()=>JSON.stringify(renderer.toJSON()),click:name=>run(()=>button(name).props.onClick()),
 resolve:(n,data)=>run(()=>calls[n].resolve(data)),filter:(i,v)=>run(()=>renderer.root.findAllByType('select')[i].props.onChange({target:{value:v}})),
 change:id=>run(()=>renderer.update(panel(id))),close:async()=>{await act(async()=>renderer.unmount());client.clear();}};
}
const row={id:107,task_id:7,actor_id:3,action:'revoked',detail:'검토 범위 변경',submission_id:20,created_at:'2026-11-17T00:00:00Z'};
const page=(items=[row],next=null)=>({items,next});
test('history opens lazily; pages retain action/task filters; close aborts and reopen starts fresh',async()=>{
 const h=await setup();assert.equal(h.calls.length,0);await h.click('회사 처리 이력 보기');await h.resolve(0,page([row],58));
 await h.click('처리 이력 다음 페이지');assert.equal(h.calls[1].params.before,58);await h.resolve(1,page([{...row,id:57}],8));
 await h.click('처리 이력 이전 페이지');assert.equal(h.calls[2].params.before,undefined);await h.resolve(2,page());
 await h.filter(0,'downloaded');await h.resolve(3,page());await h.filter(1,'7');assert.deepEqual({...h.calls[4].params},{action:'downloaded',task_id:'7'});
 await h.resolve(4,page([row],58));await h.click('처리 이력 다음 페이지');assert.deepEqual({...h.calls[5].params},{before:58,action:'downloaded',task_id:'7'});
 await h.click('회사 처리 이력 닫기');assert(h.calls[5].signal.aborted);await h.resolve(5,page([{...row,detail:'LATE'}]));assert.doesNotMatch(h.text(),/LATE/);
 await h.click('회사 처리 이력 보기');assert.deepEqual({...h.calls[6].params},{});await h.close();assert(h.calls[6].signal.aborted);
});
test('cancel removes stale rows, back from cancelled page restarts; failed refresh is not empty',async()=>{
 const h=await setup();await h.click('회사 처리 이력 보기');await h.resolve(0,page([row],58));await h.click('처리 이력 다음 페이지');
 await h.click('처리 이력 조회 취소');assert(h.calls[1].signal.aborted);await h.resolve(1,page());assert.doesNotMatch(h.text(),/검토 범위 변경/);
 await h.click('처리 이력 이전 페이지');assert.equal(h.calls[2].params.before,undefined);await h.resolve(2,page());
 await h.click('처리 이력 처음 / 새로고침');assert.doesNotMatch(h.text(),/검토 범위 변경/);await h.run(()=>h.calls[3].reject(Error('접근 권한 변경')));
 assert.match(h.text(),/접근 권한 변경/);assert.doesNotMatch(h.text(),/해당하는 처리 이력이 없습니다/);
 await h.filter(0,'accepted');await h.resolve(4,page([]));assert.match(h.text(),/해당하는 처리 이력이 없습니다/);assert(h.button('처리 이력 다음 페이지').props.disabled);await h.close();
});
test('different review cancels old request and clears filters; a late response cannot cross scopes',async()=>{
 const h=await setup();await h.click('회사 처리 이력 보기');await h.resolve(0,page());await h.filter(1,'8');
 await h.change(99);assert(h.calls[1].signal.aborted);assert.equal(h.calls[2].id,99);assert.deepEqual({...h.calls[2].params},{});
 await h.resolve(1,page([{...row,detail:'WRONG-REVIEW'}]));assert.doesNotMatch(h.text(),/WRONG-REVIEW/);await h.resolve(2,page());await h.close();
});
test('audit detail is text; response creation never claims delivery and no mutations are offered',async()=>{
 const h=await setup();await h.click('회사 처리 이력 보기');await h.resolve(0,page([{...row,action:'downloaded',detail:'a'.repeat(64)},{...row,id:106,detail:'<script>alert(1)</script>'}]));
 assert.match(h.text(),/증빙 응답 생성/);assert.match(h.text(),/실제 저장·전달·내용 검토 완료를 뜻하지 않습니다/);assert.match(h.text(),/증빙 SHA256/);
 assert.equal(h.renderer.root.findAllByType('script').length,0);assert.equal(h.renderer.root.findAllByType('input').length,0);
 assert.match(h.text(),/제출 #20/);await h.close();
});
