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
import * as ntsReport from '../src/lib/ntsReport.js';
import * as tripOdometer from '../src/lib/tripOdometer.js';
import * as monthlySummary from '../src/lib/monthlySummary.js';
import * as tripQuality from '../src/lib/tripQuality.js';
import * as tripAssignments from '../src/lib/tripAssignments.js';
import * as incompleteTrips from '../src/lib/incompleteTrips.js';
import * as navigation from '../src/lib/corporateNavigation.js';

// Run the actual panel/dialog bodies with isolated hooks and file downloads.
async function components({trips=[],staff=[],access={manage_reports:true,staff_id:1},api:overrides={},companyQuery={data:{}},modules={}}={}) {
  const requests=[],downloads=[],alerts=[],prints=[];
  const api={listFleetVehicleTrips:async()=>trips,reportXlsx:async params=>{
    requests.push(JSON.parse(JSON.stringify(params)));return {blob:{},filename:'test.xlsx'};
  },...overrides};
  const context=vm.createContext({console,setTimeout:()=>0,requestAnimationFrame:callback=>callback(),window:{print(){prints.push(true);}},URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},document:{createElement:()=>({click(){downloads.push(this.download);}})}});
  const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  const source=await readFile(new URL('../src/components/CorporatePanel.jsx',import.meta.url),'utf8');
  const code=(await transform(source+'\nexport {ReportTab,DownloadDialog,TripsTable,TripEditorModal,MonthlyDeviceRow,reportPeriodError,reportMonthError};',{loader:'jsx',jsx:'automatic',format:'esm'})).code;
  const mod=new vm.SourceTextModule(code,{context});
  const noop=()=>null;
  const body=({children})=>React.createElement('section',{},children);
  const modal=({children,footer,title})=>React.createElement('section',{'aria-label':title},React.createElement('main',{},children),footer&&React.createElement('footer',{},footer));
  const errorBox=({children,onRetry})=>React.createElement('section',{role:'alert'},children,onRetry&&React.createElement('button',{onClick:onRetry},'다시 시도'));
  const button=({children,...props})=>React.createElement('button',props,children);
  const real={'react':React,'react/jsx-runtime':jsx,'../lib/business':business,'../lib/businessExport':businessExport,
    '../lib/businessWorkspace':businessWorkspace,'../lib/ntsReport':ntsReport,'../lib/monthlySummary':monthlySummary,'../lib/tripOdometer':tripOdometer,
    '../lib/tripQuality':tripQuality,'../lib/tripAssignments':tripAssignments,'../lib/incompleteTrips':incompleteTrips};
  await mod.link(name=>{
    if(real[name])return moduleOf(real[name]);
    if(name==='../api')return moduleOf({api});
    const exports={default:noop,subjectReport:r=>r,subjectScopeNote:'',CompanySubjectMappings:noop,
      corporateAttention:noop,corporateVehicleName:noop,terminalName:noop,missingMaintenance:noop,corporateGroups:[],corporateTabs:[],
      TripEvidence:noop,TripCorrection:noop,TripCorrectionHistory:noop,TripAssignmentModal:noop,TripRulesModal:noop,TripAssignmentHistory:noop,
      FleetAccountScope:noop,useFleetAccess:()=>access,staffCanDrive:s=>s.active,
      BusinessWorkspace:noop,BusinessLocation:noop,useBusinessVehicle:noop,BusinessButton:button,BusinessError:errorBox,BusinessEmpty:noop,BusinessSection:noop,BusinessMetrics:noop,BusinessTask:noop,BusinessSettings:noop,BusinessVehicles:noop,
      BusinessCompanyInfo:noop,BusinessSubscription:noop,ageString:noop,classifyDevice:noop,deviceBattery:noop,useBusinessClock:noop,useBusinessSubscription:noop,
      alertDialog:args=>alerts.push(args),confirmDialog:noop,StatCard:noop,StatCardGrid:noop,
      FleetAssets:noop,FleetAssetForm:noop,FleetAssetDetail:noop,useFleetAssets:noop,projectFleetAssets:noop,fleetAssetsKey:[],useAssetStats:noop,useFleetReservations:noop,useCreateFleetReservation:noop,useUpdateFleetReservation:noop,useCancelFleetReservation:noop,
      Modal:modal,FormField:body,Input:noop,Select:noop,Textarea:noop,Button:button,SkeletonList:noop,
      useCorporateInfo:()=>typeof companyQuery==='function'?companyQuery():companyQuery,useStaff:()=>({data:staff}),qk:{},useQuery:noop,useQueryClient:noop};
    return moduleOf({...exports,...modules[name]});
  });
  await mod.evaluate();
  return {...mod.namespace,requests,downloads,alerts,prints};
}
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const button=(r,label)=>r.root.findAll(n=>n.type==='button'&&text(n.children).trim()===label)[0];
const vehicle={id:2,car_model:'테스트차',car_plate:'12가3456'};
const trip=distance_m=>({started_at:'2026-12-20T00:00:00Z',ended_at:'2026-12-20T00:30:00Z',distance_m,duration_min:30,annotation:{purpose:'business',driver_staff_id:1,driver_name:'김운전자'}});
const shownRows=r=>r.root.findAllByProps({className:'corporate-trip-table'})[0]?.findByType('tbody').findAllByType('tr').length||0;
const filterRecords=[trip(40),{...trip(1000),started_at:'2026-12-21T00:00:00Z',ended_at:'2026-12-21T02:00:00Z',duration_min:120,annotation:{purpose:'commute',driver_staff_id:9,driver_name:'박운전자'}}];

