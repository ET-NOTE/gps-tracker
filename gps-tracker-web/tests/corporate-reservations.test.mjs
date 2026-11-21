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
import * as businessWorkspace from '../src/lib/businessWorkspace.js';
import * as navigation from '../src/lib/corporateNavigation.js';
import * as ntsReport from '../src/lib/ntsReport.js';
import * as tripOdometer from '../src/lib/tripOdometer.js';
import * as monthlySummary from '../src/lib/monthlySummary.js';
import * as tripQuality from '../src/lib/tripQuality.js';
import * as tripAssignments from '../src/lib/tripAssignments.js';
import * as incompleteTrips from '../src/lib/incompleteTrips.js';

const fixedNow=Date.parse('2026-11-17T00:00:00Z');
class FixedDate extends Date {constructor(...args){super(...(args.length?args:[fixedNow]));}static now(){return fixedNow;}}
const booking=(id,status,driver_name,vehicle_name,license_plate)=>({id,status,driver_name,vehicle_name,license_plate,
 vehicle_id:id%2?100:101,driver_staff_id:id%2?1:2,purpose:`방문 ${id}`,note:`메모 ${id}`,report_purpose:'business',
 starts_at:`2026-11-${String(17+id).padStart(2,'0')}T00:00:00Z`,ends_at:`2026-11-${String(17+id).padStart(2,'0')}T01:00:00Z`});
const reservations=[booking(1,'planned','김영업','영업 차량','123가4567'),booking(2,'in_progress','이관리','관리 차량','987나6543'),
 booking(3,'completed','김영업','영업 차량','123가4567'),booking(4,'cancelled','김영업','영업 차량','123가4567'),booking(5,'completed','박지원','지원 차량','111다2222')];
const devices=[{id:100,vehicle_name:'영업 차량',car_plate:'123가4567'},{id:101,vehicle_name:'관리 차량',car_plate:'987나6543'}];
const staff=[{id:1,name:'김영업',active:true},{id:2,name:'이관리',active:true},{id:3,name:'지난 사용자',active:false}];
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const button=(r,label)=>r.root.find(n=>n.type==='button'&&text(n.children).trim()===label);
const statusSelect=r=>r.root.findByProps({'aria-label':'예약 상태 필터'});
const statusOption=(r,label)=>statusSelect(r).find(n=>n.type==='option'&&text(n.children)===label);
async function chooseStatus(r,label){
 const value=statusOption(r,label).props.value;
 await act(async()=>statusSelect(r).props.onChange({target:{value}}));
}
const rowIds=r=>r.root.findByType('tbody').findAllByType('tr').map(row=>row.findByProps({className:'corporate-reservation-row-actions'}).findAllByType('button')[0].props['aria-label']);

