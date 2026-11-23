import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,create} from 'react-test-renderer';
import {transform} from 'esbuild';

const hours={week_mask:127,open_minute:0,close_minute:1440,revision:2};
const operating={expense_approval_required:true,trip_purpose_required:false,personal_use_allowed:true,review_after_trip:true,offline_minutes:10,revision:3};

async function mount(t, role='owner') {
  const context=vm.createContext({});
  const source=await readFile(new URL('../src/components/business/FleetReservationPolicy.jsx',import.meta.url),'utf8');
  const code=await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'});
  const mod=new vm.SourceTextModule(code.code,{context});
  const calls=[];
  const record=name=>async body=>{calls.push([name,JSON.parse(JSON.stringify(body))]);return name==='operating'?{...operating,...body,revision:operating.revision+1}:body;};
  const api={fleetReservationPolicy:()=>{},fleetOperatingPolicy:()=>{},fleetBookingHours:()=>{},
    setFleetReservationPolicy:record('reservation'),setFleetOperatingPolicy:record('operating'),setFleetBookingHours:record('hours')};
  const data={'fleet-reservation-policy':{approval_required:true},'fleet-operating-policy':operating,'fleet-booking-hours':hours};
  const wrap=tag=>({children,primary,...props})=>React.createElement(tag,props,children);
  const Section=({title,children})=>React.createElement('section',{'aria-label':title},children);
  const modules={react:React,'react/jsx-runtime':jsx,'../../api':{api},'./FleetAccess':{useFleetAccess:()=>({role})},
    './BusinessWorkspace':{BusinessButton:wrap('button'),BusinessError:wrap('p'),BusinessSection:Section},
    './fleet-settings-controls.css':{},
    './FleetBookingHours':{bookingHoursKey:['fleet-booking-hours'],BookingHoursFields:()=>null,
      hoursDraft:h=>({mask:h.week_mask,allDay:true,start:'09:00',end:'18:00'}),hoursFromDraft:d=>({week_mask:d.mask,open_minute:0,close_minute:1440}),
      hoursChanged:(h,d)=>h.week_mask!==d.mask,hoursInvalid:()=>''},
    '@tanstack/react-query':{useQuery:({queryKey})=>({data:data[queryKey[0]],refetch:async()=>{}}),useQueryClient:()=>({setQueryData:()=>{}})}};
  await mod.link(name=>new vm.SyntheticModule(Object.keys(modules[name]),function(){
    for(const [key,value] of Object.entries(modules[name]))this.setExport(key,value);
  },{context}));
  await mod.evaluate();
  let renderer;
  await act(()=>{renderer=create(React.createElement(mod.namespace.default));});
  t.after(()=>act(()=>renderer.unmount()));
  return {renderer,calls};
}
const button=(root,text)=>root.findAll(n=>n.type==='button'&&n.children.includes(text))[0];

test('only the changed operating policy is saved, with its revision',async t=>{
  const {renderer,calls}=await mount(t);
  const root=renderer.root;
  assert.equal(button(root,'변경사항 저장').props.disabled,true);
  await act(()=>root.findByProps({'aria-label':'지출 신청 승인 방식'}).props.onChange({target:{value:'instant'}}));
  await act(()=>root.findByProps({'aria-label':'운행 목적 필수'}).props.onChange({target:{checked:true}}));
  const minutes=root.findByProps({'aria-label':'수신 지연 판단 시간(분)'});
  await act(()=>minutes.props.onChange({target:{value:'0'}}));
  assert.equal(button(root,'변경사항 저장').props.disabled,true,'out-of-range minutes cannot be saved');
  await act(()=>minutes.props.onChange({target:{value:'15'}}));
  await act(()=>button(root,'변경사항 저장').props.onClick());
  assert.deepEqual(calls,[['operating',{expense_approval_required:false,trip_purpose_required:true,personal_use_allowed:true,review_after_trip:true,offline_minutes:15,revision:3}]]);
});

test('revert restores the stored values without saving',async t=>{
  const {renderer,calls}=await mount(t);
  const root=renderer.root;
  await act(()=>root.findByProps({'aria-label':'차량 예약 승인 방식'}).props.onChange({target:{value:'instant'}}));
  assert.equal(root.findByProps({'aria-label':'차량 예약 승인 방식'}).props.value,'instant');
  await act(()=>button(root,'되돌리기').props.onClick());
  assert.equal(root.findByProps({'aria-label':'차량 예약 승인 방식'}).props.value,'approval');
  assert.deepEqual(calls,[]);
});

test('a member sees the policy read-only',async t=>{
  const {renderer}=await mount(t,'member');
  const root=renderer.root;
  assert.equal(button(root,'변경사항 저장'),undefined);
  assert.equal(root.findByProps({'aria-label':'지출 신청 승인 방식'}).props.disabled,true);
  assert.equal(root.findByProps({'aria-label':'수신 지연 판단 시간(분)'}).props.disabled,true);
  assert.match(JSON.stringify(renderer.toJSON()),/회사 소유자만 변경할 수 있습니다/);
});
