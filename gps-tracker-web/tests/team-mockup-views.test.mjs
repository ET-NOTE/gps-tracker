import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,create} from 'react-test-renderer';
import {transform} from 'esbuild';

const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const plain=value=>JSON.parse(JSON.stringify(value));

function teamData() {
  return {
    branches:[{id:1,name:'강남점'},{id:2,name:'분당점'}],
    groups:[{id:7,name:'배차 담당',permissions:['dispatch_read'],revision:3}],
    staff:[
      {id:11,name:'김배차',email:'kim@example.com',branch_id:1,group_id:7,active:true,joined:true,revision:1},
      {id:12,name:'이대기',email:'lee@example.com',branch_id:2,group_id:7,active:true,joined:false,revision:1},
      {id:13,name:'박중지',email:'park@example.com',branch_id:1,group_id:7,active:false,joined:true,revision:1},
    ],
    notes:[],
  };
}

async function load(file, modules, context) {
  const source=await readFile(new URL('../src/components/business/'+file,import.meta.url),'utf8');
  const code=(await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code;
  const mod=new vm.SourceTextModule(code,{context});
  const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  await mod.link(async name=>{
    if(typeof modules[name]==='function')return modules[name]();
    if(modules[name])return synthetic(modules[name]);
    throw Error('unexpected import '+name+' from '+file);
  });
  await mod.evaluate();
  return mod;
}

async function mountTeam(t,{cargo=false,page='staff',mockup=true}={}) {
  const context=vm.createContext({console,window:{location:{origin:'https://dev.example'}}});
  const calls=[],invalidated=[];
  const data=teamData();
  const team=async(method,path,body)=>{calls.push([method,path,body===undefined?undefined:plain(body)]);if(path.endsWith('/invite')||path==='/staff')return {code:'CODE-1'};return {id:path==='/groups'?8:undefined};};
  const tag=type=>({children,...props})=>React.createElement(type,props,children);
  const button=({children,primary,icon,...props})=>React.createElement('button',{type:'button',...props},children);
  const common={
    react:React,'react/jsx-runtime':jsx,
    '../Icon':{default:()=>null},
    './BusinessWorkspace':{BusinessButton:button,BusinessError:tag('p'),BusinessEmpty:({title})=>React.createElement('p',{},title)},
    './workspace-mockup-sync.css':{},
  };
  const views=await load('TeamMockupViews.jsx',common,context);
  const modules={...common,
    '../../api':{api:{rentalTeam:team,cargoTeam:team}},
    '../../authSession':{authScope:()=>'owner'},
    '../ui':{Modal:({title,children})=>React.createElement('section',{role:'dialog','aria-label':title},children)},
    './rental-team.css':{},
    '../../useCorporatePhone':{default:()=>false},
    '../../lib/mockupHidden':{hideOutsideMockup:mockup},
    './TeamMockupViews':()=>{const m=new vm.SyntheticModule(Object.keys(views.namespace),function(){for(const [k,v] of Object.entries(views.namespace))this.setExport(k,v);},{context});return m;},
    '@tanstack/react-query':{useQuery:()=>({isPending:false,error:null,data,refetch(){}}),useQueryClient:()=>({invalidateQueries:async options=>{invalidated.push(options.queryKey);}})},
  };
  const mod=await load('RentalTeam.jsx',modules,context);
  let renderer;
  const tabs=[];
  await act(async()=>{renderer=create(React.createElement(mod.namespace.default,{page,cargo,onTab:id=>tabs.push(id)}));});
  t.after(()=>act(()=>renderer.unmount()));
  return {renderer,calls,invalidated,tabs};
}
const findButton=(r,label)=>r.root.findAll(n=>n.type==='button'&&text(n.children).trim()===label)[0];

for (const cargo of [false,true]) {
  const service=cargo?'화물':'렌트카';
  test(service+' people ledger shows status badges, opens the invite dialog and reissues a pending code',async t=>{
    const {renderer,calls}=await mountTeam(t,{cargo});
    const rows=renderer.root.findAll(n=>n.type==='tr'&&n.parent?.type==='tbody');
    assert.equal(rows.length,3);
    const badges=renderer.root.findAll(n=>n.type==='span'&&String(n.props.className||'').startsWith('rt-badge')).map(n=>text(n.children));
    assert.deepEqual(badges,['사용 중','초대 대기','사용 중지']);
    assert.match(text(rows[1].children),/분당점.*배차 담당/);
    await act(async()=>findButton(renderer,'사용자 추가').props.onClick());
    assert.ok(renderer.root.findByProps({role:'dialog','aria-label':'직원 초대'}));
    await act(async()=>findButton(renderer,'코드 재발급').props.onClick());
    assert.deepEqual(calls,[['POST','/staff/12/invite',undefined]]);
    assert.ok(renderer.root.findByProps({role:'dialog','aria-label':'직원 초대 코드'}));
  });

  test(service+' permission group save sends the team body and keeps memo and dispatch together',async t=>{
    const {renderer,calls}=await mountTeam(t,{cargo,page:'groups'});
    const box=label=>renderer.root.findAll(n=>n.type==='label'&&text(n.children).includes(label))[0].findByType('input');
    await act(async()=>box('인수인계 메모 작성').props.onChange());
    assert.equal(box('인수인계 메모 작성').props.checked,true);
    await act(async()=>box(cargo?'지점 배차 조회':'배차 조회').props.onChange());
    assert.equal(box('인수인계 메모 작성').props.checked,false,'turning dispatch off also removes the memo');
    await act(async()=>box('인수인계 메모 작성').props.onChange());
    await act(async()=>box(cargo?'지점 차량 조회':'정비·세차 조회').props.onChange());
    await act(async()=>findButton(renderer,'변경사항 저장').props.onClick());
    const [method,path,body]=calls[0];
    assert.equal(method,'PUT');assert.equal(path,'/groups/7');
    assert.deepEqual([...body.permissions].sort(),['dispatch_read','handover_note',cargo?'fleet_read':'service_read'].sort());
    assert.equal(body.name,'배차 담당');assert.equal(body.revision,3);
  });
}

test('rental branch directory adds a branch through the team API',async t=>{
  const {renderer,calls}=await mountTeam(t,{page:'branches'});
  assert.match(text(renderer.toJSON()),/강남점.*2명/);
  await act(async()=>findButton(renderer,'지점 추가').props.onClick());
  const dialog=renderer.root.findByProps({role:'dialog','aria-label':'지점 추가'});
  await act(async()=>dialog.findByType('input').props.onChange({target:{value:'수원점'}}));
  await act(async()=>dialog.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(calls,[['POST','/branches',{name:'수원점'}]]);
});

test('with the mockup flag off the original team list is unchanged',async t=>{
  const {renderer}=await mountTeam(t,{mockup:false});
  assert.equal(renderer.root.findAll(n=>n.type==='table').length,0);
  assert.ok(findButton(renderer,'직원 초대'));
  assert.match(text(renderer.toJSON()),/직원 3명/);
});

test('freight company card saves through the cargo company API',async t=>{
  const context=vm.createContext({console});
  const calls=[];
  const tag=type=>({children,...props})=>React.createElement(type,props,children);
  const button=({children,primary,icon,...props})=>React.createElement('button',{type:'button',...props},children);
  const common={react:React,'react/jsx-runtime':jsx,'../Icon':{default:()=>null},
    './BusinessWorkspace':{BusinessButton:button,BusinessError:tag('p'),BusinessEmpty:tag('p')},'./workspace-mockup-sync.css':{}};
  const views=await load('TeamMockupViews.jsx',common,context);
  const company={name:'테스트물류',representative:'홍길동',business_number:'123-45-67890',phone:'02-1234-5678',address:'서울',revision:4};
  const FreightForm=({title,onSubmit,children})=>React.createElement('form',{'aria-label':title,onSubmit:e=>{e.preventDefault?.();return onSubmit(new Map([['name','새물류'],['phone','02-0000-0000']]));}},children);
  const modules={...common,
    '../../api':{api:{cargoTeam:async(method,path,body)=>{calls.push([method,path,plain(body)]);return {};}}},
    '../../authSession':{authScope:()=>'owner'},
    './FreightPolicySettings':{default:()=>null},
    '../../lib/freightWorkflow':{newId:()=>'x',record(){}},
    './FreightKit':{FreightTable:()=>null,FreightFacts:()=>null,FreightForm,FreightField:tag('label'),FreightButton:button,FreightFilters:()=>null,FreightBadge:tag('span')},
    '../../useCorporatePhone':{default:()=>false},'../../lib/mockupHidden':{hideOutsideMockup:true},
    './TeamMockupViews':()=>new vm.SyntheticModule(Object.keys(views.namespace),function(){for(const [k,v] of Object.entries(views.namespace))this.setExport(k,v);},{context}),
    '@tanstack/react-query':{useQuery:()=>({isPending:false,error:null,data:{company}}),useQueryClient:()=>({invalidateQueries:async()=>{}})}};
  const mod=await load('FreightAdmin.jsx',modules,context);
  let renderer;
  await act(async()=>{renderer=create(React.createElement(mod.namespace.default,{page:'company',data:{},save:async()=>{},onPage(){}}));});
  t.after(()=>act(()=>renderer.unmount()));
  assert.match(text(renderer.toJSON()),/테스트물류.*대표자.*홍길동/);
  await act(async()=>findButton(renderer,'수정').props.onClick());
  await act(async()=>renderer.root.find(n=>n.type==='form'&&n.props['aria-label']==='회사 정보 수정').props.onSubmit({}));
  assert.deepEqual(calls,[['PUT','/company',{name:'새물류',phone:'02-0000-0000',revision:4}]]);
});