test('expense categories remain reachable during vehicle and terminal outages while terminal access denials close the workspace',async()=>{
 let assetRetries=0,terminalRetries=0;
 const assets={isPending:true,refetch:()=>assetRetries++};
 const terminals={data:[],refetch:()=>terminalRetries++};
 const toolbar=React.createElement('select',{'aria-label':'회사 선택'});
 const marker=name=>()=>React.createElement(name);
 const panel=await components({modules:{
  './business/FleetAccess':{FleetAccountScope:({children})=>children(toolbar)},
  '../lib/corporateNavigation':navigation,
  '@tanstack/react-query':{useQuery:()=>terminals},
  './business/FleetAssets':{useFleetAssets:()=>assets,projectFleetAssets:rows=>rows,FleetAssets:marker('vehicle-list')},
  './business/FleetExpenses':{default:({categoriesOnly})=>React.createElement(categoriesOnly?'expense-categories':'expense-ledger')},
  './ui':{SkeletonList:marker('loading')},
  './business/BusinessWorkspace':{BusinessWorkspace:({onTab,tabs,devices,toolbar,children})=>
   React.createElement('main',{'data-vehicles':devices.length},toolbar,...tabs.map(t=>React.createElement('button',{key:t.id,onClick:()=>onTab(t.id)},t.label)),children)},
 }});
 let r;
 const render=()=>React.createElement(panel.default);
 try{
  await act(async()=>{r=create(render());});
  assert.equal(r.root.findByType('loading').type,'loading');
  assert.ok(r.root.findByProps({'aria-label':'회사 선택'}));
  await act(async()=>button(r,'항목 관리').props.onClick());
  assert.equal(r.root.findAllByType('expense-categories').length,1);
  Object.assign(assets,{isPending:false,error:Error('차량 오류'),data:[{id:1}]});
  await act(async()=>r.update(render()));
  assert.equal(r.root.findAllByType('expense-categories').length,1);
  assert.equal(r.root.findByType('main').props['data-vehicles'],0);
  await act(async()=>button(r,'차량 관리').props.onClick());
  assert.equal(r.root.findAllByType('vehicle-list').length,0);
  assert.match(text(r.toJSON()),/등록 차량을 불러오지 못했습니다/);
  await act(async()=>button(r,'다시 시도').props.onClick());
  assert.equal(assetRetries,1);
  assets.error=null;
  await act(async()=>r.update(render()));
  assert.equal(r.root.findAllByType('vehicle-list').length,1);
  terminals.isPending=true;
  await act(async()=>r.update(render()));
  assert.equal(r.root.findAllByType('loading').length,1);
  assert.equal(r.root.findByType('main').props['data-vehicles'],0);
  await act(async()=>button(r,'지출 내역').props.onClick());
  await act(async()=>button(r,'항목 관리').props.onClick());
  assert.equal(r.root.findAllByType('expense-categories').length,1);
  terminals.isPending=false;
  for (const error of [Object.assign(Error('일시 장애'),{status:503}),new TypeError('Failed to fetch')]) {
    terminals.error=error;
    await act(async()=>r.update(render()));
    assert.equal(r.root.findAllByType('expense-categories').length,1);
    await act(async()=>button(r,'차량 관리').props.onClick());
    assert.equal(r.root.findAllByType('vehicle-list').length,0);
    assert.equal(r.root.findByType('main').props['data-vehicles'],0);
    assert.match(text(r.toJSON()),/단말기 상태를 불러오지 못했습니다/);
    await act(async()=>button(r,'다시 시도').props.onClick());
    await act(async()=>button(r,'항목 관리').props.onClick());
  }
  assert.equal(terminalRetries,2);
  terminals.error=Object.assign(Error('단말기 조회 거부'),{status:403});
  await act(async()=>r.update(render()));
  assert.match(text(r.toJSON()),/단말기 상태를 불러오지 못했습니다/);
  assert.ok(r.root.findByProps({'aria-label':'회사 선택'}));
  assert.equal(r.root.findAllByType('expense-categories').length,0);
  assert.equal(button(r,'항목 관리'),undefined);
  await act(async()=>button(r,'다시 시도').props.onClick());
  assert.equal(terminalRetries,3);
 }finally{if(r)await act(async()=>r.unmount());}
});

test('report filter drafts leave results unchanged until applied and cancel restores applied values',async()=>{
  const {ReportTab}=await components({trips:filterRecords,staff:[{id:1,name:'김운전자',active:true},{id:9,name:'박운전자',active:true}]});let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle]}));});
  try{
    assert.equal(shownRows(r),2);assert.equal(r.root.findAllByProps({'aria-label':'운전자 필터'}).length,0);
    await act(async()=>button(r,'필터').props.onClick());
    assert.equal(button(r,'필터').props['aria-expanded'],true);
    await act(async()=>r.root.findByProps({'aria-label':'운전자 필터'}).props.onChange({target:{value:'9'}}));
    await act(async()=>r.root.findByProps({'aria-label':'용무 필터'}).props.onChange({target:{value:'commute'}}));
    await act(async()=>r.root.findByProps({'aria-label':'최소 운행시간'}).props.onChange({target:{value:'1'}}));
    assert.equal(shownRows(r),2,'editing the draft does not narrow the visible report');
    assert.equal(r.root.findAllByProps({'aria-label':'필터 적용 중'}).length,0);
    await act(async()=>button(r,'적용').props.onClick());
    assert.equal(shownRows(r),1);assert.equal(button(r,'필터').props['aria-expanded'],false);
    assert.equal(r.root.findAllByProps({'aria-label':'필터 적용 중'}).length,1);
    await act(async()=>button(r,'필터').props.onClick());
    await act(async()=>r.root.findByProps({'aria-label':'운전자 필터'}).props.onChange({target:{value:'1'}}));
    await act(async()=>r.root.findByProps({'aria-label':'용무 필터'}).props.onChange({target:{value:'business'}}));
    await act(async()=>r.root.findByProps({'aria-label':'최소 운행시간'}).props.onChange({target:{value:'3'}}));
    await act(async()=>button(r,'취소').props.onClick());
    assert.equal(shownRows(r),1);assert.match(text(r.root.findByProps({className:'corporate-trip-table'}).children),/박운전자/);
    await act(async()=>button(r,'필터').props.onClick());
    assert.equal(r.root.findByProps({'aria-label':'운전자 필터'}).props.value,'9');
    assert.equal(r.root.findByProps({'aria-label':'용무 필터'}).props.value,'commute');
    assert.equal(r.root.findByProps({'aria-label':'최소 운행시간'}).props.value,'1');
  }finally{await act(async()=>r.unmount());}
});

