import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNativeTrackingSnapshot } from '../src/lib/nativeTracking.js';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

const args = () => ({
  selectedId: 1, now: Date.parse('2026-10-09T12:00:00Z'),
  devices: [{ id: 1, display_name: '테스트', last_lat: 37, last_lng: 127, last_fix_at: '2026-10-09T12:00:00Z', secret: 'never-transfer' }],
  display: { markers: {}, segments: [], points: [] }, metadata: { 1: { speedKmh: 30, heading: 90, fix: true, secret: 'never-transfer' } },
});
test('native display copies no credentials, keeps zero coordinates, and marks cache/fix loss', () => {
  const input = args(); input.devices[0].last_lat = 0;
  let snapshot = buildNativeTrackingSnapshot(input);
  assert.equal(snapshot.devices[0].lat, 0);
  assert.equal(snapshot.devices[0].state, 'moving');
  assert.ok(!JSON.stringify(snapshot).includes('never-transfer'));
  snapshot = buildNativeTrackingSnapshot({...input, cached: {1: true}});
  assert.equal(snapshot.devices[0].state, 'offline');
  input.metadata[1].fix = false;
  assert.equal(buildNativeTrackingSnapshot(input).devices[0].state, 'stopped');
  input.devices[0].last_lat = null;
  assert.equal(buildNativeTrackingSnapshot(input), null);
});
test('selected tracker survives fleet cap; segments remain separate and bounded', () => {
  const input = args();
  input.devices = Array.from({length: 120}, (_, id) => ({...input.devices[0], id}));
  input.selectedId = 119;
  input.display.segments = Array.from({length: 220}, () => Array.from({length: 40}, (_, i) => ({lat: 37 + i / 10000, lng: 127})));
  const snapshot = buildNativeTrackingSnapshot(input);
  assert.equal(snapshot.devices.length, 100);
  assert.equal(snapshot.devices[0].id, '119');
  assert.ok(snapshot.segments.flat().length <= 2500);
  assert.ok(snapshot.segments.length > 1);
  assert.ok(snapshot.segments.every(s => s.length <= 40));
});

test('native session streams while open and stops on back, logout, account switch and unmount', async () => {
  const window = new EventTarget(), timers = new Map(), calls = [];
  let sequence = 0, hook, renderer;
  window.GpsTrackingMap = {
    version: 1,
    open: async request => { calls.push(['open', request.session]); return {ok: true}; },
    update: async request => { calls.push(['update', request.session]); return {ok: true}; },
    close: async () => { calls.push(['close']); },
  };
  const context = vm.createContext({ window, console, crypto: {randomUUID: () => `session-${++sequence}`},
    setInterval: fn => { timers.set(1, fn); return 1; }, clearInterval: id => timers.delete(id) });
  const moduleOf = exports => new vm.SyntheticModule(Object.keys(exports), function() {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, {context});
  const mod = new vm.SourceTextModule(await readFile(new URL('../src/hooks/useNativeTracking.js', import.meta.url), 'utf8'), {context});
  await mod.link(name => moduleOf(name === 'react' ? React : name.includes('nativeTracking') ? {buildNativeTrackingSnapshot}
    : {getDeviceColor: () => '#2563EB', classifyDevice: () => ({label: '통신 정상'})}));
  await mod.evaluate();
  const input = args(), mapRef = {current: {getNativeTrackingData: () => input.display}}, lastMetaRef = {current: input.metadata};
  function Probe({scope = 'A'}) {
    hook = mod.namespace.useNativeTracking({mapRef, lastMetaRef, scope, devices: input.devices, selectedId: 1, fences: [], cached: {}});
    return null;
  }
  const tick = async () => { for (const fn of timers.values()) await fn(); };
  await act(async () => { renderer = create(React.createElement(Probe)); });
  assert.equal(hook.available, true);
  await tick(); assert.equal(calls.length, 0);
  await act(async () => { await hook.open(); await tick(); });
  assert.deepEqual(calls.map(c => c[0]), ['open', 'update']);
  const oldSession = calls[0][1];
  const closed = new Event('gps-native-map-closed'); closed.detail = {session: oldSession};
  window.dispatchEvent(closed); await tick(); assert.equal(calls.length, 2);
  await hook.open();
  window.dispatchEvent(closed); // An older route closing cannot close a new one.
  await tick(); assert.equal(calls.at(-1)[0], 'update');
  await act(async () => renderer.update(React.createElement(Probe, {scope: 'B'})));
  await tick(); assert.equal(calls.at(-1)[0], 'close');
  await hook.open(); window.dispatchEvent(new Event('gps-auth-clearing'));
  const afterLogout = calls.length; await tick(); assert.equal(calls.length, afterLogout);
  await hook.open(); await act(async () => renderer.unmount());
  assert.equal(calls.at(-1)[0], 'close'); assert.equal(timers.size, 0);
});
