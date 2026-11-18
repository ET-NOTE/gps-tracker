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

const old={id:1,vehicle_id:2,device_id:3,starts_at:'2026-11-01T00:00:00Z',ends_at:'2026-11-05T00:00:00Z',vehicle_name:'합성 차량',terminal_name:'Archive %_'};
const page=(items=[old],next_before=null,enabled=true)=>({items,next_before,enabled});
async function waitForRender(ready,description){
 const deadline=Date.now()+5000;
 while(!ready()){
  assert(Date.now()<deadline,`Timed out waiting for ${description}`);
  // React Query batches observer notifications onto the next timer turn.
  // Wait for rendered state, rather than assuming 20 ms is enough under load.
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,0));});
 }
}
async function setup(reconsent=false){
 const calls=[],sent=[];
 const api={companySubjectBindings:(arg,signal)=>new Promise((resolve,reject)=>calls.push({arg,signal,resolve,reject})),
  companySubjectMappings:async()=>({enabled:true,items:reconsent?[{...old,id:9,status:'revoked',revision:2,binding_id:8,staff_id:7,subject_id:3}]:[],people:[{staff_id:7,subject_id:3,name:'운전자'}],bindings:[{...old,id:8}]}),
  proposeSubjectMapping:async p=>{sent.push(p);return{id:10};}};
 const context=vm.createContext({console,crypto:webcrypto});
 const exportsOf=value=>new vm.SyntheticModule(Object.keys(value),function(){for(const[k,v]of Object.entries(value))this.setExport(k,v);},{context});
 const modules={};
 async function load(file){
  const source=await readFile(new URL('../src/components/'+file+'.jsx',import.meta.url),'utf8');
  const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await m.link(name=>modules[name.slice(2)]??exportsOf(name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?rq:name.endsWith('.css')?{}:{api}));await m.evaluate();modules[file]=m;return m;
 }
 await load('PersonalProvisionQueue');await load('CompanyBindingPicker');await load('CompanyMappingQueue');const panel=await load('SubjectProvision');
 const client=new rq.QueryClient({defaultOptions:{queries:{retry:false}}});let renderer;
 await act(async()=>{renderer=create(React.createElement(rq.QueryClientProvider,{client},React.createElement(panel.namespace.CompanySubjectMappings)));});
 const run=async fn=>act(async()=>{await fn();});
 const buttons=()=>renderer.root.findAllByType('button');
 const text=()=>JSON.stringify(renderer.toJSON());
 await waitForRender(()=>buttons().some(b=>b.children.join('')==='과거 차량·SIM 연결 찾기'),'initial mapping form');
 return {calls,sent,renderer,client,run,buttons,text,
  click:async name=>{
   let button;
   await waitForRender(()=>{button=buttons().find(b=>b.children.join('')===name);return button&&!button.props.disabled;},`enabled button: ${name}`);
   await run(()=>button.props.onClick());
  },
  resolve:async(n,data)=>{
   await run(()=>calls[n].resolve(data));
   if(!calls[n].signal.aborted)await waitForRender(()=>!text().includes('차량·SIM 연결을 검색하는 중…'),'binding response');
  },
  reject:async(n,error)=>{
   await run(()=>calls[n].reject(error));
   await waitForRender(()=>text().includes(error.message),'binding error');
  },
  search:async value=>{await run(()=>renderer.root.findByProps({maxLength:80}).props.onChange({target:{value}}));await run(()=>renderer.root.findAllByType('form')[1].props.onSubmit({preventDefault(){}}));},
  close:async()=>{await act(async()=>renderer.unmount());client.clear();}};
}

