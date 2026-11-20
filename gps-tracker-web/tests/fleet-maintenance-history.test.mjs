import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,create} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as assetsLib from '../src/lib/fleetAssets.js';

const assets=[{id:5,name:'업무 차량',license_plate:'12가3456'}];
const wrap=type=>({children,...props})=>React.createElement(type,props,children);
async function component(api,queryHook=()=>({})){
  const context=vm.createContext({crypto:{randomUUID}});
  const source=await readFile(new URL('../src/components/business/FleetMaintenanceHistory.jsx',import.meta.url),'utf8');
  const js=await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'});
  const mod=new vm.SourceTextModule(js.code,{context});
  const modules={'react':React,'react/jsx-runtime':jsx,'@tanstack/react-query':{useInfiniteQuery:queryHook},
    '../../api':{api},'../../lib/fleetAssets':assetsLib,'../Icon':{default:()=>null},'./fleet-maintenance-history.css':{},
    '../ui':{FormField:wrap('label'),Input:wrap('input'),Select:wrap('select'),Textarea:wrap('textarea'),
      Modal:({children,footer})=>React.createElement('section',null,children,footer)}};
  await mod.link(name=>new vm.SyntheticModule(Object.keys(modules[name]),function(){
    for(const [key,value] of Object.entries(modules[name]))this.setExport(key,value);
  },{context}));
  await mod.evaluate();
  return mod.namespace;
}
async function render(t,view){
  let r;
  await act(async()=>{r=create(view);});
  t.after(()=>act(()=>r.unmount()));
  return r.root;
}

test('a manual completion retries with the original request key and preserves the selected vehicle and memo',async t=>{
  const requests=[],saved=[];
  const {CompletionEditor}=await component({completeFleetMaintenance:async(id,body)=>{
    requests.push([id,body]);if(requests.length===1)throw new Error('연결 중단');
  }});
  const root=await render(t,React.createElement(CompletionEditor,{assets,initialVehicle:'5',today:'2026-11-20',onSaved:id=>saved.push(id),onClose(){},onConflict(){}}));
  await act(()=>root.findAllByType('select')[1].props.onChange({target:{value:'oil'}}));
  await act(()=>root.findByType('textarea').props.onChange({target:{value:'  엔진오일  '}}));
  const save=()=>act(async()=>root.findByType('form').props.onSubmit({preventDefault(){}}));
  await save();assert.deepEqual(saved,[]);assert.equal(root.findByProps({role:'alert'}).children[0],'연결 중단');
  await save();
  assert.deepEqual(saved,['5']);
  const [id,body]=requests[1];
  assert.equal(id,'5');assert.equal(body.request_id,requests[0][1].request_id);
  assert.deepEqual(JSON.parse(JSON.stringify(body)),{request_id:body.request_id,kind:'oil',completed_on:'2026-11-20',note:'엔진오일'});
});

test('completing an insurance schedule locks the vehicle and identifies the original schedule',async t=>{
  let sent;
  const {CompletionEditor}=await component({completeFleetMaintenance:async(id,body)=>{sent=body;}});
  const root=await render(t,React.createElement(CompletionEditor,{assets,schedule:{asset:assets[0],key:'insurance_expiry',date:'2026-11-23',label:'보험 만료일'},
    today:'2026-11-20',onSaved(){},onClose(){},onConflict(){}}));
  assert.equal(root.findAllByType('select')[0].props.disabled,true);
  assert.equal(root.findAllByType('select')[1].props.value,'insurance');
  assert.equal(root.findByType('input').props.max,'2026-11-20');
  await act(async()=>root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.equal(sent.schedule_key,'insurance_expiry');
  assert.equal(sent.scheduled_on,'2026-11-23');
});

test('history filters actual saved records and pages from the last completion on the same date',async t=>{
  let options,request;
  const row={id:9,vehicle_id:5,kind:'oil',completed_on:'2026-11-20',note:'필터 교체'};
  const {MaintenanceHistory}=await component({fleetMaintenanceHistory:async params=>{request=params;}},o=>{
    options=o;return {isSuccess:true,data:{pages:[{rows:[row],has_more:true}]}};
  });
  const root=await render(t,React.createElement(MaintenanceHistory,{assets,vehicle:'5',setVehicle(){}}));
  assert.equal(root.findByType('h3').children[0],'엔진오일 교체');
  assert.equal(root.findByType('p').children[0],'필터 교체');
  await act(()=>root.findByProps({'aria-label':'완료 이력 정비 종류'}).props.onChange({target:{value:'oil'}}));
  assert.equal(options.getNextPageParam({rows:[row],has_more:false}),undefined);
  await options.queryFn({pageParam:options.getNextPageParam({rows:[row],has_more:true})});
  assert.deepEqual(JSON.parse(JSON.stringify(request)),{vehicle_id:'5',kind:'oil',before_date:'2026-11-20',before_id:9});
});
