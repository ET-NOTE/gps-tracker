import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as query from '@tanstack/react-query';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as business from '../src/lib/business.js';
import * as ntsReport from '../src/lib/ntsReport.js';
import * as incomplete from '../src/lib/incompleteTrips.js';

const now=Date.parse('2026-11-17T00:00:00Z');
const devices=count=>Array.from({length:count},(_,i)=>({id:i+1,vehicle_name:`업무차 ${i+1}`,license_plate:`12가${1000+i}`}));
const text=node=>typeof node==='string'?node:Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const button=(r,label)=>r.root.findAll(n=>n.type==='button'&&text(n.children)===label)[0];
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
async function settle(check){for(let i=0;i<100;i++){if(check())return;await act(async()=>new Promise(resolve=>setTimeout(resolve,2)));}assert.ok(check(),'overview did not settle');}

async function mount(t,{fleet=devices(2),load=async()=>[],access:initialAccess={owner_id:1,role:'owner',manage_reports:true},time=now}={}){
 let access=initialAccess,props={devices:fleet,now:time,onReport:(...args)=>opened.push(args)},r,closed=false;
 const calls=[],opened=[];
 const qc=new query.QueryClient({defaultOptions:{queries:{retry:false,gcTime:Infinity}}});
 const source=await readFile(new URL('../src/components/business/FleetIncompleteTrips.jsx',import.meta.url),'utf8');
 const context=vm.createContext({console}),moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value]of Object.entries(exports))this.setExport(key,value);},{context});
 const api={listFleetVehicleTrips:(id,params,options)=>{const call={id,params,signal:options?.signal,owner:access.owner_id,role:access.role};calls.push(call);return load(call);}};
 const Task=({title,description,label,action,onClick})=>React.createElement('article',{},React.createElement('strong',{},title),React.createElement('p',{},description),label,onClick&&React.createElement('button',{onClick},action));
 const real={react:React,'react/jsx-runtime':jsx,'@tanstack/react-query':query,'../../api':{api},'./FleetAccess':{useFleetAccess:()=>access},'../../lib/business':business,'../../lib/ntsReport':ntsReport,'../../lib/incompleteTrips':incomplete,'./BusinessWorkspace':{BusinessTask:Task,BusinessButton:({children,...rest})=>React.createElement('button',rest,children)}};
 const code=(await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,mod=new vm.SourceTextModule(code,{context});
 await mod.link(name=>moduleOf(real[name]));await mod.evaluate();
 const render=()=>React.createElement(query.QueryClientProvider,{client:qc},React.createElement(mod.namespace.default,props));
 await act(async()=>{r=create(render());});
 const close=async()=>{if(closed)return;closed=true;await act(async()=>r.unmount());qc.clear();};t.after(close);
 return {r,calls,opened,qc,close,update:async(next={},nextAccess=access)=>{props={...props,...next};access=nextAccess;await act(async()=>r.update(render()));}};
}

test('overview automatically shows confirmed missing counts and keeps the vehicle report entry',async t=>{
 const m=await mount(t,{load:async({id})=>id===1?[{}, {annotation:{purpose:'business',driver_staff_id:3}}]:[]});
 await settle(()=>text(m.r.toJSON()).includes('이번 달 미작성 1건'));
 assert.equal(m.calls.length,2);assert.equal(m.r.root.findAllByType('article').length,1,'collapsed summary stays compact');
 assert.match(text(m.r.toJSON()),/2\/2대 조회/);
 await act(async()=>button(m.r,'차량별 보기').props.onClick());
 const entry=m.r.root.findAllByType('article').find(n=>text(n.children).includes('업무차 1'));
 await act(async()=>entry.findByType('button').props.onClick());
 assert.equal(m.opened[0][0].id,1);
 assert.deepEqual(JSON.parse(JSON.stringify(m.opened[0][1])),{incomplete:true,from:'2026-11-01',to:'2026-11-17'});
 assert.equal(m.calls.length,2,'expansion does not refetch the month');
});

test('initial loading and unreceived responses never appear as a confirmed zero',async t=>{
 const wait=deferred(),m=await mount(t,{load:()=>wait.promise});
 assert.match(text(m.r.toJSON()),/조회 중/);assert.doesNotMatch(text(m.r.toJSON()),/미작성 0건|미작성 없음/);
 await act(async()=>wait.resolve([]));
 await settle(()=>text(m.r.toJSON()).includes('이번 달 미작성 0건'));
 assert.match(text(m.r.toJSON()),/미작성 없음/);
});

