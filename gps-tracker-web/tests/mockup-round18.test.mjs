import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,create} from 'react-test-renderer';
import {transform} from 'esbuild';
import {axisLabelIndexes,niceTicks,shortDay} from '../src/lib/lineChart.js';
import * as filters from '../src/lib/fleetAssetFilters.js';

const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const buttons=r=>r.root.findAll(n=>n.type==='button');
const tag=type=>({children,...props})=>React.createElement(type,props,children);

// Loads one component with the given modules; any other import gets inert stand-ins for the names it asks for.
async function load(file,modules){
  const context=vm.createContext({console});
  const code=(await transform(await readFile(new URL('../src/components/business/'+file,import.meta.url),'utf8'),{loader:'jsx',jsx:'automatic',format:'esm'})).code;
  const wanted=new Map();
  for(const m of code.matchAll(/import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g)){
    const names=new Set(wanted.get(m[3])||[]);if(m[1])names.add('default');
    for(const part of (m[2]||'').split(','))if(part.trim())names.add(part.trim().split(/\s+as\s+/)[0]);
    wanted.set(m[3],names);
  }
  const mod=new vm.SourceTextModule(code,{context});
  await mod.link(name=>{
    const exports=modules[name]||Object.fromEntries([...(wanted.get(name)||[])].map(k=>[k,()=>null]));
    return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  });
  await mod.evaluate();
  return mod.namespace;
}

test('line chart axis: ticks start at 0 with rounded steps and x labels every ceil(n/6) points plus the last',()=>{
  assert.deepEqual(niceTicks(277.5),[0,100,200,300]);
  assert.deepEqual(niceTicks(780000),[0,200000,400000,600000,800000]);
  assert.deepEqual(niceTicks(0),[0,1,2,3],'all-zero data keeps small ticks so the line sits on the floor');
  assert.deepEqual(axisLabelIndexes(7),[0,2,4,6]);
  assert.deepEqual(axisLabelIndexes(20),[0,4,8,12,16,19]);
  assert.deepEqual(axisLabelIndexes(1),[0]);
  assert.equal(shortDay('2026-11-14'),'11.14');
});

test('desktop line chart draws points with tooltips, edge-aligned date labels and a readable table',async()=>{
  const {default:Chart}=await load('MockupLineChart.jsx',{react:React,'react/jsx-runtime':jsx,'../../lib/lineChart':{axisLabelIndexes,niceTicks,shortDay},'./mockup-line-chart.css':{}});
  const points=Array.from({length:7},(_,i)=>({day:'2026-11-1'+i,value:i===4?277.5:0}));
  let r;await act(async()=>{r=create(React.createElement(Chart,{points,unit:'km',height:150,label:'최근 7일 운행'}));});
  assert.equal(r.root.findAllByProps({className:'mlc-point'}).length,7);
  assert.equal(r.root.findAllByProps({className:'mlc-point'})[4].props['aria-label'],'11.14 · 277.5 km');
  const labels=r.root.findByProps({className:'mlc-x'}).findAllByType('span');
  assert.deepEqual(labels.map(n=>text(n.children)),['11.10','11.12','11.14','11.16']);
  assert.equal(labels[0].props['data-edge'],'start');assert.equal(labels.at(-1).props['data-edge'],'end');
  assert.deepEqual(r.root.findByProps({className:'mlc-y'}).findAllByType('span').map(n=>text(n.children)),['0','100','200','300']);
  assert.equal(r.root.findByType('table').findAllByType('tr').length,7);
  // The dashboard styles every <i> as a 27px tile; the chart must not use <i> so its grid stays 1px lines.
  assert.equal(r.root.findAllByType('i').length,0);
  assert.ok(r.root.findAllByProps({className:'mlc-grid'}).every(n=>n.type==='div'));
  const css=await readFile(new URL('../src/components/business/mockup-line-chart.css',import.meta.url),'utf8');
  assert.match(css,/.mlc .mlc-grid {[^}]*height:1px[^}]*border-radius:0/);
});