test('reset only changes a report filter draft until the user applies it',async()=>{
  const {ReportTab}=await components({trips:filterRecords});let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle]}));});
  try{
    await act(async()=>button(r,'필터').props.onClick());
    await act(async()=>r.root.findByProps({'aria-label':'용무 필터'}).props.onChange({target:{value:'commute'}}));
    await act(async()=>button(r,'적용').props.onClick());
    assert.equal(shownRows(r),1);
    await act(async()=>button(r,'필터').props.onClick());
    const checks=r.root.findByProps({className:'corporate-report-filter-checks'}).findAllByType('input');
    for(const checkbox of checks)await act(async()=>checkbox.props.onChange({target:{checked:true}}));
    await act(async()=>button(r,'초기화').props.onClick());
    assert.equal(r.root.findByProps({'aria-label':'운전자 필터'}).props.value,'all');
    assert.equal(r.root.findByProps({'aria-label':'용무 필터'}).props.value,'all');
    assert.equal(r.root.findByProps({'aria-label':'최소 운행시간'}).props.value,'');
    assert.ok(r.root.findByProps({className:'corporate-report-filter-checks'}).findAllByType('input').every(input=>input.props.checked===false));
    assert.equal(shownRows(r),1);
    await act(async()=>button(r,'취소').props.onClick());
    await act(async()=>button(r,'필터').props.onClick());
    assert.equal(r.root.findByProps({'aria-label':'용무 필터'}).props.value,'commute');
    await act(async()=>button(r,'초기화').props.onClick());
    await act(async()=>button(r,'적용').props.onClick());
    assert.equal(shownRows(r),2);assert.equal(r.root.findAllByProps({'aria-label':'필터 적용 중'}).length,0);
  }finally{await act(async()=>r.unmount());}
});

test('invalid minimum driving time cannot apply or discard a report filter draft',async()=>{
  const {ReportTab}=await components({trips:filterRecords});let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle]}));});
  try{
    await act(async()=>button(r,'필터').props.onClick());
    for(const value of ['-1','not-a-number']){
      await act(async()=>r.root.findByProps({'aria-label':'최소 운행시간'}).props.onChange({target:{value}}));
      assert.equal(button(r,'적용').props.disabled,true);assert.match(text(r.toJSON()),/0 이상의 숫자/);
      await act(async()=>button(r,'적용').props.onClick());
      assert.equal(button(r,'필터').props['aria-expanded'],true);assert.equal(shownRows(r),2);
    }
    await act(async()=>r.root.findByProps({'aria-label':'최소 운행시간'}).props.onChange({target:{value:'1'}}));
    assert.equal(button(r,'적용').props.disabled,false);
    await act(async()=>button(r,'적용').props.onClick());
    assert.equal(shownRows(r),1);
  }finally{await act(async()=>r.unmount());}
});

test('report vehicle search matches vehicle identity and department without changing selection until clicked',async()=>{
  const calls=[],other={id:3,vehicle_name:'배송 차량',license_plate:'98나7654',department:'배송팀'};
  const {ReportTab}=await components({api:{listFleetVehicleTrips:async(id,params)=>{calls.push({id,...params});return filterRecords;}}});let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle,other],initialDeviceId:2,initialFilter:{from:'2026-12-01',to:'2026-12-31'}}));});
  const listed=()=>r.root.findByProps({className:'corporate-report-vehicle-list'}).findAllByType('button');
  try{
    assert.equal(listed().length,2);assert.equal(calls.length,1);
    for(const value of ['  배송 차량  ','98나7654','배송팀']){
      await act(async()=>r.root.findByProps({'aria-label':'운행 차량 검색'}).props.onChange({target:{value}}));
      assert.equal(listed().length,1);assert.match(listed()[0].props['aria-label'],/98나7654/);
      assert.equal(listed()[0].props['aria-pressed'],false);assert.equal(calls.length,1);
    }
    await act(async()=>listed()[0].props.onClick());
    assert.equal(listed()[0].props['aria-pressed'],true);assert.equal(calls.length,2);
    assert.deepEqual(calls[1],{id:3,from:'2026-12-01',to:'2026-12-31'});
    await act(async()=>r.root.findByProps({'aria-label':'운행 차량 검색'}).props.onChange({target:{value:'없는 차량'}}));
    assert.equal(listed().length,0);assert.match(text(r.toJSON()),/검색된 차량이 없습니다/);
    assert.equal(calls.length,2);assert.equal(shownRows(r),2,'no matching vehicle search does not erase the selected report');
    await act(async()=>r.root.findByProps({'aria-label':'운행 차량 검색'}).props.onChange({target:{value:''}}));
    assert.equal(listed().length,2);assert.equal(listed()[1].props['aria-pressed'],true);
  }finally{await act(async()=>r.unmount());}
});

