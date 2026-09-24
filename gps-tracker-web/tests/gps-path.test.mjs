import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzePath, enrichWithSpeedStops } from '../src/lib/stops.js';
import { liveMotion } from '../src/lib/liveMotion.js';

const epoch = Date.parse('2026-09-24T08:00:00Z');
const point = (s, lat = 37, lng = 127, extra = {}) => ({ recorded_at: new Date(epoch + s * 1000).toISOString(), lat, lng, ...extra });

test('live GPS status distinguishes movement, low speed, unknown and stale fixes', () => {
  assert.equal(liveMotion(10, point(0).recorded_at, epoch).label, '이동 중');
  assert.equal(liveMotion(0, point(0).recorded_at, epoch).label, '정지·저속');
  assert.equal(liveMotion(null, point(0).recorded_at, epoch).label, '속도 미확인');
  assert.equal(liveMotion(999, point(0).recorded_at, epoch).label, '속도 미확인');
  assert.equal(liveMotion(10, point(0).recorded_at, epoch + 301_000).label, '위치 오래됨');
  assert.equal(liveMotion(10, point(0).recorded_at, epoch - 61_000).label, '위치 오래됨');
});

test('dense slow travel is moving, independently of GPS sample count', () => {
  const points = Array.from({ length: 301 }, (_, i) => point(i * 2, 37 + i * .000025));
  const result = analyzePath(points);
  assert.equal(result.stopped.size, 0);
  assert.equal(result.movingS, 600);
  assert.ok(result.distanceM > 800);
});

test('stationary jitter requires five minutes, and does not inflate distance', () => {
  const points = Array.from({ length: 151 }, (_, i) => point(i * 2, 37 + (i % 2) * .00002));
  assert.equal(analyzePath(points.slice(0, 150)).stopped.size, 0);
  const result = analyzePath(points);
  assert.equal(result.stopped.size, 151);
  assert.equal(result.stopCount, 1, '151 GPS points represent one continuous stop');
  assert.equal(result.stoppedS, 300);
  assert.equal(result.movingS, 0);
  assert.ok(result.distanceM < .01);
});

test('separate stop episodes exclude an unobserved gap and respect the selected range', () => {
  const first = Array.from({ length: 7 }, (_, i) => point(i * 60));
  const second = Array.from({ length: 7 }, (_, i) => point(3600 + i * 60, 38));
  const result = analyzePath([...first, ...second]);
  assert.equal(result.stopCount, 2);
  assert.equal(result.stoppedS, 720);
  assert.equal(result.movingS, 0);
  assert.equal(analyzePath(second).stopCount, 1);
  assert.equal(analyzePath(second).stoppedS, 360);
});

test('outages, nonincreasing timestamps and impossible jumps are not travelled distance', () => {
  for (const points of [[point(0), point(7200, 38, 128)], [point(0), point(0, 38)], [point(0), point(2, 38)]]) {
    assert.equal(analyzePath(points).distanceM, 0);
    assert.equal(enrichWithSpeedStops(points)[1]._speed, null);
  }
});

test('valid receiver speed is preserved, including zero; invalid speed falls back', () => {
  const points = [point(0, 37, 127, { speed_kmh: 12 }), point(2, 37.0001, 127, { speed_kmh: 0 }), point(4, 37.0002, 127, { speed_kmh: 999 })];
  const enriched = enrichWithSpeedStops(points);
  assert.equal(enriched[0]._speed, 12);
  assert.equal(enriched[1]._speed, 0);
  assert.ok(enriched[2]._speed > 10 && enriched[2]._speed < 30);
});

test('live batch paints points chronologically with their individual speeds, including the equator', async () => {
  const context = vm.createContext({ Date, Number, Math });
  const base = fileURLToPath(new URL('../src/', import.meta.url));
  const cache = new Map();
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    const module = file.endsWith('colors.js')
      ? new vm.SyntheticModule(['getDeviceColor'], function() { this.setExport('getDeviceColor', () => '#123456'); }, { context })
      : new vm.SourceTextModule(await readFile(file, 'utf8'), { context, identifier: file });
    cache.set(file, module);
    await module.link((specifier, referring) => load(path.resolve(path.dirname(referring.identifier), specifier + '.js')));
    return module;
  }
  const module = await load(path.join(base, 'lib/wsEventHandler.js')); await module.evaluate();
  const history = [], markers = [], pans = [];
  const handler = module.namespace.makeWsEventHandler({
    devRef: { current: [{ id: 1 }] }, lastMetaRef: { current: {} }, wsDotAccRef: { current: {} },
    filterDeviceIdRef: { current: 1 }, trackLiveRef: { current: false },
    mapRef: { current: { updateMarker: (...x) => markers.push(x), addHistoryPoint: (...x) => history.push(x), panToCoord: (...x) => pans.push(x) } },
    setDevices() {}, setLiveSpeed() {},
  });
  handler({ type: 'location', device_id: 1, fix: true, ...point(4, 0, 127.0001), speed_kmh: 9,
    fixes: [point(4, 0, 127.0001, { speed_kmh: 9 }), point(2, 0, 127, { speed_kmh: 0 })] });
  assert.equal(markers.length, 2); assert.equal(history.length, 2);
  assert.equal(history[0][4].recordedAt, point(2).recorded_at);
  assert.equal(history[0][4].speedKmh, 0); assert.equal(history[1][4].speedKmh, 9);
  assert.equal(pans.length, 0, 'seeker-paused tracking must not move the camera');
});
