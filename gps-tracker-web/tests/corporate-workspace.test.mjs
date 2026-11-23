import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
import {corporateGroups,corporateTabs,corporatePageHint} from '../src/lib/corporateNavigation.js';
import {vehicleName} from '../src/lib/business.js';
import {corporateVehicleName,terminalName,locationState,locationSummary} from '../src/lib/corporateOverview.js';

// Exercise the production workspace interactions without maps, network or a
// browser. Drawer contents stay real; only the portal/focus shell is replaced.
async function modules(globals={},phone=false){
 const context=vm.createContext({console,...globals});
 const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
 const noop=()=>null;
 const drawer=({title,children,onClose})=>React.createElement('aside',{'aria-label':title},React.createElement('button',{onClick:onClose},'닫기'),children);
 async function load(file){
  const code=(await transform(await readFile(new URL(file,import.meta.url),'utf8'),{loader:'jsx',jsx:'automatic',format:'esm'})).code;
  const mod=new vm.SourceTextModule(code,{context});
  await mod.link(async name=>{
   if(name==='react')return synthetic(React);
   if(name==='react/jsx-runtime')return synthetic(jsx);
   if(name.endsWith('BusinessDrawer'))return synthetic({default:drawer});
   if(name.endsWith('/useCorporatePhone'))return synthetic({default:()=>phone});
   if(name.endsWith('/useBreakpoint'))return synthetic({default:()=>phone?'mobile':'desktop'});
   if(name==='../MemberDemoButton')return synthetic(await load('../src/components/MemberDemoButton.jsx'));
   if(name==='./WorkspaceHeader')return synthetic(await load('../src/components/business/WorkspaceHeader.jsx'));
   if(name==='./CorporateMobileHeader')return synthetic({default:(await load('../src/components/business/CorporateMobileHeader.jsx')).default});
   return synthetic({default:noop,corporatePageHint,classifyDevice:()=>({color:'#64748b',label:'수신 이력 없음'}),ageString:noop,vehicleName,
    corporateVehicleName,terminalName,locationState,locationSummary,kstDateTime:noop,useBusinessClock:()=>Date.parse('2026-11-17T03:00:00Z'),openPalette:noop});
  });
  await mod.evaluate();return mod.namespace;
 }
 return {workspace:await load('../src/components/business/BusinessWorkspace.jsx'),rail:await load('../src/components/SideRail.jsx')};
}
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const findButton=(scope,label)=>scope.find(n=>n.type==='button'&&text(n.children)===label);
const classNode=(scope,className)=>scope.find(n=>typeof n.type==='string'&&n.props.className?.split(' ').includes(className));
const buttons=scope=>scope.findAllByType('button').map(n=>text(n.children));

async function mount(t,props={},createNodeMock){
 const {workspace,rail}=await modules({},props.phone),changes=[],destinations=[];
 function Harness(){
  const [tab,setTab]=React.useState(props.initialTab||'overview');
  return React.createElement(workspace.BusinessWorkspace,{title:'법인차 운영',kind:'corporate',tabs:corporateTabs,groups:corporateGroups,
   onNavigate:value=>destinations.push(value),...props,tab,onTab:value=>{changes.push(value);setTab(value);}},React.createElement('output',{'aria-label':'현재 본문'},tab));
 }
 let renderer;
 await act(async()=>{renderer=create(React.createElement(Harness),{createNodeMock});});
 t.after(async()=>{await act(async()=>renderer.unmount());});
 return {renderer,changes,destinations,rail};
}

