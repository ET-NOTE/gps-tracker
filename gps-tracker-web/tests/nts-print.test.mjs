import test from 'node:test';
import assert from 'node:assert/strict';
import {ntsTripReport} from '../src/lib/ntsReport.js';
import {reportPdfDefinition,reportCsv,rentalReport} from '../src/lib/businessExport.js';
const context={device:{car_model:'아반떼',car_plate:'12가3456'},info:{company_name:'모의 회사',business_number:'000-00-00000'},from:'2026-10-01',to:'2026-10-31'};
const trip=(distance_m=10000,purpose='business')=>({started_at:'2026-10-28T00:00:00Z',ended_at:'2026-10-28T01:00:00Z',distance_m,annotation:{purpose,driver_name:'김사용',driver_department:'영업부'}});
const grid=pdf=>pdf.content.find(n=>n.table?.headerRows===3).table;
test('print form retains filtered CSV totals, excluded rows and actual zero without invented odometers',()=>{
 const report=ntsTripReport([trip(10001,'commute'),trip(20002),trip(0,'other'),{...trip(99000),ended_at:null}],{...context,filtered:true});
 const pdf=reportPdfDefinition(report),table=grid(pdf),f=report.printForm;
 assert.equal(f.total,30);assert.equal(f.work,30);assert.equal(f.ratio,'');assert.equal(f.filtered,true);
 assert.deepEqual(f.excludedRows,[false,false,false,true]);assert.equal(f.includedCount,3);
 assert.equal(table.body.length,8);assert.equal(table.body[5][5].text,'0');assert.equal(table.body[6][5].text,'99');assert.match(table.body[6][8].text,/합계 제외/);
 for(const row of table.body.slice(3,7)){assert.equal(row[3].text,'');assert.equal(row[4].text,'');}
 assert.equal(table.body.at(-1)[5].text,'30');assert.match(reportCsv(report),/"⑪조회 내역 총주행거리\(㎞\)","30"/);
 assert.ok(pdf.content.some(n=>n.text?.startsWith('필터 적용')));
});
test('long and multiline notes have stable row references and all original text in the appendix',()=>{
 const long='긴 비고입니다. '.repeat(150)+'끝표시';const rows=[trip(),trip()];rows[0].annotation.note=long;rows[1].annotation.note='첫 줄\n둘째 줄';
 const report=ntsTripReport(rows,context),pdf=reportPdfDefinition(report),table=grid(pdf);
 assert.equal(table.body[3][8].text,'상세 비고 1 참조');assert.equal(table.body[4][8].text,'상세 비고 2 참조');
 for(const row of report.rows)assert.ok(pdf.content.some(n=>n.text===row.note));
 assert.equal(pdf.content.filter(n=>n.text==='상세 비고').length,1);assert.ok(pdf.content.find(n=>n.text==='상세 비고').pageBreak==='before');
});
test('empty and missing metadata print honestly with repeatable grouped headers and no ratio',()=>{
 const report=ntsTripReport([],{...context,info:{},device:{}}),pdf=reportPdfDefinition(report);
 assert.equal(report.printForm.company,'');assert.equal(report.printForm.plate,'');assert.equal(report.printForm.ratio,'');
 assert.match(grid(pdf).body[3][0].text,/내역이 없습니다/);assert.equal(grid(pdf).headerRows,3);
 assert.equal(pdf.footer(2,4).columns[1].text,'2 / 4');assert.match(pdf.footer(2,4).columns[0].text,/차량번호 미등록/);
 assert.equal(grid(pdf).body.at(-1)[5].text,'0');
});
test('generic rental and expense PDF layout remains separate from the driving form',()=>{
 const pdf=reportPdfDefinition(rentalReport([]));assert.equal(pdf.content[0].text,'렌트카 계약 목록');assert.ok(!pdf.content.some(n=>n.table?.headerRows===3));
});
