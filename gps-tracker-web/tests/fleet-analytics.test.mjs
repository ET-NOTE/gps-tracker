import test from 'node:test';
import assert from 'node:assert/strict';
import { analyticsPeriodError, tripAnalyticsRows, costAnalyticsRows, groupAnalytics, trendSeries } from '../src/lib/fleetAnalytics.js';

test('analytics uses confirmed distances including measured zero, KST dates and distinct driver identities',()=>{
  const base = {started_at:'2026-11-01T15:00:00Z',ended_at:'2026-11-01T16:10:00Z',distance_m:1500};
  const rows = tripAnalyticsRows([
    {...base,annotation:{driver_name:'이영업',driver_staff_id:11}},
    {...base,distance_m:0,annotation:{driver_name:'이영업',driver_staff_id:12}},
    {...base,quality:{report_included:false}},
    {...base,allocation_status:'boundary_review'},
    {...base,ended_at:null},
  ], {id:1,vehicle_name:'업무 차량',department:'영업부'});
  // Every ended trip is listed; only report-included ones are marked confirmed (기록 확정 filter).
  assert.equal(rows.length,4);
  const confirmed=rows.filter(r=>r.confirmed);
  assert.equal(confirmed.length,2);
  assert.equal(confirmed[0].date,'2026-11-02');
  assert.equal(confirmed[0].minutes,70);
  assert.equal(groupAnalytics(confirmed,'driver').length,2);
  assert.deepEqual(groupAnalytics(confirmed,'vehicle')[0],{id:'1',label:'업무 차량',count:2,amount:1.5,minutes:140});
  assert.deepEqual(trendSeries(confirmed,'2026-11-01','2026-11-03',true).map(p=>p.value),[0,2,0]);
});

test('costs keep general expenses and historical category IDs distinct across a year boundary',()=>{
  const rows=costAnalyticsRows([
    {spent_on:'2026-12-31',amount_krw:8000,vehicle_id:null,category_id:1,category_name:'기타'},
    {spent_on:'2027-01-01',amount_krw:3000,vehicle_id:12,vehicle_name:'123가',category_id:2,category_name:'기타'},
  ]);
  assert.deepEqual(groupAnalytics(rows,'vehicle').map(g=>[g.label,g.amount]),[['일반 지출',8000],['123가',3000]]);
  assert.equal(groupAnalytics(rows,'category').length,2);
  assert.deepEqual(trendSeries(rows,'2026-11-01','2027-01-15'),[
    {date:'2026-11',value:0},{date:'2026-12',value:8000},{date:'2027-01',value:3000},
  ]);
});

test('analytics validates real calendar dates and the inclusive report API limit',()=>{
  for(const dates of [['2024-01-01','2024-12-31'],['2026-01-01','2027-01-01']])assert.equal(analyticsPeriodError(...dates),'');
  for(const dates of [['2026-02-30','2026-03-30'],['2026-01-01','2027-01-02'],['2026-04-02','2026-04-01'],['','2026-04-01']])assert.ok(analyticsPeriodError(...dates));
});
