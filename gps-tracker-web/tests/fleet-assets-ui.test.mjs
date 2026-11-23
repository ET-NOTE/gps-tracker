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

async function mount(t,{manage=true,phone=false,data=vehicles,devices=[],saveVehicle,onChanged=()=>{},initialMissingSchedules=false,mapReturn,mockupHidden=false}={}){
 const context=vm.createContext({console});
 const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
 const code=(await transform(await readFile(new URL('../src/components/business/FleetAssets.jsx',import.meta.url),'utf8'),{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const mod=new vm.SourceTextModule(code,{context});
 const noop=()=>null,tag=type=>({children,...props})=>React.createElement(type,props,children);
 const connections=[],vehicleUpdates=[],invalidations=[];
 const save=async(id,body)=>{vehicleUpdates.push({id,body});return saveVehicle?.(id,body);};
 const common={default:noop,VehicleGroupForm:noop,useVehicleGroups:()=>({data:[{id:45,name:'영업차량'},{id:46,name:'관리차량'}]}),api:{connectFleetVehicle:async(...args)=>{connections.push(args);},updateFleetVehicle:save,createFleetVehicle:body=>save(undefined,body)},useFleetAccess:()=>({manage_vehicles:manage,manage_reports:manage}),useFleetOrganization:()=>({data:[]}),
  useStaff:()=>({data:[{id:1,name:'김영업',active:true},{id:2,name:'이관리',active:true}]}),
  useQuery:({queryKey})=>queryKey.at(-1)==='stats'?{data:{per_device:[]}}:{data},useMutation:noop,useQueryClient:()=>({invalidateQueries:options=>invalidations.push(options.queryKey)}),fleetDistance:noop,useBusinessClock:noop,kstDateTime:value=>value,
  downloadReport:noop,classifyDevice:device=>({label:device.source_device_id?'오프라인':'미연결'}),ageString:noop,deviceBattery:noop,
  Modal:({children,footer,title,onClose})=>React.createElement('section',{role:'dialog','aria-label':title},onClose&&React.createElement('button',{'aria-label':'창 닫기',onClick:onClose}),children,footer),
  FormField:tag('label'),Input:tag('input'),Select:tag('select'),Textarea:tag('textarea'),Button:tag('button')};
 const real={'react':React,'react/jsx-runtime':jsx,'../../lib/fleetAssetFilters':filters,'../../lib/fleetAssets':assetsLib,
  '../../useCorporatePhone':{default:()=>phone},
  '../../lib/mockupHidden':{hideOutsideMockup:mockupHidden},
  './FleetBatchBindings':{default:()=>React.createElement('button',{},'단말기 일괄 연결')},
  '../CarImage':{default:({vehicleId,version,fallback})=>React.createElement('span',{'data-vehicle-id':vehicleId,'data-photo-version':version},fallback)}};
 const directoryCode=(await transform(await readFile(new URL('../src/components/business/DirectoryLayout.jsx',import.meta.url),'utf8'),{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const directory=new vm.SourceTextModule(directoryCode,{context});
 await directory.link(name=>synthetic(real[name]||common));await directory.evaluate();
 real['./DirectoryLayout']=directory.namespace;
 if(phone){
  const mobileSource=await readFile(new URL('../src/components/business/MobileFleetDirectory.jsx',import.meta.url),'utf8');
  const mobileDirectory=new vm.SourceTextModule((await transform(mobileSource,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await mobileDirectory.link(name=>synthetic(real[name]||common));await mobileDirectory.evaluate();
  real['./MobileFleetDirectory']=mobileDirectory.namespace;
 }
 await mod.link(name=>synthetic(real[name]||(name==='./BusinessDrawer'?{default:({title,children,onClose})=>React.createElement('aside',{'aria-label':title},React.createElement('button',{'aria-label':'상세 닫기',onClick:onClose},'닫기'),children)}:common)));
 await mod.evaluate();
 const reports=[],maps=[];let r;
 const render=assets=>React.createElement(mod.namespace.FleetAssets,{assets,devices,onChanged,initialMissingSchedules,mapReturn,onMap:(deviceId,origin)=>maps.push({deviceId,origin}),onReport:value=>reports.push(value.id)});
 await act(async()=>{r=create(render(data));});
 t.after(async()=>{await act(async()=>r.unmount());});
 return {r,reports,maps,connections,vehicleUpdates,invalidations,FleetAssetForm:mod.namespace.FleetAssetForm,refresh:assets=>act(async()=>r.update(render(assets)))};
}

test('editing a registered maintenance date selects that field and preserves other schedules',async t=>{
 const {r,FleetAssetForm,vehicleUpdates}=await mount(t);
 const asset={...vehicles[0],updated_at:'2026-11-19T00:00:00Z',profile:{insurance_expiry:'2027-01-03',inspection_expiry:'2027-02-01',next_service_date:null}};
 await act(async()=>r.update(React.createElement(FleetAssetForm,{asset,scheduleOnly:true,scheduleScope:'insurance_expiry',onClose(){},onSaved(){}})));
 const dialog=r.root.findByProps({role:'dialog','aria-label':'점검 일정 수정'});
 const input=dialog.findByType('input');
 assert.equal(input.props.name,'insurance_expiry');
 assert.equal(input.props.value,'2027-01-03');
 assert.equal(button(r,'저장').props.disabled,true);
 await act(()=>input.props.onChange({target:{value:'2027-02-04'}}));
 await act(async()=>dialog.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(vehicleUpdates.length,1);
 assert.deepEqual({...vehicleUpdates[0].body.profile},{...asset.profile,insurance_expiry:'2027-02-04'});
 assert.equal(vehicleUpdates[0].body.updated_at,asset.updated_at);
});

test('phone rows identify the registered terminal even when its telemetry is missing',async t=>{
 const pending={...vehicles[0],bindings:[{id:21,device_id:81,is_primary:true,terminal_name:'등록된 단말'}]};
 const {r}=await mount(t,{manage:false,phone:true,data:[pending,vehicles[1]]});
 const rows=r.root.findAllByProps({className:'mobile-fleet-row mobile-vehicle-row'});
 assert.equal(r.root.findAllByType('table').length,0);
 assert.match(text(rows[0].children),/단말 등록된 단말 · 통신 정보 확인 불가/);
 assert.match(text(rows[1].children),/단말 미연결/);
 assert.equal(r.root.findAllByProps({className:'mobile-fleet-create'}).length,0);
 await act(async()=>rows[0].props.onClick());
 assert.equal(detailDrawers(r).length,1);
 assert.equal(r.root.findAllByProps({'aria-label':'차량·점검 정보 수정'}).length,0);
});

test('phone vehicle headings keep distinct details and omit duplicate or empty descriptions',async t=>{
 const base={...vehicles[0],manager_staff_id:null,department:null};
 const data=[
  {...base,id:10,license_plate:'12tk3456',name:' 12TK 3456 ',car_model:'12tk3456'},
  {...base,id:11,license_plate:null,name:'차량 정보 미등록',car_model:'미등록'},
  {...base,id:12,license_plate:'차량번호 미등록',name:'  업무 차량  ',car_model:'쏘나타',department:'영업팀'},
  {...base,id:13,license_plate:'123가4567',name:'쏘나타',car_model:'쏘나타',manager_staff_id:1},
  {...base,id:14,license_plate:null,name:null,car_model:'스타리아'},
 ];
 const {r}=await mount(t,{phone:true,data});
 const rows=r.root.findAllByProps({className:'mobile-fleet-row mobile-vehicle-row'});
 const displayed=rows.map(row=>[
  text(row.findByProps({className:'mobile-fleet-row-title'}).children),
  row.findAllByProps({className:'mobile-fleet-row-copy'}).map(cell=>text(cell.children)).join(''),
 ]);
 for(const [title,description] of [
  ['12tk3456',''],['차량 정보 미등록',''],['업무 차량','쏘나타 · 영업팀'],
  ['123가4567','쏘나타 · 김영업'],['차량 정보 미등록','스타리아'],
 ])assert.ok(displayed.some(([heading,copy])=>heading===title&&copy===description),title+' / '+description);
 assert.equal(rows.flatMap(row=>row.findAllByProps({className:'mobile-fleet-row-copy'})).length,3);
});

test('missing-schedule list edits only missing dates and drops completed vehicles on refresh',async t=>{
 const complete={next_service_date:'2028-02-01',insurance_expiry:'2028-07-03',inspection_expiry:'2028-07-31'};
 const data=[
   {...vehicles[0],profile:{...complete,insurance_expiry:null,odometer_km:0},updated_at:'2026-11-01T00:00:00Z'},
   {...vehicles[1],profile:complete},
   {...vehicles[2],profile:null},
 ];
 const {r,refresh,vehicleUpdates}=await mount(t,{data,initialMissingSchedules:true});
 assert.equal(rowNames(r).length,2);
 assert.match(text(r.root.findByProps({role:'status'}).children),/점검 일정 미등록 2대/);
 await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 점검 일정 등록'}).props.onClick());
 const dialog=r.root.findByProps({role:'dialog','aria-label':'점검 일정 등록'});
 assert.deepEqual(dialog.findAllByType('input').map(n=>n.props.name),['insurance_expiry']);
 assert.equal(button(r,'저장').props.disabled,true);
 await act(async()=>dialog.findByType('input').props.onChange({target:{value:'2028-08-01'}}));
 await act(async()=>dialog.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(vehicleUpdates.length,1);
 const [{id,body}]=vehicleUpdates;
 assert.equal(id,1);assert.equal(body.department,'영업팀');assert.equal(body.updated_at,data[0].updated_at);
 assert.deepEqual({...body.profile},{...data[0].profile,insurance_expiry:'2028-08-01'});
 await refresh([{...data[0],profile:body.profile},...data.slice(1)]);
 assert.deepEqual(rowNames(r),['123다4567관리 차량']);
 await act(async()=>button(r,'필터 초기화').props.onClick());
 assert.equal(rowNames(r).length,3);
});

test('read-only operators can filter missing schedules without an edit action',async t=>{
 const {r}=await mount(t,{manage:false});
 await act(async()=>button(r,'필터').props.onClick());
 await act(async()=>r.root.findByProps({'aria-label':'점검 일정 등록 여부'}).props.onChange({target:{value:'missing'}}));
 await act(async()=>button(r,'적용').props.onClick());
 assert.equal(rowNames(r).length,3);
 assert.match(text(r.root.findByType('tbody').children),/보험 만료일/);
 assert.equal(r.root.findAll(n=>n.type==='button'&&text(n.children)==='일정 등록').length,0);
});

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

test('a pending vehicle registration accepts one submission, protects the draft and permits retry on failure',async t=>{
 let reject,refreshes=0;
 const firstSave=new Promise((_,fail)=>{reject=fail;});
 const {r,vehicleUpdates}=await mount(t,{saveVehicle:()=>vehicleUpdates.length===1?firstSave:undefined,onChanged:()=>refreshes++});
 await act(async()=>button(r,'차량 등록').props.onClick());
 const name=()=>r.root.find(n=>n.type==='input'&&n.props.maxLength===120&&n.props.required);
 await act(async()=>name().props.onChange({target:{value:'새 업무 차량'}}));
 const submit=r.root.findByType('form').props.onSubmit;
 const close=r.root.findByProps({'aria-label':'창 닫기'}).props.onClick;
 const cancel=button(r,'취소').props.onClick;
 let request;
 await act(async()=>{request=submit({preventDefault(){}});await submit({preventDefault(){}});close();cancel();});
 assert.equal(vehicleUpdates.length,1);
 assert.equal(r.root.findAllByProps({'aria-label':'창 닫기'}).length,0);
 assert.equal(r.root.findByType('form').props['aria-busy'],true);
 assert.equal(r.root.findByProps({className:'fleet-asset-form fleet-assets-editor'}).props.disabled,true);
 assert.equal(button(r,'취소').props.disabled,true);
 await act(async()=>{reject(Error('등록 요청 실패'));await request;});
 assert.match(text(r.root.findByProps({role:'alert'}).children),/등록 요청 실패/);
 assert.equal(name().props.value,'새 업무 차량');assert.equal(refreshes,0);
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(vehicleUpdates.length,2);assert.equal(vehicleUpdates[1].body.name,'새 업무 차량');
 assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);assert.equal(refreshes,1);
});

test('a vehicle update that finishes after leaving the screen refreshes the list without calling the old dialog',async t=>{
 let resolve,refreshes=0;
 const pending=new Promise(done=>{resolve=done;});
 const {r,invalidations}=await mount(t,{saveVehicle:()=>pending,onChanged:()=>refreshes++});
 await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 수정'}).props.onClick());
 let request;await act(async()=>{request=r.root.findByType('form').props.onSubmit({preventDefault(){}});});
 await act(async()=>r.unmount());
 await act(async()=>{resolve();await request;});
 assert.equal(refreshes,0);assert.deepEqual(invalidations.map(key=>Array.from(key)),[['business','corporate','vehicles']]);
});

const statusLabel='등록 차량 운영 상태',departmentLabel='등록 차량 부서';
const selectValue=(r,label,value)=>act(async()=>r.root.findByProps({'aria-label':label}).props.onChange({target:{value}}));
const countOption=(r,label,value)=>Number(text(r.root.findByProps({'aria-label':label}).find(n=>n.type==='option'&&n.props.value===value).children).match(/\((\d+)\)$/)[1]);

test('vehicle availability preserves search and sorting and reports counts within the current search',async t=>{
 const {r}=await mount(t);
 assert.equal(groupButton(r,'전체 차량').props['aria-pressed'],true);assert.equal(groupCount(r,'전체 차량'),3);
 await selectValue(r,'등록 차량 검색','김영업');
 assert.equal(groupCount(r,'전체 차량'),2);assert.equal(countOption(r,statusLabel,'enabled'),1);assert.equal(countOption(r,statusLabel,'disabled'),1);
 await selectValue(r,'등록 차량 정렬','distanceDesc');assert.match(rowNames(r)[0],/영업 2호/);
 await selectValue(r,statusLabel,'disabled');assert.deepEqual(rowNames(r),['123나4567영업 2호']);
 assert.equal(r.root.findByProps({'aria-label':'등록 차량 검색'}).props.value,'김영업');
 await act(async()=>button(r,'필터 초기화').props.onClick());
 assert.equal(rowNames(r).length,3);assert.equal(r.root.findByProps({'aria-label':'등록 차량 정렬'}).props.value,'name');
 assert.equal(groupButton(r,'전체 차량').props['aria-pressed'],true);
});

test('department selection keeps query and sort and combines with vehicle availability',async t=>{
 const {r}=await mount(t),sales='department-name:영업팀',office='department-name:관리팀';
 assert.equal(countOption(r,departmentLabel,sales),2);assert.equal(countOption(r,departmentLabel,office),1);assert.equal(countOption(r,departmentLabel,'unassigned'),0);
 await selectValue(r,departmentLabel,sales);assert.equal(rowNames(r).length,2);
 await selectValue(r,'등록 차량 검색','관리');assert.equal(rowNames(r).length,0);
 assert.equal(countOption(r,departmentLabel,sales),0);assert.equal(countOption(r,departmentLabel,office),1);
 await selectValue(r,'등록 차량 정렬','created');await selectValue(r,departmentLabel,office);
 assert.deepEqual(rowNames(r),['123다4567관리 차량']);assert.equal(r.root.findByProps({'aria-label':'등록 차량 검색'}).props.value,'관리');
 assert.equal(r.root.findByProps({'aria-label':'등록 차량 정렬'}).props.value,'created');
 await selectValue(r,statusLabel,'disabled');assert.equal(rowNames(r).length,0);assert.equal(r.root.findByProps({'aria-label':departmentLabel}).props.value,office);
 await act(async()=>button(r,'필터 초기화').props.onClick());assert.equal(rowNames(r).length,3);
});

test('company vehicle groups are independent from department IDs and include older ungrouped vehicles',async t=>{
 const {r}=await mount(t,{data:[{...vehicles[0],department_id:10,group_id:45},{...vehicles[1],department_id:10,group_id:46},{...vehicles[2],department:'  ',department_id:null}]});
 assert.equal(countOption(r,departmentLabel,'department:10'),2);assert.equal(countOption(r,departmentLabel,'unassigned'),1);
 assert.equal(groupCount(r,'영업차량'),1);assert.equal(groupCount(r,'관리차량'),1);assert.equal(groupCount(r,'그룹 미지정'),1);
 await act(async()=>groupButton(r,'그룹 미지정').props.onClick());assert.deepEqual(rowNames(r),['123다4567관리 차량']);assert.match(text(r.root.findByType('tbody').children),/미연결/);
 await act(async()=>groupButton(r,'전체 차량').props.onClick());await selectValue(r,departmentLabel,'department:10');assert.equal(rowNames(r).length,2);
 await act(async()=>groupButton(r,'영업차량').props.onClick());assert.deepEqual(rowNames(r),['123가4567영업 1호']);
 await act(async()=>button(r,'필터').props.onClick());await selectValue(r,'최대 거리','0');await act(async()=>button(r,'적용').props.onClick());
 assert.equal(groupCount(r,'영업차량'),1);assert.equal(groupCount(r,'관리차량'),0);
 await act(async()=>button(r,'필터 초기화').props.onClick());assert.equal(rowNames(r).length,3);assert.equal(groupCount(r,'그룹 미지정'),1);
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
 assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);assert.deepEqual(rowNames(r),['123가4567영업 1호']);
 assert.equal(groupCount(r,'전체 차량'),1);assert.equal(countOption(r,statusLabel,'disabled'),0);
 await act(async()=>button(r,'필터').props.onClick());
 await act(async()=>r.root.findByProps({'aria-label':'계기판 거리 등록 여부'}).props.onChange({target:{value:'missing'}}));
 assert.equal(r.root.findByProps({'aria-label':'최소 거리'}).props.disabled,true);
 assert.equal(r.root.findByProps({'aria-label':'최소 거리'}).props.value,'');
 await act(async()=>button(r,'적용').props.onClick());
 assert.deepEqual(rowNames(r),['123다4567관리 차량']);
 await act(async()=>button(r,'필터').props.onClick());
 await act(async()=>button(r,'초기화').props.onClick());
 assert.equal(rowNames(r).length,1);
 await act(async()=>button(r,'적용').props.onClick());
 assert.equal(rowNames(r).length,3);
});

test('vehicle list keeps registration, editing and reporting permissions and callbacks',async t=>{
 const {r,reports}=await mount(t,{manage:false});
 assert.equal(r.root.findAll(n=>n.type==='button'&&['차량 등록','수정','단말기 일괄 연결'].includes(text(n.children))).length,0);
 await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 상세'}).props.onClick());
 assert.equal(r.root.findAll(n=>n.type==='aside'&&n.props['aria-label']==='123가4567').length,1);
 assert.equal(r.root.findAll(n=>n.type==='button'&&text(n.children)==='단말기 연결').length,0);
 await act(async()=>button(r,'운행기록부 보기').props.onClick());
 assert.deepEqual(reports,[1]);assert.equal(r.root.findAll(n=>n.type==='aside'&&n.props['aria-label']==='123가4567').length,0);
 const managed=await mount(t);
 assert.ok(button(managed.r,'단말기 일괄 연결'));
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
 assert.equal(detailDrawers(r)[0].props['aria-label'],'123가4567');
 await close();
 const currentTarget={};let prevented=0;
 for(const key of ['Enter',' ']){
  await act(async()=>row().props.onKeyDown({key,target:{},currentTarget,preventDefault:()=>prevented++}));
  assert.equal(detailDrawers(r).length,0,'nested button keystrokes are left to that button');
  await act(async()=>row().props.onKeyDown({key,target:currentTarget,currentTarget,preventDefault:()=>prevented++}));
  assert.equal(detailDrawers(r)[0].props['aria-label'],'123가4567');
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
 assert.match(text(info.children),/사용 가능/);assert.match(text(r.root.findByProps({className:'fleet-vehicle-hero'}).children),/계기판 누적거리0 km/);
 assert.match(text(info.children),/담당자김영업/);
 assert.match(text(terminal.children),/단말기 통신 상태오프라인/);
 assert.match(text(maintenance.children),/일정 미등록 2건/);
 assert.match(text(maintenance.children),/보험 만료일2026-12-31/);
 assert.match(text(maintenance.children),/다음 정비 주행거리0 km/);
 assert.doesNotMatch(text(maintenance.children),/예정 없음/);
 await act(async()=>button(r,'전체 지도 보기').props.onClick());
 assert.equal(maps.length,1);
 const [{deviceId,origin}]=maps;
 assert.equal(deviceId,9001);assert.equal(origin.vehicleId,71);assert.equal(origin.detailTab,'status');
 const back=await mount(t,{data:[asset],devices:[{id:9001,display_name:'대표 단말'}],mapReturn:origin});
 assert.equal(detailDrawers(back.r)[0].props['aria-label'],'123가4567');
 const revoked=await mount(t,{data:[],mapReturn:origin});
 assert.equal(detailDrawers(revoked.r).length,0);
});

test('an active terminal with unavailable telemetry stays connected, while an ended binding is unconnected',async t=>{
 const binding={id:9,device_id:42,is_primary:true,terminal_name:'검수 단말',started_at:'2026-10-01T00:00:00Z'};
 for(const current of [true,false]){
  const asset={...vehicles[0],bindings:[{...binding,ended_at:current?null:'2026-11-01T00:00:00Z'}]};
  const {r}=await mount(t,{data:[asset],devices:[]});
  await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 상세'}).props.onClick());
  const facts=r.root.findByProps({'aria-label':'단말기 통신과 위치'}).findAllByType('dd').map(n=>text(n.children));
  assert.deepEqual(facts,current?['검수 단말','연결됨 · 통신 정보 확인 불가','확인 불가','확인 불가']:['단말기 미연결','미연결','수신 이력 없음','수신 이력 없음']);
  assert.equal(r.root.findAll(n=>n.type==='button'&&text(n.children)==='전체 지도 보기').length,0);
 }
});

test('vehicle detail survives edit cancellation and saving, and uses the refreshed vehicle version for a new connection',async t=>{
 const asset={...vehicles[0],updated_at:'first-version'};
 let changes=0;
 const {r,refresh,connections,vehicleUpdates}=await mount(t,{data:[asset],devices:[{id:901,display_name:'새 단말기'}],onChanged:()=>{changes++;}});
 await act(async()=>r.root.findByProps({'aria-label':'영업 1호 · 123가4567 상세'}).props.onClick());
 const open=()=>act(async()=>button(r,'차량·점검 정보 수정').props.onClick({currentTarget:{focus(){}}}));
 const drawer=detailDrawers(r)[0];
 await open();
 assert.equal(detailDrawers(r)[0],drawer);
 await act(async()=>button(r,'취소').props.onClick());
 assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);
 assert.equal(detailDrawers(r)[0],drawer);
 await open();
 const type=r.root.find(n=>n.type==='input'&&n.props.maxLength===120&&!n.props.required);
 await act(async()=>type.props.onChange({target:{value:'테스트 차종'}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(vehicleUpdates[0].body.car_model,'테스트 차종');
 assert.equal(changes,1);
 await refresh([{...asset,car_model:'테스트 차종',updated_at:'after-edit'}]);
 assert.equal(detailDrawers(r)[0],drawer);
 assert.match(text(drawer.children),/테스트 차종/);
 assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);
 await act(async()=>button(r,'단말기 연결').props.onClick());
 await act(async()=>r.root.find(n=>n.type==='input'&&n.props.type==='checkbox').props.onChange({target:{checked:true}}));
 await act(async()=>button(r,'연결 저장').props.onClick());
 assert.equal(connections[0][1].updated_at,'after-edit');
});

test('desktop mockup mode hides batch binding, advanced filters and sorting but keeps them on phones',async t=>{
 const desk=await mount(t,{mockupHidden:true});
 const labels=desk.r.root.findAll(n=>n.type==='button').map(n=>text(n.children));
 assert.ok(!labels.includes('단말기 일괄 연결')&&!labels.includes('필터'));
 assert.equal(desk.r.root.findAllByProps({className:'fleet-assets-sort'}).length,0);
 assert.ok(labels.includes('필터 초기화'));
 assert.match(text(desk.r.toJSON()),/차량 정보와 단말 수신 상태는 별도로 관리합니다/);
 const phone=await mount(t,{mockupHidden:true,phone:true});
 assert.ok(phone.r.root.findAll(n=>n.type==='button').some(n=>text(n.children)==='단말기 일괄 연결'));
});
