import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

async function mount(name,query,api){
 const context=vm.createContext({console,crypto:{randomUUID:()=> 'synthetic-request-id'}});
 const code=await readFile(new URL('../src/components/SubjectProvision.jsx',import.meta.url),'utf8');
 const m=new vm.SourceTextModule((await transform(code,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 let clears=0;
 await m.link(async name=>{
  const values=name==='react'?React:name==='react/jsx-runtime'?jsx:name==='@tanstack/react-query'?{useQuery:()=>query,useQueryClient:()=>({removeQueries:()=>clears++})}:name.endsWith('.css')?{}:{api};
  return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});
 });await m.evaluate();let r;
 await act(async()=>{r=create(React.createElement(m.namespace[name]));});
 return {r,clears:()=>clears,button:text=>r.root.findAllByType('button').find(b=>b.children.join('')===text)};
}
const row={id:17,revision:3,status:'pending',owner_id:1,vehicle_id:2,device_id:3,starts_at:'2026-11-08T00:00:00Z',ends_at:'2026-11-08T01:00:00Z'};
test('subject confirms exact revision and consent version; conflict remains unconfirmed and visible',async()=>{
 let calls=[],refresh=0;
 const query={data:{enabled:true,items:[row],consent_version:'fleet-subject-v1',consent_text:'합성 동의'},refetch:async()=>refresh++};
 const api={subjectDecision:async(id,body)=>{calls.push([id,body]);throw new Error('변경된 요청입니다');}};
 const ui=await mount('SubjectMappings',query,api);
 await act(async()=>ui.button('본인 운행 확인 및 동의').props.onClick());
 assert.equal(calls[0][0],17);assert.equal(calls[0][1].revision,3);assert.equal(calls[0][1].consent_version,'fleet-subject-v1');
 assert.equal(calls[0][1].action,'confirmed');assert.equal(refresh,1);assert.equal(ui.clears(),0);
 assert.match(JSON.stringify(ui.r.toJSON()),/변경된 요청입니다/);assert.match(JSON.stringify(ui.r.toJSON()),/본인 확인 대기/);
 api.subjectDecision=async()=>{};
 await act(async()=>ui.button('본인 운행 확인 및 동의').props.onClick());assert.equal(ui.clears(),1);
 await act(async()=>ui.r.unmount());
});
test('feature OFF cannot disable existing consent revocation',async()=>{
 let body;const ui=await mount('SubjectMappings',{data:{enabled:false,items:[{...row,status:'confirmed'}],consent_version:'fleet-subject-v1'},refetch:async()=>{}},{subjectDecision:async(id,b)=>{body=b;}});
 assert.equal(ui.button('이 연결의 제공 동의 철회').props.disabled,false);
 await act(async()=>ui.button('이 연결의 제공 동의 철회').props.onClick());assert.equal(body.action,'revoked');
 await act(async()=>ui.r.unmount());
});
test('provider acceptance does not auto-acknowledge inbox; retry errors stay visible',async()=>{
 let read=0,retry=0;const q={data:{items:[{...row,delivery:'provider_accepted',outcome:'response_ready',read_at:null}]},refetch:async()=>{}};
 const ui=await mount('ProvisionNotices',q,{readProvisionNotice:async()=>read++,retryProvisionNotice:async()=>{retry++;throw new Error('재시도 실패');}});
 assert.equal(read,0);assert.match(JSON.stringify(ui.r.toJSON()),/아직 확인하지 않은/);assert.equal(ui.button('푸시 다시 요청'),undefined);
 await act(async()=>ui.button('내역 확인 완료').props.onClick());assert.equal(read,1);
 q.data.items[0].delivery='review';await act(async()=>ui.r.update(React.createElement(ui.r.root.type)));
 await act(async()=>ui.button('푸시 다시 요청').props.onClick());assert.equal(retry,1);assert.match(JSON.stringify(ui.r.toJSON()),/재시도 실패/);
 await act(async()=>ui.r.unmount());
});
