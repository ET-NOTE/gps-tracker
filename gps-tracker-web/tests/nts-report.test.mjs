import test from 'node:test';
import assert from 'node:assert/strict';
import { ntsTripReport, reportVehicleLabel } from '../src/lib/ntsReport.js';
import { reportCsv, reportPdfDefinition, filterTrips } from '../src/lib/businessExport.js';
const context = {device:{id:4,car_model:'아반떼',car_plate:'12가3456',display_name:'단말-520211',department:'차량 소속'},info:{company_name:'회사',business_number:'123-45-67890'},from:'2026-10-01',to:'2026-10-31'};
const trip = (purpose, distance_m=10000) => ({started_at:'2026-10-28T15:01:00Z',ended_at:'2026-10-28T16:01:00Z',distance_m,annotation:{purpose,driver_name:'김사용',driver_staff_id:1}});
const footer = (r,label) => r.csvFooter.find(row=>row[0]?.startsWith(label))?.[1];
test('report uses captured driver department, never current vehicle department',()=>{
 const t=trip('business');t.annotation.driver_department='과거 영업부';
 assert.equal(ntsTripReport([t],context).rows[0].department,'과거 영업부');
});
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

test('CSV and print filenames use the registered vehicle name without changing the official model field',()=>{
  const device = {...context.device,vehicle_name:'본사/영업 1호'};
  const report = ntsTripReport([trip('business')],{...context,device});
  assert.equal(report.filename,'업무용승용차_운행기록부_본사_영업 1호_12가3456_2026-10-01_2026-10-31');
  assert.equal(report.printForm.model,'아반떼');
  assert.deepEqual(report.csvPreamble.find(row=>row[0]==='①차종'),['①차종','아반떼']);

  const fromAsset = ntsTripReport([],{...context,device:{...device,vehicle_name:' ',asset:{name:'관리 차량'}}});
  assert.match(fromAsset.filename,/관리 차량_12가3456_/);
  const sameName = ntsTripReport([],{...context,device:{...device,vehicle_name:device.car_plate}});
  assert.equal(sameName.filename,'업무용승용차_운행기록부_12가3456_2026-10-01_2026-10-31');
});

test('long Unicode vehicle names leave room for the plate and both dates in the saved stem',()=>{
  const device = {...context.device,vehicle_name:'🚙영업'.repeat(60)};
  const {filename} = ntsTripReport([],{...context,device});
  assert.equal([...filename].length,60);
  assert.ok(filename.startsWith('업무용승용차_운행기록부_🚙영업'));
  assert.ok(filename.endsWith('_12가3456_2026-10-01_2026-10-31'));
  assert.equal(Buffer.from(filename,'utf8').toString('utf8'),filename);
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

test('measured odometer pairs populate the official fields and use after minus before without changing GPS',()=>{
 const measured=trip('business',10000),zero=trip('commute',3000),fallback=trip('commute',5000);
 measured.annotation={...measured.annotation,odometer_before_km:1234.56,odometer_after_km:1246.90};
 zero.annotation={...zero.annotation,odometer_before_km:0,odometer_after_km:0};
 const r=ntsTripReport([measured,zero,fallback],context);
 assert.deepEqual([r.rows[0].before,r.rows[0].after,r.rows[0].km,r.rows[0].business],[1234.56,1246.90,12.34,12.34]);
 assert.deepEqual([r.rows[1].before,r.rows[1].after,r.rows[1].km,r.rows[1].commute],[0,0,0,0]);
 assert.equal(footer(r,'⑪'),17.34);assert.equal(footer(r,'⑫'),17.34);assert.equal(footer(r,'⑬'),'100.00%');
 assert.match(r.rows[0].note,/운행기록 거리 참고 10.00 km/);assert.match(r.rows[1].note,/운행기록 거리 참고 3.00 km/);
 assert.match(r.printForm.distanceBasis,/계기판 차이\(⑥−⑤\) 2건 · 운행기록 거리 대체 1건/);
 assert.ok(r.warnings.some(w=>w.includes('계기판 거리 미입력·확인 필요 1건')));
 assert.equal(measured.distance_m,10000);assert.equal(zero.distance_m,3000);
 const csv=reportCsv(r);assert.ok(csv.includes('"1234.56","1246.9","12.34"'));assert.ok(csv.includes(r.printForm.distanceBasis));
});

test('invalid, partial and out-of-contract readings never become measured report distance',()=>{
 const pairs=[[null,15],[10,null],[-1,10],[11,10],[NaN,10],[0,Infinity],['0',10],[0,10000000],[0,1.001]];
 for(const [before,after] of pairs){
  const t=trip('business');t.annotation={...t.annotation,odometer_before_km:before,odometer_after_km:after};
  const r=ntsTripReport([t],context);
  assert.deepEqual([r.rows[0].before,r.rows[0].after,r.rows[0].km],['','',10]);
  assert.equal(r.printForm.odometerCount,0);assert.equal(r.printForm.recordDistanceCount,1);assert.equal(footer(r,'⑪'),10);
 }
 const t=trip('business');t.annotation={...t.annotation,odometer_before_km:9999999.98,odometer_after_km:9999999.99};
 const r=ntsTripReport([t],context);assert.equal(r.rows[0].km,0.01);assert.equal(r.printForm.missingOdometerCount,0);
 assert.ok(!r.warnings.some(w=>w.startsWith('계기판 거리 미입력')));
});

test('odometer entry does not confirm excluded, open or invalid-GPS trips',()=>{
 const rows=[{...trip('business'),quality:{report_included:false}},{...trip('commute'),ended_at:null},trip('business',NaN)];
 rows.forEach(t=>{t.annotation={...t.annotation,odometer_before_km:100,odometer_after_km:120};});
 const r=ntsTripReport(rows,context);
 assert.equal(r.printForm.includedCount,0);assert.equal(footer(r,'⑪'),0);assert.equal(footer(r,'⑬'),'');
 for(const row of r.rows){assert.equal(row.km,20);assert.equal(row.business,'');assert.equal(row.commute,'');assert.match(row.note,/합계 제외/);}
 const missing=ntsTripReport([trip('business',null)],context);
 assert.equal(missing.printForm.missingDistanceCount,1);assert.match(missing.printForm.distanceBasis,/거리 확인 필요 1건/);
});

test('manual and merged correction distances are identified as trip records, not asserted as raw GPS',()=>{
 for(const basis of ['manual','source_sum']){
  const t={...trip('business',42500),correction_id:17,quality:{status:'confirmed',report_included:true,distance_basis:basis,measured_distance_m:12000}};
  const r=ntsTripReport([t],context),csv=reportCsv(r);
  assert.equal(r.rows[0].km,42.5);assert.equal(footer(r,'⑪'),42.5);
  assert.match(r.rows[0].note,/운행기록 거리 기준/);assert.match(r.printForm.distanceBasis,/운행기록 거리 대체 1건/);
  assert.ok(r.warnings.some(w=>w.includes('GPS 계산 또는 검토·보정된 운행기록 거리')));
  assert.doesNotMatch(csv,/GPS (?:대체|기준|참고)/);
  const pdfText=JSON.stringify(reportPdfDefinition(r));
  assert.match(pdfText,/운행기록 거리 대체 1건/);assert.doesNotMatch(pdfText,/GPS (?:대체|기준|참고)/);
 }
});
