import test from 'node:test';
import assert from 'node:assert/strict';
import { agreementTotal, needsContractReconfirmation, workflowRows, workflowStatus } from '../src/lib/rentalWorkflow.js';
import { computeSettlementPreview } from '../src/lib/rentalReturn.js';
import { matchesVehicle, rentalInventory } from '../src/lib/rentalInventory.js';
import { rentalSummary } from '../src/lib/business.js';
import { rentalAttention } from '../src/lib/businessAttention.js';

test('같은 예약의 기존 계약 확인이 실제로 해제됐을 때 재확인을 안내한다',()=>{
  const confirmed={id:1,status:'draft',rental_terms:{confirmed_at:'2026-11-19T01:00:00Z'}};
  const changed={...confirmed,rental_terms:{confirmed_at:null}};
  assert.equal(needsContractReconfirmation(confirmed,changed),true);
  assert.equal(needsContractReconfirmation(confirmed,{...confirmed,note:'메모 변경'}),false);
  assert.equal(needsContractReconfirmation(changed,changed),false);
  assert.equal(needsContractReconfirmation(null,changed),false);
  assert.equal(needsContractReconfirmation(confirmed,{...changed,id:2}),false);
  assert.equal(needsContractReconfirmation(confirmed,{...changed,status:'cancelled'}),false);
});

const booking = {id:1, status:'draft', device_id:null, starts_at:'2026-11-18T14:30:00Z', ends_at:'2026-11-19T14:31:00Z', renter_name:'고객',
  rate_type:'daily', rate_amount_krw:50000, rental_terms:{requested_model:'경차', driver_name:'실운전자',late_hourly:1200}};
const now = Date.parse('2026-11-18T15:00:00Z');
test('차량 번호와 단말기 ID가 겹쳐도 단말기 없는 실제 배차를 별도 차량으로 집계한다',()=>{
  const assets=rentalInventory([{id:7,device_id:null,plate:'검수 1',model:'경차'},{id:20,device_id:7,plate:'검수 2',model:'경차'}],[{id:7}]);
  const active={...booking,status:'active',vehicle_id:7,device_id:null};
  assert.equal(matchesVehicle(active,assets[1]),false);
  assert.equal(matchesVehicle({device_id:7},assets[0]),false);
  assert.equal(matchesVehicle({device_id:7},assets[1]),true);
  assert.deepEqual([...rentalSummary([active],assets,now).occupied],['7']);
  assert.equal(rentalAttention([active],assets,now).some(item=>item.category==='signal'),false);
});
test('고정 합의금은 기간·초과 거리로 재계산하지 않고 반납금과 연장금을 한 번씩 더한다',()=>{
  const fixed={...booking,pickup_odometer_km:100,included_km_per_day:0,over_km_price_krw:200,
    rental_terms:{pricing:{mode:'agreed',base_krw:90000,option_krw:20000,discount_krw:10000,extension_krw:12000}}};
  assert.equal(agreementTotal(fixed),112000);
  const preview=computeSettlementPreview(fixed,{returnOdometerKm:500,returnedAt:Date.parse(fixed.ends_at)+5*86400000,extraFeeKrw:8000,extraLabel:'연료'});
  assert.equal(preview.subtotal,120000);
  assert.equal(workflowStatus({...fixed,status:'returned'},now),'반납 완료');
  assert.equal(workflowStatus({...fixed,status:'returned',settled_at:fixed.ends_at},now),'정산 완료');
});
test('미방문과 취소 및 계약 확인 여부를 각각 필터링한다',()=>{
  const noShow={...booking,status:'cancelled',rental_terms:{cancel_outcome:'no_show'}};
  const cancelled={...booking,status:'cancelled',rental_terms:null};
  const confirmed={...booking,rental_terms:{confirmed_at:'2026-11-18T20:00:00Z'}};
  assert.deepEqual(workflowRows([noShow,cancelled],'reservations',{status:'미방문'},now),[noShow]);
  assert.deepEqual(workflowRows([noShow,cancelled],'reservations',{status:'취소'},now),[cancelled]);
  assert.deepEqual(workflowRows([confirmed,booking],'contracts',{review:'no'},now),[booking]);
  assert.deepEqual(workflowRows([confirmed,booking],'contracts',{review:'yes'},now),[confirmed]);
});
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
