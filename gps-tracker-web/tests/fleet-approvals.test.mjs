import test from 'node:test';
import assert from 'node:assert/strict';
import {approvalRecords,approvalReport,filterApprovals} from '../src/lib/fleetApprovals.js';
import {reportCsv} from '../src/lib/businessExport.js';

test('combined approvals preserve server review scope, composite IDs and actual booking decisions',()=>{
  const booking={id:7,created_at:'2026-11-01T10:00:00Z',can_review:true,approval_required:true,
    starts_at:'2026-11-02T01:00:00Z',ends_at:'2026-11-02T02:00:00Z',driver_staff_id:8,driver_name:'박영업',purpose:'고객 방문'};
  const spend={id:7,created_at:'2026-11-01T12:00:00Z',can_review:true,status:'approved',staff_name:'박영업',staff_id:8,
    category_name:'숙박',amount_krw:15000,department_name:'과거 영업팀'};
  const list=approvalRecords([{...booking,status:'completed'},{...booking,id:8,status:'cancelled',driver_staff_id:9},
    {...booking,id:9,status:'planned',can_review:false},{...booking,id:10,status:'planned',approval_required:false}],
    [spend,{...spend,id:100,can_review:false}],[{id:8,department_id:3,department:'영업'}]);
  assert.deepEqual(list.map(row=>row.key),['expense:7','reservation:8','reservation:7']);
  assert.deepEqual(list.map(row=>row.status),['approved','cancelled','approved']);
  assert.equal(list[1].departmentKey,'unknown');
  const only=filterApprovals(list,{status:'approved',person:'8',department:'name:과거 영업팀',query:'박영업 숙박'});
  assert.deepEqual(only.map(row=>row.key),['expense:7']);
  const report=approvalReport(only,{from:'2026-11-01',to:'2026-11-30'}),csv=reportCsv(report);
  assert.match(csv,/숙박/);assert.match(csv,/승인 완료/);assert.doesNotMatch(csv,/고객 방문|can_review|cancelled/);
  assert.equal(report.rows.length,1);
});

test('desktop approval titles lead with the visit place',()=>{
 const base={id:1,created_at:'2026-11-01T10:00:00Z',can_review:true,approval_required:true,status:'pending',starts_at:'2026-11-02T01:00:00Z',ends_at:'2026-11-02T02:00:00Z'};
 const titles=opts=>approvalRecords([{...base,purpose:'A사 본사',company_purpose_name:'영업'},{...base,id:2,company_purpose_name:'영업'},{...base,id:3}],[],[],opts).map(row=>row.title).sort();
 assert.deepEqual(titles({visitTitle:true}),['A사 본사','영업','차량 예약']);
 assert.deepEqual(titles(),['영업','영업','차량 예약']);
});
