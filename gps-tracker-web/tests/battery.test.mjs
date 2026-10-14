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
  for (const mv of [undefined, null, 0, -1, NaN, Infinity, '3900', 5000]) assert.equal(battery.batteryReading(mv).percent, null);
  assert.equal(battery.batteryReading(2875).label, '전압 매우 부족');
  assert.equal(battery.batteryReading(2876).label, '저전압');
  assert.equal(battery.batteryReading(3331).label, '저전압');
  assert.equal(battery.batteryReading(3332).label, '정상');
  assert.equal(battery.batteryReading(2690).percent, 0);
  assert.equal(battery.batteryReading(3916).percent, 75);
  assert.equal(battery.batteryReading(4200).percent, 100);
  assert.equal(battery.batteryReading(2689).mv, 2779);
  assert.equal(battery.batteryReading(3253).mv, 3219);
  assert.equal(battery.batteryReading(2690).voltage, '2.78 V');
  assert.equal(battery.batteryReading(2688).outsideCalibration, true);
  assert.equal(battery.batteryReading(2689).outsideCalibration, false);
  assert.equal(battery.batteryReading(4200).outsideCalibration, true);
  let previousVoltage = 0;
  let previous = 0;
  for (let mv = 1000; mv <= 4500; mv++) {
    const reading = battery.batteryReading(mv);
    assert.ok(reading.mv >= previousVoltage); previousVoltage = reading.mv;
    const current = reading.percent;
    assert.ok(current >= previous && current <= 100); previous = current;
  }
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
});
