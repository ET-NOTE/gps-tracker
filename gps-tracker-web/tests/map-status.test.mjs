import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as Router from 'react-router-dom';
import { create, act } from 'react-test-renderer';
import { transform } from 'esbuild';

const src = fileURLToPath(new URL('../src/', import.meta.url));
async function fixture(api = {}) {
  const values = new Map();
  const storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  let scope = 'account-A';
  const context = vm.createContext({ console, window: { location: { search: '' } },
    localStorage: storage, DOMException, URLSearchParams, document: new EventTarget() });
  const modules = new Map();
  const synthetic = exports => new vm.SyntheticModule(Object.keys(exports), function() {
    for (const [k, v] of Object.entries(exports)) this.setExport(k, v);
  }, { context });
  async function load(file) {
    if (modules.has(file)) return modules.get(file);
    const pending = (async () => {
      let module;
      if (file === 'react') module = synthetic(React);
      else if (file === 'react/jsx-runtime') module = synthetic(jsx);
      else if (file === 'react-router-dom') module = synthetic(Router);
      else if (file.endsWith('/api.js')) module = synthetic({ api });
      else if (file.endsWith('/authSession.js')) module = synthetic({ authScope: () => scope,
        assertSession: previous => { if (previous !== scope) throw new DOMException('changed', 'AbortError'); } });
      else if (file.endsWith('/colors.js')) module = synthetic({ getDeviceColor: () => '#2563eb', isStale: () => false, isFixStale: () => false, ageString: () => '방금' });
      else if (file.endsWith('/Icon.jsx')) module = synthetic({ default: () => null });
      else if (file.endsWith('.css')) module = synthetic({});
      else {
        let code = await readFile(file, 'utf8');
        if (file.endsWith('.jsx')) code = (await transform(code, { loader: 'jsx', jsx: 'automatic', format: 'esm' })).code;
        module = new vm.SourceTextModule(code, { context, identifier: file });
      }
      await module.link(async (specifier, parent) => {
        if (!specifier.startsWith('.')) return load(specifier);
        let target = path.resolve(path.dirname(parent.identifier), specifier).replaceAll('\\', '/');
        if (!/\.(js|jsx|css)$/.test(target)) {
          try { await readFile(target + '.js'); target += '.js'; } catch { target += '.jsx'; }
        }
        return load(target);
      });
      return module;
    })();
    modules.set(file, pending);
    return pending;
  }
  return { setScope: s => { scope = s; }, module: async name => {
    const m = await load(path.resolve(src, name).replaceAll('\\', '/')); await m.evaluate(); return m.namespace;
  } };
}

