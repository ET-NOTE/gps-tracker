import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
async function load(api){
 const context=vm.createContext({console});
 async function source(path){const code=await readFile(new URL(path,import.meta.url),'utf8');const m=new vm.SourceTextModule((await transform(code,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});await m.link(link);return m;}
 async function link(name){
  if(name.startsWith('./ui/'))return source('../src/components/'+name.slice(2)+'.jsx');
  const values=name==='react'?React:name==='react/jsx-runtime'?jsx:{api};
  return new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});
 }
 const m=await source('../src/components/SleepReportSettings.jsx');await m.evaluate();return m.namespace;
}
const device={id:7,sleep_report_interval_s:86400};
const applied={sleep_report_remote:true,timer_wake_enabled:true,sleep_report_saved:true,timer_wake_s:86400};
test('old firmware and unpersisted or mismatched telemetry never acknowledge remote settings',async()=>{
 const {reportSettingStatus:status}=await load({});
 assert.equal(status({timer_wake_s:86400},86400).kind,'upgrade');
 assert.equal(status({...applied,sleep_report_saved:false},86400).kind,'pending');
 assert.equal(status(applied,600).kind,'pending');
 assert.equal(status(applied,86400).kind,'applied');
});
test('minute bounds prevent submission; save waits for actual device acknowledgement and protects an edited draft during refresh',async()=>{
 let calls=[],updated;const {default:C}=await load({setDeviceSleepReportInterval:async(id,seconds)=>{calls.push({id,seconds});return {...device,sleep_report_interval_s:seconds};}});
 let r;await act(async()=>{r=create(React.createElement(C,{device,meta:{stationary:applied},onUpdated:d=>{updated=d;}}));});
 const input=()=>r.root.findByType('input'),submit=()=>r.root.findByType('form');
 for(const value of ['0','1441','1.5','']){
  await act(async()=>input().props.onChange({target:{value}}));
  await act(async()=>submit().props.onSubmit({preventDefault(){}}));
 }
 assert.equal(calls.length,0);
 await act(async()=>input().props.onChange({target:{value:'10'}}));
 await act(async()=>r.update(React.createElement(C,{device:{...device,sleep_report_interval_s:3600},meta:{stationary:applied},onUpdated:d=>{updated=d;}})));
 assert.equal(input().props.value,'10');
 await act(async()=>submit().props.onSubmit({preventDefault(){}}));
 assert.equal(calls[0].seconds,600);assert.equal(updated.sleep_report_interval_s,600);
 assert.match(JSON.stringify(r.toJSON()),/적용 대기/);assert.match(JSON.stringify(r.toJSON()),/10분/);
 await act(async()=>r.update(React.createElement(C,{device:updated,meta:{stationary:{...applied,timer_wake_s:600}}})));
 assert.match(JSON.stringify(r.toJSON()),/단말기 적용 확인/);await act(async()=>r.unmount());
});
test('failed save retains previous setting and editable draft; phone devices hide hardware settings',async()=>{
 const {default:C}=await load({setDeviceSleepReportInterval:async()=>{throw Error('offline');}});
 let r;await act(async()=>{r=create(React.createElement(C,{device}));});
 await act(async()=>r.root.findByType('input').props.onChange({target:{value:'60'}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(r.root.findByType('input').props.value,'60');assert.match(JSON.stringify(r.toJSON()),/24시간/);assert.match(JSON.stringify(r.toJSON()),/저장하지 못했습니다/);
 await act(async()=>r.update(React.createElement(C,{device:{...device,device_kind:'phone'}})));assert.equal(r.toJSON(),null);await act(async()=>r.unmount());
});
