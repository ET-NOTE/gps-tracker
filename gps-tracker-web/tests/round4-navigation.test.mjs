import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as Router from 'react-router-dom';
import { create, act } from 'react-test-renderer';
import { transform } from 'esbuild';
import { dashboardView, routeAccess } from '../src/lib/dashboardRoutes.js';
import * as fleetPositions from '../src/lib/fleetPositions.js';

test('routing: exact supported routes include pairing and trailing slash', () => {
  for (const [route, view] of [['/', 'home'], ['/devices/pair', 'devices'], ['/profile/', 'profile'], ['/corporate', 'corporate']]) assert.equal(dashboardView(route), view);
});
test('routing: unknown descendants and prefix lookalikes never become Home or privileged pages', () => {
  for (const route of ['/missing', '/devices-old', '/devices/pair/extra', '/profile/nope', '/admin-anything', '/rentcar/nope']) assert.equal(dashboardView(route), null);
});
test('routing: specialized access uses matching account type; admin checked independently', () => {
  assert.equal(routeAccess('corporate', {}, 'corporate_fleet'), true);
  assert.equal(routeAccess('rentcar', {role:'admin'}, 'corporate_fleet'), false);
  assert.equal(routeAccess('admin', {role:'admin'}, 'personal'), true);
  assert.equal(routeAccess('admin', {role:'user'}, 'corporate_fleet'), false);
  assert.equal(routeAccess('delivery', {}, undefined), false);
});

async function fleetFixture(options = {}) {
  let ready, mounted = 0;
  const markers = [], focus = [], calls = [], removed = [], paths = [], cleared = [], timers = new Map(), controls = {};
  let ws, refreshes = 0;
  const map = {updateMarker: (...args) => markers.push(args), filterToDevice: (...args) => focus.push(args), removeMarker:id=>removed.push(id), clearSeekerPath:()=>cleared.push('standard'), clearSeekerPathCanvas:()=>cleared.push('canvas'), setSeekerMode(){}, drawSeekerPath:(...args)=>paths.push(args), drawSeekerPathCanvas:(...args)=>paths.push(args)};
  const FakeMap = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => map);
    React.useEffect(() => { mounted++; return () => mounted--; }, []);
    ready = props.onReady;
    return React.createElement('fake-map');
  });
  const devices = [{id:7, display_name:'Fixture', last_lat:37, last_lng:127, last_fix_at:'2026-10-20T00:00:00Z'}];
  const context = vm.createContext({console, URLSearchParams, setInterval:(fn,ms)=>{timers.set(ms,fn);return ms;}, clearInterval:ms=>timers.delete(ms)});
  const source = await readFile(new URL('../src/pages/FleetDashboard.jsx', import.meta.url), 'utf8');
  const code = (await transform(source, {loader:'jsx', jsx:'automatic', format:'esm'})).code;
  const mod = new vm.SourceTextModule(code, {context});
  const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  await mod.link(name => {
    if(name==='react') return synthetic(React);
    if(name==='react/jsx-runtime') return synthetic(jsx);
    if(name==='react-router-dom') return synthetic(Router);
    if(name==='../state') return synthetic({useDevices:()=>{const [data,setData]=React.useState(options.devices ?? devices);controls.setDevices=setData;return {data,isSuccess:true,refetch:()=>refreshes++};}});
    if(name==='../api') return synthetic({api:{getDeviceEvents:async id=>{calls.push(id);return options.events ? options.events(id) : [];},listLocationsGrouped:(...args)=>options.locations?.(...args) ?? Promise.resolve([]),flattenGroupedAsc:points=>points}});
    if(name==='../lib/speed') return synthetic({serverSpeed:()=>0});
    if(name==='../ws') return synthetic({TrackerWS:class{constructor(event,status){ws={event,status};}connect(){} disconnect(){} subscribe(){}}});
    if(name==='../lib/fleetPositions') return synthetic(fleetPositions);
    if(name==='../lib/fleetStatus') return synthetic({FLEET_GROUPS:[{id:'all'}],fleetStatusGroup:()=> 'all'});
    if(name==='../lib/business') return synthetic({vehicleName:d=>d.display_name});
    if(name==='../useBreakpoint') return synthetic({default:()=> 'mobile'});
    if(name.includes('KakaoMap')) return synthetic({default:FakeMap});
    if(name.includes('DeviceListPanel')) return synthetic({default:props=>React.createElement('fake-list',props)});
    if(name.includes('SelectedDevicePanel')) return synthetic({default:props=>React.createElement('fake-detail',props)});
    return synthetic({default:()=>null});
  });
  await mod.evaluate();
  const Probe=()=>{controls.nav=Router.useNavigate();return null;};
  return {Component:mod.namespace.default, Probe, controls, ready:()=>ready(), markers, focus, calls, removed, paths, cleared, timers, ws:()=>ws, refreshes:()=>refreshes, mounted:()=>mounted};
}
test('Fleet mobile: map stays mounted, late SDK populates markers, selection switches panel', async () => {
  const f = await fleetFixture(); let r;
  await act(async()=>{r=create(React.createElement(Router.MemoryRouter,{initialEntries:['/fleet?device=999&canvas=1']},React.createElement(React.Fragment,null,React.createElement(f.Component),React.createElement(f.Probe))));});
  assert.deepEqual(f.calls, [], 'unknown query device must never fetch events');
  assert.equal(f.markers.length, 0, 'imperative ref alone is not SDK readiness');
  assert.equal(f.mounted(), 1);
  const panes = () => r.root.findAll(n=>n.type==='section');
  assert.deepEqual(panes().map(p=>p.props.hidden), [false,true,true]);
  await act(async()=>f.ready());
  assert.equal(f.markers.length, 1); assert.equal(f.markers[0][0], 7);
  await act(async()=>r.root.findByType('fake-list').props.onSelect({id:7}));
  assert.deepEqual(panes().map(p=>p.props.hidden), [true,true,false]);
  assert.deepEqual(f.calls,[7]);
  const mapButton = r.root.findAll(n=>n.type==='button' && n.children.join('')==='지도')[0];
  await act(async()=>mapButton.props.onClick());
  assert.deepEqual(panes().map(p=>p.props.hidden),[true,false,true]); assert.equal(f.mounted(),1);
  await act(async()=>f.controls.nav('/fleet?device=7&q=changed&canvas=1'));
  assert.equal(r.root.findByType('fake-list').props.query,'changed','incoming URL must update same mounted Fleet');
  await act(async()=>f.controls.nav('/fleet?device=999'));
  assert.equal(r.root.findByType('fake-detail').props.selectedDevice,null);
  assert.deepEqual(f.calls,[7]);
  await act(async()=>r.unmount()); assert.equal(f.mounted(),0);
});

