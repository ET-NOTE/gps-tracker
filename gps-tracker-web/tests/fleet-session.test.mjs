import test from 'node:test';
import assert from 'node:assert/strict';
import {setFleetOwner,fleetRequestScope,rememberFleetOwner,preferredFleetOwner} from '../src/lib/fleetSession.js';
const values=new Map([['access_token','test'],['auth_session','a']]);
globalThis.localStorage={getItem:k=>values.get(k)||null};
globalThis.sessionStorage={getItem:()=>null};
test('company header is limited to corporate and private asset documents',()=>{
 setFleetOwner(12);
 for(const path of ['/corporate/vehicles','/corporate/vehicles/1/photo','/documents/2/download'])assert.equal(fleetRequestScope('/api/v1'+path).owner,12);
 for(const path of ['/devices','/auth/me','/rentcar/contracts','/corporate/workspaces','/corporate/join'])assert.equal(fleetRequestScope('/api/v1'+path).owner,null);
});
test('company switch and exit reject late reads, while personal requests survive',()=>{
 setFleetOwner(12);const a=fleetRequestScope('/api/v1/corporate/vehicles'),p=fleetRequestScope('/api/v1/devices');
 setFleetOwner(13);assert.throws(()=>a.assert(),{name:'AbortError'});p.assert();
 const b=fleetRequestScope('/api/v1/documents/1/download');setFleetOwner(null);assert.throws(()=>b.assert(),{name:'AbortError'});
 assert.equal(fleetRequestScope('/api/v1/corporate/vehicles').owner,null);
});
test('preferred company belongs to the login session',()=>{
 rememberFleetOwner(12);assert.equal(preferredFleetOwner(),12);values.set('auth_session','b');assert.equal(preferredFleetOwner(),null);
});
