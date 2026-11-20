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
import * as businessExport from '../src/lib/businessExport.js';
import * as sites from '../src/lib/fleetSites.js';
import * as assets from '../src/lib/fleetAssets.js';

const people=[
 {id:1,name:'김영업',department:'영업팀',department_id:1,position:'팀장',phone:'010-1111-1111',access_role:'member',active:true,account_id:11,created_at:'2026-11-01T00:00:00Z',updated_at:'people-v1'},
 {id:2,name:'박퇴사',department:'영업팀',department_id:1,access_role:'member',active:false,created_at:'2026-11-01T00:00:00Z',updated_at:'people-v2'},
 {id:3,name:'이관리',department:'관리팀',department_id:2,access_role:'admin',active:true,created_at:'2026-11-01T00:00:00Z',updated_at:'people-v3'},
];
const places=[
 {id:10,name:'서울 본사',address:'서울 강남구',group_id:1,group_name:'본사',active:true,geometry:{type:'circle',lat:37,lng:127,radius_m:200}},
 {id:11,name:'구 본사',address:'서울 강서구',group_id:1,group_name:'본사',active:false,geometry:{type:'circle',lat:37,lng:127,radius_m:200}},
 {id:12,name:'부산 지사',address:'부산 중구',group_id:2,group_name:'지사',active:true,geometry:{type:'circle',lat:35,lng:129,radius_m:200}},
];
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const button=(r,label)=>r.root.findAll(n=>n.type==='button'&&text(n.children).trim()===label)[0];
const tableRows=r=>r.root.findByType('tbody').findAllByType('tr');
const groupButton=(r,label)=>r.root.findAll(n=>n.type==='button'&&n.props.className==='fleet-directory-group'&&text(n.children[0])===label)[0];
async function ready(check){for(let i=0;i<100;i++){if(check())return;await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));}assert.ok(check(),'directory query did not settle');}

