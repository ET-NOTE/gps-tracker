import test from 'node:test';
import assert from 'node:assert/strict';
import {filterTrips,tripReport,rentalReport,rentalPeriod,invoiceReport,reportCsv,reportPdfDefinition,csvCell,monthDateBounds} from '../src/lib/businessExport.js';
const trips=[
  {started_at:'2026-10-08T15:01:00Z',ended_at:'2026-10-08T16:01:00Z',duration_min:60,distance_m:4200,annotation:{purpose:'business',driver_staff_id:2,driver_name:'가상 운전자',fuel_cost:0,note:'쉼표, "따옴표"\n줄 바꿈'}},
  {duration_min:10,distance_m:1000,annotation:{purpose:'commute',driver_staff_id:3}},
  {duration_min:90,distance_m:1200,annotation:null},
];
test('trip exports use the same AND filters, including unassigned and minimum duration',()=>{
  const filtered=filterTrips(trips,{driver:'2',purpose:'business',minHours:'0.5'});
  assert.deepEqual(filtered,[trips[0]]);
  assert.deepEqual(filterTrips(trips,{driver:'unassigned',purpose:'unspecified',minHours:'1'}),[trips[2]]);
  assert.equal(filterTrips(trips,{driver:'2',minHours:2}).length,0);
  const r=tripReport(filtered,{device:{display_name:'테스트'},from:'2026-10-01',to:'2026-10-31'});
  assert.equal(r.rows.length,1);assert.equal(r.rows[0].start,'2026-10-09 00:01');assert.equal(r.rows[0].fuel,0);
  assert.equal(r.rows[0].note,trips[0].annotation.note);
  const csv=reportCsv(r);assert.ok(csv.startsWith('\uFEFF'));assert.ok(csv.includes('"쉼표, ""따옴표""\n줄 바꿈"'));
  assert.ok(!csv.includes('출퇴근'));assert.ok(r.summary.includes('4.20 km'));
});
test('CSV escapes formula-like text while preserving negative numeric settlements',()=>{
  for(const text of ['=1+1',' @SUM(1)','\t+1','-2+3']) assert.ok(csvCell(text).startsWith('"\''));
  assert.equal(csvCell(-20000),'"-20000"');assert.equal(csvCell(null),'""');
});
const contracts=[
  {id:1,device_id:3005,renter_name:'[테스트] A',status:'returned',starts_at:'2026-09-28T00:00:00Z',ends_at:'2026-09-29T00:00:00Z',settled_at:'2026-10-01T00:00:00Z',deposit_krw:30000,settled_amount_krw:50000,base_fee_krw:50000,settlement_json:{lines:[{kind:'base',label:'기본료',amount:50000}]}},
  {id:2,status:'active',starts_at:'2026-10-05T00:00:00Z',ends_at:'2026-10-06T00:00:00Z',deposit_krw:100000},
  {id:3,status:'returned',starts_at:'2026-10-05T00:00:00Z',ends_at:'2026-10-06T00:00:00Z',settled_at:'2026-10-31T15:00:00Z',settled_amount_krw:900000},
];
test('settlement selection uses payment date and does not omit old contracts settled this month',()=>{
  const period=rentalPeriod(contracts,{from:'2026-10-01',to:'2026-10-31',kind:'settled'});
  assert.deepEqual(period.map(c=>c.id),[1]);
  const r=rentalReport(period,{settlement:true});assert.equal(r.rows[0].refund,-20000);assert.ok(r.summary.includes('50,000원'));
  assert.equal(rentalReport(contracts,{settlement:true}).rows.length,2);
  assert.equal(rentalReport([contracts[1]]).rows[0].amount,'');
});
test('contract-period end is exclusive, includes last KST day, and intersects contract range',()=>{
  assert.deepEqual(rentalPeriod(contracts,{from:'2026-10-05',to:'2026-10-05',kind:'contracts'}).map(c=>c.id),[2,3]);
  assert.equal(rentalPeriod(contracts,{from:'2026-10-07',to:'2026-10-07',kind:'contracts'}).length,0);
});
test('monthly reports stop at the last day instead of leaking the next month',()=>{
  assert.deepEqual(monthDateBounds('2026-10'),{from:'2026-10-01',to:'2026-10-31'});
  assert.equal(monthDateBounds('2024-02').to,'2024-02-29');assert.equal(monthDateBounds('2026-12').to,'2026-12-31');
});
test('invoice retains signed refund and actual line details',()=>{
  const r=invoiceReport(contracts[0]);assert.equal(r.rows[0].amount,50000);assert.equal(r.rows.at(-1).amount,-20000);
});
test('PDF uses text tables with repeated headers and explicit empty state',()=>{
  const r=rentalReport(contracts),d=reportPdfDefinition(r),table=d.content.find(c=>c.table).table;
  assert.equal(table.headerRows,1);assert.equal(table.body.length,4);assert.equal(d.defaultStyle.font,'NanumGothic');
  assert.equal(d.pageOrientation,'landscape');
  assert.ok(reportPdfDefinition(rentalReport([])).content.some(c=>c.text==='조건에 맞는 내역이 없습니다.'));
});
