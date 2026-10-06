import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
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
      else if (file.endsWith('/api.js')) module = synthetic({ api });
      else if (file.endsWith('/authSession.js')) module = synthetic({ authScope: () => scope,
        assertSession: previous => { if (previous !== scope) throw new DOMException('changed', 'AbortError'); } });
      else if (file.endsWith('/colors.js')) module = synthetic({ getDeviceColor: () => '#2563eb', isStale: () => false });
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
