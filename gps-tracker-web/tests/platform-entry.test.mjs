import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyOwnedDevices, internalDestination, memorableView, ownerServices, rememberView, startDestination } from '../src/lib/platformNavigation.js';

test('login keeps internal device and employee links, including query and hash', () => {
  for (const path of ['/cargo?page=staff-desk','/devices/pair?tutorial=1','/?device=17#map','/fleet?device=3']) assert.equal(internalDestination(path), path);
  for (const url of [null,'//outside.invalid','/\\outside.invalid','https://outside.invalid','/%2Foutside.invalid','/devices/../login','/start']) assert.equal(internalDestination(url), null);
});
test('legacy type is the default only until explicit activation preferences exist', () => {
  assert.deepEqual(ownerServices({account_type:'rentcar'}), ['rentcar']);
  assert.deepEqual(ownerServices({account_type:'rentcar',enabled_services:[]}), []);
  assert.equal(startDestination({start_route:'/cargo',enabled_services:['rentcar']},1), '/');
  assert.equal(startDestination({start_route:'/rentcar',enabled_services:['rentcar','delivery']},1), '/rentcar');
});
test('last page is account-specific and only stores navigation, including active staff pages', () => {
  const items = new Map();
  globalThis.localStorage = {getItem:key => items.get(key), setItem:(key,value) => items.set(key,value)};
  try {
    const settings = {start_route:'last',enabled_services:[]};
    rememberView(1,'/cargo','?page=staff-desk');
    for (const path of ['/devices/pair','/admin','/start']) assert.equal(memorableView(path,''), null);
    rememberView(1,'/profile','?code=invitation');
    assert.equal(startDestination(settings,1,['delivery']), '/cargo?page=staff-desk');
    assert.equal(startDestination(settings,1), '/');
    assert.equal(startDestination(settings,2,['delivery']), '/');
  } finally { delete globalThis.localStorage; }
});
test('only owned device rows appear, with active vehicle bindings and device overrides', () => {
  const devices = [{id:1},{id:2,account_type_override:'unspecified'},{id:3,account_type_override:'rentcar'}];
  const assets = [{bindings:[{device_id:1},{device_id:2,ended_at:'2026-01-01'},{device_id:444}]}];
  const result = classifyOwnedDevices(devices,{account_type:'delivery'},assets,[{deviceId:1},{deviceId:714}]);
  assert.deepEqual(result.map(d=>[d.id,d.portalServices]),[[1,['corporate_fleet','delivery']],[2,[]],[3,['rentcar']]]);
});