test('partial failures retain known positive counts, expose permission failures and can retry',async t=>{
 let fail=true;
 const m=await mount(t,{load:async({id})=>{if(fail&&id===2)throw Object.assign(new Error('Forbidden'),{status:403});return id===1?[{}]:[];}});
 await settle(()=>text(m.r.toJSON()).includes('권한·이용권 확인 필요'));
 const shown=text(m.r.toJSON());
 assert.match(shown,/확인된 미작성 1건/);assert.match(shown,/1\/2대 조회/);assert.match(shown,/1대 조회 실패/);assert.match(shown,/일부 조회/);
 fail=false;await act(async()=>button(m.r,'다시 확인').props.onClick());
 await settle(()=>text(m.r.toJSON()).includes('이번 달 미작성 1건'));
 assert.doesNotMatch(text(m.r.toJSON()),/조회 실패|일부 조회/);assert.equal(m.calls.length,4);
});

test('failed or partially failed zero counts stay unknown, while an empty company is distinct',async t=>{
 for(const failAll of [false,true]){
  const m=await mount(t,{load:async({id})=>{if(failAll||id===2)throw new Error('offline');return [];}});
  await settle(()=>text(m.r.toJSON()).includes(failAll?'미작성 운행 조회 실패':'미작성 운행 집계 미완료'));
  assert.doesNotMatch(text(m.r.toJSON()),/미작성 0건|미작성 없음/);await m.close();
 }
 const empty=await mount(t,{fleet:[]});assert.match(text(empty.r.toJSON()),/등록 차량 없음/);assert.equal(empty.calls.length,0);
});

test('automatic scans stop at 20 vehicles with two concurrent requests and extend without rereading completed vehicles',async t=>{
 let running=0,peak=0;
 const m=await mount(t,{fleet:devices(25),load:async({id})=>{peak=Math.max(peak,++running);await new Promise(resolve=>setTimeout(resolve,2));running--;return id===22?[{}]:[];}});
 await settle(()=>text(m.r.toJSON()).includes('5대 미조회'));
 assert.equal(m.calls.length,20);assert.equal(peak,2);assert.match(text(m.r.toJSON()),/집계 미완료/);assert.doesNotMatch(text(m.r.toJSON()),/미작성 0건/);
 await act(async()=>button(m.r,'다음 5대 확인').props.onClick());
 await settle(()=>text(m.r.toJSON()).includes('이번 달 미작성 1건'));
 assert.equal(m.calls.length,25);assert.equal(new Set(m.calls.map(c=>c.id)).size,25);assert.match(text(m.r.toJSON()),/25\/25대 조회/);
});

test('company changes cancel old work and late responses cannot replace the new company summary',async t=>{
 const old=deferred();
 const m=await mount(t,{fleet:devices(4),load:call=>call.owner===1?old.promise:Promise.resolve([])});
 assert.equal(m.calls.length,2);
 const previous=m.calls.slice();
 await m.update({devices:devices(1)},{owner_id:2,role:'member',staff_id:9,manage_reports:false});
 assert.ok(previous.every(c=>c.signal.aborted));
 await settle(()=>text(m.r.toJSON()).includes('이번 달 미작성 0건'));
 await act(async()=>old.resolve([{}, {}, {}]));
 assert.match(text(m.r.toJSON()),/1\/1대 조회/);assert.doesNotMatch(text(m.r.toJSON()),/미작성 [1-9]/);
 assert.equal(m.calls.filter(c=>c.owner===1).length,2,'old queued vehicles never start');
});

test('leaving the overview aborts both active reads and does not start queued reads',async t=>{
 const wait=deferred(),m=await mount(t,{fleet:devices(5),load:()=>wait.promise});
 assert.equal(m.calls.length,2);await m.close();assert.ok(m.calls.every(c=>c.signal.aborted));
 await act(async()=>wait.resolve([{}]));assert.equal(m.calls.length,2);
});

test('scope and Korean date changes refresh the scan; minute ticks and detail toggles do not',async t=>{
 const m=await mount(t,{fleet:devices(1),time:Date.parse('2026-11-30T14:59:00Z')});
 await settle(()=>text(m.r.toJSON()).includes('이번 달 미작성 0건'));
 assert.equal(m.calls[0].params.from,'2026-11-01');assert.equal(m.calls[0].params.to,'2026-11-30');
 await m.update({now:Date.parse('2026-11-30T14:59:30Z')});assert.equal(m.calls.length,1);
 await m.update({now:Date.parse('2026-11-30T15:00:00Z')});
 await settle(()=>m.calls.length===2&&text(m.r.toJSON()).includes('이번 달 미작성 0건'));
 assert.equal(m.calls[1].params.from,'2026-12-01');assert.equal(m.calls[1].params.to,'2026-12-01');
 await m.update({}, {owner_id:1,role:'member',staff_id:5,manage_reports:false});
 await settle(()=>m.calls.length===3);assert.equal(m.calls[2].role,'member');
});
