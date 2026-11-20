import test from 'node:test';
import assert from 'node:assert/strict';
import {qualityLabel,reportIncluded,tripTimeRange,qualitySummary} from '../src/lib/tripQuality.js';
import {ntsTripReport} from '../src/lib/ntsReport.js';
const trip={started_at:'2026-10-20T02:00:00Z',ended_at:'2026-10-21T04:00:00Z',distance_m:14000,quality:{status:'review',report_included:false},annotation:{purpose:'business'}};
test('reviewed, open and boundary trips stay outside totals',()=>{assert.equal(reportIncluded(trip),false);assert.equal(reportIncluded({...trip,quality:{status:'confirmed',report_included:true}}),true);assert.equal(reportIncluded({...trip,quality:{report_included:true},ended_at:null}),false);assert.equal(reportIncluded({...trip,quality:null,allocation_status:'boundary_review'}),false);const sum=qualitySummary([trip,{...trip,quality:{report_included:true}}]);assert.equal(sum.confirmedMeters,14000);assert.equal(sum.unconfirmedMeters,14000);});
test('cross-day trips show the end date and missing ends do not claim motion',()=>{assert.match(tripTimeRange(trip),/2026-10-21 13:00/);assert.match(tripTimeRange({...trip,ended_at:null}),/종료 미수신/);assert.equal(qualityLabel({...trip,quality:{status:'end_missing'}}),'종료 미수신');});
test('CSV/PDF share excluded-trip policy without hiding measured distances',()=>{const report=ntsTripReport([trip],{device:{id:1},info:{},from:'2026-10-01',to:'2026-10-31'});assert.equal(report.rows[0].km,14);assert.match(report.rows[0].note,/합계 제외/);assert.equal(report.csvFooter.find(r=>r[0]==='⑪조회 내역 총주행거리(㎞)')[1],0);});
