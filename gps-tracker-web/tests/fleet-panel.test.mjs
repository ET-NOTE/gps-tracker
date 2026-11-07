import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create, act} from 'react-test-renderer';
import {transform} from 'esbuild';

async function fixture(file, api = {}) {
  const context=vm.createContext({console,setTimeout,clearTimeout});
  const code=(await transform(await readFile(new URL('../src/components/fleet/'+file,import.meta.url),'utf8'),{loader:'jsx',jsx:'automatic',format:'esm'})).code;
  const mod=new vm.SourceTextModule(code,{context});
  const synthetic=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});
  await mod.link(name=>{
    if(name==='react')return synthetic(React);
    if(name==='react/jsx-runtime')return synthetic(jsx);
    if(name==='../../api')return synthetic({api});
    if(name==='../../lib/business')return synthetic({vehicleName:d=>d.display_name});
    if(name==='../../lib/stops')return synthetic({haversineM:()=>0});
    if(name==='../../lib/speed')return synthetic({serverSpeed:()=>0});
    return synthetic({default:props=>React.createElement('fake-child',props)});
  });
  await mod.evaluate();return mod.namespace.default;
}
const text=r=>JSON.stringify(r.toJSON());
const device={id:7,display_name:'Test car'};
const event={id:1,kind:'wake',occurred_at:'2026-10-21T00:00:00Z'};

test('Fleet events UI distinguishes first-load failure, stale success and a real empty response',async()=>{
 const Panel=await fixture('SelectedDevicePanel.jsx');let r,retries=0;
 const props={selectedDevice:device,evError:true,events:null,onEventsRetry:()=>retries++};
 await act(async()=>{r=create(React.createElement(Panel,props));});
 assert.match(text(r),/이벤트를 불러오지 못했습니다/);assert.doesNotMatch(text(r),/최근 이벤트 없음/);
 const retry=r.root.findAll(n=>n.type==='button'&&n.children.join('')==='다시 시도')[0];
 await act(async()=>retry.props.onClick());assert.equal(retries,1);
 await act(async()=>r.update(React.createElement(Panel,{...props,events:[event]})));
 assert.match(text(r),/마지막으로 확인한 기록/);assert.match(text(r),/단말기 깨어남/);
 await act(async()=>r.update(React.createElement(Panel,{...props,evError:false,events:[]})));
 assert.match(text(r),/최근 이벤트 없음/);assert.doesNotMatch(text(r),/불러오지 못했습니다/);
 await act(async()=>r.unmount());
});

test('Fleet trip-list failure offers retry and recovers without switching vehicles',async()=>{
 let failed=true,calls=0;
 const Panel=await fixture('SelectedDevicePanel.jsx',{listTrips:async()=>{calls++;if(failed)throw Error('internal SQL details');return[];}});let r;
 await act(async()=>{r=create(React.createElement(Panel,{selectedDevice:device,events:[]}));});
 await act(async()=>r.root.findAll(n=>n.type==='button'&&n.children.join('')==='운행 이력')[0].props.onClick());
 assert.match(text(r),/운행 이력을 불러오지 못했습니다/);assert.doesNotMatch(text(r),/internal SQL/);
 failed=false;await act(async()=>r.root.findAll(n=>n.type==='button'&&n.children.join('')==='다시 시도')[0].props.onClick());
 assert.equal(calls,2);assert.match(text(r),/최근 30일 운행 없음/);
 await act(async()=>r.unmount());
});

test('Fleet trip detail renders accepted map points without fetching them again',async()=>{
 let calls=0;
 const Detail=await fixture('TripDetailTab.jsx',{listLocationsGrouped:async()=>{calls++;return[];},flattenGroupedAsc:x=>x});let r;
 const points=[{lat:37,lng:127,recorded_at:'2026-10-21T00:00:00Z'},{lat:37.1,lng:127.1,recorded_at:'2026-10-21T00:01:00Z'}];
 await act(async()=>{r=create(React.createElement(Detail,{deviceId:7,trip:{started_at:points[0].recorded_at},points,mapRef:{current:{}}}));});
 assert.equal(calls,0);assert.match(text(r),/포인트/);assert.doesNotMatch(text(r),/로딩/);
 await act(async()=>r.unmount());
});