test('binding search is lazy; search aborts old results, resets cursor and preserves literal text across pages',async()=>{
 const h=await setup();assert.equal(h.calls.length,0);await h.click('과거 차량·SIM 연결 찾기');assert.deepEqual({...h.calls[0].arg},{limit:50});
 await h.search('  Archive %_  ');assert(h.calls[0].signal.aborted);assert.equal(h.calls[1].arg.q,'Archive %_');
 await h.resolve(0,page([{...old,id:99}]));assert.doesNotMatch(h.text(),/연결 #99 선택/);
 await h.resolve(1,page([old],1));await h.click('검색 다음 페이지');assert.equal(h.calls[2].arg.before,1);assert.equal(h.calls[2].arg.q,'Archive %_');
 await h.resolve(2,page([]));await h.click('검색 이전 페이지');assert.equal(h.calls[3].arg.before,undefined);
 await h.search('new');assert(h.calls[3].signal.aborted);assert.equal(h.calls[4].arg.before,undefined);
 await h.close();assert(h.calls[4].signal.aborted);
});

test('choosing an old binding keeps its option, does not change requested dates or submit without user action',async()=>{
 const h=await setup();await h.click('과거 차량·SIM 연결 찾기');await h.resolve(0,page());
 const dates=h.renderer.root.findAllByProps({type:'datetime-local'}).map(x=>x.props.value);
 await h.click('연결 #1 선택');assert.equal(h.sent.length,0);assert.doesNotMatch(h.text(),/연결 검색 닫기/);
 const options=h.renderer.root.findAllByType('select');assert.equal(options[2].props.value,'1');assert.equal(options[2].findAllByType('option').length,3);
 assert.deepEqual(h.renderer.root.findAllByProps({type:'datetime-local'}).map(x=>x.props.value),dates);
 await h.run(()=>{options[1].props.onChange({target:{value:'7'}});const inputs=h.renderer.root.findAllByProps({type:'datetime-local'});inputs[0].props.onChange({target:{value:'2026-11-03T09:00'}});inputs[1].props.onChange({target:{value:'2026-11-03T10:00'}});});
 await h.run(()=>h.renderer.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(h.sent[0].binding_id,1);assert.equal(h.sent[0].staff_id,7);assert.equal(h.sent[0].replaces_id,undefined);assert.equal(h.sent[0].starts_at,new Date('2026-11-03T09:00').toISOString());
 assert.match(h.text(),/해당 사용자가 내 정보에서 직접 확인해야/);await h.close();
});

test('reconsent cannot change identity through the binding picker',async()=>{
 const h=await setup(true);await h.click('재동의 요청');assert.equal(h.buttons().filter(b=>b.children.join('')==='과거 차량·SIM 연결 찾기').length,0);
 assert.equal(h.renderer.root.findAllByType('select')[2].props.disabled,true);assert.equal(h.calls.length,0);await h.close();
});

test('binding errors are not empty results; cancel/retry/feature OFF and close discard pending or late rows',async()=>{
 const h=await setup();await h.click('과거 차량·SIM 연결 찾기');await h.reject(0,Error('연결 조회 실패'));
 assert.match(h.text(),/연결 조회 실패/);assert.doesNotMatch(h.text(),/검색 조건에 맞는/);
 await h.click('연결 다시 조회');await h.click('연결 검색 취소');assert(h.calls[1].signal.aborted);
 await h.resolve(1,page());assert.doesNotMatch(h.text(),/연결 #1 선택/);
 await h.click('연결 다시 조회');await h.resolve(2,page([old],null,false));assert(h.buttons().find(b=>b.children.join('')==='연결 #1 선택').props.disabled);
 await h.click('연결 다시 조회');await h.click('연결 검색 닫기');assert(h.calls[3].signal.aborted);
 await h.resolve(3,page());assert.doesNotMatch(h.text(),/연결 #1 선택/);await h.close();assert.equal(h.client.getQueryCache().getAll().length,0);
});

test('mapping filter change closes the picker and discards old company selection',async()=>{
 const h=await setup();await h.click('과거 차량·SIM 연결 찾기');
 await h.run(()=>h.renderer.root.findAllByType('select')[0].props.onChange({target:{value:'revoked'}}));assert(h.calls[0].signal.aborted);
 await h.resolve(0,page());assert.doesNotMatch(h.text(),/연결 #1 선택|연결 검색 닫기/);
 await h.close();
});
