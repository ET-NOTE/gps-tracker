import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,create} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as hoursLib from '../src/lib/fleetBookingHours.js';

async function mount(t, role='owner', hintOnly=false, overrides={}, interval={}) {
  const context=vm.createContext({});
  const source=await readFile(new URL('../src/components/business/FleetBookingHours.jsx',import.meta.url),'utf8');
  const code=await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'});
  const mod=new vm.SourceTextModule(code.code,{context});
  const saved=[];
  const data={week_mask:127,open_minute:0,close_minute:1440,revision:4,...overrides};
  const wrap=tag=>({children,...props})=>React.createElement(tag,props,children);
  const modules={react:React,'react/jsx-runtime':jsx,'../../api':{api:{}},'./FleetAccess':{useFleetAccess:()=>({role})},
    './BusinessWorkspace':{BusinessButton:wrap('button'),BusinessError:wrap('p'),BusinessSection:wrap('section')},
    './fleet-booking-hours.css':{},'../../lib/fleetBookingHours':hoursLib,'@tanstack/react-query':{useQuery:()=>({data}),useQueryClient:()=>({}),
      useMutation:()=>({mutateAsync:async entry=>saved.push(JSON.parse(JSON.stringify(entry)))})}};
  await mod.link(name=>new vm.SyntheticModule(Object.keys(modules[name]),function(){
    for(const [key,value] of Object.entries(modules[name]))this.setExport(key,value);
  },{context}));
  await mod.evaluate();
  let renderer;
  await act(()=>{renderer=create(React.createElement(mod.namespace.default,{hintOnly,...interval}));});
  t.after(()=>act(()=>renderer.unmount()));
  return {renderer,saved};
}

test('weekday preset and midnight end save the company revision with an exclusive end of day',async t=>{
  const {renderer,saved}=await mount(t);
  const root=renderer.root;
  await act(()=>root.findByProps({'aria-pressed':false,children:'평일'}).props.onClick());
  const allDay=root.findAllByType('label').find(n=>n.children.includes('하루 종일')).findByType('input');
  await act(()=>allDay.props.onChange({target:{checked:false}}));
  const [start,end]=root.findAllByProps({type:'time'});
  await act(()=>end.props.onChange({target:{value:'08:30'}}));
  assert.match(root.findByProps({role:'alert'}).children[0],/종료 시간/);
  assert.equal(root.findByProps({type:'submit'}).props.disabled,true);
  await act(()=>start.props.onChange({target:{value:'17:30'}}));
  await act(()=>end.props.onChange({target:{value:'00:00'}}));
  await act(()=>root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.deepEqual(saved,[{week_mask:31,open_minute:1050,close_minute:1440,revision:4}]);
});
test('a member can see the saved policy without editing it',async t=>{
  const {renderer}=await mount(t,'member');
  assert.match(JSON.stringify(renderer.toJSON()),/하루 종일/);
  assert.equal(renderer.root.findAllByType('form').length,0);
});
test('an unrestricted company adds no booking hint',async t=>{
  const {renderer}=await mount(t,'member',true);
  assert.equal(renderer.toJSON(),null);
});
test('the booking hint checks every occupied weekday but excludes the exact midnight endpoint',async t=>{
  const start='2026-11-20T15:00';
  for(const [end,invalid] of [['2026-11-21T00:00',false],['2026-11-23T11:00',true]]) {
    const {renderer}=await mount(t,'member',true,{week_mask:31},{start,end});
    assert.equal(JSON.stringify(renderer.toJSON()).includes('벗어납니다'),invalid);
  }
});
