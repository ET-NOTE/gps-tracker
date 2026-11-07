// Run on Windows: node --experimental-vm-modules ops/verify_dev_faults.mjs
// Exercises the actual frontend WebSocket client against dev using a separate synthetic device.
import { readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const root=path.join(process.env.LOCALAPPDATA,'GPS-DevSimulator');
const credentials=JSON.parse(await readFile(path.join(root,'login-private.json'),'utf8'));
assert.equal(credentials.email,'dev-simulator-20260924@example.invalid');
const base='https://dev-gps.serial.kr';
const api='/gps-tracker/api/v1';
let token;
async function request(endpoint,body,method=body?'POST':'GET') {
  const response=await fetch(base+endpoint,{method,redirect:'error',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:body?JSON.stringify(body):undefined});
  assert.equal(response.status,200,`${method} ${endpoint}: ${response.status}`);
  return response.json();
}
token=(await request(api+'/auth/login',{email:credentials.email,password:credentials.password,remember_me:false})).access_token;
const uid='dev-sim-fault-'+randomUUID();
await request('/gps-tracker/ingest',{device_uid:uid,l80:{fix:false,sat:0}});
const device=await request(api+'/devices/pair',{device_uid:uid,display_name:'GPS 통신 이상 검증'});
assert.ok(Number.isInteger(device.id));
const id=device.id, origin=Date.now()-180000;
const expected=new Set();let received=0,resyncs=0,connected=0,repaired=[];
let releaseConnected;
let connection=new Promise(resolve=>{releaseConnected=resolve;});
const eventWaiters=[];
const speedChecks=[]; let speedPoints=0; const observedPoints=new Map();
function waitForEvents(n) {
  if(received>=n)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(Error('Missing live events')),15000);
    eventWaiters.push(()=>{if(received<n)return false;clearTimeout(timeout);resolve();return true;});
  });
}
const pointPath=()=>api+`/devices/${id}/locations/page?`+new URLSearchParams({since:new Date(origin-10000).toISOString(),until:new Date(Date.now()+10000).toISOString(),limit:'5000'});
let repair=Promise.resolve();
const context=vm.createContext({WebSocket,window:new EventTarget(),document:{hidden:true},location:{protocol:'https:',hostname:'dev-gps.serial.kr',host:'dev-gps.serial.kr'},setTimeout,clearTimeout,console});
const module=new vm.SourceTextModule(await readFile(new URL('../gps-tracker-web/src/ws.js',import.meta.url),'utf8'),{context});
await module.link(spec=>{
  const exports=spec.includes('authSession')?{authScope:()=> 'synthetic-test',AUTH_CHANGED:'changed'}:
    spec.includes('chatBus')?{chatBus:{publish(){}}}:
    {activeStorage:()=>({getItem:()=>token}),tryRefresh:async()=> 'ok',isTokenExpiringSoon:()=>false};
  return new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
});
await module.evaluate();
const client=new module.namespace.TrackerWS(event=>{
  if(event.type==='location') {
    assert.equal(event.device_id,id);received++;
    if (event.fixes?.length) {
      for (const f of event.fixes) observedPoints.set(f.recorded_at,f);
      assert.equal(event.speed_kmh,[...event.fixes].sort((a,b)=>Date.parse(a.recorded_at)-Date.parse(b.recorded_at)).at(-1).speed_kmh);
      speedChecks.push(request(pointPath()).then(page=>{
        for (const f of event.fixes) {
          const p=page.items.find(p=>p.recorded_at===f.recorded_at && p.source===event.source);
          assert.ok(p);assert.equal(p.speed_source,'server_coordinate_v1');
          if(f.speed_kmh==null)assert.equal(p.speed_kmh,null);else assert.ok(Math.abs(p.speed_kmh-f.speed_kmh)<1e-4);
          assert.equal(p.reported_speed_kmh,null);speedPoints++;
        }
      }));
    }
    for(let i=eventWaiters.length-1;i>=0;i--)if(eventWaiters[i]())eventWaiters.splice(i,1);
  }
  if(event.type==='resync') {resyncs++;repair=request(pointPath()).then(page=>{repaired=page.items;});}
},status=>{if(status==='connected'){connected++;releaseConnected();}});
function payload(seconds,boot=1,baseTime=origin) {
  const now=Date.now();
  const fixes=seconds.map(s=>({lat:37+s*.00001,lng:127,sat:12,up_ms:s*1000,age_ms:Math.max(0,now-baseTime-s*1000)}));
  for(const s of seconds)expected.add(`${boot}:${s}`);
  return {device_uid:uid,boot,ts:Math.floor((now-baseTime)/1000),fixes,l80:{fix:true,lat:fixes.at(-1).lat,lng:127,sat:12}};
}
try {
  client.subscribe([id]);client.connect();await connection;
  await request('/gps-tracker/ingest',payload([100,102,104]));await waitForEvents(1);await Promise.all(speedChecks);
  await request('/gps-tracker/ingest',payload([100,102,104]));
  await request('/gps-tracker/ingest',payload([108,106,104]));await waitForEvents(2);await Promise.all(speedChecks);
  const newest=await request(api+`/devices/${id}/locations/latest`);
  await request('/gps-tracker/ingest',payload([96,98]));await waitForEvents(3);await Promise.all(speedChecks);
  assert.equal((await request(api+`/devices/${id}/locations/latest`)).recorded_at,newest.recorded_at);
  // A closed TCP/WebSocket session must resubscribe and repair the missed REST history.
  connection=new Promise(resolve=>{releaseConnected=resolve;});
  client.socket.close();
  await request('/gps-tracker/ingest',payload([110,112]));
  await Promise.race([connection,new Promise((_,reject)=>setTimeout(()=>reject(Error('Reconnect timeout')),15000))]);
  await repair;
  assert.equal(resyncs,1);assert.equal(connected,2);
  // If reconnect wins the race with the POST, the new points arrive over WS.
  // REST repair plus subsequently streamed points must cover the complete history.
  if (repaired.length < expected.size) await waitForEvents(4);
  const recovered = new Set([...repaired.map(p=>p.recorded_at),...observedPoints.keys()]);
  assert.equal(recovered.size,expected.size);
  const beforeBoot=received;
  await request('/gps-tracker/ingest',payload([100,102],2,Date.now()-105000));
  await waitForEvents(beforeBoot+1);await Promise.all(speedChecks);
  const all=await request(pointPath());
  assert.equal(all.items.length,expected.size);
  const result={checked_at:new Date().toISOString(),device_id:id,unique_sent_points:expected.size,saved_points:all.items.length,speed_points_verified:speedPoints,connections:connected,resyncs,rest_repaired_points:repaired.length,total_recovered_points:recovered.size};
  await writeFile(path.join(root,'fault-verification.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
} finally {
  client.disconnect();
  // Only the device provisioned above, owned by the dedicated simulator account.
  await request(api+`/devices/${id}?purge=true`,undefined,'DELETE');
}
