import test from 'node:test';
import assert from 'node:assert/strict';
import {expenseTotals,expenseGroups,expenseReport,expenseTripOptions,expenseTripAmount} from '../src/lib/fleetExpenses.js';
import {reportCsv,reportPdfDefinition} from '../src/lib/businessExport.js';
const row=(id,status,amount,extra={})=>({id,status,amount_krw:amount,spent_on:'2026-10-29',staff_name:'김기사',department_id:1,department_name:'영업팀 당시',vehicle_id:null,vehicle_name:'일반 지출',group_name:'여비교통비',category_name:'숙박비 당시',payment_method:'company_card',note:'',...extra});
const rows=[row(1,'approved',50000),row(2,'pending',80000),row(3,'rejected',90000),row(4,'cancelled',100000),row(5,'approved',10000,{vehicle_id:3,vehicle_name:'업무차 당시',trip_started_at:'2026-10-29T01:00:00Z',category_name:'유류비 당시'})];

test('general expenses use closed assigned trips without inheriting fuel amounts',()=>{
 const trip={ended_at:'2026-10-29T02:00:00Z',allocation_status:'assigned',annotation:{fuel_expense_id:7,fuel_cost:50000}};
 const trips=[trip,{...trip,ended_at:null},{...trip,allocation_status:'boundary_review'}];
 assert.deepEqual(expenseTripOptions(trips,'expense'),[trip]);assert.deepEqual(expenseTripOptions(trips,'fuel'),[]);
 assert.deepEqual(expenseTripAmount(trip,'expense'),{});assert.deepEqual(expenseTripAmount(trip,'fuel'),{amount_krw:50000});
 const report=expenseReport([{...rows[4],category_name:'통행료'}],{from:'2026-10-01',to:'2026-10-31'});
 assert.equal(report.rows[0].trip,'2026-10-29 10:00');assert.doesNotMatch(report.rows[0].trip,/주유비/);
});
test('expenses total only approved ledger rows, never add linked trip fuel again',()=>{assert.deepEqual(expenseTotals(rows),{amount:60000,pending:1,approved:2,rejected:1,cancelled:1});assert.equal(expenseGroups(rows,'month')[0].amount,60000);assert.equal(expenseGroups(rows,'vehicle').length,2);assert.equal(expenseGroups(rows,'department')[0].count,2);assert.equal(expenseTotals(rows.filter(r=>r.id!==5)).amount,50000);});
test('CSV and PDF share filtered snapshots, status and approved-only summary',()=>{const report=expenseReport(rows.slice(0,2),{from:'2026-10-01',to:'2026-10-29',filterText:'차량 전체'});assert.equal(report.rows.length,2);assert.match(report.summary,/50,000/);assert.match(reportCsv(report),/숙박비 당시/);assert.match(reportCsv(report),/승인대기/);assert.equal(reportPdfDefinition(report).content.at(-1).text,report.footer);const hostile=expenseReport([row(9,'approved',1,{note:'=HYPERLINK("bad")'})],{from:'2026-10-01',to:'2026-10-29'});assert.match(reportCsv(hostile),/'=HYPERLINK/);});