test('corporate groups return to each last selected child without losing the active body',async t=>{
 const {renderer:r,changes}=await mount(t);
 const primary=()=>r.root.findByProps({'aria-label':'법인차 운영 메뉴'});
 await act(async()=>findButton(primary(),'운행일지').props.onClick());
 assert.equal(r.root.findByType('output').children[0],'report');
 await act(async()=>findButton(r.root.findByProps({'aria-label':'운행일지 하위 메뉴'}),'월간 요약').props.onClick());
 await act(async()=>findButton(primary(),'지출 관리').props.onClick());
 await act(async()=>findButton(r.root.findByProps({'aria-label':'지출 관리 하위 메뉴'}),'항목 관리').props.onClick());
 await act(async()=>findButton(primary(),'운행일지').props.onClick());
 assert.equal(r.root.findByType('output').children[0],'monthly');
 assert.equal(findButton(primary(),'운행일지').props['aria-current'],'page');
 assert.equal(findButton(r.root.findByProps({'aria-label':'운행일지 하위 메뉴'}),'월간 요약').props['aria-current'],'page');
 await act(async()=>findButton(primary(),'지출 관리').props.onClick());
 assert.equal(r.root.findByType('output').children[0],'expense-categories');
 assert.deepEqual(changes,['report','monthly','expenses','expense-categories','monthly','expense-categories']);
});

test('design navigation exposes live, vehicle tools, and booking as a direct destination',async t=>{
 const {renderer:r,changes}=await mount(t);
 const primary=()=>r.root.findByProps({'aria-label':'법인차 운영 메뉴'});
 const navGroups=primary().findAll(n=>n.type==='button' && n.props.className==='business-nav-item');
 assert.deepEqual(navGroups.map(n=>text(n.children)),corporateGroups.map(g=>g.label));
 await act(async()=>findButton(primary(),'차량 관리').props.onClick());
 const vehicleTabs=()=>r.root.findByProps({'aria-label':'차량 관리 하위 메뉴'});
 assert.deepEqual(buttons(vehicleTabs()),['차량 목록','단말기 관리','정비·보험']);
 await act(async()=>findButton(vehicleTabs(),'정비·보험').props.onClick());
 await act(async()=>findButton(primary(),'차량 예약').props.onClick());
 assert.equal(r.root.findByType('output').children[0],'reservations');
 assert.equal(findButton(primary(),'차량 예약').props['aria-current'],'page');
 await act(async()=>findButton(primary(),'차량 관리').props.onClick());
 assert.equal(findButton(vehicleTabs(),'정비·보험').props['aria-current'],'page');
 assert.deepEqual(changes,['vehicles','maintenance','reservations','maintenance']);
});

test('corporate tab navigation resets the persistent mobile scroll without resetting ordinary workspace interactions',async t=>{
 const resets=[];
 const viewport={scrollTop:30,scrollTo:({top})=>{viewport.scrollTop=top;resets.push(top);}};
 const {renderer:r}=await mount(t,{initialTab:'expenses'},element=>element.props.className?.split(' ').includes('business-workspace')?viewport:null);
 const primary=()=>r.root.findByProps({'aria-label':'법인차 운영 메뉴'});
 assert.equal(viewport.scrollTop,0);assert.deepEqual(resets,[0]);
 const previousContent=classNode(r.root,'business-content');
 viewport.scrollTop=240;
 await act(async()=>findButton(primary(),'차량 관리').props.onClick());
 assert.equal(viewport.scrollTop,0);assert.deepEqual(resets,[0,0]);
 assert.notEqual(classNode(r.root,'business-content'),previousContent,'the independent desktop content scroll region also starts with a new node');
 viewport.scrollTop=180;
 await act(async()=>findButton(primary(),'차량 관리').props.onClick());
 await act(async()=>findButton(classNode(r.root,'business-nav-tools'),'계정 메뉴').props.onClick());
 await act(async()=>findButton(r.root.findByType('aside'),'닫기').props.onClick());
 assert.equal(viewport.scrollTop,180);assert.deepEqual(resets,[0,0]);
 await act(async()=>findButton(primary(),'운행일지').props.onClick());
 assert.equal(viewport.scrollTop,0);
 viewport.scrollTop=90;
 await act(async()=>findButton(r.root.findByProps({'aria-label':'운행일지 하위 메뉴'}),'월간 요약').props.onClick());
 assert.equal(viewport.scrollTop,0);assert.deepEqual(resets,[0,0,0,0]);
});