const fixedDevice = {id:7,display_name:'Fixture',last_lat:37,last_lng:127,last_fix_at:'2026-10-20T00:00:00Z'};
const trip = {started_at:'2026-10-20T00:00:00Z',ended_at:'2026-10-20T00:10:00Z'};
const deferred = () => { let resolve,reject; const promise = new Promise((yes,no)=>{resolve=yes;reject=no;}); return {promise,resolve,reject}; };
const mountFleet = async (f, path='/fleet') => {
  let r;
  await act(async()=>{r=create(React.createElement(Router.MemoryRouter,{initialEntries:[path]},React.createElement(React.Fragment,null,React.createElement(f.Component),React.createElement(f.Probe))));});
  return r;
};
const detail = r => r.root.findByType('fake-detail').props;
const text = r => JSON.stringify(r.toJSON());

test('Fleet: SDK before devices waits for coordinates, fits once, then removes unlinked markers', async()=>{
  const f=await fleetFixture({devices:[]});const r=await mountFleet(f);
  await act(async()=>f.ready());
  assert.equal(f.focus.filter(args=>args[1].fit).length,0);
  await act(async()=>f.controls.setDevices([fixedDevice]));
  assert.equal(f.focus.filter(args=>args[1].fit).length,1);
  await act(async()=>f.controls.setDevices([{...fixedDevice,last_lat:38,last_fix_at:'2026-10-20T01:00:00Z'}]));
  assert.equal(f.focus.filter(args=>args[1].fit).length,1,'polling must preserve user camera');
  await act(async()=>f.controls.setDevices([]));
  assert.deepEqual(f.removed,[7]);
  const before=f.markers.length;
  await act(async()=>f.ws().event({type:'location',device_id:7,fix:true,lat:39,lng:127,recorded_at:'2026-10-20T02:00:00Z'}));
  assert.equal(f.markers.length,before,'unlinked device must not return over WS');
  await act(async()=>r.unmount());
});

test('Fleet: first live fix is retained before SDK readiness and snapshots cannot rewind it',async()=>{
  const f=await fleetFixture({devices:[{id:7,display_name:'No GPS'}]});const r=await mountFleet(f,'/fleet?device=7');
  assert.match(text(r),/최근 위치가 아직 수신되지/);
  await act(async()=>f.ws().event({type:'location',device_id:7,fixes:[{lat:38,lng:128,recorded_at:'2026-10-20T01:00:00Z'},{lat:99,lng:127,recorded_at:'2026-10-20T02:00:00Z'}]}));
  assert.equal(f.markers.length,0);
  await act(async()=>f.ready());
  assert.equal(f.markers.at(-1)[1],38);
  assert.ok(f.focus.some(args=>args[0]===7&&args[1].fit));
  await act(async()=>f.controls.setDevices([fixedDevice]));
  assert.equal(f.markers.at(-1)[1],38,'older poll cannot move latest fix back');
  await act(async()=>f.ws().event({type:'location',device_id:7,fix:true,lat:36,lng:126,recorded_at:'2026-10-20T00:30:00Z'}));
  assert.equal(f.markers.at(-1)[1],38,'out-of-order WS cannot rewind marker');
  assert.doesNotMatch(text(r),/최근 위치가 아직 수신되지/);
  await act(async()=>r.unmount());
});

