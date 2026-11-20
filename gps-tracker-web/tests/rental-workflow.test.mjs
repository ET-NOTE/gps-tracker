import test from 'node:test';
import assert from 'node:assert/strict';
import { agreementTotal, workflowRows, workflowStatus } from '../src/lib/rentalWorkflow.js';
import { computeSettlementPreview } from '../src/lib/rentalReturn.js';

const booking = {id:1, status:'draft', device_id:null, starts_at:'2026-11-18T14:30:00Z', ends_at:'2026-11-19T14:31:00Z', renter_name:'고객',
  rate_type:'daily', rate_amount_krw:50000, rental_terms:{requested_model:'경차', driver_name:'실운전자',late_hourly:1200}};
const now = Date.parse('2026-11-18T15:00:00Z');
test('배차 전 예약은 운영 상태와 현지 날짜에 따라 검색된다',()=>{
  const active={...booking,id:2,device_id:7,status:'active'};
  assert.equal(workflowStatus(booking,now),'배차 대기');
  assert.deepEqual(workflowRows([booking,active],'checkout',{query:'실운전자',from:'2026-11-19',to:'2026-11-19'},now),[booking]);
  assert.deepEqual(workflowRows([booking,active],'reservations',{query:'경차',device:7},now),[active]);
  assert.deepEqual(workflowRows([booking,active],'returns',{},now),[active]);
});
test('요금표와 출고 정책 및 정산의 약정 요금 단위가 일치한다',()=>{
  assert.equal(agreementTotal(booking),50000);
  const returnedAt=new Date(Date.parse(booking.ends_at)+3600000);
  const preview=computeSettlementPreview(booking,{returnOdometerKm:null,returnedAt,extraFeeKrw:0});
  assert.equal(preview.subtotal,51200);
  assert.equal(preview.lines.find(l=>l.kind==='late').label.includes('1.5배'),false);
  assert.equal(computeSettlementPreview({...booking,rental_terms:null},{returnOdometerKm:null,returnedAt,extraFeeKrw:0}).subtotal,53125);
});
