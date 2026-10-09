import test from 'node:test';
import assert from 'node:assert/strict';
import {businessDate, businessPeriod, rentalStatus, rentalSummary, filterRentals, maintenanceTasks} from '../src/lib/business.js';
const now = Date.parse('2026-10-08T15:30:00Z');
const devices = [{id:1}, {id:2}, {id:3,enabled:false}, {id:4}];
const c = (id,status,start,end,extra={}) => ({id,device_id:id,status,starts_at:start,ends_at:end,...extra});
const contracts = [
  c(1,'active','2026-04-01T00:00:00Z','2026-04-02T00:00:00Z'),
  c(2,'draft','2026-10-09T00:00:00Z','2026-10-09T08:00:00Z',{renter_name:'Kim'}),
  c(4,'active','2026-10-09T02:00:00Z','2026-10-09T10:00:00Z'),
  c(8,'returned','2026-08-01T00:00:00Z','2026-08-02T00:00:00Z',{settled_at:'2026-09-30T15:00:00Z',settled_amount_krw:150000}),
  c(9,'returned','2026-09-01T00:00:00Z','2026-09-02T00:00:00Z',{settled_at:'2026-09-30T14:59:59Z',settled_amount_krw:70000}),
];
test('business periods use Korean midnight and month, including UTC day boundary', () => {
  assert.equal(businessDate(now),'2026-10-09');
  const p=businessPeriod(now);
  assert.equal(p.from,'2026-10-01T00:00:00+09:00');
  assert.equal(p.todayEnd,'2026-10-09T15:00:00.000Z');
  assert.equal(businessDate('2026-12-31T15:00:00Z'),'2027-01-01');
});
test('old open contracts stay overdue; future active and draft do not occupy vehicles', () => {
  const s=rentalSummary(contracts,devices,now);
  assert.equal(rentalStatus(contracts[0],now),'overdue');
  assert.deepEqual([...s.occupied],['1']);
  assert.deepEqual(s.available.map(d=>d.id),[2,4]);
  assert.equal(s.todayPickups.length,2);
  assert.equal(s.todayReturns.length,1);
  assert.equal(s.revenue,150000);
});
test('search and status filters do not change summary data or mutate source contracts', () => {
  const before=rentalSummary(contracts,devices,now);
  assert.deepEqual(filterRentals(contracts,{query:'KIM',status:'active'},now).map(c=>c.id),[2]);
  assert.deepEqual(filterRentals(contracts,{status:'overdue'},now).map(c=>c.id),[1]);
  assert.deepEqual(filterRentals(contracts,{deviceId:'4'},now).map(c=>c.id),[4]);
  assert.deepEqual(rentalSummary(contracts,devices,now),before);
  assert.equal(contracts[0].status,'active');
});
test('maintenance includes overdue and next 30 days, ordered and separated by type', () => {
  const tasks=maintenanceTasks([{id:1,next_service_date:'2026-10-08',insurance_expiry:'2026-11-08',inspection_expiry:'2026-11-09'},{id:2,insurance_expiry:'2026-10-09'}],now);
  assert.deepEqual(tasks.map(t=>[t.device.id,t.field,t.overdue]),[[1,'next_service_date',true],[2,'insurance_expiry',false],[1,'insurance_expiry',false]]);
});
