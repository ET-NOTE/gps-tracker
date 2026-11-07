import test from 'node:test';
import assert from 'node:assert/strict';
import {projectFleetAssets} from '../src/lib/fleetAssets.js';
const asset={id:800,name:'업무차',profile:{},enabled:true,bindings:[{device_id:12,is_primary:true,started_at:'2026-10-01T00:00:00Z'}]};
test('fleet asset id never replaces the source SIM id',()=>{
 const [row]=projectFleetAssets([asset],[{id:12,display_name:'단말기',last_fix_at:'2026-10-02T00:00:00Z',last_lat:37,last_lng:127}]);
 assert.equal(row.id,800);assert.equal(row.source_device_id,12);assert.equal(row.last_lat,37);assert.equal(row.vehicle_name,'업무차');
});
test('SIM position before connection or without timestamp is not assigned to the vehicle',()=>{
 for(const time of [null,'bad','2026-09-30T00:00:00Z']){
  const [row]=projectFleetAssets([asset],[{id:12,last_fix_at:time,last_lat:37,last_lng:127}]);
  assert.equal(row.last_lat,null);assert.equal(row.last_lng,null);
 }
});
test('unconnected asset has no device or another vehicles telemetry',()=>{
 const [row]=projectFleetAssets([{...asset,bindings:[]}],[{id:800,last_lat:37,last_lng:127}]);
 assert.equal(row.source_device_id,undefined);assert.equal(row.last_lat,undefined);assert.equal(row.display_name,'단말기 미연결');
});
