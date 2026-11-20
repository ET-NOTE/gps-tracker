import test from 'node:test';
import assert from 'node:assert/strict';
import { addPayment, confirmFinance, reviewCharge, saveCharge, setAgreement, shipmentFinance } from '../src/lib/freightFinance.js';
import { catalogInUse, finishService, linkTerminal, removeCatalog, restoreVehicle, saveCatalog } from '../src/lib/freightCatalog.js';
import { stamp } from '../src/lib/freightWorkflow.js';

function workspace() {
  return {
    codes:{vehicleTypes:['카고'],chargeTypes:['대기료']},policies:{bufferMinutes:10,requireDriverCheck:true,requireProofForBilling:true},
    drivers:[],vehicles:[],carriers:[],shippers:[],services:[],incidents:[],orders:[],recurring:[],payments:[],charges:[],activity:[],
    branches:[{id:'branch',name:'본점'}],shipments:[{id:'ship',vehicleId:'truck',status:'delivered',sellAmount:10000,buyAmount:7000,proof:{status:'approved'},invoiceStatus:'draft',payableStatus:'draft'}]
  };
}
test('additional approved charges reopen affected amounts and keep the existing payment history intact',()=>{
  const d=workspace(), s=d.shipments[0];
  confirmFinance(d,s,true,'검토');confirmFinance(d,s,false,'검토');
  const p={at:stamp(),amount:10000,side:'receipt',method:'계좌이체',note:''};
  addPayment(d,s,p);
  saveCharge(d,null,{shipmentId:'ship',kind:'대기료',sellAmount:600,buyAmount:0,companyCost:100,at:stamp(),note:'현장 대기'});
  assert.equal(shipmentFinance(d,s).sell,10000);
  reviewCharge(d,d.charges[0],'approved','');
  const result=shipmentFinance(d,s);
  assert.deepEqual([result.receivable,result.payable,result.margin],[600,7000,3500]);
  assert.equal(s.invoiceStatus,'draft');assert.equal(s.payableStatus,'confirmed');
  assert.throws(()=>addPayment(d,s,{...p,amount:601}));
  assert.throws(()=>addPayment(d,s,{...p,side:'receipt_refund',amount:300}));
  addPayment(d,s,{...p,side:'receipt_refund',amount:300,note:'반품 정산'});
  assert.equal(shipmentFinance(d,s).received,9700);
  assert.throws(()=>setAgreement(d,s,{sellAmount:'20000',buyAmount:'7000',reason:'변경'}));
  assert.throws(()=>reviewCharge(d,d.charges[0],'rejected','재심사'));
});
test('unagreed amounts remain unknown; cancelled shipping includes only approved extras',()=>{
  const d=workspace(),s=d.shipments[0];
  s.sellAmount=null;s.proof.status='submitted';
  assert.equal(shipmentFinance(d,s).sell,null);assert.throws(()=>confirmFinance(d,s,true,''));
  setAgreement(d,s,{sellAmount:'0',buyAmount:'',reason:'승인 대기'});
  assert.equal(shipmentFinance(d,s).sell,0);assert.equal(shipmentFinance(d,s).buy,null);
  assert.throws(()=>confirmFinance(d,s,true,''));
  s.status='cancelled';s.sellAmount=9000;
  assert.equal(shipmentFinance(d,s).sell,0);
});
test('one terminal per vehicle and ownership checks, maintenance preserves other holds',()=>{
  const d=workspace(),v={id:'truck',plate:'A',deviceId:'',manualHold:true,readiness:'hold'};d.vehicles=[v,{id:'second',plate:'B',deviceId:''}];
  const devices=[{id:12},{id:15}];
  linkTerminal(d,devices,12,'truck');assert.equal(v.deviceId,'12');
  assert.throws(()=>linkTerminal(d,devices,15,'truck'));assert.throws(()=>linkTerminal(d,devices,999,'second'));
  linkTerminal(d,devices,12,'second');assert.equal(v.deviceId,'');assert.equal(d.vehicles[1].deviceId,'12');
  const t=Date.now(),svc={vehicleId:'truck',type:'정비',start:stamp(t-60000),end:stamp(t+3600000),cost:0,note:''};
  const id=saveCatalog(d,'services',null,svc);assert.throws(()=>saveCatalog(d,'services',null,svc));
  finishService(d,id);assert.equal(v.readiness,'hold');assert.throws(()=>finishService(d,id));
  assert.equal(catalogInUse(d,'vehicles','truck'),true);assert.throws(()=>removeCatalog(d,'vehicles','truck'));
});
test('editing a vehicle while a non-accident incident blocks dispatch preserves automatic and manual holds separately',()=>{
  const d=workspace();
  const v={id:'truck',plate:'검수',model:'탑차',type:'카고',capacityKg:500,branchId:'branch',carrierId:'',driverId:'',odometer:10,insuranceUntil:'2028-01-01',inspectionAt:'2028-01-01',readiness:'hold',manualHold:false};
  d.vehicles.push(v);
  d.incidents.push({vehicleId:v.id,type:'지연',vehicleBlocked:true,status:'open'});
  saveCatalog(d,'vehicles',v.id,{...v,note:'정정'});assert.equal(v.manualHold,false);
  assert.throws(()=>saveCatalog(d,'vehicles',v.id,{...v,readiness:'ready'}));
  restoreVehicle(d,v.id);assert.equal(v.readiness,'hold');
  d.incidents[0].status='resolved';restoreVehicle(d,v.id);assert.equal(v.readiness,'ready');
  saveCatalog(d,'vehicles',v.id,{...v,readiness:'hold'});restoreVehicle(d,v.id);assert.equal(v.manualHold,true);assert.equal(v.readiness,'hold');
});
