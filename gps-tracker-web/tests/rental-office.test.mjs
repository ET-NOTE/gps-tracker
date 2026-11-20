import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyFigures,fillTemplate,initialPeriod,kstDay,matchOfficeCustomer,periodOk,recordLimit,vehicleUsage} from '../src/lib/rentalOffice.js';

test('Korean ledger dates separate rent fees, refunds and deposits',()=>{
  const book={entries:[
    {kind:'payment',recorded_at:'2026-11-19T15:00:00Z',amount_krw:50000},
    {kind:'deposit_in',recorded_at:'2026-11-19T15:30:00Z',amount_krw:30000},
    {kind:'refund',recorded_at:'2026-11-19T23:00:00Z',amount_krw:5000}
  ],costs:[{occurred_on:'2026-11-20',amount_krw:7500}]};
  assert.deepEqual(dailyFigures(book),[{id:'2026-11-20',payment:50000,refund:5000,cost:7500}]);
  assert.equal(kstDay('2026-11-19T14:59:59Z'),'2026-11-19');
  assert.ok(periodOk(initialPeriod()));
  assert.equal(periodOk({from:'2026-01-02',to:'2026-01-01'}),false);
});
test('contract payment and deposit ceilings remain independent including cancelled rentals',()=>{
  const c={status:'active',billed_krw:50000,paid_krw:12000,deposit_krw:20000,held_krw:8000};
  assert.deepEqual(['payment','refund','deposit_in','deposit_out'].map(k=>recordLimit(c,k)),[38000,12000,12000,8000]);
  assert.deepEqual(['payment','refund','deposit_in','deposit_out'].map(k=>recordLimit({...c,status:'cancelled'},k)),[0,12000,0,8000]);
});
test('actual overlapping rental hours are counted only once, clipped to KST window and today',()=>{
  const book={entries:[],costs:[],contracts:[
    {id:1,status:'returned',device_id:7,starts_at:'2026-11-19T14:00:00Z',ends_at:'2026-11-20T01:00:00Z',returned_at:'2026-11-20T00:00:00Z'},
    {id:2,status:'active',device_id:7,starts_at:'2026-11-19T23:00:00Z',ends_at:'2026-11-21T00:00:00Z'},
    {id:3,status:'draft',device_id:8,starts_at:'2026-11-19T15:00:00Z',ends_at:'2026-11-21T00:00:00Z'}]};
  const [used,idle]=vehicleUsage(book,[{id:7},{id:8}],{from:'2026-11-20',to:'2026-11-20'},Date.parse('2026-11-20T03:00:00Z'));
  assert.equal(used.hours,12);assert.equal(used.utilization,100);assert.equal(idle.hours,0);
});
test('customer history matches formatted phones; plain-text template uses real contract values',()=>{
  const c={id:17,renter_name:'고객 A',renter_phone:'010-1000-2020',billed_krw:50000};
  const cat={customers:[{name:'단골 고객',phone:'01010002020'}]};
  assert.equal(matchOfficeCustomer(c,cat).name,'단골 고객');
  assert.equal(fillTemplate('{{고객명}} / {{계약번호}} / {{대여요금}} / {{기타}}',c,'회사'),
    '고객 A / #17 / 50,000원 / {{기타}}');
});