test('corporate company controls appear once above the body and remain interactive',async t=>{
 const companies=[];
 const toolbar=React.createElement('select',{'aria-label':'회사 선택',onChange:e=>companies.push(e.target.value)},React.createElement('option',{value:'1'},'첫 회사'),React.createElement('option',{value:'2'},'다른 회사'));
 const {renderer:r}=await mount(t,{initialTab:'expenses',toolbar});
 const topbar=classNode(r.root,'business-topbar'),body=classNode(r.root,'business-content');
 assert.equal(r.root.findAllByType('select').length,1);
 assert.equal(topbar.findAllByType('select').length,1);
 assert.equal(body.findAllByType('select').length,0);
 assert.equal(r.root.findByProps({'aria-label':'지출 관리 하위 메뉴'}).type,'nav');
 assert.equal(text(topbar.findByProps({'aria-label':'현재 위치'}).children),'법인운행지출 관리지출 내역');
 const width=topbar.findByProps({'aria-label':'화면 폭 선택'});
 await act(async()=>findButton(width,'넓게').props.onClick());
 assert.equal(classNode(r.root,'business-workspace').props['data-view-width'],'wide');
 assert.equal(r.root.findAll(n=>typeof n.type==='string'&&n.props.className?.includes('business-page-heading')).length,0);
 await act(async()=>topbar.findByType('select').props.onChange({target:{value:'2'}}));
 assert.deepEqual(companies,['2']);
});

test('section navigation switches settings in the sidebar without duplicating company controls',async t=>{
 const {workspace}=await modules();
 const companies=[],changes=[];let r;
 const company=React.createElement('p',{'aria-label':'회사 정보 본문'},'등록된 회사 정보');
 const subscription=React.createElement('p',{'aria-label':'이용권 본문'},'현재 이용권');
 function Harness(){
  const [section,setSection]=React.useState('company');
  const sections={settings:[['company','회사 정보'],['subscription','이용권 관리']]};
  const toolbar=React.createElement('select',{'aria-label':'회사 선택',onChange:e=>companies.push(e.target.value)},React.createElement('option',{value:'1'},'첫 회사'),React.createElement('option',{value:'2'},'다른 회사'));
  return React.createElement(workspace.BusinessWorkspace,{title:'법인차 운영',kind:'corporate',tabs:corporateTabs,groups:corporateGroups,tab:'settings',onTab(){},toolbar,section,sections,onSection:(page,id)=>{assert.equal(page,'settings');changes.push(id);setSection(id);}},
   React.createElement(workspace.BusinessSettings,{company,subscription,activeTab:section,onTab:setSection,hideNavigation:true}));
 }
 await act(async()=>{r=create(React.createElement(Harness));});
 t.after(async()=>{await act(async()=>r.unmount());});
 const topbar=()=>classNode(r.root,'business-topbar'),body=()=>classNode(r.root,'business-content');
 assert.equal(r.root.findAllByProps({'aria-label':'관리 설정 하위 메뉴'}).length,1);
 const nav=()=>r.root.findByProps({'aria-label':'관리 설정 하위 메뉴'});
 assert.equal(nav().type,'nav');
 assert.equal(r.root.findAllByProps({'aria-label':'지출 관리 하위 메뉴'}).length,0);
 assert.equal(r.root.findAllByType('select').length,1);assert.equal(body().findAllByType('select').length,0);
 assert.equal(body().findAllByType('button').length,0,'controlled body does not repeat the header tabs');
 assert.equal(body().findByProps({'aria-label':'회사 정보 본문'}).children[0],'등록된 회사 정보');
 await act(async()=>findButton(nav(),'이용권 관리').props.onClick());
 assert.deepEqual(changes,['subscription']);assert.equal(findButton(nav(),'이용권 관리').props['aria-current'],'page');
 assert.equal(body().findAllByProps({'aria-label':'회사 정보 본문'}).length,0);
 assert.equal(body().findByProps({'aria-label':'이용권 본문'}).children[0],'현재 이용권');
 await act(async()=>topbar().findByType('select').props.onChange({target:{value:'2'}}));
 assert.deepEqual(companies,['2']);assert.equal(r.root.findAllByType('select').length,1);
 await act(async()=>findButton(nav(),'회사 정보').props.onClick());
 assert.equal(body().findAllByProps({'aria-label':'이용권 본문'}).length,0);
 assert.equal(body().findAllByProps({'aria-label':'회사 정보 본문'}).length,1);
});

