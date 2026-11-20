import test from 'node:test';
import assert from 'node:assert/strict';
import {freightReport} from '../src/lib/freightReports.js';
import {freightMenu,freightPages} from '../src/lib/freightMenu.js';
import {dashboardView,routeAccess} from '../src/lib/dashboardRoutes.js';

const vehicle={id:'v',branchId:'west',carrierId:'',plate:'QA-01'};
const run={id:'s',number:'1',vehicleId:'v',orderIds:['o'],branchId:'west',carrierId:'',start:'2026-11-01T01:00',end:'2026-11-02T00:30',status:'delivered',sellAmount:100,buyAmount:60};
const data={vehicles:[vehicle],orders:[{id:'o',shipperId:'sender'}],shippers:[{id:'sender',name:'화주'}],carriers:[],
  shipments:[run,{...run,id:'early',start:'2026-10-31T16:00:00+09:00',end:'2026-11-01T10:00'},
    {...run,id:'unknown',number:'2',sellAmount:null},{...run,id:'cancel',status:'cancelled',sellAmount:999}],
  payments:[],charges:[{id:'c',shipmentId:'s',status:'approved',sellAmount:10,buyAmount:5,companyCost:3}],
  services:[{vehicleId:'v',start:'2026-11-01T10:00',status:'done',cost:50}]};
const filter={start:'2026-11-01',end:'2026-11-02',branch:'west',carrier:''};
test('freight reports respect Korea dates, agreed amounts, company costs and unique assigned days',()=>{
  const r=freightReport(data,filter);
  assert.equal(r.dayCount,2);assert.equal(r.totals.margin,42);assert.equal(r.totals.sell,110);assert.equal(r.totals.buy,125);
  assert.equal(r.totals.known,1);assert.equal(r.groups[0].count,2);assert.equal(r.totals.delivered,2);
  assert.deepEqual(r.utilization[0],{id:'v',plate:'QA-01',count:3,days:2,ratio:100,cost:50});
  assert.ok(freightReport(data,{...filter,start:'2026-11-03'}).error);
  assert.ok(freightReport(data,{...filter,start:'2025-10-31'}).error);
  assert.equal(freightReport(data,{...filter,branch:'east'}).shipments.length,0);
});
test('both delivery entries share the account gate and every reference menu has one route',()=>{
  assert.equal(dashboardView('/delivery'),'delivery');assert.equal(dashboardView('/cargo/'),'delivery');
  assert.equal(routeAccess('delivery',{},'delivery'),true);assert.equal(routeAccess('delivery',{},'rentcar'),false);
  assert.equal(freightPages.size,freightMenu.flatMap(g=>g.pages).length);assert.equal(freightPages.size,30);
});
