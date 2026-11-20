import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

test('pause requires confirmation, preserves epoch, and never presents server acceptance as device acknowledgement',async()=>{
  let row={device_id:7,name:'시험 SIM',paused:false,enforced:false,epoch:'original',device_applied:false},calls=[],refreshes=0;
  const query={get data(){return {items:[row]};},refetch:async()=>{refreshes++;}};
  const api={setCollectionControl:async(id,body)=>{calls.push({id,...body});row={...row,paused:true,enforced:true,epoch:'next'};}};
  const context=vm.createContext({console});
  const code=await readFile(new URL('../src/components/CollectionControl.jsx',import.meta.url),'utf8');
  const m=new vm.SourceTextModule((await transform(code,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await m.link(async name=>{
    const values=name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?{useQuery:()=>query}:{api};
    return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});
  });
  await m.evaluate();let r;const C=m.namespace.default;
  await act(async()=>{r=create(React.createElement(C));});
  const button=text=>r.root.findAllByType('button').find(b=>b.children.join('')===text);
  await act(async()=>button('수집 중지').props.onClick());assert.equal(calls.length,0);
  await act(async()=>button('취소').props.onClick());assert.equal(calls.length,0);
  await act(async()=>button('수집 중지').props.onClick());
  await act(async()=>button('확인').props.onClick());
  assert.deepEqual(calls,[{id:7,paused:true,epoch:'original'}]);assert.ok(refreshes);
  assert.match(JSON.stringify(r.toJSON()),/새 위치 저장 중지/);
  assert.match(JSON.stringify(r.toJSON()),/단말기 적용 미확인/);
  row={...row,device_applied:true,ack_at:'2026-11-05T12:00:00Z'};
  await act(async()=>r.update(React.createElement(C)));
  assert.match(JSON.stringify(r.toJSON()),/단말기 적용 확인/);
  row={...row,restricted:true};await act(async()=>r.update(React.createElement(C)));
  assert.equal(button('수집 재개'),undefined);await act(async()=>r.unmount());
});
