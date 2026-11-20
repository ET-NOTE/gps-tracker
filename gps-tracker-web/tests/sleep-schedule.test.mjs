import test from 'node:test';
import assert from 'node:assert/strict';
import {sleepReportDeadlineMs} from '../src/lib/sleepSchedule.js';
test('daily sleep reporting has modem grace and legacy firmware keeps its existing deadline',()=>{
 const base=24*3600000;
 for(const data of [undefined,{}, {timer_wake_enabled:true,timer_wake_s:600},{timer_wake_enabled:false,timer_wake_s:86400},{timer_wake_enabled:true,timer_wake_s:'86400'},{timer_wake_enabled:true,timer_wake_s:604801}])assert.equal(sleepReportDeadlineMs(data),base);
 assert.equal(sleepReportDeadlineMs({timer_wake_enabled:true,timer_wake_s:86400}),base+15*60000);
});
