import test from 'node:test';
import assert from 'node:assert/strict';
import {notificationDecisions,selectedAttention,recordedTripNotices} from '../src/lib/fleetNotifications.js';

const notices=[{category:'reservation',id:1,status:'planned'},{category:'trip',id:1,status:'completed'},
  {category:'expense',id:2,status:'rejected'},{category:'expense',id:3,status:'pending'}];
const alerts=[{id:'signal-3'},{id:'battery-4'},{id:'maintenance-7-inspection_expiry'}];

test('each in-app decision type follows the selected company and ignores unreviewed statuses',()=>{
  const policy={in_app:true,reservation:true,trip:false,expense:true};
  assert.deepEqual(notificationDecisions(notices,policy).map(row=>row.label),['예약 승인','지출 반려']);
  assert.deepEqual(notificationDecisions(notices,{...policy,trip:true,expense:false}).map(row=>row.label),['예약 승인','예약 차량 운행 완료']);
});
test('terminal and inspection reminders are independently selectable',()=>{
  assert.deepEqual(selectedAttention(alerts,{in_app:true,connection:true,maintenance:false}),alerts.slice(0,2));
  assert.deepEqual(selectedAttention(alerts,{in_app:true,connection:false,maintenance:true}),alerts.slice(2));
});
test('missing policy or disabled in-app channel shows no cached notices',()=>{
  for (const p of [null,{in_app:false,reservation:true,trip:true,expense:true,connection:true,maintenance:true}]) {
    assert.deepEqual(notificationDecisions(notices,p),[]);
    assert.deepEqual(selectedAttention(alerts,p),[]);
  }
});

test('GPS-derived alerts respect report quality, allocation periods and actual event times',()=>{
  const begin=Date.parse('2026-11-20T00:00:00+09:00'),until=begin+36000000;
  const dates={started_at:new Date(begin-60000).toISOString(),ended_at:new Date(begin+60000).toISOString()};
  const trips=[dates,{...dates,allocation_status:'boundary_review'},{...dates,quality:{report_included:false}},
    {started_at:new Date(begin+3600000).toISOString(),ended_at:null,quality:{status:'running'}}];
  assert.deepEqual(recordedTripNotices(trips,{id:2},begin,until).map(e=>e.label),['운행 시작','운행 종료']);
});
