import test from 'node:test';
import assert from 'node:assert/strict';
import { addBusinessDays, boardDays, rentalOnDay, validPosition, tripCompleteness } from '../src/lib/businessWorkspace.js';

test('dispatch board rolls over year/month in KST without host timezone drift', () => {
  assert.equal(addBusinessDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(boardDays('2026-02-26'), ['2026-02-26','2026-02-27','2026-02-28','2026-03-01','2026-03-02','2026-03-03','2026-03-04']);
});
test('midnight return, cancelled contract and overdue occupancy have distinct semantics', () => {
  const now = Date.parse('2026-10-15T12:00:00+09:00');
  const c = { status:'returned', starts_at:'2026-10-12T23:00:00+09:00', ends_at:'2026-10-14T00:00:00+09:00' };
  assert.equal(rentalOnDay(c,'2026-10-13',now),true);
  assert.equal(rentalOnDay(c,'2026-10-14',now),false);
  assert.equal(rentalOnDay({...c,status:'cancelled'},'2026-10-13',now),false);
  assert.equal(rentalOnDay({...c,status:'active'},'2026-10-15',now),true);
  assert.equal(rentalOnDay({...c,status:'active'},'2026-10-16',now),false);
  assert.equal(rentalOnDay({...c,status:'draft'},'2026-10-15',now),false);
});
test('location preview never coerces unknown coordinates to the ocean', () => {
  for (const [lat,lng] of [[null,127],[37,null],[undefined,127],[0,0],[91,127],[37,181],['bad',127],['',127],[false,127]]) assert.equal(validPosition({last_lat:lat,last_lng:lng}),false);
  assert.equal(validPosition({last_lat:37.5,last_lng:127}),true);
});
test('log completeness requires both purpose and driver; fuel excludes missing values', () => {
  assert.equal(tripCompleteness([]).percent,null);
  const result = tripCompleteness([{annotation:{purpose:'business',driver_staff_id:1,fuel_cost:50000}}, {annotation:{purpose:'commute',driver_staff_id:2,fuel_cost:0}}, {annotation:{purpose:'unspecified',driver_staff_id:1}}, {}]);
  assert.deepEqual(result,{total:4,complete:2,percent:50,missingPurpose:2,missingDriver:1,fuelEntries:2,fuelCost:50000});
});