test('all-vehicle monthly XLSX includes every available vehicle despite vehicle search and report filters',async()=>{
  const other={id:3,car_model:'배송 차량',car_plate:'98나7654'};
  const {ReportTab,requests}=await components({trips:filterRecords});let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle,other],initialDeviceId:2,initialFilter:{from:'2026-12-20',to:'2027-01-03'}}));});
  try{
    await act(async()=>r.root.findByProps({'aria-label':'운행 차량 검색'}).props.onChange({target:{value:'배송'}}));
    await act(async()=>button(r,'필터').props.onClick());
    await act(async()=>r.root.findByProps({'aria-label':'용무 필터'}).props.onChange({target:{value:'commute'}}));
    await act(async()=>button(r,'적용').props.onClick());
    assert.equal(shownRows(r),1);
    await act(async()=>button(r,'전체 차량 월간 엑셀').props.onClick());
    assert.equal(r.root.findByProps({'aria-label':'엑셀 다운로드 월'}).props.value,'2026-12');
    assert.match(text(r.root.findByProps({className:'corporate-export-summary'}).children),/적용 차량 2대/);
    assert.match(text(r.toJSON()),/2026-12-20 ~ 2027-01-03/);
    await act(async()=>button(r,'XLSX 다운로드').props.onClick());
    assert.deepEqual(requests,[{type:'nts',month:'2026-12',scope:'vehicles',vehicle_ids:[2,3]}]);
  }finally{await act(async()=>r.unmount());}
});

test('XLSX identifies actual missing company and vehicle fields within the selected department intersection',async()=>{
  const devices=[{...vehicle,department:'영업'},
    {id:3,vehicle_name:'영업 지원차',car_model:'  ',license_plate:'23나4567',department:'영업'},
    {id:4,vehicle_name:'개발 차량',car_model:null,car_plate:' ',license_plate:null,department:'개발'}];
  const {DownloadDialog,requests}=await components({companyQuery:{data:{company_name:' ',business_number:null}}});let r;
  await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-11',devices,initialVehicleIds:[2,3,4],initialDepartments:['영업'],onClose(){}}));});
  const readiness=()=>r.root.findByProps({'aria-label':'다운로드 전 정보 확인'});
  try{
    assert.match(text(readiness().children),/회사 정보 미입력회사명 · 사업자등록번호/);
    let rows=readiness().findByType('tbody').findAllByType('tr');
    assert.equal(rows.length,1);assert.match(text(rows[0].children),/영업 지원차.*차종/);
    assert.doesNotMatch(text(readiness().children),/개발 차량/);
    assert.match(text(readiness().children),/시스템 설정 → 회사 정보/);
    assert.match(text(readiness().children),/차량·점검 정보 수정/);
    await act(async()=>r.root.findAllByType('label').find(n=>text(n.children)==='개발').findByType('input').props.onChange());
    rows=readiness().findByType('tbody').findAllByType('tr');
    assert.equal(rows.length,2);assert.match(text(rows[1].children),/개발 차량.*차종 · 차량번호/);
    await act(async()=>r.root.findAllByType('label').find(n=>text(n.children).startsWith('개발 차량')).findByType('input').props.onChange());
    assert.equal(readiness().findByType('tbody').findAllByType('tr').length,1);
    assert.equal(button(r,'XLSX 다운로드').props.disabled,false,'missing metadata is advisory rather than a new download block');
    await act(async()=>button(r,'XLSX 다운로드').props.onClick());
    assert.deepEqual(requests,[{type:'nts',month:'2026-11',scope:'vehicles',vehicle_ids:[2,3],departments:['영업','개발']}]);
  }finally{await act(async()=>r.unmount());}
});

test('XLSX has no metadata all-clear until company loading finishes, including a cached refresh',async()=>{
  for(const state of [{isPending:true,isFetching:true},{data:{},isFetching:true}]){
    let current=state;
    const {DownloadDialog}=await components({companyQuery:()=>current});let r;
    const render=()=>React.createElement(DownloadDialog,{ym:'2026-11',devices:[vehicle],onClose(){}});
    await act(async()=>{r=create(render());});
    try{
      const readiness=()=>r.root.findByProps({'aria-label':'다운로드 전 정보 확인'});
      assert.equal(readiness().props['aria-busy'],true);
      assert.match(text(readiness().children),/회사 정보를 확인하는 중/);
      assert.doesNotMatch(text(readiness().children),/회사 정보 미입력|입력되어 있습니다/);
      assert.equal(button(r,'XLSX 다운로드').props.disabled,false);
      current={data:{company_name:'시리얼링크',business_number:'123-45-67890'},isPending:false,isFetching:false};
      await act(async()=>r.update(render()));
      assert.equal(readiness().props['aria-busy'],false);
      assert.match(text(readiness().children),/선택한 차량의 차종·차량번호가 입력되어 있습니다/);
      assert.equal(readiness().findAllByType('table').length,0);
    }finally{await act(async()=>r.unmount());}
  }
});

test('XLSX distinguishes failed company lookup from blank fields and offers a retry without blocking the file',async()=>{
  let retries=0;
  let current={data:{},error:Error('조회 실패'),refetch:()=>{retries++;}};
  const {DownloadDialog,requests}=await components({companyQuery:()=>current});let r;
  const render=()=>React.createElement(DownloadDialog,{ym:'2026-11',devices:[vehicle],onClose(){}});
  await act(async()=>{r=create(render());});
  try{
    const readiness=()=>r.root.findByProps({'aria-label':'다운로드 전 정보 확인'});
    assert.match(text(readiness().children),/회사 정보를 불러오지 못해/);
    assert.doesNotMatch(text(readiness().children),/회사 정보 미입력|입력되어 있습니다/);
    assert.equal(button(r,'XLSX 다운로드').props.disabled,false);
    await act(async()=>button(r,'회사 정보 다시 조회').props.onClick());
    assert.equal(retries,1);
    current={...current,isFetching:true};await act(async()=>r.update(render()));
    assert.match(text(readiness().children),/회사 정보를 확인하는 중/);
    assert.equal(button(r,'회사 정보 다시 조회'),undefined);
    current={data:{company_name:'시리얼링크',business_number:null},isFetching:false};
    await act(async()=>r.update(render()));
    assert.match(text(readiness().children),/회사 정보 미입력사업자등록번호/);
    assert.doesNotMatch(text(readiness().children),/회사명 · 사업자등록번호|회사 정보를 불러오지 못해/);
    await act(async()=>button(r,'XLSX 다운로드').props.onClick());
    assert.equal(requests.length,1);
  }finally{await act(async()=>r.unmount());}
});

