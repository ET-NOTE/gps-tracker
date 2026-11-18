import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as business from '../src/lib/business.js';
import * as businessExport from '../src/lib/businessExport.js';
import * as ntsReport from '../src/lib/ntsReport.js';
import * as tripQuality from '../src/lib/tripQuality.js';
import * as tripOdometer from '../src/lib/tripOdometer.js';

const now=Date.parse('2026-11-17T00:34:00Z');
const vehicle={id:2,vehicle_name:'업무차',license_plate:'12가3456'};
const trip={started_at:'2026-11-17T00:00:00Z',ended_at:'2026-11-17T01:00:00Z',distance_m:2500,binding_id:7,source_device_id:9,annotation:{purpose:'business',driver_staff_id:3,note:'기존 메모'}};
const booking={id:8,vehicle_id:2,driver_staff_id:3,starts_at:'2026-11-17T00:00:00Z',ends_at:'2026-11-17T01:00:00Z',purpose:'거래처 방문',note:'기존 메모',status:'planned'};
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const button=(r,label)=>r.root.findAll(n=>n.type==='button'&&text(n.children).trim()===label).at(-1);
const pending=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

// Exercise the actual component functions; mutation hooks intentionally leave
// isPending false to reproduce two clicks before React Query updates its state.
async function components({save=async()=>{},view='list'}={}) {
 const calls=[],alerts=[],queries=[];
 const source=await readFile(new URL('../src/components/CorporatePanel.jsx',import.meta.url),'utf8');
 class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const context=vm.createContext({console,Date:Clock,localStorage:{getItem:()=>view,setItem(){}}});
 const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
 const noop=()=>null;
 const Modal=({children,footer})=>React.createElement('section',{},children,footer);
 const Button=({children,busy,disabled,...props})=>React.createElement('button',{...props,disabled:disabled||busy},children);
 const Field=({children,label})=>React.createElement('label',{},label,children);
 const write=(kind,payload)=>{calls.push({kind,payload});return save(kind,payload);};
 const mocks={
  Modal,Button,BusinessButton:Button,FormField:Field,Input:props=>React.createElement('input',props),Select:({children,...props})=>React.createElement('select',props,children),
  useFleetAccess:()=>({manage_reports:true,staff_id:3}),staffCanDrive:()=>true,
  useCreateFleetReservation:()=>({isPending:false,mutateAsync:payload=>write('create',payload)}),
  useUpdateFleetReservation:()=>({isPending:false,mutateAsync:payload=>write('update',payload)}),
  useCancelFleetReservation:()=>({mutateAsync:noop}),
  useFleetReservations:params=>{queries.push(params);return {data:[],isLoading:false,refetch:noop};},
  useBusinessClock:()=>now,useStaff:()=>({data:[{id:3,name:'김운전자',active:true}]}),
  alertDialog:async args=>{alerts.push(args);},
 };
 const real={react:React,'react/jsx-runtime':jsx,'../api':{api:{annotateFleetVehicleTrip:(id,payload)=>write('trip',{id,...payload})}},
  '../lib/business':{...business,businessDate:(value=now)=>business.businessDate(value)},'../lib/businessExport':businessExport,'../lib/ntsReport':ntsReport,'../lib/tripQuality':tripQuality,'../lib/tripOdometer':tripOdometer};
 const imports=new Map();
 for(const match of source.matchAll(/import\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g)) {
  const names=match[1].match(/\{([^}]+)\}/)?.[1].split(',').map(name=>name.trim().split(/\s+as\s+/)[0])||[];
  imports.set(match[2],[...new Set([...(imports.get(match[2])||[]),...names])]);
 }
 const code=(await transform(source+'\nexport {TripEditorModal,ReservationDialog,ReservationsTab,localToIso,isoToLocal};',{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const mod=new vm.SourceTextModule(code,{context});
 await mod.link(name=>moduleOf(real[name]||Object.fromEntries(['default',...(imports.get(name)||[])].map(key=>[key,mocks[key]||noop]))));
 await mod.evaluate();
 return {...mod.namespace,Modal,calls,alerts,queries};
}

function props(kind,onSaved=()=>{},onClose=()=>{}) {
 return kind==='trip'?{trip,staff:[{id:3,name:'김운전자'}],deviceId:2,onSaved,onClose}:
  {init:kind==='update'?booking:null,presetDate:'2026-11-17',devices:[vehicle],staff:[{id:3,name:'김운전자',active:true}],onSaved,onClose};
}

for(const kind of ['trip','create','update']) {
 test(`${kind}: one write per rapid double click, with close and form locked until completion`,async()=>{
  const wait=pending(),c=await components({save:()=>wait.promise});let r,saved=0,closed=0;
  const Component=kind==='trip'?c.TripEditorModal:c.ReservationDialog;
  await act(async()=>{r=create(React.createElement(Component,props(kind,()=>saved++,()=>closed++)));});
  const submit=button(r,'저장').props.onClick,close=r.root.findByType(c.Modal).props.onClose;
  let first,second;
  await act(async()=>{first=submit();second=submit();close();});
  assert.equal(c.calls.length,1);assert.equal(closed,0);
  assert.equal(r.root.findByType(c.Modal).props.onClose,undefined);
  assert.equal(r.root.findByType('fieldset').props.disabled,true);
  assert.equal(button(r,'취소').props.disabled,true);
  assert.equal(button(r,'저장 중...').props.disabled,true);
  await act(async()=>{wait.resolve();await Promise.all([first,second]);});
  assert.equal(saved,1);assert.equal(r.root.findByType('fieldset').props.disabled,false);
  await act(async()=>r.unmount());
 });

 test(`${kind}: failed saves retain edits and allow a single retry`,async()=>{
  let attempts=0;
  const c=await components({save:async()=>{if(++attempts===1)throw new Error('연결 실패');}});let r,saved=0;
  const Component=kind==='trip'?c.TripEditorModal:c.ReservationDialog;
  await act(async()=>{r=create(React.createElement(Component,props(kind,()=>saved++)));});
  const memo=()=>kind==='trip'?r.root.findByProps({placeholder:'메모'}):r.root.findByType('textarea');
  await act(async()=>memo().props.onChange({target:{value:'다시 저장할 메모'}}));
  await act(async()=>button(r,'저장').props.onClick());
  assert.equal(c.alerts.at(-1).body,'연결 실패');assert.equal(saved,0);
  assert.equal(memo().props.value,'다시 저장할 메모');assert.equal(r.root.findByType('fieldset').props.disabled,false);
  await act(async()=>button(r,'저장').props.onClick());
  assert.equal(c.calls.length,2);assert.equal(saved,1);
  const payload=kind==='update'?c.calls[1].payload.body:c.calls[1].payload;
  assert.equal(payload.note,'다시 저장할 메모');
  await act(async()=>r.unmount());
 });

 test(`${kind}: results arriving after the dialog unmount cannot close another dialog or raise an alert`,async()=>{
  for(const outcome of ['resolve','reject']) {
   const wait=pending(),c=await components({save:()=>wait.promise});let r,saved=0;
   const Component=kind==='trip'?c.TripEditorModal:c.ReservationDialog;
   await act(async()=>{r=create(React.createElement(Component,props(kind,()=>saved++)));});
   let request;await act(async()=>{request=button(r,'저장').props.onClick();});
   await act(async()=>r.unmount());
   await act(async()=>{wait[outcome](outcome==='reject'?new Error('늦은 실패'):undefined);await request;});
   assert.equal(saved,0);assert.equal(c.alerts.length,0);
  }
 });
}

test('reservations reject invalid, reversed and overlong dates before calling the API',async()=>{
 const c=await components();let r;
 await act(async()=>{r=create(React.createElement(c.ReservationDialog,props('update')));});
 for(const [start,end] of [
  ['2026-11-17T09:00','2026-11-17T09:00'],['2026-11-17T10:00','2026-11-17T09:00'],
  ['2026-02-30T09:00','2026-03-02T10:00'],['2026-11-17T09:00','2027-11-19T09:00'],
 ]) {
  await act(async()=>{const inputs=r.root.findAllByProps({type:'datetime-local'});inputs[0].props.onChange({target:{value:start}});inputs[1].props.onChange({target:{value:end}});});
  await act(async()=>button(r,'저장').props.onClick());
  assert.equal(c.calls.length,0);assert.equal(c.alerts.at(-1).title,'예약 시간 확인');
 }
 assert.equal(r.root.findByType('fieldset').props.disabled,false);
 await act(async()=>r.unmount());
});

test('trip odometer validation blocks invalid writes and preserves zero, clear and optimistic version semantics',async()=>{
 const c=await components();let r;
 const original={...trip,annotation:{...trip.annotation,odometer_before_km:100,odometer_after_km:102.5,updated_at:'2026-11-18T01:00:00Z'}};
 await act(async()=>{r=create(React.createElement(c.TripEditorModal,{...props('trip'),trip:original}));});
 const field=label=>r.root.findAll(n=>n.type==='input'&&n.props['aria-label']===label)[0];
 const fill=async(a,b)=>act(async()=>{field('주행 전 계기판 (km)').props.onChange({target:{value:a}});field('주행 후 계기판 (km)').props.onChange({target:{value:b}});});
 await act(async()=>button(r,'저장').props.onClick());
 assert.equal('odometer_before_km' in c.calls[0].payload,false,'unmodified values must not overwrite other annotation edits');
 for(const [a,b] of [['','2'],['10','9'],['-1','2'],['0','1.001']]) {
  await fill(a,b);assert.equal(button(r,'저장').props.disabled,true);
  await act(async()=>button(r,'저장').props.onClick());
  assert.equal(c.calls.length,1);
 }
 await fill('0','12.35');assert.equal(!!button(r,'저장').props.disabled,false);
 assert.match(text(r.toJSON()),/12.35 km/);
 await act(async()=>button(r,'저장').props.onClick());
 assert.equal(c.calls[1].payload.odometer_before_km,0);assert.equal(c.calls[1].payload.odometer_after_km,12.35);
 assert.equal(c.calls[1].payload.expected_version,original.annotation.updated_at);
 assert.equal('distance_m' in c.calls[1].payload,false,'measured readings must not mutate GPS distance');
 await fill('','');await act(async()=>button(r,'저장').props.onClick());
 assert.equal(c.calls[2].payload.odometer_before_km,null);assert.equal(c.calls[2].payload.odometer_after_km,null);
 await act(async()=>r.unmount());
});

test('corrected trips retain read-only odometer fields and omit them while other details are edited',async()=>{
 const c=await components();let r;
 await act(async()=>{r=create(React.createElement(c.TripEditorModal,{...props('trip'),trip:{...trip,correction_id:7,annotation:{...trip.annotation,odometer_before_km:0,odometer_after_km:2.5}}}));});
 const inputs=r.root.findAll(n=>n.type==='input'&&n.props['aria-label']?.includes('계기판'));
 assert.equal(inputs.length,2);assert.ok(inputs.every(n=>n.props.disabled));
 assert.match(text(r.toJSON()),/원본으로 복원한 뒤/);
 await act(async()=>button(r,'저장').props.onClick());
 assert.equal('odometer_before_km' in c.calls[0].payload,false);assert.equal('odometer_after_km' in c.calls[0].payload,false);
 await act(async()=>r.unmount());
});

test('failed odometer saves retain readings for retry and cancelling writes nothing',async()=>{
 let attempts=0;const c=await components({save:async()=>{if(++attempts===1)throw Error('서버 저장 실패');}});let r,closed=0;
 await act(async()=>{r=create(React.createElement(c.TripEditorModal,props('trip',()=>{},()=>closed++)));});
 const field=label=>r.root.findAll(n=>n.type==='input'&&n.props['aria-label']===label)[0];
 await act(async()=>{field('주행 전 계기판 (km)').props.onChange({target:{value:'1000'}});field('주행 후 계기판 (km)').props.onChange({target:{value:'1012.5'}});});
 await act(async()=>button(r,'취소').props.onClick());assert.equal(closed,1);assert.equal(c.calls.length,0);
 await act(async()=>button(r,'저장').props.onClick());
 assert.equal(c.alerts[0].body,'서버 저장 실패');assert.equal(field('주행 후 계기판 (km)').props.value,'1012.5');
 await act(async()=>button(r,'저장').props.onClick());assert.equal(c.calls.length,2);assert.equal(c.calls[1].payload.odometer_after_km,1012.5);
 await act(async()=>r.unmount());
});

test('reservation forms and query boundaries remain Korean time in a Los Angeles browser',async()=>{
 const previous=process.env.TZ;process.env.TZ='America/Los_Angeles';
 const mounted=[];
 try {
  const c=await components({view:'calendar'});
  assert.equal(c.localToIso('2026-11-17T09:00'),'2026-11-17T00:00:00.000Z');
  assert.equal(c.isoToLocal('2026-11-17T00:00:00Z'),'2026-11-17T09:00');
  let r;
  await act(async()=>{r=create(React.createElement(c.ReservationDialog,props('create')));});mounted.push(r);
  assert.deepEqual(r.root.findAllByProps({type:'datetime-local'}).map(n=>n.props.value),['2026-11-17T09:00','2026-11-17T10:00']);
  assert.match(text(r.toJSON()),/한국시간\(KST\)/);
  await act(async()=>button(r,'저장').props.onClick());
  assert.equal(c.calls[0].payload.starts_at,'2026-11-17T00:00:00.000Z');
  await act(async()=>{r=create(React.createElement(c.ReservationDialog,{...props('create'),presetDate:null}));});mounted.push(r);
  assert.deepEqual(r.root.findAllByProps({type:'datetime-local'}).map(n=>n.props.value),['2026-11-17T10:00','2026-11-17T11:00']);
  await act(async()=>{r=create(React.createElement(c.ReservationsTab,{devices:[vehicle]}));});mounted.push(r);
  assert.equal(r.root.findByProps({'aria-label':'예약 조회 월'}).props.value,'2026-11');
  assert.equal(c.queries.at(-1).from,'2026-10-24T15:00:00.000Z');
  assert.equal(c.queries.at(-1).to,'2026-12-07T15:00:00.000Z');
  await act(async()=>button(r,'목록').props.onClick());
  assert.equal(c.queries.at(-1).from,'2026-11-09T15:00:00.000Z');
  assert.equal(c.queries.at(-1).to,'2027-01-16T15:00:00.000Z');
 } finally {
  for(const r of mounted)await act(async()=>r.unmount());
  if(previous===undefined)delete process.env.TZ;else process.env.TZ=previous;
 }
});
