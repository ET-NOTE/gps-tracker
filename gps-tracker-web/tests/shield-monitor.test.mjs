import test from 'node:test';
import assert from 'node:assert/strict';
import { createShieldMonitorController } from '../src/lib/shieldMonitorController.js';

const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a;reject=b; }); return {promise,resolve,reject}; };
const report = id => ({ device_uid:`uno-shield-${id}`, server_now:'2026-09-28T04:00:00Z',items:[] });
const devices = [{id:1},{id:2}];
const tick = () => new Promise(r => setImmediate(r));

test('switching devices clears the previous data and discards a late response', async () => {
  const old=deferred(); let state;
  const c=createShieldMonitorController({getScope:()=> 'account-a',api:{listShieldDevices:async()=>devices,getShieldStatus:id=>id===1?old.promise:Promise.resolve(report(2))},onChange:s=>state=s});
  const first=c.refreshDevices();await tick();await c.select(2);
  assert.equal(state.data.device_uid,'uno-shield-2');
  old.resolve(report(1));await first;
  assert.equal(state.selectedId,2);assert.equal(state.data.device_uid,'uno-shield-2');
});

test('logout clears private data immediately and late private data cannot replace public status', async () => {
  let scope='account-a',state;const old=deferred();
  const c=createShieldMonitorController({getScope:()=>scope,api:{listShieldDevices:async()=>devices,getShieldStatus:()=>old.promise},fetchPublic:async()=>report('public'),onChange:s=>state=s});
  const first=c.refreshDevices();await tick();scope='anonymous';const logout=c.refreshDevices();
  assert.equal(state.data,null);assert.deepEqual(state.devices,[]);
  await logout;old.resolve(report(1));await first;
  assert.equal(state.mode,'public');assert.equal(state.data.device_uid,'uno-shield-public');
});

test('ownership loss clears both stale status and export data', async () => {
  let state,denied=false;
  const c=createShieldMonitorController({getScope:()=> 'account-a',api:{listShieldDevices:async()=>devices,getShieldStatus:async()=>{if(denied)throw {status:404};return report(1);}},onChange:s=>state=s});
  await c.refreshDevices();denied=true;await c.refresh();
  assert.equal(state.data,null);assert.equal(state.selectedId,null);assert.ok(state.error);
  assert.deepEqual(state.devices,[{id:2}]);
});

test('list failure and an empty account never silently show a public or another account device', async () => {
  let state;const c=createShieldMonitorController({getScope:()=> 'account-a',api:{listShieldDevices:async()=>{throw new Error('network');}},fetchPublic:()=>assert.fail('public fallback'),onChange:s=>state=s});
  await c.refreshDevices();assert.equal(state.mode,'owned');assert.ok(state.error);assert.equal(state.data,null);
  const empty=createShieldMonitorController({getScope:()=> 'account-b',api:{listShieldDevices:async()=>[]},onChange:s=>state=s,preferredId:1});
  await empty.refreshDevices();assert.deepEqual(state.devices,[]);assert.equal(state.selectedId,null);assert.equal(state.error,null);
});

test('late inventory from a previous account and a disposed page are ignored', async () => {
  let state,scope='account-a';const old=deferred();
  const c=createShieldMonitorController({getScope:()=>scope,api:{listShieldDevices:()=>scope==='account-a'?old.promise:Promise.resolve([{id:2}]),getShieldStatus:async id=>report(id)},onChange:s=>state=s});
  const first=c.refreshDevices();scope='account-b';await c.refreshDevices();old.resolve([{id:1}]);await first;
  assert.equal(state.selectedId,2);assert.equal(state.data.device_uid,'uno-shield-2');
  c.dispose();const snapshot=state;await c.refreshDevices();assert.equal(state,snapshot);
});
