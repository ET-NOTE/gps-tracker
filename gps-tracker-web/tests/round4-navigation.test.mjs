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

async function fleetFixture() {
  let ready, mounted = 0;
  const markers = [], focus = [], calls = [];
  const map = {updateMarker: (...args) => markers.push(args), filterToDevice: (...args) => focus.push(args), clearSeekerPath(){}, setSeekerMode(){}};
  const Map = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => map);
    React.useEffect(() => { mounted++; return () => mounted--; }, []);
    ready = props.onReady;
    return React.createElement('fake-map');
  });
  const devices = [{id:7, display_name:'Fixture', last_lat:37, last_lng:127, last_fix_at:'2026-10-20T00:00:00Z'}];
  const context = vm.createContext({console, window:{location:{search:''}}, URLSearchParams, setInterval:()=>1, clearInterval(){}});
  const source = await readFile(new URL('../src/pages/FleetDashboard.jsx', import.meta.url), 'utf8');
  const code = (await transform(source, {loader:'jsx', jsx:'automatic', format:'esm'})).code;
  const mod = new vm.SourceTextModule(code, {context});
  const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  await mod.link(name => {
    if(name==='react') return synthetic(React);
    if(name==='react/jsx-runtime') return synthetic(jsx);
    if(name==='react-router-dom') return synthetic(Router);
    if(name==='../state') return synthetic({useDevices:()=>({data:devices,isSuccess:true})});
    if(name==='../api') return synthetic({api:{getDeviceEvents:async id=>{calls.push(id);return[];}}});
    if(name==='../lib/speed') return synthetic({serverSpeed:()=>0});
    if(name==='../ws') return synthetic({TrackerWS:class{connect(){} disconnect(){} subscribe(){}}});
    if(name==='../lib/fleetStatus') return synthetic({FLEET_GROUPS:[{id:'all'}],fleetStatusGroup:()=> 'all'});
    if(name==='../lib/business') return synthetic({vehicleName:d=>d.display_name});
    if(name==='../useBreakpoint') return synthetic({default:()=> 'mobile'});
    if(name.includes('KakaoMap')) return synthetic({default:Map});
    if(name.includes('DeviceListPanel')) return synthetic({default:props=>React.createElement('fake-list',props)});
    if(name.includes('SelectedDevicePanel')) return synthetic({default:props=>React.createElement('fake-detail',props)});
    return synthetic({default:()=>null});
  });
  await mod.evaluate();
  const controls={};
  const Probe=()=>{controls.nav=Router.useNavigate();return null;};
  return {Component:mod.namespace.default, Probe, controls, ready:()=>ready(), markers, focus, calls, mounted:()=>mounted};
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
