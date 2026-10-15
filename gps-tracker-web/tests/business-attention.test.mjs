import test from 'node:test';
import assert from 'node:assert/strict';
import { rentalAttention, upcomingReservation, RENTAL_SIGNAL_DELAY_MS } from '../src/lib/businessAttention.js';
import { computeSettlementPreview, validateReturn, returnPayload } from '../src/lib/rentalReturn.js';

const now = Date.parse('2026-10-15T12:00:00+09:00');
const contract = { id: 1, device_id: 1, status: 'active', starts_at: '2026-10-14T12:00:00+09:00', ends_at: '2026-10-15T11:00:00+09:00', rate_type: 'daily', rate_amount_krw: 24000, deposit_krw: 50000, pickup_odometer_km: 10000, included_km_per_day: 100, over_km_price_krw: 200 };
const form = { returnedAt: '2026-10-15T12:00:00+09:00', odometer: '10120', extraFee: '', extraLabel: '', location: ' 본사 ', note: '' };

test('rental attention prioritizes overdue returns, deduplicates signal alerts, ignores fresh GPS failures', () => {
  const devices = [{ id:1,last_seen_at:new Date(now-RENTAL_SIGNAL_DELAY_MS).toISOString(),next_service_date:'2026-10-14' }, {id:2,last_seen_at:new Date(now).toISOString(),last_fix_at:'2026-01-01T00:00:00Z'}, {id:3,enabled:false}, {id:4}];
  const rows = [contract,{...contract,id:2},{...contract,id:3,device_id:2},{...contract,id:4,device_id:3},{...contract,id:5,device_id:4,starts_at:'2026-10-16T00:00:00+09:00',ends_at:'2026-10-17T00:00:00+09:00'}];
  const tasks = rentalAttention(rows,devices,now);
  assert.equal(tasks[0].label,'반납 지연');
  assert.deepEqual(tasks.filter(t=>t.category==='signal').map(t=>t.device.id),[1]);
  assert.equal(tasks.filter(t=>t.category==='maintenance').length,1);
  assert.ok(tasks.findIndex(t=>t.category==='signal') < tasks.findIndex(t=>t.category==='maintenance'));
});
test('missing signal only becomes a task while actually rented; reconnect clears it', () => {
  assert.equal(rentalAttention([contract],[{id:1}],now).filter(t=>t.category==='signal').length,1);
  for (const status of ['returned','cancelled','draft']) assert.equal(rentalAttention([{...contract,status}],[{id:1}],now).filter(t=>t.category==='signal').length,0);
  assert.equal(rentalAttention([contract],[{id:1,last_seen_at:new Date(now-RENTAL_SIGNAL_DELAY_MS+1).toISOString()}],now).filter(t=>t.category==='signal').length,0);
});
test('next reservation is the earliest planned future booking, excluding cancellations and past bookings', () => {
  const first={id:2,status:'planned',starts_at:'2026-10-16T03:00:00Z'};
  assert.equal(upcomingReservation([{id:1,status:'cancelled',starts_at:'2026-10-15T04:00:00Z'}, {...first,id:3,starts_at:'2026-10-17T03:00:00Z'},first,{...first,id:4,starts_at:'2026-10-14T03:00:00Z'}],now).id,2);
  assert.equal(upcomingReservation([],now),null);
});
test('settlement preview mirrors server rounding at partial hour/day/month boundaries', () => {
  const calculate=(c,at=c.ends_at)=>computeSettlementPreview(c,{returnedAt:new Date(at),returnOdometerKm:null,extraFeeKrw:0});
  const starts_at='2026-10-01T00:00:00Z';
  assert.equal(calculate({...contract,starts_at,ends_at:'2026-10-02T00:59:59Z'}).subtotal,24000);
  assert.equal(calculate({...contract,starts_at,ends_at:'2026-10-02T01:00:00Z'}).subtotal,48000);
  assert.equal(calculate({...contract,rate_type:'hourly',starts_at,ends_at:'2026-10-01T01:00:59Z'}).subtotal,24000);
  assert.equal(calculate({...contract,rate_type:'monthly',starts_at,ends_at:'2026-10-31T23:59:59Z'}).subtotal,24000);
  assert.equal(calculate(contract,'2026-10-15T11:00:59+09:00').lines.some(l=>l.kind==='late'),false);
  assert.equal(calculate(contract,'2026-10-15T11:01:00+09:00').subtotal,25500);
});
test('return preview distinguishes extra mileage, manual fees, refund and additional charge', () => {
  const result=computeSettlementPreview(contract,{returnedAt:new Date(form.returnedAt),returnOdometerKm:10120,extraFeeKrw:3000,extraLabel:'세차'});
  assert.equal(result.subtotal,32500); // 24000 + 4000km fee + 1500 late + 3000
  assert.equal(result.balance,17500);
  assert.equal(computeSettlementPreview({...contract,deposit_krw:0},{returnedAt:new Date(form.returnedAt),returnOdometerKm:null,extraFeeKrw:0}).balance,-25500);
});
test('return validation rejects invalid times, decreasing/decimal odometer and unexplained charges', () => {
  assert.deepEqual(validateReturn(contract,form,now),{information:'',charges:''});
  for (const returnedAt of ['', 'bad', '2026-10-14T00:00:00Z','2026-10-16T00:00:00Z']) assert.ok(validateReturn(contract,{...form,returnedAt},now).information);
  for (const odometer of ['9999','-1','10100.5','NaN','2147483648']) assert.ok(validateReturn(contract,{...form,odometer},now).information);
  for (const extraFee of ['1.5','Infinity','1000']) assert.ok(validateReturn(contract,{...form,extraFee},now).charges);
  assert.equal(validateReturn(contract,{...form,extraFee:'-1000',extraLabel:'할인'},now).charges,'');
  assert.deepEqual(returnPayload(form),{returned_at:'2026-10-15T03:00:00.000Z',return_odometer_km:10120,return_location:'본사',extra_fee_krw:null,extra_fee_label:null,note:null});
});