async function mount(t,{data=reservations,request}={}){
 const state={data,error:null,isLoading:false,confirm:true,cancelError:null};
 const calls={query:[],cancel:[],create:[],update:[],confirm:[],alerts:[],retry:0};
 const storage=new Map();
 const context=vm.createContext({console,Date:FixedDate,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)}});
 const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
 const source=await readFile(new URL('../src/components/CorporatePanel.jsx',import.meta.url),'utf8');
 const code=(await transform(source+'\nexport {ReservationsTab};',{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const mod=new vm.SourceTextModule(code,{context});
 const noop=()=>null,tag=type=>({children,...props})=>React.createElement(type,props,children);
 const body=tag('section');
 const real={'react':React,'react/jsx-runtime':jsx,'../lib/business':business,'../lib/businessExport':businessExport,'../lib/corporateNavigation':navigation,
  '../lib/businessWorkspace':businessWorkspace,'../lib/ntsReport':ntsReport,'../lib/monthlySummary':monthlySummary,'../lib/tripOdometer':tripOdometer,
  '../lib/tripQuality':tripQuality,'../lib/tripAssignments':tripAssignments,'../lib/incompleteTrips':incompleteTrips};
 await mod.link(name=>{
  if(real[name])return moduleOf(real[name]);
  const exports={default:noop,api:{},subjectReport:r=>r,subjectScopeNote:'',CompanySubjectMappings:noop,
   corporateAttention:noop,corporateVehicleName:noop,terminalName:noop,missingMaintenance:noop,corporateGroups:[],corporateTabs:[],
   TripEvidence:noop,TripCorrection:noop,TripCorrectionHistory:noop,TripAssignmentModal:noop,TripRulesModal:noop,TripAssignmentHistory:noop,
   FleetAccountScope:noop,useFleetAccess:()=>({manage_reports:true,staff_id:1}),staffCanDrive:s=>s.active,
   BusinessWorkspace:noop,BusinessLocation:noop,useBusinessVehicle:noop,BusinessButton:tag('button'),
   BusinessError:({children,onRetry})=>React.createElement('section',{role:'alert'},children,React.createElement('button',{onClick:onRetry},'다시 시도')),
   BusinessEmpty:({title,children})=>React.createElement('section',{},title,children),BusinessSection:body,BusinessMetrics:noop,BusinessTask:noop,BusinessSettings:noop,BusinessVehicles:noop,
   BusinessCompanyInfo:noop,BusinessSubscription:noop,ageString:noop,classifyDevice:noop,deviceBattery:noop,useBusinessClock:()=>fixedNow,useBusinessSubscription:noop,
   alertDialog:args=>calls.alerts.push(args),confirmDialog:async args=>{calls.confirm.push(args);return state.confirm;},StatCard:noop,StatCardGrid:noop,
   FleetAssets:noop,FleetAssetForm:noop,FleetAssetDetail:noop,useFleetAssets:noop,projectFleetAssets:noop,fleetAssetsKey:[],useAssetStats:noop,
   useFleetReservations:params=>{calls.query.push({...params});return {data:state.data,error:state.error,isLoading:state.isLoading,refetch:()=>{calls.retry++;}};},
   useCreateFleetReservation:()=>({mutateAsync:async value=>calls.create.push(JSON.parse(JSON.stringify(value)))}),
   useUpdateFleetReservation:()=>({mutateAsync:async value=>calls.update.push(JSON.parse(JSON.stringify(value)))}),
   useCancelFleetReservation:()=>({mutateAsync:async id=>{if(state.cancelError)throw state.cancelError;calls.cancel.push(id);}}),
   Modal:({children,footer,title,onClose})=>React.createElement('section',{role:'dialog','aria-label':title,onClose},children,React.createElement('footer',{},footer)),
   FormField:body,Input:tag('input'),Select:tag('select'),Textarea:tag('textarea'),Button:tag('button'),SkeletonList:()=>React.createElement('div',{'aria-label':'불러오는 중'}),
   useCorporateInfo:noop,useStaff:()=>({data:staff}),qk:{},useQuery:noop,useQueryClient:noop};
  return moduleOf(exports);
 });
 await mod.evaluate();
 const props={devices,request};let r;
 await act(async()=>{r=create(React.createElement(mod.namespace.ReservationsTab,props));});
 t.after(async()=>{await act(async()=>r.unmount());});
 const rerender=async()=>act(async()=>r.update(React.createElement(mod.namespace.ReservationsTab,props)));
 return {r,state,calls,storage,rerender};
}

test('reservation search, status counts and table rows share the same query scope',async t=>{
 const {r,calls}=await mount(t);
 assert.equal(statusSelect(r).props.value,'all');
 assert.deepEqual(rowIds(r),reservations.map(row=>'예약 '+row.id+' 상세·수정'));
 await chooseStatus(r,'예정·진행 (2)');
 assert.deepEqual(rowIds(r),['예약 1 상세·수정','예약 2 상세·수정']);
 assert.ok(statusOption(r,'전체 (5)'));assert.ok(statusOption(r,'예정·진행 (2)'));assert.ok(statusOption(r,'완료 (2)'));assert.ok(statusOption(r,'취소 (1)'));
 const scope=calls.query.at(-1);
 await act(async()=>r.root.findByProps({'aria-label':'예약 차량·사용자 검색'}).props.onChange({target:{value:' 김영업 '}}));
 assert.ok(statusOption(r,'전체 (3)'));assert.ok(statusOption(r,'예정·진행 (1)'));assert.ok(statusOption(r,'완료 (1)'));assert.ok(statusOption(r,'취소 (1)'));
 assert.deepEqual(rowIds(r),['예약 1 상세·수정']);
 await chooseStatus(r,'완료 (1)');
 assert.deepEqual(rowIds(r),['예약 3 상세·수정']);
 await chooseStatus(r,'전체 (3)');
 assert.equal(rowIds(r).length,3);
 await act(async()=>r.root.findByProps({'aria-label':'예약 차량·사용자 검색'}).props.onChange({target:{value:'987나'}}));
 assert.deepEqual(rowIds(r),['예약 2 상세·수정']);
 assert.deepEqual(calls.query.at(-1),scope,'search and status do not change the date query');
 await act(async()=>r.root.findByProps({'aria-label':'예약 차량·사용자 검색'}).props.onChange({target:{value:'없는 차량'}}));
 assert.equal(rowIds(r).length,0);assert.match(text(r.toJSON()),/검색 결과가 없습니다/);assert.ok(statusOption(r,'전체 (0)'));
});

test('weekly bookings use Monday KST, span midnight, and exclude the exclusive end day',async t=>{
 const record={...reservations[0],starts_at:'2026-11-15T15:00:00Z',ends_at:'2026-11-17T15:00:00Z'};
 const {r,calls}=await mount(t,{data:[record]});
 await act(async()=>button(r,'주간 일정').props.onClick());
 assert.equal(calls.query.at(-1).from,'2026-11-15T15:00:00.000Z');
 assert.equal(calls.query.at(-1).to,'2026-11-22T15:00:00.000Z');
 assert.equal(r.root.findAllByProps({className:'fleet-week-event'}).length,2);
 await act(async()=>r.root.findByProps({'aria-label':'다음 주'}).props.onClick());
 assert.equal(r.root.findAllByProps({className:'fleet-week-event'}).length,0);
 await act(async()=>button(r,'이번 주').props.onClick());
 assert.equal(r.root.findAllByProps({className:'fleet-week-event'}).length,2);
});

test('a reservation refresh error hides stale rows and counts in both list and calendar',async t=>{
 const {r,state,calls,rerender}=await mount(t);
 state.error=Error('조회 실패');await rerender();
 assert.equal(r.root.findAllByType('table').length,0);assert.ok(statusOption(r,'전체 (—)'));assert.ok(statusOption(r,'예정·진행 (—)'));
 assert.equal(r.root.findAll(n=>n.type==='button'&&n.props['aria-label']?.includes('상세·수정')).length,0);
 await act(async()=>button(r,'다시 시도').props.onClick());assert.equal(calls.retry,1);
 await act(async()=>button(r,'캘린더').props.onClick());
 assert.equal(r.root.findAllByProps({className:'corporate-calendar-event'}).length,0);
 state.error=null;await rerender();
 assert.ok(r.root.findAllByProps({className:'corporate-calendar-event'}).length>0);
});

test('calendar navigation preserves list filters and day selection presets a new booking',async t=>{
 const {r,storage}=await mount(t);
 await chooseStatus(r,'완료 (2)');assert.equal(rowIds(r).length,2);
 await act(async()=>button(r,'캘린더').props.onClick());
 assert.equal(storage.get('resv_view'),'calendar');
 assert.equal(r.root.findByProps({'aria-label':'예약 조회 월'}).props.value,'2026-11');
 assert.equal(r.root.findAllByProps({className:'corporate-calendar-day'}).length,42);
 assert.equal(r.root.findAllByProps({className:'corporate-calendar-event'}).length,5,'calendar includes every status');
 await act(async()=>r.root.findByProps({'aria-label':'2026-11-20 새 예약'}).props.onClick({currentTarget:{focus(){}}}));
 const dialog=r.root.findByProps({role:'dialog'});
 assert.equal(dialog.props['aria-label'],'새 예약');
 const dateInputs=dialog.findAll(n=>n.type==='input'&&n.props.type==='datetime-local');
 assert.equal(dateInputs[0].props.value,'2026-11-20T09:00');assert.equal(dateInputs[1].props.value,'2026-11-20T10:00');
 await act(async()=>dialog.findByType('footer').findAllByType('button')[0].props.onClick());
 await act(async()=>button(r,'예약 목록').props.onClick());
 assert.equal(storage.get('resv_view'),'list');assert.equal(statusSelect(r).props.value,'completed');assert.equal(rowIds(r).length,2);
});

test('calendar overflow lists every matching booking across KST month boundaries and returns from editing',async t=>{
 const endingAtMidnight={...reservations[0],starts_at:'2026-11-29T22:00:00+09:00',ends_at:'2026-11-30T00:00:00+09:00'};
 const bookings=reservations.slice(1,4).map((r,i)=>({...r,starts_at:`2026-11-30T${10+i}:00:00+09:00`,ends_at:'2026-12-01T02:00:00+09:00'}));
 bookings[0].vehicle_name=bookings[0].license_plate;
 const {r,state,rerender,calls}=await mount(t,{data:[endingAtMidnight,...bookings]});
 const press=async node=>act(()=>node.props.onClick({currentTarget:{focus(){}}}));
 await press(button(r,'캘린더'));
 const dates=['2026-11-30','2026-12-01'];
 for(const day of dates){
   const overflow=r.root.findByProps({'aria-label':`${day} 예약 전체 3건 보기`});
   assert.equal(overflow.type,'button');
   assert.equal(text(overflow.children),'+1');
   await press(overflow);
   const dayDialog=r.root.findByProps({'aria-label':`${day} 예약`});
   const actions=dayDialog.findAllByProps({className:'corporate-calendar-booking'});
   assert.equal(actions.length,3);
   for(const [i,r] of bookings.entries()){
     const label=text(actions[i].children);
     assert.ok(label.includes(r.driver_name)&&label.includes(r.vehicle_name)&&label.includes(r.license_plate));
     assert.ok(label.includes(`목적 ${r.purpose}`));
     assert.equal(label.split(r.license_plate).length,2,'the same vehicle identity is announced once');
     assert.ok(label.includes(['진행중','완료','취소'][i]));
   }
   assert.match(text(actions[2].children),day===dates[0]?/12:00 ~ 2026-12-01 02:00/:/2026-11-30 12:00 ~ 02:00/);
   await press(actions[2]);
   const detail=r.root.findByProps({'aria-label':'예약 상세'});
   assert.match(text(detail.children),new RegExp(bookings[2].purpose));
   await press(button(r,'예약 변경'));
   assert.equal(r.root.findByProps({placeholder:'거래처 방문, 외근...'}).props.value,bookings[2].purpose);
   await act(()=>r.root.findByProps({'aria-label':'예약 편집'}).props.onClose());
   assert.equal(r.root.findAllByProps({role:'dialog'}).length,2);
   await act(()=>detail.props.onClose());
   assert.equal(r.root.findAllByProps({role:'dialog'}).length,1);
   await act(()=>dayDialog.props.onClose());
 }
 assert.equal(r.root.findByProps({'aria-label':'2026-12-01'}).props.disabled,true,'adjacent month dates cannot create new bookings');
 const last=r.root.findByProps({'aria-label':'2026-11-30 예약 전체 3건 보기'});
 await press(last);
 state.data=[bookings[0]];await rerender();
 assert.equal(r.root.findAllByProps({className:'corporate-calendar-booking'}).length,1,'the open list follows refetches');
 assert.equal(calls.create.length,0);
 assert.equal(calls.update.length,0);
});

test('reservation row details save the selected booking and cancellation remains confirmed',async t=>{
 const {r,state,calls}=await mount(t);
 await act(async()=>r.root.findByProps({'aria-label':'예약 1 상세·수정'}).props.onClick());
 assert.equal(r.root.findByProps({role:'dialog'}).props['aria-label'],'예약 편집');
 assert.equal(r.root.findByProps({placeholder:'거래처 방문, 외근...'}).props.value,'방문 1');
 await act(async()=>r.root.findByProps({placeholder:'거래처 방문, 외근...'}).props.onChange({target:{value:' 수정한 방문 '}}));
 await act(async()=>button(r,'저장').props.onClick());
 assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);
 assert.equal(calls.update[0].id,1);assert.equal(calls.update[0].body.vehicle_id,100);assert.equal(calls.update[0].body.purpose,'수정한 방문');
 assert.equal(calls.update[0].body.starts_at,reservations[0].starts_at.replace('Z','.000Z'));
 state.confirm=false;await act(async()=>r.root.findByProps({'aria-label':'예약 1 취소'}).props.onClick());
 assert.equal(calls.cancel.length,0);
 state.confirm=true;await act(async()=>r.root.findByProps({'aria-label':'예약 1 취소'}).props.onClick());
 assert.deepEqual(calls.cancel,[1]);assert.equal(calls.confirm.at(-1).danger,true);
 state.cancelError=Error('이미 변경된 예약');await act(async()=>r.root.findByProps({'aria-label':'예약 2 취소'}).props.onClick());
 assert.equal(calls.alerts.at(-1).title,'예약 취소 실패');assert.equal(calls.alerts.at(-1).body,'이미 변경된 예약');
 await chooseStatus(r,'취소 (1)');
 assert.deepEqual(rowIds(r),['예약 4 상세·수정']);assert.equal(r.root.findAllByProps({'aria-label':'예약 4 취소'}).length,0);
});
