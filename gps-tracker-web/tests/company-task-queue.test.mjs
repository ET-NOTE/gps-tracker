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
 const calls=[],writes=[];
 const api={};for(const key of ['companyTaskPage','companyTask'])api[key]=(arg,signal)=>new Promise((resolve,reject)=>calls.push({key,arg,signal,resolve,reject}));
 api.submitCompanyTask=(id,body)=>new Promise((resolve,reject)=>writes.push({id,body,resolve,reject}));
 const context=vm.createContext({console,FileReader:class{readAsDataURL(){this.result='data:application/pdf;base64,cGRm';this.onload();}}});
 const exportsOf=v=>new vm.SyntheticModule(Object.keys(v),function(){for(const[k,x]of Object.entries(v))this.setExport(k,x);},{context});
 async function load(file,queue){
  const source=await readFile(new URL('../src/components/'+file+'.jsx',import.meta.url),'utf8');
  const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await m.link(name=>name==='./CompanyTaskQueue'?queue:exportsOf(name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?rq:name==='../lib/fileDownload'?{saveBlob:async()=>({status:'saved'}),fileSaveMessage:()=>''}:{api}));await m.evaluate();return m;
 }
 const queue=await load('CompanyTaskQueue'),panel=await load('PrivacyCompanyTask',queue);
 const client=new rq.QueryClient({defaultOptions:{queries:{retry:false}}});let renderer;
 await act(async()=>{renderer=create(React.createElement(rq.QueryClientProvider,{client},React.createElement(panel.namespace.CompanyTaskInbox)));});
 const run=async fn=>act(async()=>{fn();await new Promise(r=>setTimeout(r,20));});
 const button=name=>renderer.root.findAllByType('button').find(b=>b.children.join('')===name);
 return {calls,writes,renderer,client,run,button,text:()=>JSON.stringify(renderer.toJSON()),click:name=>run(()=>button(name).props.onClick()),
  resolve:(n,data)=>run(()=>calls[n].resolve(data)),filter:(index,value)=>run(()=>renderer.root.findAllByType('select')[index].props.onChange({target:{value}})),
  close:async()=>{await act(async()=>renderer.unmount());client.clear();}};
}
const row={id:1,revision:1,category:'trips',status:'requested',kind:'access',staff_id:2,expires_at:'2099-01-01',from_at:'2026-11-10T00:00:00Z',until_at:'2026-11-11T00:00:00Z',instructions:'합성 처리 요청'};
const page=(items=[row],next=null)=>({items,next});
const detail=(task=row)=>({task,submissions:[]});
const open='#1 · 운행 기록 · 처리 보고 요청';
test('company task next/previous/first keep status/category filters and accurate last page',async()=>{
 const h=await setup();assert.deepEqual({...h.calls[0].arg},{after:0});await h.resolve(0,page([row],50));await h.click('회사 요청 다음 페이지');assert.equal(h.calls[1].arg.after,50);
 await h.resolve(1,page([{...row,id:51}],100));await h.click('회사 요청 이전 페이지');assert.equal(h.calls[2].arg.after,0);
 await h.resolve(2,page());await h.filter(0,'changes_requested');assert.equal(h.calls[3].arg.status,'changes_requested');await h.resolve(3,page());
 await h.filter(1,'files');assert.deepEqual({...h.calls[4].arg},{after:0,status:'changes_requested',category:'files'});await h.resolve(4,page([row],50));
 await h.click('회사 요청 다음 페이지');assert.equal(h.calls[5].arg.category,'files');await h.resolve(5,page([]));assert(h.button('회사 요청 다음 페이지').props.disabled);
 await h.click('회사 요청 처음 / 새로고침');assert.equal(h.calls[6].arg.after,0);await h.close();assert(h.calls[6].signal.aborted);
});
test('filter and close abort lazy detail; late instructions never revive the old form',async()=>{
 const h=await setup();await h.resolve(0,page());assert.equal(h.calls.length,1);await h.click(open);assert.equal(h.calls[1].key,'companyTask');
 await h.filter(0,'submitted');assert(h.calls[1].signal.aborted);await h.resolve(1,detail());assert.doesNotMatch(h.text(),/합성 처리 요청/);await h.resolve(2,page([{...row,status:'submitted'}]));
 await h.click('#1 · 운행 기록 · 담당자 검토 중');const pending=h.calls[3];await h.click('#1 · 운행 기록 · 담당자 검토 중');assert(pending.signal.aborted);await h.close();
});
test('list cancel/retry and failed refresh hide previous details and distinguish empty results',async()=>{
 const h=await setup();await h.click('회사 요청 조회 취소');assert(h.calls[0].signal.aborted);await h.resolve(0,page());assert(!h.button(open));
 await h.click('회사 요청 처음 / 새로고침');await h.resolve(1,page());await h.click(open);await h.resolve(2,detail());assert.match(h.text(),/합성 처리 요청/);
 await h.click('회사 요청 처음 / 새로고침');assert.doesNotMatch(h.text(),/합성 처리 요청/);await h.run(()=>h.calls[3].reject(Error('조회 실패')));assert.match(h.text(),/조회 실패/);assert.doesNotMatch(h.text(),/유효한 요청이 없습니다/);
 await h.filter(1,'files');await h.resolve(4,page([]));assert.match(h.text(),/유효한 요청이 없습니다/);await h.close();assert.equal(h.client.getQueryCache().getAll().length,0);
});
test('submission locks navigation; conflict revalidates detail and removes stale form on access loss',async()=>{
 const h=await setup();await h.resolve(0,page([row],50));await h.click(open);await h.resolve(1,detail());
 await h.run(()=>h.renderer.root.findByProps({type:'file'}).props.onChange({target:{files:[{name:'proof.pdf',type:'application/pdf',size:30}]}}));
 await h.run(()=>h.renderer.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
 await h.run(()=>h.renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));assert.equal(h.writes[0].body.revision,1);
 assert(h.button('회사 요청 다음 페이지').props.disabled);assert(h.button(open).props.disabled);assert(h.renderer.root.findAllByType('select').slice(0,2).every(x=>x.props.disabled));
 await h.run(()=>h.writes[0].reject(Object.assign(Error('상태 변경'),{status:409})));assert.equal(h.calls[2].key,'companyTask');assert.equal(h.renderer.root.findAllByType('form').length,0);
 await h.run(()=>h.calls[2].reject(Object.assign(Error('요청이 회수되었습니다'),{status:409})));assert.match(h.text(),/요청이 회수되었습니다/);assert.equal(h.renderer.root.findAllByType('form').length,0);await h.close();
});
