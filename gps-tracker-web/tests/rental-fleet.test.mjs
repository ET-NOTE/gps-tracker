import test from 'node:test';
import assert from 'node:assert/strict';
import { vehicleReadiness, workState, fleetDashboard, fleetWorkOnDay } from '../src/lib/rentalFleet.js';

const now = Date.parse('2026-11-20T00:15:00+09:00');
const device = { id: 10, enabled: true }, empty = { occupied: new Set() };
const service = { device_id: 10, kind: 'cleaning', starts_at: new Date(now - 3600000).toISOString(), ends_at: new Date(now + 3600000).toISOString() };
test('dispatch week uses Korean midnight and releases service and incident blocks at their effective end', () => {
  const overnight = {...service, starts_at:'2026-12-31T23:00:00+09:00', ends_at:'2027-01-02T00:00:00+09:00'};
  assert.equal(fleetWorkOnDay(overnight,'2027-01-01'),true);
  assert.equal(fleetWorkOnDay(overnight,'2027-01-02'),false);
  assert.equal(fleetWorkOnDay({...overnight,closed_at:'2027-01-01T00:00:00+09:00'},'2027-01-01'),false);
  assert.equal(fleetWorkOnDay({...overnight,status:'cancelled'},'2026-12-31'),false);
  const incident = {...overnight,kind:'breakdown',closed_at:overnight.ends_at};
  assert.equal(fleetWorkOnDay(incident,'2027-01-03'),true);
  assert.equal(fleetWorkOnDay({...incident,inspection_released_at:'2027-01-03T00:00:00+09:00'},'2027-01-03'),false);
});
test('incident resolution keeps the hold until explicit inspection, including when other tasks overlap', () => {
  const report = { device_id: 10, kind: 'breakdown', starts_at: service.starts_at };
  const reviewed = { ...report, closed_at: service.starts_at };
  const released = { ...reviewed, inspection_released_at: service.starts_at };
  assert.equal(workState(reviewed),'review');
  for (const item of [report,reviewed]) assert.equal(vehicleReadiness(device,[item,service],empty,now).code,'hold');
  assert.equal(vehicleReadiness(device,[released,service],empty,now).code,'service');
  assert.equal(vehicleReadiness(device,[released,{...service,closed_at:service.starts_at}],empty,now).code,'ready');
  assert.equal(vehicleReadiness(device,[{...service,kind:'inspection',ends_at:null,return_inspection:true}],empty,now).code,'service');
  assert.equal(vehicleReadiness({...device,rental_profile:{readiness:'hold'}},[],empty,now).code,'hold');
});

test('daily timeline uses actual checkout and return in Korea and omits cancelled bookings', () => {
  const base = { id:1, device_id:10, status:'returned', starts_at:'2026-11-19T23:50:00+09:00',
    ends_at:'2026-11-21T18:00:00+09:00', rental_terms:{checkout_at:'2026-11-20T00:01:00+09:00'},returned_at:'2026-11-20T00:12:00+09:00' };
  const d = fleetDashboard([base,{...base,id:2,status:'cancelled'}],[device],[],now);
  assert.deepEqual(d.timeline.map(e=>e.type),['출고','반납']);
  assert.equal(d.trend.length,7); assert.equal(d.trend.at(-1).count,1); assert.equal(d.trend.at(-2).count,0);
  assert.equal(d.actions.find(r=>r.key==='return').rows.length,0);
});

test('handover before scheduled pickup occupies the vehicle immediately', () => {
  const contract={id:1,device_id:10,status:'active',starts_at:new Date(now + 3600000).toISOString(),ends_at:new Date(now+86400000).toISOString()};
  const result=fleetDashboard([{...contract,rental_terms:{checkout_at:new Date(now-10000).toISOString()}}],[device],[],now);
  assert.equal(result.summary.occupied.size,1);assert.equal(result.counts.active,1);
  assert.equal(fleetDashboard([contract],[device],[],now).summary.occupied.size,0);
});
