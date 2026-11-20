import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTrips, tripReport} from '../src/lib/businessExport.js';
import {ntsTripReport} from '../src/lib/ntsReport.js';
import {groupAnalytics, tripAnalyticsRows} from '../src/lib/fleetAnalytics.js';

const vehicle={id:7,vehicle_name:'업무차'};
const context={device:vehicle,from:'2026-11-01',to:'2026-11-30'};
const trip=(purpose,id,name)=>({
  started_at:'2026-11-12T01:00:00Z',ended_at:'2026-11-12T02:00:00Z',distance_m:2000,
  annotation:{purpose,company_purpose_id:id,company_purpose_name:name},
});
const trips=[trip('business',9,'거래처 방문'),trip('commute',9,'거래처 방문'),trip('business',null,null)];

test('a company purpose filter follows the linked ID independently of statutory classification',()=>{
  assert.deepEqual(filterTrips(trips,{purpose:'company:9'}),trips.slice(0,2));
  assert.deepEqual(filterTrips(trips,{purpose:'company:1'}),[]);
  assert.deepEqual(filterTrips(trips,{purpose:'business'}),[trips[0],trips[2]]);
});
test('custom labels appear in reports and statistics without moving mileage into another tax category',()=>{
  const form=ntsTripReport(trips,context), general=tripReport(trips,context);
  assert.deepEqual(form.rows.map(r=>[r.business,r.commute]),[[2,0],[0,2],[2,0]]);
  assert.match(form.rows[0].note,/거래처 방문/);
  assert.equal(general.rows[0].purpose,'업무 · 거래처 방문');
  assert.equal(general.rows[2].purpose,'업무');
  const groups=groupAnalytics(tripAnalyticsRows(trips,vehicle),'category');
  assert.deepEqual(groups.map(g=>[g.label,g.count]),[['거래처 방문',2],['업무',1]]);
});
