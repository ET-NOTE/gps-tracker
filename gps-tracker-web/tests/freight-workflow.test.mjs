import test from 'node:test';
import assert from 'node:assert/strict';
import {makeOrder,candidate,assign,shipAction,stamp,inputTime,weekOf,addDays,matchRate,moneyValue} from '../src/lib/freightWorkflow.js';
import {freightHeaders,importOrders} from '../src/lib/freightCsv.js';

function fixture(){
  const d={branches:[{id:'b',name:'본점'}],shippers:[{id:'h',name:'화주',active:true}],locations:[{id:'a',name:'창고',region:'서울'},{id:'z',name:'도착지',region:'부산'}],
    vehicles:[{id:'v',plate:'테스트',type:'탑차',driverId:'off',capacityKg:1000,readiness:'ready',carrierId:''}],
    drivers:[{id:'off',name:'휴무',availability:'off',active:true,licenseChecked:true},{id:'d',name:'기사',availability:'available',active:true,licenseChecked:true}],
    rates:[],services:[],incidents:[],payments:[],shipments:[],orders:[],activity:[],carriers:[],codes:{units:['박스'],vehicleTypes:['탑차','카고']},policies:{bufferMinutes:30,requireDriverCheck:true,ownAutoConfirm:false}};
  const o={shipperId:'h',branchId:'b',pickupLocationId:'a',dropoffLocationId:'z',start:'2099-08-01T09:00',end:'2099-08-01T12:00',unit:'박스',quantity:2,weightKg:50,capacityKg:50,
    vehicleType:'탑차',cargoName:'상자',temperature:'상온',tripType:'편도',mixedAllowed:false,sellAmount:0,buyAmount:null,note:'',externalRef:'REF'};
  return {d,o};
}
const decision={vehicleId:'v',driverId:'d',sellAmount:0,buyAmount:null,note:''};
test('order, acceptance, loading and delivery keep order linkage, history and quoted zero',()=>{
  const {d,o}=fixture(),order=makeOrder(d,o);
  assert.throws(()=>makeOrder(d,{...o,externalRef:'ref'}),/중복|이미/);
  const pair=candidate(d,o,d.vehicles[0]);assert.equal(pair.reason,'');assert.equal(pair.driver.id,'d');
  const s=assign(d,order,decision);
  assert.equal(s.status,'requested');assert.equal(order.shipmentId,s.id);assert.equal(s.sellAmount,0);assert.equal(s.buyAmount,null);
  assert.throws(()=>shipAction(d,s,'loaded',{note:''}),/단계/);
  shipAction(d,s,'accept',{note:'수락'});shipAction(d,s,'arrived',{note:'현장 도착'});
  shipAction(d,s,'loaded',{note:'상차 완료'});shipAction(d,s,'delivered',{note:'도착'});
  assert.deepEqual(s.events.map(e=>e.type),['requested','confirmed','arrived','loaded','delivered']);
  assert.equal(s.status,'delivered');assert.equal(order.status,'completed');assert.equal(s.proof.status,'missing');
});
test('vehicle, driver, maintenance and buffer conflicts; cancellation releases a time slot',()=>{
  const {d,o}=fixture(),order=makeOrder(d,o);const s=assign(d,order,decision);
  const later={...o,start:'2099-08-01T12:29',end:'2099-08-01T13:30'};
  assert.match(candidate(d,later,d.vehicles[0]).reason,/중복/);
  assert.equal(candidate(d,{...later,start:'2099-08-01T12:30'},d.vehicles[0]).reason,'');
  assert.throws(()=>shipAction(d,s,'release',{note:''}),/사유/);
  shipAction(d,s,'decline',{note:'기사 휴무'});assert.equal(order.status,'open');assert.equal(order.shipmentId,'');
  d.services.push({vehicleId:'v',status:'scheduled',start:o.start,end:o.end});assert.match(candidate(d,o,d.vehicles[0]).reason,/관리 일정/);
  d.services[0].status='done';d.incidents.push({vehicleId:'v',status:'open',type:'지연',vehicleBlocked:true});assert.match(candidate(d,o,d.vehicles[0]).reason,/운행 제한/);
  d.incidents[0].status='resolved';assert.equal(candidate(d,o,d.vehicles[0]).reason,'');
  d.policies.ownAutoConfirm=true;assert.equal(assign(d,order,decision).status,'confirmed');
});
test('CSV preserves quoted fields and reports a per-row error for a duplicated external number',()=>{
  const {d}=fixture();
  const row=['ext01','화주','본점','창고','도착지','2099-08-01 09:00','2099-08-01 12:00','"식품, 포장"','3','박스','50','탑차','50','0','','"첫 줄\r\n둘째 줄"'].join(',');
  const csv='\uFEFF'+freightHeaders.join(',')+'\r\n'+row;
  importOrders(d,csv);assert.equal(d.orders[0].cargoName,'식품, 포장');assert.match(d.orders[0].note,/둘째 줄/);assert.equal(d.orders[0].buyAmount,null);
  assert.throws(()=>importOrders(d,csv),/2행.*이미/);
  assert.throws(()=>importOrders(d,'열이 다름'),/머리글/);
});
test('KST week, rate and amount calculations allow zero-priced transport and choose sufficient capacity',()=>{
  const {d,o}=fixture();
  assert.equal(inputTime('2026-11-19T15:30:00Z'),'2026-11-20T00:30');
  assert.equal(weekOf('2026-11-22'),'2026-11-16');assert.equal(addDays('2026-12-31',1),'2027-01-01');
  d.rates=[50,10,100].map(capacityKg=>({pickupRegion:'서울',dropoffRegion:'부산',vehicleType:'탑차',capacityKg,active:true}));
  assert.equal(matchRate(d,o).capacityKg,50);assert.equal(moneyValue('0'),0);assert.equal(moneyValue(''),null);
  assert.throws(()=>moneyValue(-1));assert.match(stamp(),/T\d\d:\d\d$/);
});
