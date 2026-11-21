import test from 'node:test';
import assert from 'node:assert/strict';
import {dailyFigures,fillTemplate,initialPeriod,kstDay,matchOfficeCustomer,outstandingReturns,periodOk,recordLimit,returnReadingsRange,suggestedRecordAmount,vehicleUsage} from '../src/lib/rentalOffice.js';

test('usage includes complete odometer deltas for actual KST returns, distinguishing zero, missing and unrelated readings',()=>{
  const period={from:'2026-11-20',to:'2026-11-20'},begin='2026-09-01T00:00:00+09:00',day='2026-11-20T00:00:00+09:00';
  const contract={vehicle_id:12,status:'returned',starts_at:begin,ends_at:'2026-09-02T00:00:00+09:00',returned_at:day};
  const contracts=[1,2,3,4,5,6].map(id=>({...contract,id}));
  contracts[4].returned_at='2026-11-21T00:00:00+09:00';contracts[5].status='active';
  assert.equal(returnReadingsRange(contracts,period).from,new Date(begin).toISOString());
  assert.equal(returnReadingsRange([contracts[4],contracts[5]],period),null);
  const readings=[[1,100,160],[2,160,160],[3,180,150],[4,null,200],[5,120,300],[6,0,60]].map(([id,pickup_odometer_km,return_odometer_km])=>({id,pickup_odometer_km,return_odometer_km}));
  const [v]=vehicleUsage({contracts,entries:[],costs:[]},[{id:12,vehicle_id:12}],period,Date.parse('2026-11-25'),{readings});
  assert.deepEqual([v.distance,v.measured,v.missing],[60,2,2]);
});

test('overlapping completed service and outstanding service schedules are clipped and aggregated separately',()=>{
  const period={from:'2026-11-20',to:'2026-11-20'};
  const job=(kind,starts_at,ends_at,closed_at=null)=>({vehicle_id:12,kind,starts_at,ends_at,closed_at});
  const at=h=>'2026-11-20T'+h+':00:00+09:00';
  const work=[job('maintenance','2026-11-19T23:00:00+09:00',at('03'),at('04')),job('inspection',at('03'),at('05'),at('06')),
    job('cleaning',at('07'),at('09')),job('maintenance',at('08'),at('11')),job('accident',at('01'),null,at('09'))];
  const [v]=vehicleUsage({contracts:[],entries:[],costs:[]},[{id:12}],period,Date.parse(at('12')),{work});
  assert.equal(v.completedHours,6);assert.equal(v.scheduledHours,4);
});

test('refund queue distinguishes overpaid fees and deposits due after a return or cancellation',()=>{
  const contract={id:1,status:'active',billed_krw:50000,paid_krw:50000,held_krw:8000};
  const rows=outstandingReturns([contract,{...contract,id:2,paid_krw:52000},
    {...contract,id:3,status:'returned',settlement_finalized:true},{...contract,id:4,status:'cancelled',paid_krw:53000},
    {...contract,id:5,status:'cancelled',held_krw:0}]);
  assert.deepEqual(rows.map(({id,excess,deposit})=>[id,excess,deposit]),[[2,2000,0],[3,0,8000],[4,3000,8000]]);
});

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
  const noShow={...c,status:'cancelled',cancel_outcome:'no_show',cancellation_fee_krw:15000,billed_krw:15000};
  assert.deepEqual(['payment','refund','deposit_in','deposit_out'].map(k=>recordLimit(noShow,k)),[3000,12000,0,8000]);
  assert.equal(suggestedRecordAmount({...noShow,paid_krw:20000},'refund'),5000);
  assert.deepEqual(['payment','refund','deposit_in','deposit_out'].map(k=>recordLimit({...c,settlement_finalized:true},k)),[0,0,12000,8000]);
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
