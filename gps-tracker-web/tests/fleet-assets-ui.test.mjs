import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as filters from '../src/lib/fleetAssetFilters.js';
import * as assetsLib from '../src/lib/fleetAssets.js';

const vehicles=[
 {id:1,name:'영업 1호',department:'영업팀',manager_staff_id:1,license_plate:'123가4567',enabled:true,bindings:[],profile:{odometer_km:0},created_at:'2026-11-01T00:00:00Z'},
 {id:2,name:'영업 2호',department:'영업팀',manager_staff_id:1,license_plate:'123나4567',enabled:false,bindings:[],profile:{odometer_km:12000},created_at:'2026-11-03T00:00:00Z'},
 {id:3,name:'관리 차량',department:'관리팀',manager_staff_id:2,license_plate:'123다4567',enabled:true,bindings:[],profile:{},created_at:'2026-11-05T00:00:00Z'},
];
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const button=(r,label)=>r.root.find(n=>n.type==='button'&&text(n.children).trim()===label);
const groupButton=(r,label)=>r.root.find(n=>n.type==='button'&&n.props['aria-pressed']!==undefined&&text(n.findAllByType('span')[0]?.children)===label);
const groupCount=(r,label)=>Number(text(groupButton(r,label).findAllByType('span')[1].children));
const rowNames=r=>r.root.findByType('tbody').findAllByType('tr').map(n=>text(n.findAllByType('td')[0].children));
const detailDrawers=r=>r.root.findAll(n=>n.type==='aside'&&n.props['aria-label']);

