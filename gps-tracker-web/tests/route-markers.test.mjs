import test from 'node:test';
import assert from 'node:assert/strict';
import {screenBearing,spacedMarkerIndexes} from '../src/lib/routeMarkers.js';
test('projected cardinal and diagonal directions follow the drawn line',()=>{
 const center={x:100,y:100};
 for(const [x,y,angle] of [[100,0,0],[200,100,90],[100,200,180],[0,100,270],[200,0,45]])assert.equal(screenBearing(center,{x,y}),angle);
 assert.equal(screenBearing(center,center),null);assert.equal(screenBearing(null,center),null);
});
test('screen spacing stays readable on a long dense route and never changes source data',()=>{
 const points=Array.from({length:1500},(_,i)=>({x:100+Math.sin(i/80)*50,y:i/2,recordedAt:i}));
 const before=JSON.stringify(points),picked=spacedMarkerIndexes(points,48,{width:390,height:844});
 assert.ok(picked.size>8&&picked.size<24);
 const visible=[...picked].map(i=>points[i]);
 for(let i=0;i<visible.length;i++)for(let j=i+1;j<visible.length;j++)assert.ok(Math.hypot(visible[i].x-visible[j].x,visible[i].y-visible[j].y)>=48);
 assert.equal(JSON.stringify(points),before);
 assert.ok(spacedMarkerIndexes(points.map(p=>({...p,x:p.x*4,y:p.y*4})),48).size>picked.size);
});
test('priority stops win collisions, offscreen points do not suppress visible ones',()=>{
 const points=[{x:0,y:0},{x:10,y:0,priority:2},{x:1e6,y:0},{x:60,y:0}];
 assert.deepEqual([...spacedMarkerIndexes(points,48,{width:100,height:100})].sort(),[1,3]);
});