test('settings selection calls its parent and waits for controlled updates while legacy mode stays usable',async t=>{
 const {workspace}=await modules(),changes=[];
 const props={company:React.createElement('p',{},'회사 본문'),subscription:React.createElement('p',{},'이용권 본문'),onTab:value=>changes.push(value)};
 let r;
 await act(async()=>{r=create(React.createElement(workspace.BusinessSettings,{...props,activeTab:'company'}));});
 t.after(async()=>{await act(async()=>r.unmount());});
 await act(async()=>findButton(r.root,'이용권 관리').props.onClick());
 assert.deepEqual(changes,['subscription']);assert.equal(r.root.findByType('p').children[0],'회사 본문');
 await act(async()=>r.update(React.createElement(workspace.BusinessSettings,{...props,activeTab:'subscription'})));
 assert.equal(r.root.findByType('p').children[0],'이용권 본문');assert.equal(findButton(r.root,'이용권 관리').props['aria-pressed'],true);
 await act(async()=>r.update(React.createElement(workspace.BusinessSettings,{...props,activeTab:'company',hideNavigation:true})));
 assert.equal(r.root.findAllByType('button').length,0);assert.equal(r.root.findByType('p').children[0],'회사 본문');
 await act(async()=>r.update(React.createElement(workspace.BusinessSettings,{...props,key:'legacy'})));
 assert.equal(r.root.findByType('p').children[0],'회사 본문');
 await act(async()=>findButton(r.root,'이용권 관리').props.onClick());
 assert.equal(r.root.findByType('p').children[0],'이용권 본문');
});

test('account drawer uses the same allowed destinations as the application rail',async t=>{
 const {rail}=await modules();
 const permitted=rail.sideRailItems({isCorporate:true,isAdmin:true}).filter(item=>item.id!=='corporate');
 const {renderer:r,destinations}=await mount(t,{globalNavigation:permitted});
 await act(async()=>findButton(classNode(r.root,'business-nav-tools'),'계정 메뉴').props.onClick());
 const drawer=r.root.findByType('aside');
 assert.deepEqual(buttons(drawer),['닫기','실시간 지도','단말기','내정보','관리자']);
 await act(async()=>findButton(drawer,'관리자').props.onClick());
 assert.deepEqual(destinations,['admin']);
 assert.equal(r.root.findAllByType('aside').length,0);
 assert.equal(findButton(classNode(r.root,'business-nav-tools'),'계정 메뉴').props['aria-expanded'],false);
 assert.deepEqual(Array.from(rail.sideRailItems({isCorporate:true}),item=>item.id),['home','devices','profile','corporate']);
 assert.deepEqual(Array.from(rail.sideRailItems({isRentcar:true,isDelivery:true}),item=>item.id),['home','devices','profile','rentcar','delivery']);
});