async function mount(name,{access={manage_team:true,role:'owner'},phone=false,props={},staffData=people,siteData=places,organization={},groupQuery,assetQuery={},siteServices={},apiOverrides={},waitForData=true}={}){
 const calls={visits:[],updates:[],unlinks:[],revocations:[]};
 const qc=new query.QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
 const api={fleetInvites:async()=>[],fleetTeamAudit:async()=>[],
  listFleetSites:async()=>siteData,listFleetSiteGroups:groupQuery|| (async()=>[{id:1,name:'본사',active:true},{id:2,name:'지사',active:true}]),
  listFleetSiteVisits:async params=>{calls.visits.push({...params});return {items:[{id:1,site_name:'서울 본사',vehicle_name:'영업 차량',first_inside_at:'2026-11-17T00:00:00Z',last_inside_at:'2026-11-17T00:05:00Z',observed_seconds:300,status:'inside'}],next_before:params.before?null:'visit-cursor'};},
  updateStaff:async(id,body)=>calls.updates.push({id,body}),unlinkFleetStaff:async id=>calls.unlinks.push(id),revokeFleetInvite:async id=>calls.revocations.push(id),...apiOverrides};
 const context=vm.createContext({console});
 const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
 const source=await readFile(new URL(`../src/components/business/${name}.jsx`,import.meta.url),'utf8');
 const code=(await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const mod=new vm.SourceTextModule(code,{context});
 const tag=type=>({children,...props})=>React.createElement(type,props,children);
 const noop=()=>null;
 const common={default:noop,api,qk:{staff:()=>['staff']},useStaff:()=>({data:staffData,isPending:false}),
  useFleetAccess:()=>access,useFleetOrganization:()=>({data:[{id:1,name:'영업팀',kind:'department',active:true},{id:2,name:'관리팀',kind:'department',active:true}],...organization}),
  useFleetAssets:()=>({data:[{id:100,name:'영업 차량'},{id:101,name:'관리 차량'}],...assetQuery}),fleetRoles:{member:'일반 사용자',admin:'관리자'},confirmDialog:async()=>true,
  BusinessSection:({children,action,title})=>React.createElement('section',{},React.createElement('h3',{},title),action,children),
  BusinessButton:tag('button'),BusinessEmpty:({title})=>React.createElement('p',{},title),BusinessError:({children})=>React.createElement('div',{role:'alert'},children),
  Modal:({children,title})=>React.createElement('section',{role:'dialog','aria-label':title},children),
  FormField:tag('label'),Input:tag('input'),Select:tag('select'),Textarea:tag('textarea'),Button:tag('button')};
 const real={'react':React,'react/jsx-runtime':jsx,'@tanstack/react-query':query,'../../lib/business':business,'../../lib/businessExport':businessExport,'../../lib/fleetSites':{...sites,...siteServices},'../../lib/fleetAssets':assets};
 const directorySource=await readFile(new URL('../src/components/business/DirectoryLayout.jsx',import.meta.url),'utf8');
 const directoryCode=(await transform(directorySource,{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const directoryModule=new vm.SourceTextModule(directoryCode,{context});
 await directoryModule.link(name=>moduleOf(real[name]||{}));await directoryModule.evaluate();
 real['./DirectoryLayout']=directoryModule.namespace;
 if(phone){
  real['../../useCorporatePhone']={default:()=>true};
  const mobileSource=await readFile(new URL('../src/components/business/MobileFleetDirectory.jsx',import.meta.url),'utf8');
  const mobileDirectory=new vm.SourceTextModule((await transform(mobileSource,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
  await mobileDirectory.link(name=>moduleOf(real[name]||common));await mobileDirectory.evaluate();
  real['./MobileFleetDirectory']=mobileDirectory.namespace;
 }
 await mod.link(name=>moduleOf(real[name]||common));await mod.evaluate();
 let r;
 const render=nextProps=>React.createElement(query.QueryClientProvider,{client:qc},React.createElement(mod.namespace.default,nextProps));
 await act(async()=>{r=create(render(props));});
 if(waitForData)await ready(()=>qc.isFetching()===0&&(name==='FleetPeople'||r.root.findAllByType('tbody').length>0||r.root.findAllByProps({role:'alert'}).length>0));
 return {r,calls,update:async nextProps=>act(async()=>r.update(render(nextProps))),close:async()=>{await act(async()=>r.unmount());qc.clear();}};
}

test('people search and department scope retain correct status counts and matching rows',async()=>{
 const {r,close}=await mount('FleetPeople');
 try{
  assert.equal(tableRows(r).length,3);assert.ok(button(r,'활성 (2)'));
  await act(async()=>groupButton(r,'영업팀').props.onClick());
  assert.equal(tableRows(r).length,2);assert.ok(button(r,'전체 (2)'));assert.ok(button(r,'비활성 (1)'));
  await act(async()=>button(r,'비활성 (1)').props.onClick());
  assert.equal(tableRows(r).length,1);assert.match(text(tableRows(r)[0].children),/박퇴사/);
  await act(async()=>r.root.findByProps({'aria-label':'사용자 검색'}).props.onChange({target:{value:'  김영업  '}}));
  assert.ok(button(r,'전체 (1)'));assert.ok(button(r,'활성 (1)'));assert.ok(button(r,'비활성 (0)'));
  assert.equal(tableRows(r).length,0);assert.match(text(r.toJSON()),/조건에 맞는 사용자가 없습니다/);
  await act(async()=>button(r,'활성 (1)').props.onClick());
  assert.equal(tableRows(r).length,1);assert.match(text(tableRows(r)[0].children),/김영업/);
 }finally{await close();}
});

test('phone employee details keep contact information and restrict management actions to authorized roles',async()=>{
 const {r,close}=await mount('FleetPeople',{phone:true,access:{role:'admin',manage_team:true}});
 try{
  assert.equal(r.root.findAllByType('table').length,0);
  const employees=r.root.findAllByProps({className:'mobile-person'});
  assert.equal(employees.length,3);
  assert.match(text(employees[0].children),/010-1111-1111/);
  assert.ok(employees[0].findAllByType('button').some(b=>text(b.children)==='수정'));
  assert.equal(employees[2].findAllByType('button').length,0);
 }finally{await close();}
});

test('compact people management preserves confirmations and optimistic concurrency values',async()=>{
 const {r,calls,close}=await mount('FleetPeople');
 try{
  const row=tableRows(r)[0];
  assert.equal(row.findByType('summary').props['aria-label'],'김영업 관리');
  await act(async()=>row.findAll(n=>n.type==='button'&&text(n.children)==='비활성화')[0].props.onClick());
  await ready(()=>calls.updates.length>0);
  assert.equal(calls.updates[0].id,1);assert.equal(calls.updates[0].body.active,false);assert.equal(calls.updates[0].body.updated_at,'people-v1');
  await act(async()=>row.findAll(n=>n.type==='button'&&text(n.children)==='연결 해제')[0].props.onClick());
  await ready(()=>calls.unlinks.length>0);assert.deepEqual(calls.unlinks,[1]);
 }finally{await close();}
});

test('people administration remains unavailable to members and admin accounts retain owner-only editing',async()=>{
 const member=await mount('FleetPeople',{access:{manage_team:false,role:'member'}});
 try{
  assert.equal(button(member.r,'+ 사용자 등록'),undefined);assert.equal(button(member.r,'CSV 일괄 등록'),undefined);
  assert.equal(button(member.r,'변경 이력'),undefined);assert.equal(member.r.root.findAllByProps({className:'fleet-people-row-menu'}).length,0);
  await act(async()=>button(member.r,'부서·직책').props.onClick());assert.equal(button(member.r,'+ 추가'),undefined);
 }finally{await member.close();}
 const admin=await mount('FleetPeople',{access:{manage_team:true,role:'admin'}});
 try{assert.equal(tableRows(admin.r)[0].findAllByType('summary').length,1);assert.equal(tableRows(admin.r)[2].findAllByType('summary').length,0);}
 finally{await admin.close();}
});

test('site group and search scope preserve active defaults and status counts',async()=>{
 const {r,close}=await mount('FleetSites');
 try{
  assert.equal(tableRows(r).length,2);assert.equal(button(r,'사용 중 (2)').props['aria-pressed'],true);
  await act(async()=>groupButton(r,'본사').props.onClick());
  assert.equal(tableRows(r).length,1);assert.ok(button(r,'전체 (2)'));assert.ok(button(r,'사용 중지 (1)'));
  await act(async()=>button(r,'전체 (2)').props.onClick());assert.equal(tableRows(r).length,2);
  await act(async()=>r.root.findByProps({'aria-label':'지점 검색'}).props.onChange({target:{value:'강서'}}));
  assert.equal(tableRows(r).length,1);assert.match(text(tableRows(r)[0].children),/구 본사/);assert.ok(button(r,'사용 중 (0)'));
 }finally{await close();}
});

test('site visit entry passes its site and changing date or vehicle resets cursor pagination',async()=>{
 const {r,calls,close}=await mount('FleetSites');
 try{
  await act(async()=>tableRows(r)[0].findAll(n=>n.type==='button'&&text(n.children)==='방문 기록')[0].props.onClick());
  await ready(()=>calls.visits.length===1&&button(r,'다음'));
  assert.equal(calls.visits[0].site_id,'10');assert.equal(calls.visits[0].before,undefined);
  await act(async()=>button(r,'다음').props.onClick());await ready(()=>calls.visits.length===2&&button(r,'이전'));
  assert.equal(calls.visits[1].before,'visit-cursor');
  await act(async()=>r.root.findByProps({'aria-label':'방문 기록 차량'}).props.onChange({target:{value:'101'}}));
  await ready(()=>calls.visits.length===3&&button(r,'이전'));
  assert.equal(calls.visits[2].vehicle_id,'101');assert.equal(calls.visits[2].before,undefined);assert.equal(button(r,'이전').props.disabled,true);
  await act(async()=>r.root.findByProps({'aria-label':'방문 기록 시작일'}).props.onChange({target:{value:''}}));
  assert.equal(calls.visits.length,3);assert.equal(r.root.findAllByType('table').length,0);assert.match(text(r.toJSON()),/조회 기간을 확인해 주세요/);
 }finally{await close();}
});

test('site viewers can search and inspect visits without site or group management actions',async()=>{
 const {r,close}=await mount('FleetSites',{access:{manage_team:false,role:'member'}});
 try{
  assert.equal(button(r,'+ 지점 등록'),undefined);assert.equal(button(r,'그룹 관리'),undefined);assert.equal(button(r,'수정'),undefined);
  assert.equal(tableRows(r).length,2);assert.ok(button(r,'방문 기록'));
 }finally{await close();}
});

test('external directory tabs replace internal navigation and preserve site-to-visit selection',async()=>{
 const roster=await mount('FleetPeople',{props:{activeTab:'users',hideNavigation:true}});
 try{
  assert.equal(button(roster.r,'사용자 목록'),undefined);assert.equal(tableRows(roster.r).length,3);
  await roster.update({activeTab:'organization',hideNavigation:true});
  assert.deepEqual(roster.r.root.findAllByType('table').map(t=>t.props['aria-label']),['부서 목록','직책 목록']);assert.match(text(roster.r.toJSON()),/영업팀/);
 }finally{await roster.close();}
 const selectedTabs=[],onTab=value=>selectedTabs.push(value);
 const directory=await mount('FleetSites',{props:{activeTab:'sites',hideNavigation:true,onTab}});
 try{
  assert.equal(button(directory.r,'지점 목록'),undefined);
  await act(async()=>tableRows(directory.r)[0].findAll(n=>n.type==='button'&&text(n.children)==='방문 기록')[0].props.onClick());
  assert.deepEqual(selectedTabs,['visits']);assert.equal(directory.calls.visits.length,0);
  await directory.update({activeTab:'visits',hideNavigation:true,onTab});
  await ready(()=>directory.calls.visits.length===1);
  assert.equal(directory.calls.visits[0].site_id,'10');
 }finally{await directory.close();}
});

test('directory groups expose unassigned records and counts follow search and status scope',async()=>{
 const roster=await mount('FleetPeople',{staffData:[...people,{id:4,name:'미배정부원',department_id:null,active:true}]});
 try{
  assert.equal(text(groupButton(roster.r,'부서 미지정').children),'부서 미지정1');
  await act(async()=>groupButton(roster.r,'부서 미지정').props.onClick());
  assert.equal(groupButton(roster.r,'부서 미지정').props['aria-pressed'],true);
  assert.equal(tableRows(roster.r).length,1);assert.match(text(tableRows(roster.r)[0].children),/미배정부원/);
  await act(async()=>roster.r.root.findByProps({'aria-label':'사용자 검색'}).props.onChange({target:{value:'김영업'}}));
  assert.equal(text(groupButton(roster.r,'부서 미지정').children),'부서 미지정0');
  assert.equal(text(groupButton(roster.r,'영업팀').children),'영업팀1');
 }finally{await roster.close();}
 const directory=await mount('FleetSites',{siteData:[...places,{id:13,name:'미분류 현장',group_id:null,active:true,geometry:{type:'circle',lat:37,lng:127,radius_m:200}}]});
 try{
  await act(async()=>groupButton(directory.r,'미분류').props.onClick());
  assert.equal(groupButton(directory.r,'미분류').props['aria-pressed'],true);
  assert.equal(tableRows(directory.r).length,1);assert.match(text(tableRows(directory.r)[0].children),/미분류 현장/);
 }finally{await directory.close();}
});

test('inactive directory shortcuts reset group scope and all view restores the full list',async()=>{
 for(const [name,group,footer,person] of [['FleetPeople','관리팀','비활성 사용자','박퇴사'],['FleetSites','지사','사용 중지 지점','구 본사']]){
  const {r,close}=await mount(name);
  try{
   await act(async()=>groupButton(r,group).props.onClick());
   const shortcut=r.root.findAll(n=>n.type==='button'&&n.props.className==='fleet-directory-footer-action'&&text(n.children[0])===footer)[0];
   await act(async()=>shortcut.props.onClick());
   assert.equal(shortcut.props['aria-pressed'],true);assert.equal(tableRows(r).length,1);assert.match(text(tableRows(r)[0].children),new RegExp(person));
   assert.equal(text(groupButton(r,'전체 보기').children),'전체 보기3');
   await act(async()=>groupButton(r,'전체 보기').props.onClick());
   assert.equal(groupButton(r,'전체 보기').props['aria-pressed'],true);assert.equal(tableRows(r).length,3);
  }finally{await close();}
 }
});

test('directory manage actions select the controlled organization or group tab',async()=>{
 for(const [name,activeTab,label,expected] of [['FleetPeople','users','부서·직책 관리','organization'],['FleetSites','sites','지점 그룹 관리','groups']]){
  const tabs=[],directory=await mount(name,{props:{activeTab,hideNavigation:true,onTab:tab=>tabs.push(tab)}});
  try{
   await act(async()=>directory.r.root.findAll(n=>n.type==='button'&&n.props['aria-label']===label)[0].props.onClick());
   assert.deepEqual(tabs,[expected]);
  }finally{await directory.close();}
 }
});

test('pending or failed site groups do not produce a misleading empty directory',async()=>{
 let resolveGroups;
 const directory=await mount('FleetSites',{groupQuery:()=>new Promise(resolve=>{resolveGroups=resolve;}),waitForData:false});
 try{
  await ready(()=>typeof resolveGroups==='function');
  assert.equal(directory.r.root.findAllByType('tbody').length,0);
  assert.match(text(directory.r.toJSON()),/지점 불러오는 중/);
  assert.equal(text(groupButton(directory.r,'전체 보기').children),'전체 보기—');
  await act(async()=>resolveGroups([{id:1,name:'본사',active:true},{id:2,name:'지사',active:true}]));
  await ready(()=>directory.r.root.findAllByType('tbody').length>0);
  assert.equal(tableRows(directory.r).length,2);
 }finally{await directory.close();}
 const failed=await mount('FleetSites',{groupQuery:async()=>{throw Error('그룹 조회 실패');}});
 try{
  assert.equal(failed.r.root.findAllByType('tbody').length,0);assert.ok(failed.r.root.findAllByProps({role:'alert'}).length);
  assert.equal(text(groupButton(failed.r,'전체 보기').children),'전체 보기—');
 }finally{await failed.close();}
});

test('multiple assigned vehicles remain readable without expanding the default person row',async()=>{
 const roster=await mount('FleetPeople',{access:{manage_team:false,role:'member'},staffData:[{...people[0],vehicle_ids:[100,101]}]});
 try{
  const disclosure=tableRows(roster.r)[0].findByType('details');
  assert.equal(disclosure.props.open,undefined);
  assert.equal(disclosure.findByType('summary').props['aria-label'],'김영업 운행 가능 차량 2대');
  assert.equal(text(disclosure.findByType('summary').children),'2대 배정');
  assert.deepEqual(disclosure.findAllByType('li').map(n=>text(n.children)),['영업 차량 · 차량 100','관리 차량 · 차량 101']);
 }finally{await roster.close();}
 for(const [assetQuery,expected] of [[{data:undefined,isPending:true},'조회 중…'],[{data:undefined,error:Error('offline')},'차량 조회 실패']]){
  const directory=await mount('FleetPeople',{staffData:[people[0]],assetQuery});
  try{
   assert.equal(text(tableRows(directory.r)[0].findAllByType('td')[4].children),expected);
  }finally{await directory.close();}
 }
});

test('organization tables keep inactive items visible and hide editing from members',async()=>{
 const organization={data:[{id:1,name:'영업팀',kind:'department',active:true},{id:2,name:'이전 직책',kind:'position',active:false}]};
 for(const manage_team of [true,false]){
  const directory=await mount('FleetPeople',{props:{activeTab:'organization'},organization,access:{manage_team,role:manage_team?'owner':'member'}});
  try{
   const tables=directory.r.root.findAllByType('table');
   assert.deepEqual(tables.map(t=>t.props['aria-label']),['부서 목록','직책 목록']);
   assert.match(text(tables[1].children),/이전 직책사용 중지/);
   assert.equal(tables[1].findAllByType('th').length,manage_team?3:2);
   assert.equal(tables[1].findAllByType('button').length,manage_team?1:0);
   assert.ok(tables.every(t=>t.findAllByType('th').every(th=>th.props.scope==='col')));
   if(manage_team){
    await act(async()=>tables[1].findByType('button').props.onClick());
    assert.equal(directory.r.root.findByProps({role:'dialog'}).props['aria-label'],'직책 수정');
    assert.equal(directory.r.root.findAll(n=>n.type==='input'&&n.props.type==='checkbox')[0].props.checked,false);
   }
  }finally{await directory.close();}
 }
});

test('opening a user by name preserves values after save errors and retries with the version',async()=>{
 const saves=[];
 const directory=await mount('FleetPeople',{apiOverrides:{updateStaff:async(id,body)=>{saves.push({id,body});if(saves.length===1)throw Error('저장 충돌입니다. 다시 확인하세요.');}}});
 try{
  await act(async()=>button(directory.r,'김영업').props.onClick());
  const dialog=directory.r.root.findByProps({role:'dialog'});
  assert.ok(dialog.findByProps({'aria-label':'기본 정보'}));assert.ok(dialog.findByProps({'aria-label':'상세 정보'}));
  const nameInput=()=>directory.r.root.findAll(n=>n.type==='label'&&n.props.label==='이름')[0].findByType('input');
  await act(async()=>nameInput().props.onChange({target:{value:'김영업 수정'}}));
  await act(async()=>directory.r.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.match(text(directory.r.root.findByProps({role:'alert'}).children),/저장 충돌/);
  assert.equal(nameInput().props.value,'김영업 수정');assert.equal(button(directory.r,'저장').props.disabled,false);
  await act(async()=>directory.r.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.equal(saves.length,2);assert.equal(saves[1].id,1);assert.equal(saves[1].body.name,'김영업 수정');assert.equal(saves[1].body.updated_at,'people-v1');
  assert.equal(directory.r.root.findAllByProps({role:'dialog'}).length,0);
 }finally{await directory.close();}
});

test('site details expose aligned facts, preserve visit navigation and restrict editing',async()=>{
 for(const manage_team of [true,false]){
  const directory=await mount('FleetSites',{access:{manage_team,role:manage_team?'owner':'member'},siteData:[{...places[0],note:'입구에서 방문 확인',created_at:'2026-11-01T00:00:00Z'}]});
  try{
   await act(async()=>button(directory.r,'서울 본사').props.onClick());
   const dialog=directory.r.root.findByProps({role:'dialog'});
   assert.equal(dialog.props['aria-label'],'서울 본사');
   assert.deepEqual(dialog.findAllByType('dt').map(n=>text(n.children)),['주소','그룹','감지 구역','상태','등록일']);
   assert.ok(dialog.findAllByType('dd').some(n=>text(n.children)==='2026-11-01'));
   assert.match(text(dialog.children),/입구에서 방문 확인/);
   assert.equal(dialog.findAll(n=>n.type==='button'&&text(n.children)==='수정').length,manage_team?1:0);
   await act(async()=>dialog.findAll(n=>n.type==='button'&&text(n.children)==='방문 기록')[0].props.onClick());
   await ready(()=>directory.calls.visits.length===1);
   assert.equal(directory.calls.visits[0].site_id,'10');assert.equal(directory.r.root.findAllByProps({role:'dialog'}).length,0);
  }finally{await directory.close();}
 }
});

test('site address search and saving recover from failures without discarding the form',async()=>{
 const searches=[],saves=[];
 const directory=await mount('FleetSites',{siteServices:{searchSiteAddress:async value=>{searches.push(value);if(searches.length===1)throw Error('주소 검색 연결 실패');return [{name:'새 본사',address:'서울 강남구 테헤란로',lat:37.5,lng:127.1}];}},apiOverrides:{createFleetSite:async body=>{saves.push(body);if(saves.length===1)throw Error('지점 저장 실패');}}});
 try{
  await act(async()=>button(directory.r,'+ 지점 등록').props.onClick());
  const field=label=>directory.r.root.findAll(n=>n.type==='label'&&n.props.label===label)[0].findByType('input');
  assert.ok(directory.r.root.findByProps({'aria-label':'필수 정보'}));assert.ok(directory.r.root.findByProps({'aria-label':'상세 정보'}));
  assert.equal(button(directory.r,'저장').props.disabled,true);
  await act(async()=>field('전국 주소·장소 검색').props.onChange({target:{value:'실패 주소'}}));
  await act(async()=>button(directory.r,'검색').props.onClick());
  assert.match(text(directory.r.root.findByProps({role:'alert'}).children),/주소 검색 연결 실패/);
  await act(async()=>field('전국 주소·장소 검색').props.onChange({target:{value:'새 주소'}}));
  assert.equal(directory.r.root.findAllByProps({role:'alert'}).length,0);
  await act(async()=>button(directory.r,'검색').props.onClick());
  await act(async()=>directory.r.root.findByProps({className:'fleet-site-results'}).findByType('button').props.onClick());
  assert.equal(field('지점명').props.value,'새 본사');assert.equal(field('주소').props.value,'서울 강남구 테헤란로');assert.equal(button(directory.r,'저장').props.disabled,false);
  await act(async()=>directory.r.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.match(text(directory.r.root.findByProps({role:'alert'}).children),/지점 저장 실패/);
  assert.equal(field('지점명').props.value,'새 본사');assert.equal(button(directory.r,'저장').props.disabled,false);
  await act(async()=>directory.r.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(searches,['실패 주소','새 주소']);assert.equal(saves.length,2);assert.equal(saves[1].name,'새 본사');assert.equal(saves[1].geometry.lat,37.5);assert.equal(saves[1].geometry.lng,127.1);
  assert.equal(directory.r.root.findAllByProps({role:'dialog'}).length,0);
 }finally{await directory.close();}
});
