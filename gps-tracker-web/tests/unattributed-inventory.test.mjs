import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as helpers from '../src/lib/unattributedInventory.js';

test('inclusive Korean dates, 31-day bound and safe device IDs',()=>{
  const form={kind:'location',start:'2026-10-01',end:'2026-10-31',device:' 123 '};
  assert.deepEqual(helpers.inventoryFilters(form),{kind:'location',from:'2026-09-30T15:00:00.000Z',until:'2026-10-31T15:00:00.000Z',device_id:'123',limit:50});
  for(const patch of [{end:'2026-11-01'},{end:'2026-09-30'},{start:'2026-02-30'},{kind:'raw'},{device:'0'},{device:'-1'},{device:'1.5'},{device:'9007199254740992'}])assert.throws(()=>helpers.inventoryFilters({...form,...patch}));
  assert.equal(helpers.inventoryFilters({...form,device:''}).device_id,undefined);
  assert.deepEqual(helpers.recentInventoryDates(new Date('2026-11-14T16:00:00Z')),{start:'2026-11-09',end:'2026-11-15'});
});

async function component(api){
  const context=vm.createContext({console,AbortController});
  const exportsOf=value=>new vm.SyntheticModule(Object.keys(value),function(){for(const [k,v] of Object.entries(value))this.setExport(k,v);},{context});
  const source=await readFile(new URL('../src/components/UnattributedInventory.jsx',import.meta.url),'utf8');
  const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await m.link(name=>exportsOf(name==='react'?React:name==='react/jsx-runtime'?jsx:name==='../api'?{api}:name.endsWith('.css')?{}:helpers));
  await m.evaluate();return m.namespace.default;
}
const row={day:'2026-11-10',device_id:132,category:'l80',records:3,current_link:'linked'};
const page={items:[row],next_cursor:null,notice:'과거 귀속은 확인 필요'};
const text=r=>JSON.stringify(r.toJSON());
const button=(r,label)=>r.root.findAllByType('button').find(n=>n.children.join('')===label);
const submit=r=>r.root.findByType('form').props.onSubmit({preventDefault(){}});
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('manual metadata query, keyset next page, error differs from empty',async()=>{
  const calls=[];let result={...page,next_cursor:'cursor-132'};
  const Panel=await component({adminUnattributed:async(q,s)=>{calls.push({q,s});if(result instanceof Error)throw result;return result;}});
  let r;await act(async()=>{r=create(React.createElement(Panel));});assert.equal(calls.length,0);
  await act(async()=>{submit(r);await settle();});assert.match(text(r),/GPS 모듈/);assert.match(text(r),/과거 귀속은 확인 필요/);
  result=page;await act(async()=>{button(r,'다음 페이지').props.onClick();await settle();});
  assert.equal(calls[1].q.cursor,'cursor-132');assert.equal(calls[1].q.from,calls[0].q.from);
  result=Error('조회 제한: 잠시 후 다시 조회해 주세요');await act(async()=>{submit(r);await settle();});
  assert.match(r.root.findByProps({role:'alert'}).children.join(''),/조회 제한/);assert.doesNotMatch(text(r),/개 기록/);
  result={...page,items:[]};await act(async()=>{submit(r);await settle();});assert.match(text(r),/외부 사본의 확인을 완료한 것은 아닙니다/);
  await act(async()=>r.unmount());
});

test('filter edits, cancel and unmount abort; stale responses never replace new data',async()=>{
  const pending=[];const Panel=await component({adminUnattributed:(q,s)=>new Promise(resolve=>pending.push({q,s,resolve}))});
  let r;await act(async()=>{r=create(React.createElement(Panel));});await act(async()=>submit(r));
  await act(async()=>r.root.findByType('select').props.onChange({target:{value:'event'}}));assert.equal(pending[0].s.aborted,true);
  await act(async()=>submit(r));assert.equal(pending[1].q.kind,'event');
  await act(async()=>{pending[1].resolve({...page,items:[{...row,category:'wake'}]});await settle();});assert.match(text(r),/기상/);
  await act(async()=>{pending[0].resolve(page);await settle();});assert.doesNotMatch(text(r),/GPS 모듈/);
  await act(async()=>submit(r));await act(async()=>button(r,'조회 취소').props.onClick());assert.equal(pending[2].s.aborted,true);
  await act(async()=>{pending[2].resolve(page);await settle();});assert.doesNotMatch(text(r),/개 기록/);
  await act(async()=>submit(r));await act(async()=>r.unmount());assert.equal(pending[3].s.aborted,true);
});