test('XLSX empty selection does not claim complete metadata and retains manual odometer and user guidance',async()=>{
  const {DownloadDialog}=await components({companyQuery:{data:{company_name:'시리얼링크',business_number:'123-45-67890'}}});let r;
  await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-11',devices:[vehicle],initialVehicleIds:[],onClose(){}}));});
  try{
    const readiness=r.root.findByProps({'aria-label':'다운로드 전 정보 확인'});
    assert.match(text(readiness.children),/차량을 선택하면/);
    assert.doesNotMatch(text(readiness.children),/입력되어 있습니다|회사 정보 미입력/);
    assert.match(text(r.toJSON()),/저장된 주행 전·후 계기판 거리의 차이를 우선 사용/);
    assert.match(text(r.toJSON()),/계기판이 미입력된 운행은 GPS 계산 또는 검토·보정된 운행기록 거리를 사용/);
    assert.match(text(r.toJSON()),/계기판 값은 운행 기록 수정에서 입력/);
    assert.match(text(r.toJSON()),/실제 차량 이용자가 다르면 파일의 사용자 성명·부서를 보완/);
    assert.equal(button(r,'XLSX 다운로드').props.disabled,true);
  }finally{await act(async()=>r.unmount());}
});

test('compact report status selection resets conflicting filters and selected rows',async()=>{
  const assignment={allocation_status:'assigned',source_device_id:10,binding_id:1};
  const records=[{...trip(40),...assignment},{...trip(100),...assignment,started_at:'2026-12-21T00:00:00Z',ended_at:'2026-12-21T00:30:00Z',annotation:{purpose:'unspecified'}}];
  const {ReportTab}=await components({trips:records});let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle]}));});
  await act(async()=>r.root.findByProps({'aria-label':'현재 운행 최대 100건 선택'}).props.onChange());
  assert.match(text(r.toJSON()),/2건 선택/);
  await act(async()=>button(r,'필터').props.onClick());
  await act(async()=>r.root.findByProps({'aria-label':'운전자 필터'}).props.onChange({target:{value:'9'}}));
  await act(async()=>r.root.findByProps({'aria-label':'최소 운행시간'}).props.onChange({target:{value:'2'}}));
  await act(async()=>button(r,'적용').props.onClick());
  assert.match(text(r.toJSON()),/필터 조건에 맞는 운행이 없습니다/);
  await act(async()=>button(r,'미작성 (1)').props.onClick());
  await act(async()=>button(r,'필터').props.onClick());
  assert.equal(r.root.findByProps({'aria-label':'운전자 필터'}).props.value,'all');
  assert.equal(r.root.findByProps({'aria-label':'최소 운행시간'}).props.value,'');
  await act(async()=>button(r,'취소').props.onClick());
  assert.equal(r.root.findByProps({className:'corporate-trip-table'}).findByType('tbody').findAllByType('tr').length,1);
  assert.match(text(r.toJSON()),/0건 선택/);
  await act(async()=>button(r,'전체 (2)').props.onClick());
  assert.equal(r.root.findByProps({className:'corporate-trip-table'}).findByType('tbody').findAllByType('tr').length,2);
  await act(async()=>r.unmount());
});

test('monthly table retains short/zero/unknown distances, recorded costs and edit permissions',async()=>{
  for(const [meters,expected] of [[40,'0.04 km'],[0,'0 km'],[null,'— km']]){
    const record={...trip(meters),annotation:{...trip(meters).annotation,fuel_cost:12000}};
    const row={...monthlySummary.summarizeMonthlyTrips([record]),label:'업무 차량',department:'영업',purchase_price_krw:30000000};
    const {MonthlyDeviceRow}=await components({access:{manage_vehicles:false}});let r;
    await act(async()=>{r=create(React.createElement(MonthlyDeviceRow,{row,onEdit(){}}));});
    assert.equal(r.root.findAllByType('td')[3].children.join(''),expected);
    assert.match(text(r.toJSON()),/12,000원/);
    assert.match(text(r.toJSON()),/실 입력비 반영/);
    assert.equal(button(r,'정보 편집').props.disabled,true);
    if(meters==null)assert.match(text(r.toJSON()),/확정 거리 없음/);
    await act(async()=>r.unmount());
  }
});

test('trip rows, daily total and editor preserve short/zero/unknown distance',async()=>{
  const {TripsTable,TripEditorModal}=await components();
  let r;
  const record=trip(40);
  await act(async()=>{r=create(React.createElement(TripsTable,{trips:[record],dailyDistance:new Map([['2026-12-20',40]]),selected:new Set(),eligible:[],onSelect(){},onSelectAll(){}}));});
  assert.equal(r.root.findAll(n=>n.type==='td'&&text(n.children)==='0.04 km').length,2);
  assert.equal(r.root.findByProps({'aria-label':'운행기록 목록 · 좌우 스크롤'}).props.tabIndex,0);
  await act(async()=>r.unmount());
  for(const [meters,expected] of [[40,'0.04 km'],[0,'0 km'],[null,'· —'],[NaN,'· —'],[-1,'· —']]){
    await act(async()=>{r=create(React.createElement(TripEditorModal,{trip:trip(meters),staff:[],deviceId:2,onClose(){}}));});
    assert.ok(text(r.toJSON()).includes(expected));
    if(meters==null||!Number.isFinite(meters)||meters<0)assert.ok(!text(r.toJSON()).includes('0 km'));
    await act(async()=>r.unmount());
  }
});