test('corporate map shortcut uses only an allowed home destination without changing the account navigation input',async t=>{
 const allowed=[{id:'home',label:'홈',icon:'home'},{id:'profile',label:'내정보',icon:'user'}];
 const {renderer:r,destinations,changes}=await mount(t,{globalNavigation:allowed});
 const primary=r.root.findByProps({'aria-label':'법인차 운영 메뉴'});
 const map=findButton(primary,'실시간 지도');
 assert.ok(map.props.className.includes('business-map-shortcut'));
 await act(async()=>map.props.onClick());
 assert.deepEqual(destinations,['home']);assert.deepEqual(changes,[]);
 assert.equal(r.root.findByType('output').children[0],'overview');
 assert.equal(allowed[0].label,'홈');assert.equal(allowed[0].icon,'home');
 await act(async()=>findButton(classNode(r.root,'business-nav-tools'),'계정 메뉴').props.onClick());
 await act(async()=>findButton(r.root.findByType('aside'),'실시간 지도').props.onClick());
 assert.deepEqual(destinations,['home','home']);assert.equal(r.root.findAllByType('aside').length,0);

 const {renderer:restricted}=await mount(t,{globalNavigation:[allowed[1]]});
 assert.ok(!buttons(restricted.root.findByProps({'aria-label':'법인차 운영 메뉴'})).includes('실시간 지도'));
 await act(async()=>findButton(classNode(restricted.root,'business-nav-tools'),'계정 메뉴').props.onClick());
 assert.deepEqual(buttons(restricted.root.findByType('aside')),['닫기','내정보']);
 const {renderer:standalone}=await mount(t,{globalNavigation:allowed,onNavigate:undefined});
 assert.ok(!buttons(standalone.root.findByProps({'aria-label':'법인차 운영 메뉴'})).includes('실시간 지도'));
});

test('mobile more keeps every corporate child and permitted account destination reachable',async t=>{
 const allowed=[{id:'home',label:'홈',icon:'home'},{id:'profile',label:'내정보',icon:'user'},{id:'admin',label:'관리자',icon:'wrench'}];
 const {renderer:r,changes,destinations}=await mount(t,{globalNavigation:allowed});
 const mobile=()=>r.root.findByProps({'aria-label':'법인차 운영 빠른 메뉴'});
 await act(async()=>findButton(mobile(),'사용자').props.onClick());
 assert.equal(changes.at(-1),'staff');
 assert.equal(findButton(mobile(),'사용자').props['aria-current'],'page');
 await act(async()=>findButton(mobile(),'더보기').props.onClick());
 let drawer=r.root.findByType('aside');
 for(const child of corporateTabs)assert.ok(buttons(drawer).includes(child.label),child.label);
 assert.ok(!buttons(drawer).includes('렌트카'));
 assert.ok(buttons(drawer).includes('실시간 지도'));assert.ok(!buttons(drawer).includes('홈'));
 await act(async()=>findButton(drawer,'차량 예약').props.onClick());
 assert.equal(changes.at(-1),'reservations');
 assert.equal(r.root.findAllByType('aside').length,0);
 await act(async()=>findButton(mobile(),'더보기').props.onClick());
 drawer=r.root.findByType('aside');
 await act(async()=>findButton(drawer,'내정보').props.onClick());
 assert.deepEqual(destinations,['profile']);
 assert.equal(r.root.findAllByType('aside').length,0);
 await act(async()=>findButton(mobile(),'지도').props.onClick());
 assert.deepEqual(destinations,['profile','home']);
 await act(async()=>findButton(mobile(),'더보기').props.onClick());
 await act(async()=>findButton(r.root.findByType('aside'),'실시간 지도').props.onClick());
 assert.deepEqual(destinations,['profile','home','home']);assert.equal(r.root.findAllByType('aside').length,0);
});

