import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

async function bundled(file) {
  const result = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, write: false, format: 'esm', platform: 'node' });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}
const battery = await bundled('../src/lib/battery.js');

test('battery state boundaries and percentage are monotonic; invalid readings stay unknown', () => {
  for (const mv of [undefined, null, 0, -1, NaN, Infinity, '3900', 65536]) assert.equal(battery.batteryReading(mv).percent, null);
  assert.equal(battery.batteryReading(2875).label, '전압 매우 부족');
  assert.equal(battery.batteryReading(2876).label, '저전압');
  assert.equal(battery.batteryReading(3331).label, '저전압');
  assert.equal(battery.batteryReading(3332).label, '정상');
  assert.equal(battery.batteryReading(2500).percent, 0);
  assert.equal(battery.batteryReading(3901).percent, 75);
  assert.equal(battery.batteryReading(4200).percent, 100);
  assert.equal(battery.batteryReading(2689).mv, 2761);
  assert.equal(battery.batteryReading(3253).mv, 3219);
  assert.equal(battery.batteryReading(2500).voltage, '2.60 V');
  assert.equal(battery.batteryReading(2537).outsideCalibration, true);
  assert.equal(battery.batteryReading(2538).outsideCalibration, false);
  assert.equal(battery.batteryReading(4200).outsideCalibration, true);
  assert.equal(battery.batteryReading(2800).percent, 5, 'previous zero range now retains usable estimated percentage');
  let previousVoltage = 0;
  let previous = 0;
  for (let mv = 1000; mv <= 4500; mv++) {
    const reading = battery.batteryReading(mv);
    assert.ok(reading.mv >= previousVoltage); previousVoltage = reading.mv;
    const current = reading.percent;
    assert.ok(current >= previous && current <= 100); previous = current;
  }
});

test('charging voltage stays visible above the old limit and warns only above the raw ceiling', () => {
  const policy = battery.batteryPolicy;
  assert.equal(policy.normal_max_raw_mv, policy.charging_reference.raw_mv + policy.charging_reference.headroom_mv);
  for (const raw of [4501, 4772, 4858, 5272]) {
    const b = battery.batteryReading(raw);
    assert.equal(b.label, '정상');
    assert.equal(b.percent, 100);
    assert.equal(b.rawMv, raw);
    assert.equal(b.mv, raw + 3, 'keep existing endpoint calibration');
  }
  for (const raw of [5273, 6000, 65535]) {
    const b = battery.batteryReading(raw);
    assert.equal(b.label, '과충전');
    assert.equal(b.percent, 100);
    assert.equal(b.rawMv, raw);
    assert.equal(b.mv, raw + 3, 'do not clip voltage at the warning threshold');
    assert.ok(battery.batteryText(raw).includes('과충전'));
  }
  assert.equal(battery.batteryReading(6000).voltage, '6.00 V');
});

test('newer API battery wins over old GPS metadata; new missing ADC never falls back to CBC or old voltage', () => {
  const d = { last_seen_at:'2026-10-14T03:00:00Z', last_vbat_mv:2800, last_cbc_mv:4200 };
  assert.equal(battery.deviceBattery(d, {recordedAt:'2026-10-14T02:00:00Z',vbatMv:4200}).rawMv,2800);
  assert.equal(battery.deviceBattery(d, {receivedAt:'2026-10-14T03:00:01Z',vbatMv:3200}).rawMv,3200);
  assert.equal(battery.deviceBattery(d, {receivedAt:'2026-10-14T03:00:01Z',vbatMv:null,cbcMv:4000}).percent,null);
  assert.equal(battery.deviceBattery({...d,device_kind:'phone'}).percent,null);
});

test('live no-fix and fix telemetry update detail fields together and reject old packets', async () => {
  globalThis.localStorage = {getItem:()=>null};
  const {makeWsEventHandler} = await bundled('../src/lib/wsEventHandler.js');
  const devRef={current:[{id:1,last_seen_at:'2026-10-14T02:00:00Z',last_vbat_mv:4100}]};
  const lastMetaRef={current:{}};
  const h=makeWsEventHandler({devRef,lastMetaRef,mapRef:{current:null},wsDotAccRef:{current:{}},filterDeviceIdRef:{current:null},trackLiveRef:{current:false},setDevices:fn=>{devRef.current=fn(devRef.current);},setLiveSpeed:()=>{}});
  h({type:'location',device_id:1,recorded_at:'2026-10-14T03:00:00Z',fix:false,vbat_mv:2790,cbc_mv:2740});
  assert.equal(devRef.current[0].last_vbat_mv,2790);
  assert.equal(battery.deviceBattery(devRef.current[0],lastMetaRef.current[1]).label,'전압 매우 부족');
  h({type:'location',device_id:1,recorded_at:'2026-10-14T03:00:10Z',fix:true,lat:37.5,lng:127,vbat_mv:3200,cbc_mv:3100});
  assert.equal(devRef.current[0].last_vbat_mv,3200);
  assert.equal(devRef.current[0].last_cbc_mv,3100);
  h({type:'location',device_id:1,recorded_at:'2026-10-14T02:00:00Z',fix:true,lat:37.5,lng:127,vbat_mv:4200});
  assert.equal(devRef.current[0].last_vbat_mv,3200);
  h({type:'location',device_id:1,recorded_at:'2026-10-14T03:00:20Z',fix:false,cbc_mv:3100});
  assert.equal(devRef.current[0].last_vbat_mv,null);
  assert.equal(battery.deviceBattery(devRef.current[0],lastMetaRef.current[1]).percent,null);
  h({type:'location',device_id:1,recorded_at:'2026-10-14T03:00:15Z',fix:true,lat:37.6,lng:127,vbat_mv:4200});
  assert.equal(devRef.current[0].last_fix_at,'2026-10-14T03:00:15Z','delayed GPS fixes still advance the GPS watermark');
  assert.equal(devRef.current[0].last_vbat_mv,null,'delayed GPS battery must not replace newer no-fix telemetry');
  assert.equal(lastMetaRef.current[1].vbatMv,null);
});

