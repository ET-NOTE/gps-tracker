import test from 'node:test';
import assert from 'node:assert/strict';
import { ntsTripReport, reportVehicleLabel } from '../src/lib/ntsReport.js';
import { reportCsv, filterTrips } from '../src/lib/businessExport.js';
const context = {device:{id:4,car_model:'아반떼',car_plate:'12가3456',display_name:'단말-520211',department:'차량 소속'},info:{company_name:'회사',business_number:'123-45-67890'},from:'2026-10-01',to:'2026-10-31'};
const trip = (purpose, distance_m=10000) => ({started_at:'2026-10-28T15:01:00Z',ended_at:'2026-10-28T16:01:00Z',distance_m,annotation:{purpose,driver_name:'김사용',driver_staff_id:1}});
const footer = (r,label) => r.csvFooter.find(row=>row[0]?.startsWith(label))?.[1];
test('attached template columns, KST dates and vehicle filename; no invented odometer or staff department',()=>{
  const r=ntsTripReport([trip('business')],context);
  assert.deepEqual(r.columns.map(c=>c.key),['date','department','driver','before','after','km','commute','business','note']);
  assert.equal(r.rows[0].date,'2026-10-29 (목)');
  for(const key of ['department','before','after']) assert.equal(r.rows[0][key],'');
  assert.match(r.filename,/아반떼_12가3456_2026-10-01_2026-10-31/);
  assert.ok(!r.filename.includes('520211'));
  assert.equal(reportVehicleLabel(context.device),'아반떼 · 12가3456');
});
test('commute and business stay separate and both feed the template business-distance total',()=>{
  const r=ntsTripReport([trip('commute',10000),trip('business',20000),trip('other',10000)],context);
  assert.equal(footer(r,'⑪'),40);assert.equal(footer(r,'⑫'),30);assert.equal(footer(r,'⑬'),'75.00%');
  assert.equal(r.rows[0].commute,10);assert.equal(r.rows[0].business,0);
  assert.equal(r.rows[1].commute,0);assert.equal(r.rows[1].business,20);
});
test('open/invalid trips remain marked in rows but do not inflate totals or produce a percentage',()=>{
  const r=ntsTripReport([trip('business'),{...trip('business'),ended_at:null},trip('business',null),trip('business',-2),{...trip('business'),ended_at:'2026-10-27T15:00:00Z'}],context);
  assert.equal(r.rows.length,5);assert.equal(footer(r,'⑪'),10);assert.equal(footer(r,'⑬'),'');
  assert.match(r.rows[1].note,/합계 제외/);assert.equal(r.rows[2].km,'');
  assert.ok(r.warnings.some(w=>w.includes('4건')));
});
test('unknown purpose is not classified as personal or business, and zero/empty have no percentage',()=>{
  const r=ntsTripReport([trip('business'),trip('unspecified')],context);
  assert.equal(r.rows[1].commute,'');assert.equal(r.rows[1].business,'');
  assert.equal(footer(r,'⑪'),20);assert.equal(footer(r,'⑬'),'');
  for(const rows of [[],[trip('other',0)]]) assert.equal(footer(ntsTripReport(rows,context),'⑬'),'');
});
test('visible precision matches totals; filter scope cannot silently become full period',()=>{
  const selected=filterTrips([trip('business',10004),trip('commute',999)],{purpose:'business'});
  const r=ntsTripReport(selected,{...context,filtered:true});
  assert.equal(r.rows.length,1);assert.equal(footer(r,'⑪'),10);assert.match(r.warnings.at(-1),/필터/);
});
test('metadata and free text are escaped, missing company and registration are shown before download',()=>{
  const t=trip('business');t.annotation.driver_name='=HYPERLINK("bad")';t.annotation.note='쉼표, "메모"\n다음 줄';
  const r=ntsTripReport([t],{...context,info:{company_name:'=1+1'},device:{id:8}});
  assert.ok(r.warnings[0].includes('사업자등록번호'));assert.match(r.filename,/차량번호미등록_8/);
  const csv=reportCsv(r);assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"\'=1+1"'));assert.ok(csv.includes('"\'=HYPERLINK(""bad"")"'));
  assert.ok(csv.includes('쉼표, ""메모""\n다음 줄'));
});