test('phone menu opens the permitted company sections, reports, and account destinations',async t=>{
 const selections=[];
 const {renderer:r,changes,destinations}=await mount(t,{
  phone:true, sections:{staff:[['users','사용자 목록'],['organization','부서·직책']]},
  onSection:(page,id)=>selections.push([page,id]),
  globalNavigation:[{id:'home',label:'지도',icon:'map'},{id:'profile',label:'내정보',icon:'user'}],
 });
 const open=async label=>{await act(async()=>r.root.findByProps({'aria-label':label}).props.onClick());return r.root.findByType('aside');};
 let drawer=await open('전체 메뉴');
 await act(async()=>findButton(drawer,'사용자 관리').props.onClick());
 assert.ok(!buttons(drawer).includes('변경 이력'));
 await act(async()=>findButton(drawer,'부서·직책').props.onClick());
 assert.deepEqual(changes,['staff']);assert.deepEqual(selections,[['staff','organization']]);
 assert.equal(r.root.findAllByType('aside').length,0);
 drawer=await open('전체 메뉴');
 await act(async()=>findButton(drawer,'운행일지').props.onClick());
 await act(async()=>findButton(drawer,'운행기록부').props.onClick());
 assert.equal(changes.at(-1),'report');
 drawer=await open('회사 및 계정 메뉴');
 assert.ok(!buttons(drawer).includes('관리자'));
 await act(async()=>findButton(drawer,'내정보').props.onClick());
 await act(async()=>r.root.findByProps({'aria-label':'실시간 지도'}).props.onClick());
 assert.deepEqual(destinations,['profile','home']);
});

test('rentcar keeps its own header, page title, schedule action and account links',async t=>{
 const tabs=[{id:'overview',label:'운영 현황',icon:'home'},{id:'schedule',label:'배차표',icon:'clock'},{id:'contracts',label:'계약',icon:'list'}];
 const scrolls=[];
 const {renderer:r,changes,destinations}=await mount(t,{title:'렌트카 운영',kind:'rentcar',tabs,groups:undefined},()=>({scrollTo:options=>scrolls.push(options)}));
 assert.equal(text(classNode(r.root,'business-header').findByType('h1').children),'렌트카 운영');
 assert.equal(text(classNode(r.root,'business-page-heading').findByType('h2').children),'운영 현황');
 assert.equal(r.root.findAll(n=>typeof n.type==='string'&&n.props.className?.includes('business-topbar')).length,0);
 assert.equal(r.root.findAll(n=>typeof n.type==='string'&&n.props.className?.includes('business-map-shortcut')).length,0);
 const mobile=r.root.findByProps({'aria-label':'렌트카 운영 빠른 메뉴'});
 await act(async()=>findButton(mobile,'배차표').props.onClick());
 assert.equal(changes.at(-1),'schedule');
 await act(async()=>findButton(mobile,'더보기').props.onClick());
 assert.deepEqual(buttons(r.root.findByType('aside')),['닫기','운영 현황','배차표','계약','단말기 관리','내정보·계정 유형']);
 await act(async()=>findButton(r.root.findByType('aside'),'단말기 관리').props.onClick());
 assert.deepEqual(destinations,['devices']);
 assert.deepEqual(scrolls,[],'the corporate navigation fix leaves rental scrolling unchanged');
});

async function mountVehicles(t,{localMap,devices,document,createNodeMock}){
 const {workspace}=await modules({document}),destinations=[];let renderer;
 await act(async()=>{renderer=create(React.createElement(workspace.BusinessWorkspace,{
  title:'법인차 운영',kind:'corporate',tabs:corporateTabs,groups:corporateGroups,tab:'vehicles',onTab(){},devices,
 },React.createElement(workspace.BusinessLocation,{devices}),React.createElement(workspace.BusinessVehicles,{devices,separateTerminal:true,localMap,onMap:id=>destinations.push(id)})),{createNodeMock});});
 t.after(async()=>{await act(async()=>renderer.unmount());});
 return {renderer,destinations};
}
const mapVehicles=[
 {id:1,vehicle_name:'위치 없는 차량',display_name:'단말 1',last_lat:null,last_lng:null},
 {id:2,vehicle_name:'위치 있는 차량',display_name:'단말 2',last_lat:37.5,last_lng:127,last_fix_at:'2026-11-17T02:59:00Z'},
];

