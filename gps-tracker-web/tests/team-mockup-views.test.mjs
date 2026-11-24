import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,create} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as teamImport from '../src/lib/teamImport.js';

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

async function mountTeam(t,{cargo=false,page='staff',mockup=true,canManage=true,fail=()=>false}={}) {
  const context=vm.createContext({console,TextDecoder,window:{location:{origin:'https://dev.example'}}});
  const calls=[],invalidated=[],downloads=[];
  const data=teamData();
  const team=async(method,path,body)=>{calls.push([method,path,body===undefined?undefined:plain(body)]);if(fail(method,path,body))throw Error('이미 변경된 사용자');if(path.endsWith('/invite')||path==='/staff')return {code:'CODE-1'};return {id:path==='/groups'?8:undefined};};
  const tag=type=>({children,...props})=>React.createElement(type,props,children);
  const button=({children,primary,icon,...props})=>React.createElement('button',{type:'button',...props},children);
  const common={
    react:React,'react/jsx-runtime':jsx,
    '../Icon':{default:()=>null},
    './BusinessWorkspace':{BusinessButton:button,BusinessError:tag('p'),BusinessEmpty:({title})=>React.createElement('p',{},title)},
    './workspace-mockup-sync.css':{},
  };
  const views=await load('TeamMockupViews.jsx',common,context);
  const saved=[];
  const dialogs=await load('TeamBulkDialogs.jsx',{...common,'../ui':{Modal:({title,subtitle,children})=>React.createElement('section',{role:'dialog','aria-label':title,'data-subtitle':subtitle},children)},'../../lib/teamImport':teamImport,'../../lib/fileDownload':{saveBlob:(blob,name)=>saved.push(name)}},context);
  const modules={...common,
    './TeamBulkDialogs':()=>new vm.SyntheticModule(Object.keys(dialogs.namespace),function(){for(const [k,v] of Object.entries(dialogs.namespace))this.setExport(k,v);},{context}),
    '../../api':{api:{rentalTeam:team,cargoTeam:team}},
    '../../authSession':{authScope:()=>'owner'},
    '../ui':{Modal:({title,children})=>React.createElement('section',{role:'dialog','aria-label':title},children)},
    './rental-team.css':{},
    '../../useCorporatePhone':{default:()=>false},
    '../../lib/mockupHidden':{hideOutsideMockup:mockup},
    '../../lib/downloadReport':{downloadReport:async(report,format)=>{downloads.push([report,format]);}},
    './TeamMockupViews':()=>{const m=new vm.SyntheticModule(Object.keys(views.namespace),function(){for(const [k,v] of Object.entries(views.namespace))this.setExport(k,v);},{context});return m;},
    '@tanstack/react-query':{useQuery:()=>({isPending:false,error:null,data,refetch(){}}),useQueryClient:()=>({invalidateQueries:async options=>{invalidated.push(options.queryKey);}})},
  };
  const mod=await load('RentalTeam.jsx',modules,context);
  let renderer;
  const tabs=[];
  await act(async()=>{renderer=create(React.createElement(mod.namespace.default,{page,cargo,canManage,onTab:id=>tabs.push(id)}));});
  t.after(()=>act(()=>renderer.unmount()));
  return {renderer,calls,invalidated,tabs,downloads};
}
const findButton=(r,label)=>r.root.findAll(n=>n.type==='button'&&text(n.children).trim()===label)[0];

