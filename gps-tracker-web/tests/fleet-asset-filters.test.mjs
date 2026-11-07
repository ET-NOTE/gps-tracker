import test from 'node:test';
import assert from 'node:assert/strict';
import {filterFleetAssets,assetFilterError,assetRegistrationDay,assetOdometer} from '../src/lib/fleetAssetFilters.js';
import {fleetAssetLabel} from '../src/lib/fleetAssets.js';

const asset=(id,km,extra={})=>({id,name:`업무차 ${id}`,enabled:true,profile:{odometer_km:km},created_at:'2026-10-15T00:00:00Z',bindings:[],...extra});
const rows=[asset(1,null),asset(2,0),asset(3,12000.5),asset(4,75000),asset(5,undefined)];
const ids=(options,data=rows,staff=[])=>filterFleetAssets(data,options,staff).map(v=>v.id);

test('odometer ranges include exact decimal boundaries and never treat missing as zero',()=>{
  assert.deepEqual(ids({minKm:'0',maxKm:'0'}),[2]);
  assert.deepEqual(ids({minKm:'12000.5',maxKm:'12000.5'}),[3]);
  assert.deepEqual(ids({minKm:'12000.5'}),[3,4]);
  assert.deepEqual(ids({maxKm:'12000.5'}),[2,3]);
  assert.deepEqual(ids({distance:'missing'}),[1,5]);
  assert.deepEqual(ids({distance:'recorded'}),[2,3,4]);
  assert.equal(ids({}).length,5);
  for(const v of [null,undefined,'',false,'100',NaN,Infinity,-1]) assert.equal(assetOdometer(asset(9,v)),null);
});
test('registration range includes both Korean days independent of host timezone',()=>{
  const dates=['2026-10-14T14:59:59Z','2026-10-14T15:00:00Z','2026-10-15T14:59:59.999Z','2026-10-15T15:00:00Z',null,'bad'];
  const data=dates.map((created_at,i)=>asset(i+1,0,{created_at}));
  assert.deepEqual(ids({from:'2026-10-15',to:'2026-10-15'},data),[2,3]);
  assert.deepEqual(ids({to:'2026-10-15'},data),[1,2,3]);
  assert.deepEqual(ids({from:'2026-10-15'},data),[2,3,4]);
  assert.equal(ids({},data).length,6);
  assert.equal(assetRegistrationDay('2026-10-15T00:00:00+09:00'),'2026-10-15');
});
test('invalid or reversed ranges are reported rather than silently applied',()=>{
  for(const f of [{minKm:'-1'},{maxKm:'NaN'},{maxKm:'10000001'},{minKm:'2',maxKm:'1'},
    {from:'2026-02-30'},{to:'not-date'},{from:'2026-10-16',to:'2026-10-15'}]) {
    assert.ok(assetFilterError(f));assert.deepEqual(ids(f),[]);
  }
  assert.equal(assetFilterError({from:'2024-02-29',minKm:'0',maxKm:'10000000'}),'');
});
test('distance sorts keep unregistered last without mutating source or SIM bindings',()=>{
  const before=structuredClone(rows);
  assert.deepEqual(ids({sort:'distanceAsc'}),[2,3,4,1,5]);
  assert.deepEqual(ids({sort:'distanceDesc'}),[4,3,2,1,5]);
  assert.deepEqual(rows,before);
});
test('distance, date, status and manager/terminal search compose without adding other vehicles',()=>{
  const data=[asset(50,12,{manager_staff_id:7,bindings:[{device_id:900,terminal_name:'SIM 가나다'}]}),asset(51,12,{enabled:false})];
  const f={minKm:'10',maxKm:'20',from:'2026-10-15',to:'2026-10-15',status:'enabled'};
  assert.deepEqual(ids({...f,query:'  김담당 '},data,[{id:7,name:'김담당'}]),[50]);
  assert.deepEqual(ids({...f,query:'sim 가나다'},data),[50]);
  assert.deepEqual(ids({...f,status:'disabled'},data),[51]);
  assert.equal(data[0].bindings[0].device_id,900);
});
test('vehicle choices distinguish unnamed assets by primary terminal or vehicle ID',()=>{
  assert.equal(fleetAssetLabel({id:50,name:'차량 정보 미등록',bindings:[{terminal_name:'보조',is_primary:false},{terminal_name:'단말-520211',is_primary:true}]}),'차량 정보 미등록 · 단말: 단말-520211');
  assert.equal(fleetAssetLabel({id:51,name:''}),'차량 정보 미등록 · 차량 51');
  assert.equal(fleetAssetLabel({id:52,name:'영업차',license_plate:'12가3456'}),'영업차 · 12가3456');
  assert.equal(fleetAssetLabel({id:53,name:'12가3456',license_plate:'12가3456'}),'12가3456');
});