async function mount(t,{manage=true,data=vehicles,devices=[]}={}){
 const context=vm.createContext({console});
 const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
 const code=(await transform(await readFile(new URL('../src/components/business/FleetAssets.jsx',import.meta.url),'utf8'),{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const mod=new vm.SourceTextModule(code,{context});
 const noop=()=>null,tag=type=>({children,...props})=>React.createElement(type,props,children);
 const connections=[],vehicleUpdates=[];
 const common={default:noop,api:{connectFleetVehicle:async(...args)=>{connections.push(args);},updateFleetVehicle:async(id,body)=>{vehicleUpdates.push({id,body});}},useFleetAccess:()=>({manage_vehicles:manage,manage_reports:manage}),useFleetOrganization:()=>({data:[]}),
  useStaff:()=>({data:[{id:1,name:'김영업',active:true},{id:2,name:'이관리',active:true}]}),
  useQuery:()=>({data}),useMutation:noop,useQueryClient:()=>({invalidateQueries:noop}),fleetDistance:noop,useBusinessClock:noop,kstDateTime:value=>value,
  classifyDevice:device=>({label:device.source_device_id?'오프라인':'미연결'}),ageString:noop,deviceBattery:noop,
  Modal:({children,footer,title})=>React.createElement('section',{role:'dialog','aria-label':title},children,footer),
  FormField:tag('label'),Input:tag('input'),Select:tag('select'),Textarea:tag('textarea'),Button:tag('button')};
 const real={'react':React,'react/jsx-runtime':jsx,'../../lib/fleetAssetFilters':filters,'../../lib/fleetAssets':assetsLib,
  '../CarImage':{default:({vehicleId,version,fallback})=>React.createElement('span',{'data-vehicle-id':vehicleId,'data-photo-version':version},fallback)}};
 const directoryCode=(await transform(await readFile(new URL('../src/components/business/DirectoryLayout.jsx',import.meta.url),'utf8'),{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const directory=new vm.SourceTextModule(directoryCode,{context});
 await directory.link(name=>synthetic(real[name]||common));await directory.evaluate();
 real['./DirectoryLayout']=directory.namespace;
 await mod.link(name=>synthetic(real[name]||(name==='./BusinessDrawer'?{default:({title,children,onClose})=>React.createElement('aside',{'aria-label':title},React.createElement('button',{'aria-label':'상세 닫기',onClick:onClose},'닫기'),children)}:common)));
 await mod.evaluate();
 const reports=[],maps=[];let r;
 await act(async()=>{r=create(React.createElement(mod.namespace.FleetAssets,{assets:data,devices,onChanged:noop,onMap:value=>maps.push(value),onReport:value=>reports.push(value.id)}));});
 t.after(async()=>{await act(async()=>r.unmount());});
 return {r,reports,maps,connections,vehicleUpdates};
}

test('saving a vehicle keeps unset profile numbers blank and preserves actual zero readings',async t=>{
 const data=[{...vehicles[0],profile:{odometer_km:null,next_service_km:0,model_year:null}}];
 const {r,vehicleUpdates}=await mount(t,{data});
 await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 수정'}).props.onClick());
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(vehicleUpdates.length,1);
 const {profile}=vehicleUpdates[0].body;
 assert.equal(profile.odometer_km,null);
 assert.equal(profile.model_year,null);
 assert.equal(profile.next_service_km,0);
});

test('vehicle status counts follow search scope and switching status preserves search and sort',async t=>{
 const {r}=await mount(t);
 assert.equal(groupButton(r,'전체').props['aria-pressed'],true);assert.equal(groupCount(r,'전체'),3);
 await act(async()=>r.root.findByProps({'aria-label':'등록 차량 검색'}).props.onChange({target:{value:'김영업'}}));
 assert.equal(groupCount(r,'전체'),2);assert.equal(groupCount(r,'사용 가능'),1);assert.equal(groupCount(r,'사용 정지'),1);
 await act(async()=>r.root.findByProps({'aria-label':'등록 차량 정렬'}).props.onChange({target:{value:'distanceDesc'}}));
 assert.match(rowNames(r)[0],/영업 2호/);
 await act(async()=>groupButton(r,'사용 정지').props.onClick());
 assert.deepEqual(rowNames(r),['영업 2호123나4567']);
 assert.equal(r.root.findByProps({'aria-label':'등록 차량 검색'}).props.value,'김영업');
 await act(async()=>button(r,'필터 초기화').props.onClick());
 assert.equal(rowNames(r).length,3);assert.equal(r.root.findByProps({'aria-label':'등록 차량 정렬'}).props.value,'name');
 assert.equal(groupButton(r,'전체').props['aria-pressed'],true);
});

test('vehicle department groups keep search-scoped counts and switch without losing query or sort',async t=>{
 const {r}=await mount(t);
 assert.equal(groupCount(r,'영업팀'),2);assert.equal(groupCount(r,'관리팀'),1);assert.equal(groupCount(r,'미지정'),0);
 await act(async()=>groupButton(r,'영업팀').props.onClick());
 assert.equal(rowNames(r).length,2);assert.equal(groupButton(r,'전체').props['aria-pressed'],false);
 await act(async()=>r.root.findByProps({'aria-label':'등록 차량 검색'}).props.onChange({target:{value:'관리'}}));
 assert.equal(rowNames(r).length,0);assert.equal(groupCount(r,'영업팀'),0);assert.equal(groupCount(r,'관리팀'),1);
 assert.equal(groupButton(r,'영업팀').props['aria-pressed'],true);
 await act(async()=>r.root.findByProps({'aria-label':'등록 차량 정렬'}).props.onChange({target:{value:'created'}}));
 await act(async()=>groupButton(r,'관리팀').props.onClick());
 assert.deepEqual(rowNames(r),['관리 차량123다4567']);
 assert.equal(r.root.findByProps({'aria-label':'등록 차량 검색'}).props.value,'관리');
 assert.equal(r.root.findByProps({'aria-label':'등록 차량 정렬'}).props.value,'created');
 await act(async()=>groupButton(r,'사용 정지').props.onClick());
 assert.equal(rowNames(r).length,0);assert.equal(groupButton(r,'관리팀').props['aria-pressed'],false);
 await act(async()=>button(r,'필터 초기화').props.onClick());
 assert.equal(rowNames(r).length,3);assert.equal(groupButton(r,'전체').props['aria-pressed'],true);
});

test('vehicle groups use registered departments and include vehicles without a department or a terminal',async t=>{
 const {r}=await mount(t,{data:[
  {...vehicles[0],department_id:10},
  {...vehicles[1],department_id:10},
  {...vehicles[2],department:'  ',department_id:null},
 ]});
 assert.equal(groupCount(r,'영업팀'),2);assert.equal(groupCount(r,'미지정'),1);
 await act(async()=>groupButton(r,'미지정').props.onClick());
 assert.deepEqual(rowNames(r),['관리 차량123다4567']);
 assert.match(text(r.root.findByType('tbody').children),/미연결/);
 await act(async()=>groupButton(r,'사용 정지').props.onClick());
 assert.deepEqual(rowNames(r),['영업 2호123나4567']);
 await act(async()=>groupButton(r,'영업팀').props.onClick());
 assert.equal(rowNames(r).length,2);assert.equal(groupButton(r,'사용 정지').props['aria-pressed'],false);
 await act(async()=>button(r,'필터').props.onClick());
 await act(async()=>r.root.findByProps({'aria-label':'최대 거리'}).props.onChange({target:{value:'0'}}));
 await act(async()=>button(r,'적용').props.onClick());
 assert.equal(groupCount(r,'영업팀'),1);assert.equal(groupCount(r,'미지정'),0);
 await act(async()=>button(r,'필터 초기화').props.onClick());
 assert.equal(rowNames(r).length,3);assert.equal(groupCount(r,'영업팀'),2);assert.equal(groupCount(r,'미지정'),1);
});

test('vehicle filter modal isolates drafts and validates before applying ranges',async t=>{
 const {r}=await mount(t);
 await act(async()=>button(r,'필터').props.onClick());
 await act(async()=>r.root.findByProps({'aria-label':'최소 거리'}).props.onChange({target:{value:'12000'}}));
 assert.equal(rowNames(r).length,3);
 await act(async()=>button(r,'취소').props.onClick());
 await act(async()=>button(r,'필터').props.onClick());
 assert.equal(r.root.findByProps({'aria-label':'최소 거리'}).props.value,'');
 await act(async()=>r.root.findByProps({'aria-label':'최소 거리'}).props.onChange({target:{value:'10'}}));
 await act(async()=>r.root.findByProps({'aria-label':'최대 거리'}).props.onChange({target:{value:'0'}}));
 assert.equal(button(r,'적용').props.disabled,true);assert.match(text(r.root.findByProps({role:'alert'}).children),/최소 거리가 최대 거리보다 큽니다/);
 assert.equal(rowNames(r).length,3);
 await act(async()=>r.root.findByProps({'aria-label':'최소 거리'}).props.onChange({target:{value:'0'}}));
 await act(async()=>button(r,'적용').props.onClick());
 assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);assert.deepEqual(rowNames(r),['영업 1호123가4567']);
 assert.equal(groupCount(r,'전체'),1);assert.equal(groupCount(r,'사용 정지'),0);
 await act(async()=>button(r,'필터').props.onClick());
 await act(async()=>r.root.findByProps({'aria-label':'계기판 거리 등록 여부'}).props.onChange({target:{value:'missing'}}));
 assert.equal(r.root.findByProps({'aria-label':'최소 거리'}).props.disabled,true);
 assert.equal(r.root.findByProps({'aria-label':'최소 거리'}).props.value,'');
 await act(async()=>button(r,'적용').props.onClick());
 assert.deepEqual(rowNames(r),['관리 차량123다4567']);
 await act(async()=>button(r,'필터').props.onClick());
 await act(async()=>button(r,'초기화').props.onClick());
 assert.equal(rowNames(r).length,1);
 await act(async()=>button(r,'적용').props.onClick());
 assert.equal(rowNames(r).length,3);
});

test('vehicle list keeps registration, editing and reporting permissions and callbacks',async t=>{
 const {r,reports}=await mount(t,{manage:false});
 assert.equal(r.root.findAll(n=>n.type==='button'&&['차량 등록','수정'].includes(text(n.children))).length,0);
 await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 상세'}).props.onClick());
 assert.equal(r.root.findAll(n=>n.type==='aside'&&n.props['aria-label']==='영업 1호').length,1);
 assert.equal(r.root.findAll(n=>n.type==='button'&&text(n.children)==='단말기 연결').length,0);
 await act(async()=>button(r,'운행기록부 보기').props.onClick());
 assert.deepEqual(reports,[1]);assert.equal(r.root.findAll(n=>n.type==='aside'&&n.props['aria-label']==='영업 1호').length,0);
 const managed=await mount(t);
 await act(async()=>button(managed.r,'차량 등록').props.onClick());
 assert.equal(managed.r.root.findByProps({role:'dialog'}).props['aria-label'],'차량 등록');
});

test('vehicle rows open details by click, Enter and Space without hijacking nested controls',async t=>{
 const {r}=await mount(t);
 const row=()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 상세 열기'});
 const close=async()=>act(async()=>r.root.findByProps({'aria-label':'상세 닫기'}).props.onClick());
 assert.equal(row().props.tabIndex,0);
 await act(async()=>row().props.onClick({target:{closest:()=>({tagName:'BUTTON'})}}));
 assert.equal(detailDrawers(r).length,0);
 await act(async()=>row().props.onClick({target:{closest:()=>null}}));
 assert.equal(detailDrawers(r)[0].props['aria-label'],'영업 1호');
 await close();
 const currentTarget={};let prevented=0;
 for(const key of ['Enter',' ']){
  await act(async()=>row().props.onKeyDown({key,target:{},currentTarget,preventDefault:()=>prevented++}));
  assert.equal(detailDrawers(r).length,0,'nested button keystrokes are left to that button');
  await act(async()=>row().props.onKeyDown({key,target:currentTarget,currentTarget,preventDefault:()=>prevented++}));
  assert.equal(detailDrawers(r)[0].props['aria-label'],'영업 1호');
  await close();
 }
 assert.equal(prevented,2);
 await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 수정'}).props.onClick());
 assert.equal(r.root.findByProps({role:'dialog'}).props['aria-label'],'차량 정보 수정');
 assert.equal(detailDrawers(r).length,0);
});

test('connection shortcut opens the correct tab and keeps vehicle and terminal identifiers independent',async t=>{
 const data=[{...vehicles[0],id:71,updated_at:'vehicle-version'},
  {...vehicles[1],id:72,bindings:[{id:2,device_id:9002,is_primary:true,terminal_name:'다른 차량 단말'}]}];
 const devices=[{id:9001,display_name:'연결할 단말'},{id:9002,display_name:'다른 차량 단말'}];
 const {r,connections}=await mount(t,{data,devices});
 await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 단말 연결'}).props.onClick());
 assert.equal(button(r,'단말기 연결').props['aria-pressed'],true);
 const checks=r.root.findAll(n=>n.type==='input'&&n.props.type==='checkbox');
 assert.equal(checks[0].props.disabled,false);assert.equal(checks[1].props.disabled,true);
 await act(async()=>checks[0].props.onChange({target:{checked:true}}));
 await act(async()=>button(r,'연결 저장').props.onClick());
 assert.equal(connections.length,1);assert.equal(connections[0][0],71);
 assert.deepEqual(JSON.parse(JSON.stringify(connections[0][1])),{device_ids:[9001],primary_device_id:9001,updated_at:'vehicle-version'});
 assert.equal(detailDrawers(r).length,0);
 const viewer=await mount(t,{manage:false,data,devices});
 assert.equal(viewer.r.root.findAll(n=>n.type==='button'&&/단말 연결| 수정$/.test(n.props['aria-label']||'')).length,0);
});

test('vehicle detail keeps operational state, communication, missing schedules and measured zero distinct',async t=>{
 const asset={...vehicles[0],id:71,profile:{odometer_km:0,next_service_km:0,insurance_expiry:'2026-12-31',car_image_url:'photo-version'},
  bindings:[{id:1,device_id:9001,is_primary:true,terminal_name:'대표 단말',started_at:'2026-11-01T00:00:00Z'}]};
 const {r,maps}=await mount(t,{data:[asset],devices:[{id:9001,display_name:'대표 단말'}]});
 assert.equal(r.root.findByProps({'data-photo-version':'photo-version'}).props['data-vehicle-id'],71);
 await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 상세'}).props.onClick());
 const info=r.root.findByProps({'aria-label':'차량 기본 정보'});
 const terminal=r.root.findByProps({'aria-label':'단말기 통신과 위치'});
 const maintenance=r.root.findByProps({'aria-label':'차량 점검 일정'});
 assert.match(text(info.children),/사용 가능/);assert.match(text(info.children),/계기판 누적거리0 km/);
 assert.match(text(info.children),/담당자김영업/);
 assert.match(text(terminal.children),/단말기 통신 상태오프라인/);
 assert.match(text(maintenance.children),/일정 미등록 2건/);
 assert.match(text(maintenance.children),/보험 만료일2026-12-31/);
 assert.match(text(maintenance.children),/다음 정비 주행거리0 km/);
 assert.doesNotMatch(text(maintenance.children),/예정 없음/);
 await act(async()=>button(r,'전체 지도 보기').props.onClick());
 assert.deepEqual(maps,[9001]);assert.equal(detailDrawers(r).length,0);
});