for (const cargo of [false,true]) {
  const service=cargo?'화물':'렌트카';
  test(service+' people ledger shows status badges, opens the invite dialog and reissues a pending code',async t=>{
    const {renderer,calls,downloads}=await mountTeam(t,{cargo});
    const rows=renderer.root.findAll(n=>n.type==='tr'&&n.parent?.type==='tbody');
    assert.equal(rows.length,3);
    const badges=renderer.root.findAll(n=>n.type==='span'&&String(n.props.className||'').startsWith('rt-badge')).map(n=>text(n.children));
    assert.deepEqual(badges,['사용 중','초대 대기','사용 중지']);
    assert.match(text(rows[1].children),/분당점.*배차 담당/);
    await act(async()=>renderer.root.findByProps({'aria-label':'사용자 목록 다운로드'}).props.onClick());
    assert.equal(downloads[0][1],'csv');
    assert.deepEqual(plain(downloads[0][0].rows[1]),['이대기','lee@example.com','분당점','배차 담당','초대 대기']);
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

test('team CSV import reads quoted cells, BOM and CRLF and checks every row',()=>{
  const config={staff:[{email:'Kim@Example.com'}],branches:[{id:1,name:'강남점'}],groups:[{id:7,name:'배차 담당'}]};
  const ok=teamImport.checkTeamCsv('﻿이름,이메일,지점,권한 그룹\r\n"홍, 길동", hong@example.com ,강남점,배차 담당\r\n',config);
  assert.deepEqual(plain(ok.rows),[{row:2,name:'홍, 길동',email:'hong@example.com',branch:'강남점',group:'배차 담당',branch_id:1,group_id:7}]);
  assert.equal(ok.problems.length,0);
  const bad=teamImport.checkTeamCsv(['이름,이메일,지점,권한 그룹',',kim@example.com,강남점,배차 담당','박,잘못된주소,없는점,배차 담당','이,lee@x.com,강남점,없는 그룹','최,LEE@x.com,강남점,배차 담당'].join('\n'),config);
  assert.deepEqual(plain(bad.problems.map(p=>p.reasons)),[['이름 없음','중복 이메일'],['이메일 형식','등록되지 않은 지점'],['등록되지 않은 권한 그룹'],['중복 이메일']]);
  assert.deepEqual(teamImport.problemLines(bad.problems,2),['2행 · 이름 없음: 이름 없음, 중복 이메일','3행 · 박: 이메일 형식, 등록되지 않은 지점','외 2개 행']);
  assert.equal(teamImport.checkTeamCsv('이름,이메일,지점,권한 그룹\n',config).error,'제목 행 아래에 사용자 정보를 입력해 주세요.');
  assert.equal(teamImport.checkTeamCsv('이름,연락처\n홍,010',config).error,'등록 서식의 제목 행을 확인해 주세요. 이름·이메일·지점·권한 그룹이 필요합니다.');
  const many='이름,이메일,지점,권한 그룹\n'+Array.from({length:1001},(_,i)=>`u${i},u${i}@x.com,강남점,배차 담당`).join('\n');
  assert.equal(teamImport.checkTeamCsv(many,config).error,'최대 1,000명씩 나누어 등록해 주세요.');
  assert.equal(teamImport.checkTeamCsv('이름,이메일,지점,권한 그룹\n'+'가'.repeat(400000),config).error,'파일 크기는 1MB 이하여야 합니다.');
  assert.equal(teamImport.importSummary(3,1),'3명 등록, 1명 실패');assert.equal(teamImport.importSummary(4,0),'4명의 사용자를 등록했습니다.');
});

test('selection count, pruning on filter change and a partly failed group apply',async t=>{
  const {renderer,calls}=await mountTeam(t,{fail:(method,path)=>method==='PUT'&&path==='/staff/12'});
  const apply=()=>renderer.root.findAll(n=>n.type==='button'&&text(n.children).startsWith('권한 그룹 적용'))[0];
  assert.equal(apply().props.disabled,true);
  await act(async()=>renderer.root.findByProps({'aria-label':'현재 목록 전체 선택'}).props.onChange());
  assert.equal(text(apply().children),'권한 그룹 적용 · 3명');
  await act(async()=>renderer.root.findByProps({'aria-label':'지점'}).props.onChange({target:{value:'1'}}));
  assert.equal(text(apply().children),'권한 그룹 적용 · 2명','people filtered out leave the selection');
  await act(async()=>renderer.root.findByProps({'aria-label':'지점'}).props.onChange({target:{value:''}}));
  await act(async()=>renderer.root.findByProps({'aria-label':'이대기 선택'}).props.onChange());
  await act(async()=>apply().props.onClick());
  const dialog=renderer.root.findByProps({role:'dialog','aria-label':'권한 그룹 적용'});
  assert.equal(dialog.props['data-subtitle'],'3명의 사용자에게 적용할 권한 그룹을 선택하세요.');
  assert.equal(dialog.findByProps({'aria-label':'권한 그룹'}).props.value,'7','a shared group is preselected');
  await act(async()=>findButton(renderer,'그룹 적용').props.onClick());
  assert.deepEqual(calls.filter(c=>c[0]==='PUT').map(c=>c[1]),['/staff/11','/staff/12','/staff/13']);
  assert.match(text(renderer.root.findByProps({role:'dialog','aria-label':'권한 그룹 적용'}).children),/2명 적용, 1명 실패/);
});

test('bulk import sends one invite per row, keeps going after a failure and reports both',async t=>{
  const {renderer,calls}=await mountTeam(t,{fail:(method,path,body)=>method==='POST'&&path==='/staff'&&body.email==='b@x.com'});
  await act(async()=>findButton(renderer,'일괄 등록').props.onClick());
  const dialog=()=>renderer.root.findByProps({role:'dialog','aria-label':'사용자 일괄 등록'});
  const csv='이름,이메일,지점,권한 그룹\r\n가,a@x.com,강남점,배차 담당\r\n나,b@x.com,분당점,배차 담당\r\n';
  const file={size:csv.length,arrayBuffer:async()=>new TextEncoder().encode(csv).buffer};
  await act(async()=>dialog().findByProps({type:'file'}).props.onChange({target:{files:[file]}}));
  assert.match(text(dialog().children),/등록 준비 완료/);
  await act(async()=>dialog().findAll(n=>n.type==='button'&&text(n.children)==='일괄 등록')[0].props.onClick());
  assert.deepEqual(calls.filter(c=>c[0]==='POST').map(c=>c[2].email),['a@x.com','b@x.com']);
  assert.match(text(dialog().children),/1명 등록, 1명 실패/);assert.match(text(dialog().children),/3행 · 나: 이미 변경된 사용자/);
});

test('without user management the checkbox column and bulk buttons stay hidden',async t=>{
  const {renderer}=await mountTeam(t,{canManage:false});
  assert.equal(renderer.root.findAll(n=>n.type==='input'&&n.props.type==='checkbox').length,0);
  assert.equal(findButton(renderer,'일괄 등록'),undefined);
  assert.equal(renderer.root.findAll(n=>n.type==='button'&&text(n.children).startsWith('권한 그룹 적용')).length,0);
});
