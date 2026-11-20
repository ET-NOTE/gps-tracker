import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import path from 'node:path';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
async function setup(){
 let scale=100000,frame=0;const frames=new Map(),markers=[],events=new Map();
 const node={clientWidth:1000,clientHeight:1000,style:{},appendChild(){},replaceChildren(){},getBoundingClientRect:()=>({width:1000,height:1000})};
 const canvas=()=>{const c={style:{},width:20,height:20,rotation:0,toDataURL:()=>`angle:${c.rotation}`};c.getContext=()=>new Proxy({rotate:r=>{c.rotation=r;}},{get:(t,k)=>t[k]||(()=>{})});return c;};
 class LatLng{constructor(lat,lng){this.lat=lat;this.lng=lng;}getLat(){return this.lat;}getLng(){return this.lng;}}
 class Marker{constructor(o){Object.assign(this,o);markers.push(this);}setMap(v){this.map=v;}getPosition(){return this.position;}setPosition(p){this.position=p;}setImage(i){this.image=i;}}
 class Polyline{constructor(o){Object.assign(this,o);}setMap(v){this.map=v;}setOptions(){}setPath(p){this.path=p;}}
 const maps={LatLng,Marker,Polyline,Size:class{},Point:class{},MarkerImage:class{constructor(src){this.angle=Number(src.split(':')[1]);}},InfoWindow:class{close(){}},
 Map:class{constructor(n){this.node=n;}getNode(){return node;}getLevel(){return 10;}getCenter(){return new LatLng(37,127);}setCenter(){}relayout(){}getProjection(){return {containerPointFromCoords:p=>({x:100+(p.lng-127)*scale,y:700-(p.lat-37)*scale})};}},
 event:{addListener:(target,event,fn)=>{if(!events.has(event))events.set(event,[]);events.get(event).push(fn);},removeListener(){}},};
 const window={kakao:{maps},addEventListener(){},removeEventListener(){},devicePixelRatio:1};
 const context=vm.createContext({console:{...console,warn(){}},window,document:{createElement:()=>canvas()},setInterval:()=>1,clearInterval(){},performance,btoa,
 ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:fn=>{frames.set(++frame,fn);return frame;},cancelAnimationFrame:id=>frames.delete(id)});
 const cache=new Map(),src=fileURLToPath(new URL('../src/',import.meta.url));
 const synthetic=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const [k,v]of Object.entries(values))this.setExport(k,v);},{context});
 async function load(file){if(cache.has(file))return cache.get(file);const promise=(async()=>{let m;
 if(file==='react')m=synthetic(React);else if(file==='react/jsx-runtime')m=synthetic(jsx);
 else if(file.endsWith('/kakaoSdk.js'))m=synthetic({loadKakaoMaps:async()=>{}});
 else if(file.endsWith('/battery.js'))m=synthetic({batteryText:()=>''});
 else if(file.endsWith('.json'))m=synthetic({default:JSON.parse(await readFile(file,'utf8'))});
 else m=new vm.SourceTextModule((await transform(await readFile(file,'utf8'),{loader:file.endsWith('jsx')?'jsx':'js',jsx:'automatic',format:'esm'})).code,{context,identifier:file});
 await m.link(name=>load(name.startsWith('.')?path.resolve(path.dirname(file),name)+(path.extname(name)?'':'.js'):name));return m;})();cache.set(file,promise);return promise;}
 const m=await load(path.join(src,'components/KakaoMap.jsx'));await m.evaluate();const ref=React.createRef();let r;
 await act(async()=>{r=create(React.createElement(m.namespace.default,{ref}),{createNodeMock:()=>node});});
 const flush=()=>{for(const [id,fn]of [...frames]){frames.delete(id);fn(0);}};
 return {api:ref.current,markers,flush,zoom:n=>{scale=n;for(const f of events.get('idle')||[])f();flush();},close:async()=>act(async()=>r.unmount())};
}
test('skipped original fixes determine direction; zoom thins without discarding points and seeker does not resurrect them',async()=>{
 const f=await setup(),now=Date.now(),at=i=>new Date(now+i*1000).toISOString();
 f.api.addHistoryPoint(1,37,127,'#2563eb',{recordedAt:at(0)});
 f.api.addHistoryPoint(1,37.001,127,'#2563eb',{recordedAt:at(1),skipMarker:true});
 f.api.addHistoryPoint(1,37.001,127.001,'#2563eb',{recordedAt:at(2)});
 f.flush();assert.equal(f.markers.length,2);assert.ok(Math.abs(f.markers[1].image.angle-Math.PI/2)<.001);
 assert.equal(f.markers.filter(x=>x.map).length,2);
 f.zoom(10000);assert.equal(f.markers.filter(x=>x.map).length,1);assert.equal(f.api.getNativeTrackingData(1).points.length,2);
 f.api.filterToDevice(1,{fit:false});assert.equal(f.markers.filter(x=>x.map).length,1);
 f.api.setSeekerMode(true);f.zoom(100000);assert.equal(f.markers.filter(x=>x.map).length,0);
 f.api.setSeekerMode(false);assert.equal(f.markers.filter(x=>x.map).length,2);await f.close();
});
test('new batch starts with unknown direction and original predecessor crosses native bridge with its own time',async()=>{
 const f=await setup(),now=Date.now(),at=i=>new Date(now+i*1000).toISOString();
 f.api.addHistoryPoint(1,37,127,'#2563eb',{recordedAt:at(0)});
 f.api.addHistoryPoint(1,38,128,'#2563eb',{recordedAt:at(100),skipMarker:true});
 f.api.addHistoryPoint(1,38,128,'#2563eb',{recordedAt:at(101)});f.flush();assert.ok(!Number.isFinite(f.markers.at(-1).image.angle));
 f.api.updateMarker(1,37,127,'test','#2563eb',{recordedAt:at(110),speedKmh:30},{deferPolyline:true});
 f.api.updateMarker(1,37,127.001,'test','#2563eb',{recordedAt:at(120),speedKmh:30},{deferPolyline:true});
 const data=f.api.getNativeTrackingData(1);assert.equal(data.markers[1].previousFix.lng,127);assert.equal(data.markers[1].previousFix.recordedAt,at(110));await f.close();
});