test('local vehicle location selects and scrolls to its map even before a position is received',async t=>{
 const queried=[],scrolled=[];let mapAvailable=true;
 const resets=[];
 const viewport={scrollTop:0,scrollTo:({top})=>{viewport.scrollTop=top;resets.push(top);}};
 const document={querySelector:selector=>{queried.push(selector);return mapAvailable?{scrollIntoView:options=>scrolled.push(options)}:null;}};
 const {renderer:r,destinations}=await mountVehicles(t,{localMap:true,devices:mapVehicles,document,createNodeMock:element=>element.props.className?.split(' ').includes('business-workspace')?viewport:null});
 assert.deepEqual(resets,[0]);viewport.scrollTop=150;
 const rows=()=>r.root.findAll(n=>typeof n.type==='string'&&n.props.className?.split(' ').includes('business-vehicle'));
 assert.equal(rows().filter(n=>n.props.className.includes('is-selected')).length,0);
 const missing=()=>rows().find(n=>text(n.children).includes('위치 없는 차량'));
 const located=()=>rows().find(n=>text(n.children).includes('위치 있는 차량'));
 assert.ok(text(missing().children).includes('위치 없음'));
 await act(async()=>findButton(missing(),'위치').props.onClick());
 assert.ok(missing().props.className.includes('is-selected'));
 assert.match(text(classNode(r.root,'business-map-selection').children),/지도에 표시할 위치가 없습니다/);
 assert.deepEqual(queried,['.business-map-wrap']);
 assert.equal(scrolled.length,1);assert.equal(scrolled[0].block,'center');assert.equal(scrolled[0].behavior,'smooth');
 assert.deepEqual(destinations,[],'a vehicle without a GPS fix stays in the company workspace');
 await act(async()=>findButton(located(),'위치').props.onClick());
 assert.ok(located().props.className.includes('is-selected'));assert.ok(!missing().props.className.includes('is-selected'));
 assert.doesNotMatch(text(classNode(r.root,'business-map-selection').children),/지도에 표시할 위치가 없습니다/);
 assert.equal(scrolled.length,2);assert.deepEqual(destinations,[]);
 mapAvailable=false;
 await act(async()=>findButton(missing(),'위치').props.onClick());
 assert.ok(missing().props.className.includes('is-selected'));
 assert.equal(scrolled.length,2);assert.deepEqual(destinations,[],'an unmounted map does not redirect to another scope');
 assert.deepEqual(resets,[0]);assert.equal(viewport.scrollTop,150,'selecting a vehicle does not trigger the tab-navigation scroll reset');
});

test('nonlocal vehicle map actions retain their device destination regardless of position availability',async t=>{
 const queried=[];
 const {renderer:r,destinations}=await mountVehicles(t,{localMap:false,devices:mapVehicles,document:{querySelector:selector=>{queried.push(selector);return null;}}});
 const rows=()=>r.root.findAll(n=>typeof n.type==='string'&&n.props.className?.split(' ').includes('business-vehicle'));
 for(const device of mapVehicles){
  const row=rows().find(n=>text(n.children).includes(device.vehicle_name));
  await act(async()=>findButton(row,'지도').props.onClick());
  assert.ok(rows().find(n=>text(n.children).includes(device.vehicle_name)).props.className.includes('is-selected'));
 }
 assert.deepEqual(destinations,[1,2]);assert.deepEqual(queried,[]);
});

test('empty corporate vehicle lists guide registration before terminal connection while legacy hints stay unchanged',async t=>{
 const {workspace}=await modules();let r;
 await act(async()=>{r=create(React.createElement(workspace.BusinessVehicles,{devices:[],separateTerminal:true}));});
 t.after(async()=>{await act(async()=>r.unmount());});
 const empty=()=>classNode(r.root,'business-empty');
 assert.equal(text(empty().findByType('strong').children),'등록된 차량이 없습니다.');
 assert.equal(text(empty().findByType('p').children),'차량 관리에서 차량을 먼저 등록한 뒤 단말기를 연결해 주세요.');
 await act(async()=>r.update(React.createElement(workspace.BusinessVehicles,{devices:[],separateTerminal:false})));
 assert.equal(text(empty().findByType('p').children),'연결된 단말기의 차량 정보를 등록해 주세요.');
});
