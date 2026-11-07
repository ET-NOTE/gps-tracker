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

test('one-minute history rejects over 31 days before any request; 31 days remains complete',async()=>{
  let calls=0;
  const from='2026-10-01T00:00:00Z',until='2026-11-01T00:00:00Z';
  const fetch=async(a,b)=>{calls++;return Array.from({length:(Date.parse(b)-Date.parse(a))/60000},(_,i)=>({bucket:new Date(Date.parse(a)+i*60000).toISOString()}));};
  await assert.rejects(collectAggregates(fetch,'1m',from,'2026-11-02T00:00:00Z'),/최대 31일/);
  assert.equal(calls,0);
  const rows=await collectAggregates(fetch,'1m',from,until);
  assert.equal(rows.length,44640);
  assert.equal(new Set(rows.map(r=>r.bucket)).size,44640);
});

test('aggregation rejects malformed, oversized, duplicated, unordered or outside-window rows',async()=>{
  const from='2026-10-01T00:00:00Z',until='2026-10-01T00:10:00Z';
  for(const data of [{items:[]},[{}],[{bucket:until}],[{bucket:'2026-09-30T23:59:00Z'}],
    [{bucket:from},{bucket:from}],[{bucket:'2026-10-01T00:02:00Z'},{bucket:from}],
    [{bucket:'2026-10-01T00:00:30Z'}],Array(2001).fill({bucket:from})]) {
    await assert.rejects(collectAggregates(async()=>data,'1m',from,until),/모두 확인하지 못했습니다/);
  }
  assert.deepEqual(await collectAggregates(async()=>[],'1m',from,until),[]);
});

test('partial first buckets and leap-year coarse histories remain supported without overlap',async()=>{
  const windows=[];
  const rows=await collectAggregates(async(a,b)=>{
    windows.push([a,b]);
    return Array.from({length:Math.ceil((Date.parse(b)-Math.floor(Date.parse(a)/300000)*300000)/300000)},(_,i)=>({bucket:new Date(Math.floor(Date.parse(a)/300000)*300000+i*300000).toISOString()}));
  },'5m','2024-01-01T00:02:00Z','2025-01-01T00:00:00Z');
  assert.equal(rows.length,105408);
  assert.equal(new Set(rows.map(r=>r.bucket)).size,rows.length);
  assert.equal(windows.at(-1)[1],'2025-01-01T00:00:00.000Z');
});

test('aggregate failure or cancellation on later windows never returns partial history',async()=>{
  let calls=0;
  await assert.rejects(collectAggregates(async(a)=>{if(calls++)throw Error('network');return [{bucket:a}];},'1h','2026-01-01T00:00:00Z','2026-06-01T00:00:00Z'),/network/);
  const c=new AbortController();
  await assert.rejects(collectAggregates(async()=>{c.abort();return [];},'5m','2026-10-01T00:00:00Z','2026-11-01T00:00:00Z',c.signal),{name:'AbortError'});
});