test('Fleet: reconnection refreshes snapshots and selected events; disconnect is visible',async()=>{
  const f=await fleetFixture();const r=await mountFleet(f,'/fleet?device=7');
  await act(async()=>f.ws().status('disconnected'));
  assert.match(text(r),/실시간 연결을 복구/);
  await act(async()=>{f.ws().status('connected');f.ws().event({type:'resync'});});
  assert.equal(f.refreshes(),1);assert.deepEqual(f.calls,[7,7]);
  assert.doesNotMatch(text(r),/실시간 연결을 복구/);
  await act(async()=>r.unmount());
});

test('Fleet events: refresh failure retains accepted data and retry restores it',async()=>{
  let failed=false;
  const f=await fleetFixture({events:()=>failed ? Promise.reject(Error('database')) : Promise.resolve([{id:1,kind:'wake'}])});
  const r=await mountFleet(f,'/fleet?device=7');
  assert.equal(detail(r).events[0].id,1);
  failed=true;await act(async()=>f.timers.get(60000)());
  assert.equal(detail(r).evError,true);assert.equal(detail(r).events[0].id,1);
  failed=false;await act(async()=>detail(r).onEventsRetry());
  assert.equal(detail(r).evError,false);assert.equal(detail(r).events[0].id,1);
  await act(async()=>r.unmount());
});

test('Fleet events: old device response cannot contaminate the new selection',async()=>{
  const old=deferred();const f=await fleetFixture({devices:[fixedDevice,{id:8}],events:id=>id===7?old.promise:Promise.resolve([{id:8}])});
  const r=await mountFleet(f,'/fleet?device=7');
  await act(async()=>f.controls.nav('/fleet?device=8'));
  await act(async()=>old.resolve([{id:7}]));
  assert.equal(detail(r).selectedDevice.id,8);assert.equal(detail(r).events[0].id,8);
  await act(async()=>r.unmount());
});

test('Fleet trips: clear previous route on load; failure and empty data are retryable without duplicate detail fetch',async()=>{
  let result=[{lat:37,lng:127,recorded_at:trip.started_at}],requests=0;
  const f=await fleetFixture({locations:()=>{requests++;return result instanceof Error?Promise.reject(result):Promise.resolve(result);}});
  const r=await mountFleet(f,'/fleet?device=7&canvas=1');await act(async()=>f.ready());
  await act(async()=>detail(r).onTripSelect(trip));
  assert.equal(f.paths.length,1);assert.equal(detail(r).tripPoints[0].lat,37);assert.equal(requests,1);
  const second={...trip,started_at:'2026-10-20T01:00:00Z'};
  result=Error('network');const cleared=f.cleared.length;
  await act(async()=>detail(r).onTripSelect(second));
  assert.ok(f.cleared.length>cleared);assert.equal(detail(r).selectedTrip,null);assert.match(text(r),/운행 경로를 불러오지 못했습니다/);
  result=[];
  await act(async()=>r.root.findAll(n=>n.type==='button'&&n.children.join('')==='다시 시도')[0].props.onClick());
  assert.match(text(r),/표시할 위치 기록이 없습니다/);assert.equal(f.paths.length,1);
  result=[{lat:38,lng:128,recorded_at:second.started_at}];
  await act(async()=>r.root.findAll(n=>n.type==='button'&&n.children.join('')==='다시 시도')[0].props.onClick());
  assert.equal(detail(r).selectedTrip.started_at,second.started_at);assert.equal(f.paths.length,2);
  await act(async()=>r.unmount());
});

test('Fleet trips: late route after changing vehicles cannot draw or reopen selection',async()=>{
  const response=deferred();const f=await fleetFixture({devices:[fixedDevice,{id:8}],locations:()=>response.promise});
  const r=await mountFleet(f,'/fleet?device=7');await act(async()=>f.ready());
  let request;await act(async()=>{request=detail(r).onTripSelect(trip);});
  await act(async()=>f.controls.nav('/fleet?device=8'));
  await act(async()=>{response.resolve([{lat:37,lng:127}]);await request;});
  assert.equal(detail(r).selectedTrip,null);assert.equal(f.paths.length,0);
  await act(async()=>r.unmount());
});

test('Fleet position merge rejects malformed coordinates and unknown-time rewinds',()=>{
  const previous={lat:37,lng:127,recordedAt:'2026-10-20T00:00:00Z'};
  for(const incoming of [{lat:null,lng:127},{lat:Infinity,lng:127},{lat:91,lng:127},{lat:37,lng:-181},{lat:38,lng:127,recordedAt:'invalid'}]) assert.equal(fleetPositions.latestFleetPosition(previous,incoming),previous);
});


test('Fleet: coordinates without a fix timestamp cannot consume initial fit or block the first dated fix',async()=>{
 const f=await fleetFixture({devices:[{...fixedDevice,last_fix_at:null}]});const r=await mountFleet(f,'/fleet?device=7');
 await act(async()=>f.ready());assert.equal(f.markers.length,0);
 await act(async()=>f.ws().event({type:'location',device_id:7,fix:true,lat:38,lng:128,recorded_at:fixedDevice.last_fix_at}));
 assert.equal(f.markers.at(-1)[1],38);assert.ok(f.focus.some(args=>args[0]===7&&args[1].fit));
 await act(async()=>r.unmount());
});