test('battery indication does not hide a stale/offline connection', async () => {
  const {classifyDevice} = await bundled('../src/colors.js');
  assert.equal(classifyDevice({last_seen_at:new Date(Date.now()-3600000).toISOString(),last_vbat_mv:2800}).id,'offline');
  assert.equal(classifyDevice({last_seen_at:new Date().toISOString(),last_vbat_mv:2800}).id,'critical_batt');
  assert.equal(classifyDevice({last_seen_at:new Date().toISOString(),last_vbat_mv:5273}).id,'overcharge');
  assert.equal(classifyDevice({last_seen_at:new Date(Date.now()-3600000).toISOString(),last_vbat_mv:6000}).id,'offline');
});

test('runtime remains paired with the latest voltage, including missing and delayed WS packets', async () => {
  globalThis.localStorage = {getItem:()=>null};
  const {makeWsEventHandler} = await bundled('../src/lib/wsEventHandler.js');
  const old = {status:'estimated', remaining_seconds:5000};
  const current = {status:'estimated', remaining_seconds:4000};
  const devRef={current:[{id:1,last_seen_at:'2026-10-14T02:00:00Z',last_vbat_mv:3900,battery_runtime:old}]};
  const lastMetaRef={current:{}};
  const h=makeWsEventHandler({devRef,lastMetaRef,mapRef:{current:null},wsDotAccRef:{current:{}},filterDeviceIdRef:{current:null},trackLiveRef:{current:false},setDevices:fn=>{devRef.current=fn(devRef.current);},setLiveSpeed:()=>{}});
  h({type:'location',device_id:1,recorded_at:'2026-10-14T03:00:00Z',fix:false,vbat_mv:3800,battery_runtime:current});
  assert.equal(battery.deviceBattery(devRef.current[0],lastMetaRef.current[1]).runtime,current);
  assert.equal(devRef.current[0].battery_runtime,current);
  h({type:'location',device_id:1,recorded_at:'2026-10-14T02:59:00Z',fix:true,lat:37.5,lng:127,vbat_mv:3900,battery_runtime:old});
  assert.equal(battery.deviceBattery(devRef.current[0],lastMetaRef.current[1]).runtime,current);
  h({type:'location',device_id:1,recorded_at:'2026-10-14T03:00:01Z',fix:false});
  assert.equal(battery.deviceBattery(devRef.current[0],lastMetaRef.current[1]).runtime,null);
});

test('runtime formatting uses the server timestamp and hides stale or inapplicable predictions', async () => {
  const {batteryRuntimeView:view}=await bundled('../src/lib/batteryRuntime.js');
  const at=Date.parse('2026-10-14T17:00:00+09:00');
  const estimate={status:'estimated',measurement_at:new Date(at).toISOString(),remaining_seconds:183780,estimated_empty_at:new Date(at+183780000).toISOString()};
  assert.equal(view(estimate,at).text,'예상 남은 시간 약 51시간');
  assert.match(view(estimate,at).date,/10\. 16\./);
  assert.match(view(estimate,at).date,/20:00/);
  assert.equal(view(estimate,at+301000).date,null);
  for(const status of ['sleeping','unavailable','external_power_possible','stale']) {
    const output=view({...estimate,status},at);
    assert.equal(output.date,null);
    assert.ok(!output.text.includes('51시간'));
  }
  assert.match(view({...estimate,status:'depleted',remaining_seconds:0,estimated_empty_at:new Date(at).toISOString()},at).text,/충전 필요/);
  assert.equal(view({...estimate,estimated_empty_at:'invalid'},at).date,null);
  assert.equal(view(null,at),null);
});

test('an in-flight REST snapshot cannot overwrite newer live battery or runtime', async () => {
  globalThis.sessionStorage = {getItem:()=>null};
  globalThis.window = Object.assign(new EventTarget(), {location:{hostname:'localhost'}});
  const {mergeDeviceSnapshot}=await bundled('../src/state/devices.js');
  const old={id:1,last_battery_at:'2026-10-14T02:00:00Z',last_vbat_mv:3900,battery_runtime:{remaining_seconds:4000}};
  const live={...old,last_battery_at:'2026-10-14T02:01:00Z',last_vbat_mv:null,battery_runtime:null};
  const [merged]=mergeDeviceSnapshot([old],[live],[old]);
  assert.equal(merged.last_vbat_mv,null);
  assert.equal(merged.battery_runtime,null);
  assert.equal(merged.last_battery_at,live.last_battery_at);
  const refreshed={...old,last_battery_at:'2026-10-14T02:02:00Z',last_vbat_mv:3800,battery_runtime:{remaining_seconds:3000}};
  assert.equal(mergeDeviceSnapshot([refreshed],[live],[old])[0].battery_runtime,refreshed.battery_runtime);
});
