import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

test('independent use/provision controls preserve revision, clear fetched locations, and show unactivated retention honestly',async()=>{
 let control={use_paused:false,provision_paused:false,revision:3},calls=[],clears=0;
 const query={get data(){return {control,retention:null,retention_enabled:false};},refetch:async()=>{}};
 const api={setProcessingControl:async body=>{calls.push(body);control={...body,revision:4};}};
 const context=vm.createContext({console});
 const code=await readFile(new URL('../src/components/ProcessingControl.jsx',import.meta.url),'utf8');
 const m=new vm.SourceTextModule((await transform(code,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(async name=>{
  const values=name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?{useQuery:()=>query,useQueryClient:()=>({removeQueries:()=>clears++})}:{api};
  return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});
 });await m.evaluate();let r;
 await act(async()=>{r=create(React.createElement(m.namespace.default));});
 const button=text=>r.root.findAllByType('button').find(b=>b.children.join('')===text);
 await act(async()=>button('제공 중지').props.onClick());
 assert.equal(calls[0].revision,3);assert.equal(calls[0].provision_paused,true);assert.equal(calls[0].use_paused,false);assert.equal(clears,1);
 assert.match(JSON.stringify(r.toJSON()),/자동 파기는 아직 활성화되지/);
 assert.ok(button('제공 재개'));assert.ok(button('이용 중지'));
 api.setProcessingControl=async()=>{throw new Error('진행 중인 위치 처리');};
 await act(async()=>button('이용 중지').props.onClick());
 assert.match(JSON.stringify(r.toJSON()),/진행 중인 위치 처리/);assert.equal(control.use_paused,false);
 await act(async()=>r.unmount());
});