const networkError = () => { throw new TypeError('network unavailable'); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('home window uses KST midnight and validates wake timestamps', async () => {
  const f = await fixture({ getDeviceEvents: async () => [{ occurred_at: 'invalid', data: { wake_cause: 'motion' } }] });
  const { computeHomeSinceISO } = await f.module('lib/deviceLoader.js');
  const now = Date.parse('2026-10-06T15:01:00Z');
  assert.equal(await computeHomeSinceISO({ last_fix_at: '2026-10-06T15:00:30Z' }, now), '2026-10-06T15:00:00.000Z');
  assert.equal(await computeHomeSinceISO({ id: 1, last_fix_at: '2026-10-05T23:00:00Z' }, now), '2026-10-05T15:00:00.000Z');
});

test('superseded or unmounted history requests never repaint the map', async () => {
  const reads = [deferred(), deferred(), deferred()]; let calls = 0;
  const device = { id: 1, last_fix_at: new Date().toISOString() };
  const f = await fixture({ listDevices: async () => [device],
    listLocationsGrouped: () => reads[calls++].promise, flattenGrouped: x => x });
  const updates = [], loaded = [];
  const loader = (await f.module('lib/deviceLoader.js')).makeDeviceLoaders({
    mapRef: { current: { updateMarker: (...x) => updates.push(x), clearHistoryPoints() {}, addHistoryPoint() {}, fitToAllMarkers() {} } },
    devRef: { current: [] }, lastMetaRef: { current: {} }, lastLoadedFixAtRef: { current: {} }, wsRef: { current: null },
    setDevicesLoaded: v => loaded.push(v),
  });
  const first = loader.loadDevices(); await new Promise(r => setImmediate(r));
  const second = loader.loadDevices(); await new Promise(r => setImmediate(r));
  reads[1].resolve([{ recorded_at: device.last_fix_at, lat: 37, lng: 127 }]); await second;
  reads[0].resolve([{ recorded_at: device.last_fix_at, lat: 38, lng: 128 }]); await first;
  assert.equal(updates.length, 1); assert.equal(updates[0][1], 37); assert.equal(loaded.length, 1);
  const third = loader.loadDevices(); await new Promise(r => setImmediate(r)); loader.cancel();
  reads[2].resolve([{ recorded_at: device.last_fix_at, lat: 39, lng: 129 }]); await third;
  assert.equal(updates.length, 1); assert.equal(loaded.length, 1);
});

test('slow history cannot clear a newer live trail; next refresh can repair it', async () => {
  const at = offset => new Date(Date.now() + offset).toISOString();
  const before = at(-2000), live = at(-1000);
  const device = { id: 1, last_fix_at: before, last_lat: 37, last_lng: 127 };
  let rows = [{ recorded_at: before, lat: 37, lng: 127 }];
  const f = await fixture({ listDevices: async () => [device], listLocationsGrouped: async () => rows, flattenGrouped: x => x });
  const updates = [], clears = [], lastLoadedFixAtRef = { current: {} };
  const loader = (await f.module('lib/deviceLoader.js')).makeDeviceLoaders({
    mapRef: { current: { updateMarker: (...x) => updates.push(x), clearLiveTrail: () => clears.push(true), clearHistoryPoints() {}, addHistoryPoint() {} } },
    devRef: { current: [device] }, lastMetaRef: { current: { 1: { recordedAt: live } } }, lastLoadedFixAtRef, wsRef: { current: null }, setDevicesLoaded() {},
  });
  await loader.loadDevicesIncremental(true);
  assert.equal(clears.length, 0); assert.equal(updates.length, 0); assert.equal(lastLoadedFixAtRef.current[1], null);
  rows = []; await loader.loadDevicesIncremental(true);
  assert.equal(updates.length, 0, 'empty history cannot replace live marker with an old device coordinate');
  rows = [{ recorded_at: live, lat: 37.1, lng: 127.1 }];
  await loader.loadDevicesIncremental(true);
  assert.equal(clears.length, 1); assert.equal(updates.length, 1);
});
test('cache provenance belongs to the response; a successful retry recovers without an online event', async () => {
  const f = await fixture(); const { cachedRead, isCachedResponse } = await f.module('lib/offlineCache.js');
  const online = await cachedRead('devices', async () => [{ id: 1 }]);
  assert.equal(isCachedResponse(online), false);
  const saved = await cachedRead('devices', networkError);
  assert.equal(isCachedResponse(saved), true);
  assert.equal(saved[0].id, 1);
  const recovered = await cachedRead('devices', async () => [{ id: 2 }]);
  assert.equal(isCachedResponse(recovered), false);
  assert.equal(isCachedResponse(saved), true, 'another response cannot relabel old data as fresh');
});

test('authorization failures and account changes cannot restore or leak saved data', async () => {
  const f = await fixture(); const { cachedRead } = await f.module('lib/offlineCache.js');
  await cachedRead('devices', async () => [{ id: 1 }]);
  for (const status of [401, 403, 500]) {
    await assert.rejects(cachedRead('devices', async () => { throw Object.assign(Error(), { status }); }), e => e.status === status);
  }
  let resolve;
  const pending = cachedRead('devices', () => new Promise(r => { resolve = r; }));
  f.setScope('account-B'); resolve([{ id: 1 }]);
  await assert.rejects(pending, { name: 'AbortError' });
  await assert.rejects(cachedRead('devices', networkError), TypeError);
});

test('home refresh retries cached history even when latest fix is unchanged; unrelated reads do not affect home', async () => {
  const api = {};
  const f = await fixture(api); const cache = await f.module('lib/offlineCache.js');
  const device = { id: 1, last_fix_at: new Date().toISOString() };
  let offline = false, calls = 0;
  api.listDevices = () => cache.cachedRead('devices', offline ? networkError : async () => [device]);
  api.listLocationsGrouped = id => {
    calls++; return cache.cachedRead(`history-${id}`, offline ? networkError : async () => []);
  };
  api.flattenGrouped = groups => groups;
  const sources = {};
  const lastLoadedFixAtRef = { current: {} };
  const loader = (await f.module('lib/deviceLoader.js')).makeDeviceLoaders({
    mapRef: { current: null }, devRef: { current: [] }, lastMetaRef: { current: {} }, lastLoadedFixAtRef,
    wsRef: { current: null }, setDevices() {}, setDevicesLoaded() {},
    onDataSource: (key, cached) => { sources[key] = cached; },
  });
  await loader.loadDevices();
  // Seed cached responses then simulate the next app opening without connectivity.
  offline = true; await loader.loadDevices();
  assert.equal(sources.devices, true); assert.equal(sources[1], true);
  assert.equal(lastLoadedFixAtRef.current[1], null);
  offline = false; await loader.loadDevicesIncremental(true);
  assert.equal(calls, 3, 'unchanged last_fix_at must not skip recovery of saved history');
  assert.equal(sources.devices, false); assert.equal(sources[1], false);
  await cache.cachedRead('other-panel', async () => []);
  await cache.cachedRead('other-panel', networkError);
  assert.equal(sources[1], false);
});

test('map notices follow selected device; changing selection cannot show previous speed', async () => {
  const f = await fixture(); const { default: Overlay, mapCacheNotice } = await f.module('components/MapTopOverlay.jsx');
  assert.equal(mapCacheNotice({ 2: true }, 1), null);
  assert.match(mapCacheNotice({ 2: true }, 2), /이전 경로/);
  assert.match(mapCacheNotice({ 2: true }, null), /이전 경로/);
  assert.equal(mapCacheNotice({}, 1), null);
  const now = Date.now();
  let rendered;
  await act(async () => { rendered = create(React.createElement(Overlay, {
    devices: [{ id: 1, display_name: 'First' }, { id: 2, display_name: 'Second', last_fix_at: new Date(now).toISOString() }],
    selected: 2, showSpeed: true, now, onSelect() {}, mapRef: { current: null },
    liveSpeed: { deviceId: 1, label: 'First', speedKmh: 77, recordedAt: new Date(now).toISOString() },
  })); });
  const summary = rendered.root.findByProps({ 'aria-label': '실시간 운행 정보' });
  assert.equal(summary.findByType('strong').children.join(''), '--');
  assert.match(JSON.stringify(rendered.toJSON()), /Second/);
  assert.doesNotMatch(JSON.stringify(rendered.toJSON()), /First/);
  await act(async () => rendered.unmount());
});

test('both navigation surfaces remove Driving while keeping role-specific destinations', async () => {
  const f = await fixture();
  for (const file of ['components/BottomNav.jsx', 'components/SideRail.jsx']) {
    const Navigation = (await f.module(file)).default;
    const changes = [];
    let r;
    await act(async () => { r = create(React.createElement(Navigation, {
      active: 'home', onChange: v => changes.push(v), isAdmin: true, isCorporate: true, isRentcar: true, isDelivery: true,
    })); });
    const buttons = r.root.findAllByType('button');
    assert.equal(buttons.length, 7, 'three general tabs plus four authorized role tabs');
    assert.deepEqual(buttons.slice(0, 3).map(b => b.findByType('div').children.join('')), ['홈', '단말기', '내정보']);
    await act(async () => buttons[1].props.onClick());
    assert.deepEqual(changes, ['devices']);
    await act(async () => r.unmount());
  }
});

test('home tool menu exposes all former Driving actions and requires a device only for the seeker', async () => {
  const f = await fixture(); const Actions = (await f.module('components/MapActions.jsx')).default;
  const opened = [];
  let r;
  const props = { hasDevice: false, bottom: 76, onTool: value => opened.push(value) };
  await act(async () => { r = create(React.createElement(Actions, props)); });
  const toggle = () => r.root.findByProps({ 'aria-label': '운행 도구' });
  await act(async () => toggle().props.onClick());
  let group = r.root.findByProps({ 'aria-label': '운행 도구 목록' });
  assert.equal(group.findAllByType('button')[0].props.disabled, true);
  assert.match(JSON.stringify(r.toJSON()), /지오펜스 관리/);
  assert.match(JSON.stringify(r.toJSON()), /경로 계획/);
  await act(async () => group.findAllByType('button')[1].props.onClick());
  assert.deepEqual(opened, ['geofence']);
  assert.equal(toggle().props['aria-expanded'], false);
  await act(async () => r.update(React.createElement(Actions, { ...props, hasDevice: true })));
  await act(async () => toggle().props.onClick());
  group = r.root.findByProps({ 'aria-label': '운행 도구 목록' });
  assert.equal(group.findAllByType('button')[0].props.disabled, false);
  await act(async () => group.findAllByType('button')[0].props.onClick());
  assert.deepEqual(opened, ['geofence', 'seeker']);
  await act(async () => r.unmount());
});

test('mini/detail/management/planner are exclusive; leaving Home or losing the device releases the map', async () => {
  const f = await fixture(); const { useHomeMapTools } = await f.module('hooks/useHomeMapTools.js');
  const { isSeekerVisible } = await f.module('lib/seeker.js');
  let controls, r;
  function Probe({ view = 'home', hasDevice = true }) {
    controls = useHomeMapTools(view, hasDevice);
    return null;
  }
  await act(async () => { r = create(React.createElement(Probe)); });
  const active = () => [controls.showMiniSeeker, controls.showSeeker, controls.showGeofence, controls.showRoutePlanner].filter(Boolean).length;
  await act(async () => controls.toggleMini());
  assert.equal(controls.showMiniSeeker, true);
  await act(async () => controls.openTool('seeker'));
  assert.equal(active(), 1); assert.equal(controls.showSeeker, true);
  assert.equal(isSeekerVisible('home', 1, controls.showSeeker, controls.showMiniSeeker), true, 'live layers must pause for detail on Home');
  for (const tool of ['geofence', 'route']) {
    await act(async () => controls.openTool(tool));
    assert.equal(active(), 1); assert.equal(controls.fullToolOpen, true);
  }
  await act(async () => controls.closeTool());
  assert.equal(active(), 0); assert.equal(controls.fullToolOpen, false);
  await act(async () => controls.openTool('seeker'));
  await act(async () => r.update(React.createElement(Probe, { hasDevice: false })));
  assert.equal(active(), 0); assert.equal(controls.fullToolOpen, false, 'no invisible sheet trapping the controls');
  await act(async () => r.update(React.createElement(Probe)));
  await act(async () => controls.openTool('route'));
  await act(async () => r.update(React.createElement(Probe, { view: 'devices' })));
  await act(async () => r.update(React.createElement(Probe)));
  assert.equal(active(), 0, 'returning Home starts with the live map');
  await act(async () => r.unmount());
});

test('old /tools links redirect Home with parameters intact and replace their history entry', async () => {
  const f = await fixture(); const Redirect = (await f.module('components/LegacyToolsRedirect.jsx')).default;
  for (const pathname of ['/tools', '/tools/history']) {
    let r, location, navigate;
    function Probe() { location = Router.useLocation(); navigate = Router.useNavigate(); return null; }
    await act(async () => {
      r = create(React.createElement(Router.MemoryRouter, { initialEntries: ['/profile', `${pathname}?device=42&date=2026-10-06#history`] },
        React.createElement(Router.Routes, null,
          React.createElement(Router.Route, { path: '/tools/*', element: React.createElement(Redirect) }),
          React.createElement(Router.Route, { path: '*', element: React.createElement(Probe) }))));
    });
    assert.equal(location.pathname, '/');
    assert.equal(location.search, '?device=42&date=2026-10-06');
    assert.equal(location.hash, '#history');
    await act(async () => navigate(-1));
    assert.equal(location.pathname, '/profile');
    await act(async () => r.unmount());
  }
});


test('device card preserves all actions without executing them on expand, and closes after selection', async () => {
  const f = await fixture(); const Card = (await f.module('components/DeviceCardSummary.jsx')).default;
  const calls = []; let r;
  await act(async () => { r = create(React.createElement(Card, {
    device: { id: 1, device_uid: 'test-only', display_name: 'Test', last_vbat_mv: 4100 },
    status: { label: '오프라인', color: 'red' }, color: 'blue',
    onView: () => calls.push('view'), onDetail: () => calls.push('detail'),
    onPin: () => calls.push('pin'), onReceive: () => calls.push('receive'), onColor: () => calls.push('color'),
    onRename: () => calls.push('rename'), onUnpair: () => calls.push('unpair'),
  })); });
  const toggle = () => r.root.findByProps({ 'aria-label': '단말기 더보기' });
  for (let i = 0; i < 5; i++) {
    await act(async () => toggle().props.onClick());
    assert.equal(calls.length, i, 'opening actions must not change the device');
    const buttons = r.root.findByProps({ 'aria-label': '단말기 작업' }).findAllByType('button');
    await act(async () => buttons[i].props.onClick());
    assert.equal(toggle().props['aria-expanded'], false);
  }
  assert.deepEqual(calls, ['pin', 'receive', 'color', 'rename', 'unpair']);
  await act(async () => r.root.findByProps({ className: 'device-primary-actions' }).findAllByType('button')[0].props.onClick());
  assert.equal(calls.at(-1), 'view');
  assert.match(JSON.stringify(r.toJSON()), /오프라인/);
  await act(async () => r.unmount());
});

test('map options support native click activation and propagate the chosen map layer', async () => {
  const f = await fixture(); const Controls = (await f.module('components/MapControls.jsx')).default;
  const layers = []; let r;
  await act(async () => { r = create(React.createElement(Controls, { mapRef: { current: { setMapType: v => layers.push(v) } } })); });
  const toggle = () => r.root.findByProps({ 'aria-label': '지도 옵션' });
  await act(async () => toggle().props.onClick({ stopPropagation() {} }));
  assert.equal(toggle().props['aria-expanded'], true);
  await act(async () => r.root.findByProps({ title: '위성+라벨' }).props.onClick({ stopPropagation() {} }));
  assert.deepEqual(layers, ['hybrid']);
  await act(async () => toggle().props.onClick({ stopPropagation() {} }));
  assert.equal(toggle().props['aria-expanded'], false);
  await act(async () => r.unmount());
});