async function mountMaintenance(){
  const history=[];
  const ns=await load('FleetOperations.jsx',{react:React,'react/jsx-runtime':jsx,'@tanstack/react-query':{useQueryClient:()=>({invalidateQueries(){}})},
    '../../useCorporatePhone':{default:()=>false},'../../lib/mockupHidden':{hideOutsideMockup:true},
    '../../lib/business':{businessDate:()=>'2026-11-24'},'./useBusinessData':{useBusinessClock:()=>Date.parse('2026-11-24T03:00:00Z')},
    '../../lib/fleetAssets':{fleetAssetLabel:a=>a.name},'../../lib/fleetAssetFilters':filters,
    './FleetMaintenanceHistory':{CompletionEditor:()=>null,MaintenanceHistory:props=>{history.push(props);return React.createElement('maintenance-history');},maintenanceKinds:{}},
    '../Icon':{default:()=>null},'../ui':{Modal:tag('section')},'./BusinessDrawer':{default:tag('aside')},'../CarImage':{default:()=>null},
    '../entry/login-vehicle.png':{default:''},'./fleet-operation-layout.css':{},'../../colors':{classifyDevice:()=>({id:'active'})},
    '../../lib/businessExport':{kstDateTime:v=>v},'../../lib/battery':{deviceBattery:()=>({})}});
  const assets=[{id:1,name:'영업 1호',department:'영업팀',profile:{next_service_date:'2026-11-01',insurance_expiry:'2026-12-31'},bindings:[]}];
  let r;await act(async()=>{r=create(React.createElement(ns.default,{mode:'maintenance',assets,devices:[],departments:[],staff:[],canManage:true,openDetail(){},editSchedule(){},refreshAssets(){}}));});
  return {r,history};
}

test('desktop maintenance tabs: upcoming includes overdue with its badge, completed history, and both under 전체',async()=>{
  const {r,history}=await mountMaintenance();
  const tabs=r.root.findByProps({'aria-label':'일정 상태'}).findAllByType('button');
  assert.deepEqual(tabs.map(n=>text(n.children)),['예정 일정','완료 내역','전체']);
  const cards=()=>r.root.findAll(n=>n.props.className==='fleet-care-card');
  assert.equal(cards().length,2);
  assert.match(text(cards()[0].children),/기한 경과/);assert.match(text(cards()[1].children),/예정/);
  assert.ok(!buttons(r).some(n=>text(n.children)==='검색'),'the search toggle is hidden; filters apply on change');
  assert.ok(buttons(r).some(n=>text(n.children)==='일정 등록'));
  assert.ok(!buttons(r).some(n=>text(n.children)==='완료 이력 등록'),'one button on the upcoming tab');
  await act(async()=>tabs[1].props.onClick());
  assert.equal(cards().length,0);assert.equal(r.root.findAllByType('maintenance-history').length,1);
  assert.ok(buttons(r).some(n=>text(n.children)==='완료 이력 등록'),'free-form completion records stay on the history tab');
  await act(async()=>r.root.findByProps({'aria-label':'일정 상태'}).findAllByType('button')[2].props.onClick());
  assert.equal(cards().length,2);assert.equal(r.root.findAllByType('maintenance-history').length,1);
  assert.ok(history.length>0);
});

test('cargo incidents keep the register button disabled without vehicles and link to the vehicle list',async()=>{
  const pages=[];
  const ns=await load('FreightIncidents.jsx',{react:React,'react/jsx-runtime':jsx,'../../useCorporatePhone':{default:()=>false},'../../lib/mockupHidden':{hideOutsideMockup:true},
    './FreightKit':{FreightButton:({primary,icon,children,...p})=>React.createElement('button',{type:'button',...p},children),FreightTable:()=>React.createElement('table'),FreightField:tag('label'),FreightForm:tag('form'),FreightOptions:()=>null,FreightBadge:tag('span'),FleetResourceFilters:tag('div')},
    './FreightOfficeFields':{choices:v=>Object.fromEntries(v.map(x=>[x,x])),choicesFrom:()=>({}),OfficeFilter:()=>null},
    '../../lib/freightWorkflow':{newId:()=>'x',getRow:()=>null,stamp:()=>'',timeLabel:v=>v,record(){},vehicleName:()=>''},'../../lib/freightCatalog':{restoreVehicle(){}}});
  const data={incidents:[],vehicles:[],branches:[],shipments:[]};
  let r;await act(async()=>{r=create(React.createElement(ns.default,{data,save:async()=>{},onPage:p=>pages.push(p)}));});
  const register=buttons(r).find(n=>text(n.children)==='발생 내역 등록');
  assert.equal(register.props.disabled,true);assert.equal(register.props.title,'차량을 먼저 등록해 주세요');
  assert.ok(!buttons(r).some(n=>text(n.children)==='차량 등록하기'));
  await act(async()=>buttons(r).find(n=>text(n.children)==='차량 목록').props.onClick());
  assert.deepEqual(pages,['cargo-vehicles']);
});