test('report XLSX opens with selected vehicle/start month and an explicit independent monthly scope',async()=>{
  const {ReportTab,requests}=await components({staff:[{id:1,name:'현재 사용자',active:true},{id:9,name:'과거 사용자',active:false}]});
  let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[{id:1,car_plate:'11가1111'},vehicle],initialDeviceId:2,initialFilter:{from:'2026-12-20',to:'2027-01-03'}}));});
  await act(async()=>button(r,'필터').props.onClick());
  const driver=r.root.findByProps({'aria-label':'운전자 필터'});
  assert.equal(text(driver.findAllByType('option').find(n=>n.props.value==='9').children),'과거 사용자 (비활성)');
  await act(async()=>driver.props.onChange({target:{value:'9'}}));
  await act(async()=>r.root.findByProps({'aria-label':'최소 운행시간'}).props.onChange({target:{value:'1'}}));
  await act(async()=>button(r,'적용').props.onClick());
  await act(async()=>button(r,'월간 엑셀(XLSX)').props.onClick());
  assert.equal(r.root.findByProps({'aria-label':'엑셀 다운로드 월'}).props.value,'2026-12');
  assert.match(text(r.toJSON()),/2026-12-20 ~ 2027-01-03/);
  assert.match(text(r.toJSON()),/선택한 월의 전체 기간/);
  assert.match(text(r.toJSON()),/운전자·최소 운행시간·미작성·미확정 필터는 적용하지 않습니다/);
  await act(async()=>button(r,'XLSX 다운로드').props.onClick());
  assert.deepEqual(requests,[{type:'nts',month:'2026-12',scope:'vehicles',vehicle_ids:[2]}]);
  await act(async()=>r.unmount());
});

test('XLSX month changes preserve explicit vehicle scope, including a single-vehicle company',async()=>{
  const {DownloadDialog,requests}=await components();let r;
  await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-12',devices:[vehicle],initialVehicleIds:[2],sourcePeriod:{from:'2026-12-20',to:'2027-01-03'},onClose(){}}));});
  await act(async()=>r.root.findByProps({'aria-label':'엑셀 다운로드 월'}).props.onChange({target:{value:'2027-01'}}));
  await act(async()=>button(r,'XLSX 다운로드').props.onClick());
  assert.deepEqual(requests,[{type:'nts',month:'2027-01',scope:'vehicles',vehicle_ids:[2]}]);
  await act(async()=>r.unmount());
});

test('existing monthly XLSX keeps all vehicles and inherited department filters',async()=>{
  const {DownloadDialog,requests}=await components();let r;
  await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-11',devices:[{...vehicle,department:'영업'},{id:3,department:'개발'}],initialDepartments:['영업'],onClose(){}}));});
  assert.equal(r.root.findAllByProps({'aria-label':'엑셀 다운로드 월'}).length,0);
  await act(async()=>button(r,'XLSX 다운로드').props.onClick());
  assert.deepEqual(requests,[{type:'nts',month:'2026-11',scope:'vehicles',departments:['영업']}]);
  await act(async()=>r.unmount());
});

test('a stale print success or failure cannot erase newer date/filter results',async()=>{
  for(const change of ['date','filter']) for(const rejectOld of [false,true]){
    let settle;
    const pending=new Promise((resolve,reject)=>{settle=rejectOld?()=>reject(Error('이전 인쇄 실패')):()=>resolve([trip(40)]);});
    const {ReportTab}=await components({api:{listFleetVehicleTrips:async(id,params)=>params.download==='print'?pending:[trip(40)]}});
    let r;
    await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle],initialFilter:{from:'2026-11-01',to:'2026-11-17'}}));});
    await act(async()=>{button(r,'화면 인쇄').props.onClick();});
    if(change==='filter')await act(async()=>button(r,'필터').props.onClick());
    await act(async()=>r.root.findByProps({'aria-label':change==='date'?'운행 조회 시작일':'용무 필터'}).props.onChange({target:{value:change==='date'?'2026-11-02':'business'}}));
    if(change==='filter')await act(async()=>button(r,'적용').props.onClick());
    assert.equal(r.root.findAllByProps({className:'corporate-trip-table'}).length,1);
    await act(async()=>settle());
    assert.equal(r.root.findAllByProps({className:'corporate-trip-table'}).length,1);
    assert.equal(r.root.findAllByProps({role:'alert'}).length,0);
    await act(async()=>r.unmount());
  }
});

test('print preparation blocks duplicate clicks and unlocks after both success and failure',async()=>{
  let release,printRequests=0;
  const pending=new Promise(resolve=>{release=resolve;});
  const {ReportTab,prints}=await components({api:{listFleetVehicleTrips:async(id,params)=>{
    if(params.download==='print'){
      printRequests++;
      if(printRequests===1)return pending;
      if(printRequests===2)throw Error('인쇄 준비 실패');
    }
    return [trip(40)];
  }}});let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle],initialFilter:{from:'2026-11-01',to:'2026-11-17'}}));});
  const click=button(r,'화면 인쇄').props.onClick;
  await act(async()=>{click();click();});
  assert.equal(printRequests,1);
  assert.equal(button(r,'인쇄 준비 중...').props.disabled,true);
  await act(async()=>release([trip(40)]));
  assert.equal(prints.length,1);
  assert.equal(button(r,'화면 인쇄').props.disabled,false);
  assert.equal(r.root.findAllByProps({className:'corporate-trip-table'}).length,1);
  await act(async()=>button(r,'화면 인쇄').props.onClick());
  assert.equal(printRequests,2);
  assert.match(text(r.toJSON()),/인쇄 준비 실패/);
  assert.equal(button(r,'인쇄 준비 중...'),undefined);
  await act(async()=>button(r,'다시 시도').props.onClick());
  assert.equal(button(r,'화면 인쇄').props.disabled,false);
  await act(async()=>button(r,'화면 인쇄').props.onClick());
  assert.equal(printRequests,3);assert.equal(prints.length,2);
  await act(async()=>r.unmount());
});

