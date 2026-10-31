import test from 'node:test';
import assert from 'node:assert/strict';
import {summarizeMonthlyTrips,monthlyDistance,monthlyPercentages,monthlyStatus} from '../src/lib/monthlySummary.js';
import {monthlyReport,reportCsv,reportPdfDefinition} from '../src/lib/businessExport.js';
const trip = (distance_m, extra={}) => ({started_at:'2026-10-01T00:00:00Z',ended_at:'2026-10-01T01:00:00Z',distance_m,...extra});

test('monthly distinguishes no records, unconfirmed records and confirmed zero distance',()=>{
 const empty=summarizeMonthlyTrips([]),excluded=summarizeMonthlyTrips([trip(500,{quality:{report_included:false}})]),zero=summarizeMonthlyTrips([trip(0)]);
 assert.equal(monthlyStatus(empty),'운행 기록 없음');
 assert.equal(monthlyStatus(excluded),'확정 기록 없음 · 합계 제외 1건');
 assert.equal(monthlyDistance(empty.totalKm,empty.includedCount),'—');
 assert.equal(monthlyDistance(zero.totalKm,zero.includedCount),'0');
 for(const row of [empty,excluded,zero]) assert.deepEqual(monthlyPercentages(row),{business:null,other:null});
});

test('monthly short distances remain visible and unspecified trips are not called personal',()=>{
 const r=summarizeMonthlyTrips([trip(70)]);
 assert.equal(monthlyDistance(r.totalKm,r.includedCount),'0.07');
 assert.equal(monthlyDistance(0.003,1),'<0.01');
 assert.equal(monthlyDistance(1234.567,1),'1,234.57');
 assert.deepEqual(monthlyPercentages(r),{business:0,other:100});
 assert.equal(r.personalKm,.07);
});

test('monthly uses the same trip quality boundary and retains separately recorded expenses',()=>{
 const r=summarizeMonthlyTrips([trip(100,{annotation:{purpose:'business'}}),trip(100,{annotation:{purpose:'commute'}}),trip(200),trip(900,{allocation_status:'boundary_review',annotation:{fuel_cost:3400}}),trip(800,{ended_at:null}),trip(NaN),trip(-1)]);
 assert.deepEqual({total:r.totalKm,business:r.businessKm,other:r.personalKm,included:r.includedCount,excluded:r.excludedCount,cost:r.annotationCost}, {total:.4,business:.2,other:.2,included:3,excluded:4,cost:3400});
 assert.deepEqual(monthlyPercentages(r),{business:50,other:50});
});

test('monthly CSV and PDF preserve blank versus zero and short-distance meaning',()=>{
 const rows=[[],[trip(0)],[trip(70)],[trip(3)]].map((trips,i)=>({label:'차량 '+i,...summarizeMonthlyTrips(trips)}));
 const r=monthlyReport(rows,{month:'2026-10',estimateFuelCost:()=>0,estimateDepreciation:()=>0});
 assert.deepEqual(r.rows.map(row=>row.total),['',0,.07,'<0.01']);
 assert.equal(r.rows[0].status,'운행 기록 없음');
 assert.ok(reportCsv(r).includes('"집계 상태"'));
 const pdf=reportPdfDefinition(r).content.find(c=>c.table).table.body;
 assert.equal(pdf[1][3].text,''); assert.equal(pdf[2][3].text,'0'); assert.equal(pdf[3][3].text,'0.07'); assert.equal(pdf[4][3].text,'<0.01');
});
