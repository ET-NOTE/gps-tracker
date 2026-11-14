import test from 'node:test';
import assert from 'node:assert/strict';
import { locationState, locationSummary, fleetDistance, groupMapPositions, missingMaintenance, corporateVehicleName, corporateAttention } from '../src/lib/corporateOverview.js';
const now=Date.parse('2026-10-29T12:00:00+09:00');
const position={last_lat:37.5,last_lng:127,last_fix_at:new Date(now).toISOString()};
test('fresh GPS is not inferred from current telemetry or stale coordinates',()=>{
 assert.equal(locationState({...position,last_fix_at:'2026-10-20T12:00:00+09:00',last_seen_at:new Date(now).toISOString()},now),'old');
 for(const time of [null,'bad',new Date(now+1).toISOString()]) assert.equal(locationState({...position,last_fix_at:time},now),'old');
 assert.equal(locationState({...position,last_lat:null},now),'none');
 assert.equal(locationState({...position,last_fix_at:new Date(now-300000).toISOString()},now),'current');
 assert.deepEqual(locationSummary([position,{...position,last_fix_at:null},{}],now),{current:1,old:1,none:1});
});
test('unreceived, pending and measured zero distance stay distinct',()=>{
 const device={id:1}; const row={device_id:1,today_distance_m:0,total_distance_m:0};
 assert.equal(fleetDistance([device],[row],now).todayKm,null);
 assert.equal(fleetDistance([{...device,...position}],[row],now).pending,1);
 assert.equal(fleetDistance([device],[{...row,today_fix_count:1}],now).todayKm,null);
 assert.equal(fleetDistance([device],[{...row,today_fix_count:2}],now).todayKm,0);
 for(const value of [null,NaN,-1]) assert.equal(fleetDistance([device],[{...row,today_fix_count:3,today_distance_m:value}],now).todayKm,null);
});
test('partial totals exclude other workspaces and never fabricate missing vehicles',()=>{
 const rows=[{device_id:1,today_fix_count:10,today_distance_m:1500,total_distance_m:3000},{device_id:99,today_fix_count:20,today_distance_m:900000,total_distance_m:900000}];
 const result=fleetDistance([{id:1},{id:2}],rows,now);
 assert.equal(result.todayKm,1.5); assert.equal(result.monthKm,3); assert.equal(result.partial,true); assert.equal(result.noData,1);
 assert.equal(fleetDistance([],rows,now).todayKm,null);
});
test('today coverage respects KST midnight and excludes future fixes',()=>{
 assert.equal(fleetDistance([{id:1,last_fix_at:'2026-10-28T15:01:00Z'}],[],now).pending,1);
 assert.equal(fleetDistance([{id:1,last_fix_at:'2026-10-28T14:59:00Z'}],[],now).noData,1);
 assert.equal(fleetDistance([{id:1,last_fix_at:new Date(now+1).toISOString()}],[],now).noData,1);
});
test('coincident map positions are selectable as one group, distant points stay separate',()=>{
 const item=(id,x,y)=>({device:{id},x,y});
 const groups=groupMapPositions([item(3,500,0),item(2,1,1),item(1,0,0)]);
 assert.deepEqual(groups.map(g=>g.items.map(i=>i.device.id)),[[1,2],[3]]);
 assert.equal(groupMapPositions([item(1,0,0),item(2,140,0),item(3,280,0)]).length,2);
});
test('unregistered schedules and vehicle names cannot masquerade as healthy or terminal names',()=>{
 assert.equal(missingMaintenance([{}, {next_service_date:'2026-12-01',insurance_expiry:'2027-01-01',inspection_expiry:'2027-01-01'}]).length,1);
 assert.equal(corporateVehicleName({display_name:'단말-520211'}),'차량 정보 미등록');
});
test('sleeping within its reporting window is not a long communication warning',()=>{
 const d={id:1};
 assert.equal(corporateAttention([d],now,{classify:()=>({id:'sleeping'}),battery:()=>({state:'normal'})}).length,0);
 assert.equal(corporateAttention([d],now,{classify:()=>({id:'offline'}),battery:()=>({state:'critical',percent:2,voltage:'2.78 V',label:'전압 매우 부족'})}).length,2);
});