test('report range validation matches inclusive Korean 366-day API limits and blocks requests',async()=>{
  let calls=0;
  const {ReportTab,reportPeriodError}=await components({api:{listFleetVehicleTrips:async()=>{calls++;return [];}}});
  for(const [from,to] of [['2024-01-01','2024-12-31'],['2026-01-01','2027-01-01'],['2026-11-17','2026-11-17']])assert.equal(reportPeriodError(from,to),'');
  for(const [from,to] of [['2024-01-01','2025-01-01'],['2026-01-01','2027-01-02']])assert.match(reportPeriodError(from,to),/366일/);
  for(const [from,to] of [['','2026-11-17'],['2026-11-18','2026-11-17'],['2026-02-30','2026-03-01']])assert.match(reportPeriodError(from,to),/올바르게/);
  let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle],initialFilter:{from:'2024-01-01',to:'2025-01-01'}}));});
  assert.equal(calls,0);
  assert.match(text(r.toJSON()),/최대 366일/);
  assert.equal(button(r,'새로고침').props.disabled,true);
  assert.equal(button(r,'다시 시도'),undefined,'changing the range, not retrying it, resolves validation errors');
  await act(async()=>r.root.findByProps({'aria-label':'운행 조회 종료일'}).props.onChange({target:{value:'2024-12-31'}}));
  assert.equal(calls,1);
  assert.match(text(r.toJSON()),/이 기간에 운행 기록이 없습니다/);
  assert.equal(r.root.findAllByProps({role:'alert'}).length,0);
  await act(async()=>r.unmount());
});

test('report fetch failure remains distinct from empty results and retries the same period',async()=>{
  const calls=[];let fail=true;
  const {ReportTab}=await components({api:{listFleetVehicleTrips:async(id,params)=>{calls.push({id,...params});if(fail)throw Error('연결 실패');return [];}}});let r;
  await act(async()=>{r=create(React.createElement(ReportTab,{devices:[vehicle],initialFilter:{from:'2026-11-01',to:'2026-11-17'}}));});
  assert.match(text(r.toJSON()),/운행기록을 불러오지 못했습니다/);
  assert.doesNotMatch(text(r.toJSON()),/이 기간에 운행 기록이 없습니다/);
  fail=false;await act(async()=>button(r,'다시 시도').props.onClick());
  assert.deepEqual(calls,[{id:2,from:'2026-11-01',to:'2026-11-17'},{id:2,from:'2026-11-01',to:'2026-11-17'}]);
  assert.match(text(r.toJSON()),/이 기간에 운행 기록이 없습니다/);
  await act(async()=>r.unmount());
});

test('XLSX locks its inputs, blocks duplicate clicks and retries with preserved selections in its footer',async()=>{
  const calls=[];let rejectFirst,closed=0;
  const pending=new Promise((resolve,reject)=>{rejectFirst=reject;});
  const {DownloadDialog,alerts,downloads}=await components({api:{reportXlsx:async params=>{calls.push(JSON.parse(JSON.stringify(params)));return calls.length===1?pending:{blob:{},filename:'retry.xlsx'};}}});let r;
  await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-11',devices:[{...vehicle,department:'영업'},{id:3,department:'개발'}],initialVehicleIds:[2],initialDepartments:['영업'],sourcePeriod:{from:'2026-11-01',to:'2026-11-17'},onClose(){closed++;}}));});
  await act(async()=>r.root.findByProps({'aria-label':'엑셀 다운로드 월'}).props.onChange({target:{value:'2027-02'}}));
  await act(async()=>r.root.findAll(n=>n.type==='button'&&text(n.children).startsWith('우리 양식'))[0].props.onClick());
  await act(async()=>button(r,'개별 선택').props.onClick());
  assert.equal(button(r,'XLSX 다운로드').props.disabled,true);
  assert.match(text(r.toJSON()),/운행목적을 하나 이상 선택/);
  await act(async()=>button(r,'XLSX 다운로드').props.onClick());
  assert.equal(calls.length,0);
  await act(async()=>r.root.findAllByType('label').find(n=>text(n.children)==='업무').findByType('input').props.onChange());
  const click=button(r,'XLSX 다운로드').props.onClick;
  await act(async()=>{click();click();});
  assert.equal(calls.length,1);
  const fields=r.root.findByProps({'aria-label':'엑셀 다운로드 조건'});
  assert.equal(fields.props.disabled,true);
  assert.ok(fields.findAllByType('input').length>=4);
  assert.equal(button(r,'취소').props.disabled,true);
  assert.ok(r.root.findByType('footer').findAllByType('button').length===2);
  await act(async()=>rejectFirst(Error('일시적인 연결 실패')));
  assert.equal(r.root.findByProps({'aria-label':'엑셀 다운로드 조건'}).props.disabled,false);
  assert.equal(r.root.findByProps({'aria-label':'엑셀 다운로드 월'}).props.value,'2027-02');
  assert.match(text(r.root.findByType('footer').children),/일시적인 연결 실패.*선택한 조건을 유지했습니다/);
  assert.equal(alerts.length,0,'failure belongs to this dialog, not a second alert modal');
  await act(async()=>button(r,'다시 다운로드').props.onClick());
  assert.deepEqual(calls,[{type:'ours',month:'2027-02',scope:'vehicles',vehicle_ids:[2],purposes:['business'],departments:['영업']},{type:'ours',month:'2027-02',scope:'vehicles',vehicle_ids:[2],purposes:['business'],departments:['영업']}]);
  assert.deepEqual(downloads,['retry.xlsx']);assert.equal(closed,1);
  await act(async()=>r.unmount());
});

