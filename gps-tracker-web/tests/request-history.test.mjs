import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as rq from '@tanstack/react-query';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

async function setup(){
  const calls=[];
  const api={privacyRequestHistory:(id,params,signal)=>new Promise((resolve,reject)=>calls.push({id,params,signal,resolve,reject}))};
  const context=vm.createContext({console});
  const exportsOf=value=>new vm.SyntheticModule(Object.keys(value),function(){for(const [k,v]of Object.entries(value))this.setExport(k,v);},{context});
  const source=await readFile(new URL('../src/components/PersonalRequestHistory.jsx',import.meta.url),'utf8');
  const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await m.link(name=>exportsOf(name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?rq:{api}));await m.evaluate();
  const client=new rq.QueryClient({defaultOptions:{queries:{retry:false}}});
  let renderer;await act(async()=>{renderer=create(React.createElement(rq.QueryClientProvider,{client},React.createElement(m.namespace.default,{requestId:134,statuses:{received:'접수',in_review:'검토 중'}})));});
  const run=async fn=>act(async()=>{fn();await new Promise(r=>setTimeout(r,15));});
  return {calls,renderer,client,run,text:()=>JSON.stringify(renderer.toJSON()),
    click:async name=>run(()=>renderer.root.findAllByType('button').find(b=>b.children.join('')===name).props.onClick()),
    resolve:async(n,data)=>run(()=>calls[n].resolve(data)),
    close:async()=>{await act(async()=>renderer.unmount());client.clear();}};
}
const result=(revision,next=null)=>({request_id:134,through:56,current_revision:56,items:[{revision,status:'in_review',message:'<img src=x onerror=alert(1)> 공개 안내',due_at:null,created_at:'2026-11-10T00:00:00Z'}],next});
test('history is lazy; collapse aborts and discards cached data; reopening starts fresh',async()=>{
  const h=await setup();assert.equal(h.calls.length,0);
  await h.click('처리 이력 보기');assert.equal(h.calls[0].id,134);
  await h.click('처리 이력 접기');assert(h.calls[0].signal.aborted);
  await h.resolve(0,result(56));assert.doesNotMatch(h.text(),/공개 안내/);
  await h.click('처리 이력 보기');assert.equal(h.calls.length,2);
  await h.resolve(1,result(56));assert.match(h.text(),/공개 안내/);
  assert.equal(h.renderer.root.findAllByType('img').length,0);
  await h.click('처리 이력 접기');assert.equal(h.client.getQueryCache().getAll().length,0);
  await h.close();
});
test('history navigation freezes upper revision, shows newer update and refresh resets pagination',async()=>{
  const h=await setup();await h.click('처리 이력 보기');await h.resolve(0,result(56,32));
  await h.click('이력 다음');assert.deepEqual({...h.calls[1].params},{before:32,through:56});
  await h.resolve(1,{...result(31,7),current_revision:57});assert.match(h.text(),/새 처리 내용이 있습니다/);
  await h.click('이력 이전');assert.deepEqual({...h.calls[2].params},{through:56});
  await h.resolve(2,result(56,32));await h.click('이력 처음 / 새로고침');assert.deepEqual({...h.calls[3].params},{});
  await h.close();assert(h.calls[3].signal.aborted);
});
test('history errors hide stale rows and do not masquerade as empty history; explicit retry succeeds',async()=>{
  const h=await setup();await h.click('처리 이력 보기');await h.resolve(0,result(56));
  await h.click('이력 처음 / 새로고침');assert.doesNotMatch(h.text(),/공개 안내/);
  await h.run(()=>h.calls[1].reject(Error('조회 제한: 잠시 후 다시 시도해 주세요.')));
  assert.match(h.text(),/조회 제한/);assert.doesNotMatch(h.text(),/기록된 처리 이력이 없습니다/);
  await h.click('이력 처음 / 새로고침');await h.resolve(2,{...result(1),items:[]});
  assert.match(h.text(),/이 범위에 기록된 처리 이력이 없습니다/);assert.doesNotMatch(h.text(),/조회 제한/);
  await h.close();
});
test('cancel hides late results and unmount aborts active history query',async()=>{
  const h=await setup();await h.click('처리 이력 보기');await h.click('이력 조회 취소');
  assert(h.calls[0].signal.aborted);await h.resolve(0,result(56));assert.doesNotMatch(h.text(),/공개 안내/);
  assert.match(h.text(),/이력 조회를 취소했습니다/);await h.click('이력 처음 / 새로고침');
  await h.close();assert(h.calls[1].signal.aborted);
});
