import test from 'node:test';
import assert from 'node:assert/strict';
import { collectHistory, collectAggregates } from '../src/lib/historyPager.js';

test('history follows all cursors beyond 10,000 transmissions without losing same-time sources', async () => {
  const rows=Array.from({length:10006},(_,i)=>({recorded_at:new Date(1790000000000+Math.floor(i/2)*1000).toISOString(),source:i%2?'phone':'l80'})).reverse();
  let calls=0;
  const result=await collectHistory(async cursor=>{
    calls++;
    const i=Number(cursor||0),end=Math.min(i+2000,rows.length);
    return {items:rows.slice(i,end),has_more:end<rows.length,next_cursor:end<rows.length?String(end):null};
  });
  assert.equal(calls,6);assert.equal(result.length,rows.length);
  assert.equal(new Set(result.map(p=>p.recorded_at+p.source)).size,rows.length);
});
test('cancellation and an intermediate failure never return a partial day',async()=>{
  const c=new AbortController();let calls=0;
  await assert.rejects(collectHistory(async()=>{calls++;c.abort();return {items:[],has_more:true,next_cursor:'next'};},{signal:c.signal}),{name:'AbortError'});
  assert.equal(calls,1);
  calls=0;
  await assert.rejects(collectHistory(async()=>{if(calls++)throw Error('network');return {items:[{}],has_more:true,next_cursor:'next'};}),/network/);
  await assert.rejects(collectHistory(async()=>({items:[{}],has_more:false,next_cursor:null}),{maxPoints:0}),/좌표가 많습니다/);
});
test('a repeated cursor fails explicitly rather than looping or claiming completion',async()=>{
  await assert.rejects(collectHistory(async()=>({items:[],has_more:true,next_cursor:'same'})),/진행되지/);
});
test('31-day five-minute aggregation includes all 8,928 buckets with disjoint windows',async()=>{
  const start=Date.parse('2026-08-01T00:00:00+09:00'),end=Date.parse('2026-09-01T00:00:00+09:00');
  const windows=[];
  const rows=await collectAggregates(async(a,b)=>{
    const x=Date.parse(a),y=Date.parse(b);windows.push([x,y]);
    return Array.from({length:(y-x)/300000},(_,i)=>({bucket:new Date(x+i*300000).toISOString()}));
  },'5m',new Date(start).toISOString(),new Date(end).toISOString());
  assert.equal(rows.length,8928);assert.equal(new Set(rows.map(r=>r.bucket)).size,8928);
  assert.equal(windows[0][0],start);assert.equal(windows.at(-1)[1],end);
  windows.slice(1).forEach((w,i)=>assert.equal(w[0],windows[i][1]));
});