test('XLSX allows month editing but rejects blank/out-of-range months before the API',async()=>{
  const {DownloadDialog,requests,reportMonthError}=await components();let r;
  for(const valid of ['2000-01','2100-12'])assert.equal(reportMonthError(valid),'');
  await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-11',devices:[vehicle],sourcePeriod:{from:'2026-11-01',to:'2026-11-17'},onClose(){}}));});
  for(const invalid of ['', '1999-12','2101-01','2026-13']){
    await act(async()=>r.root.findByProps({'aria-label':'엑셀 다운로드 월'}).props.onChange({target:{value:invalid}}));
    assert.equal(r.root.findByProps({'aria-label':'엑셀 다운로드 월'}).props.value,invalid);
    assert.equal(button(r,'XLSX 다운로드').props.disabled,true);
    await act(async()=>button(r,'XLSX 다운로드').props.onClick());
    assert.equal(requests.length,0);
    assert.ok(r.root.findAllByProps({role:'alert'}).length>0);
  }
  await act(async()=>r.root.findByProps({'aria-label':'엑셀 다운로드 월'}).props.onChange({target:{value:'2100-12'}}));
  assert.equal(button(r,'XLSX 다운로드').props.disabled,false);
  await act(async()=>r.unmount());
});

test('XLSX blocks missing vehicles, empty selections and empty department intersections',async()=>{
  const {DownloadDialog,requests}=await components();
  const cases=[
    {devices:[],expected:/다운로드할 차량이 없습니다/},
    {devices:[vehicle],initialVehicleIds:[],expected:/차량을 하나 이상/},
    {devices:[vehicle],initialDepartments:[],expected:/부서를 하나 이상/},
    {devices:[{...vehicle,department:'개발'}],initialDepartments:['영업'],expected:/함께 해당하는 차량이 없습니다/},
  ];
  for(const {expected,...props} of cases){let r;
    await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-11',...props,onClose(){}}));});
    assert.equal(button(r,'XLSX 다운로드').props.disabled,true);
    assert.match(text(r.toJSON()),expected);
    assert.match(text(r.root.findByProps({className:'corporate-export-summary'}).children),/적용 차량 0대/);
    await act(async()=>button(r,'XLSX 다운로드').props.onClick());
    assert.equal(requests.length,0);
    if(props.initialDepartments?.[0]==='영업'){
      await act(async()=>button(r,'전체').props.onClick());
      assert.equal(button(r,'XLSX 다운로드').props.disabled,false,'a stale department filter can be cleared even with only one current department');
    }
    await act(async()=>r.unmount());
  }
});

test('XLSX counts vehicle/department intersection and preserves all explicitly selected department values',async()=>{
  const {DownloadDialog,requests}=await components();let r;
  await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-11',devices:[{...vehicle,department:'영업'},{id:3,department:'개발'}],initialVehicleIds:[2],initialDepartments:['개발'],onClose(){}}));});
  assert.match(text(r.root.findByProps({className:'corporate-export-summary'}).children),/적용 차량 0대/);
  await act(async()=>r.root.findAllByType('label').find(n=>text(n.children)==='영업').findByType('input').props.onChange());
  assert.match(text(r.root.findByProps({className:'corporate-export-summary'}).children),/적용 차량 1대/);
  await act(async()=>button(r,'XLSX 다운로드').props.onClick());
  assert.deepEqual(requests,[{type:'nts',month:'2026-11',scope:'vehicles',vehicle_ids:[2],departments:['개발','영업']}]);
  await act(async()=>r.unmount());
});

test('selecting all four trip purposes remains an unfiltered purpose export',async()=>{
  const {DownloadDialog,requests}=await components();let r;
  await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-11',devices:[{...vehicle,department:'영업'}],initialVehicleIds:[2],initialDepartments:['영업'],onClose(){}}));});
  await act(async()=>button(r,'개별 선택').props.onClick());
  for(const purpose of ['업무','출퇴근','기타','미지정']){
    await act(async()=>r.root.findAllByType('label').find(n=>text(n.children)===purpose).findByType('input').props.onChange());
  }
  await act(async()=>button(r,'XLSX 다운로드').props.onClick());
  assert.deepEqual(requests,[{type:'nts',month:'2026-11',scope:'vehicles',vehicle_ids:[2],departments:['영업']}]);
  await act(async()=>r.unmount());
});

test('leaving an XLSX dialog prevents late file saves and stale error prompts',async()=>{
  for(const fail of [false,true]){
    let settle;const pending=new Promise((resolve,reject)=>{settle=fail?()=>reject(Error('이전 회사 실패')):()=>resolve({blob:{},filename:'old.xlsx'});});
    const {DownloadDialog,downloads,alerts}=await components({api:{reportXlsx:()=>pending}});let r;
    await act(async()=>{r=create(React.createElement(DownloadDialog,{ym:'2026-11',devices:[vehicle],onClose(){}}));});
    await act(async()=>{button(r,'XLSX 다운로드').props.onClick();});
    await act(async()=>r.unmount());
    await act(async()=>settle());
    assert.equal(downloads.length,0);assert.equal(alerts.length,0);
  }
});
