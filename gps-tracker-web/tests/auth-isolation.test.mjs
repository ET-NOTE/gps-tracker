import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient } from '@tanstack/react-query';
import { webcrypto } from 'node:crypto';

const src = fileURLToPath(new URL('../src/', import.meta.url));
class Storage {
  values = new Map();
  getItem(k) { return this.values.get(k) ?? null; }
  setItem(k, v) { this.values.set(k, String(v)); }
  removeItem(k) { this.values.delete(k); }
  get length() { return this.values.size; }
  key(i) { return [...this.values.keys()][i]; }
}
const token = id => `x.${Buffer.from(JSON.stringify({ sub: id, exp: 9999999999 })).toString('base64url')}.x`;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(fetch) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: Infinity, staleTime: 30000, retry: false } } });
  const window = new EventTarget(); window.location = { hostname: 'dev-gps.serial.kr', reload() { throw Error('unexpected reload'); } };
  const context = vm.createContext({ localStorage: new Storage(), sessionStorage: new Storage(), window,
    navigator: {}, crypto: webcrypto, fetch, Event, DOMException, AbortController, FormData, Headers, URLSearchParams,
    atob: s => Buffer.from(s, 'base64').toString(), setTimeout: () => 1, clearTimeout() {}, console });
  const cache = new Map();
  async function load(file) {
    if (cache.has(file)) return cache.get(file);
    let m;
    if (file.endsWith('state/queryClient.js')) m = new vm.SyntheticModule(['queryClient'], function() { this.setExport('queryClient', queryClient); }, { context });
    else if (file.endsWith('/colors.js') || file.endsWith('/pairTutorialSeen.js')) {
      const name = file.endsWith('/colors.js') ? 'hydrateDeviceColors' : 'hydratePairTutorialSeen';
      m = new vm.SyntheticModule([name], function() { this.setExport(name, () => {}); }, { context });
    } else m = new vm.SourceTextModule(await readFile(file, 'utf8'), { context, identifier: file });
    cache.set(file, m);
    await m.link((specifier, referring) => load(path.resolve(path.dirname(referring.identifier), specifier + '.js').replaceAll('\\', '/')));
    return m;
  }
  const api = await load(path.join(src, 'api.js').replaceAll('\\', '/')); await api.evaluate();
  const keys = await load(path.join(src, 'state/keys.js').replaceAll('\\', '/')); await keys.evaluate();
  return { api: api.namespace, qk: keys.namespace.qk, queryClient, context, module: async name => {
    const m = await load(path.join(src, name).replaceAll('\\', '/')); await m.evaluate(); return m.namespace;
  } };
}
test('new account never reuses previous account query cache', async () => {
  const f = await fixture(async () => new Response('{}'));
  f.api.setTokens(token('A'), 'refresh-A');
  f.queryClient.setQueryData(f.qk.me(), { user: 'A' });
  f.api.clearTokens(); f.api.setTokens(token('B'), 'refresh-B');
  let calls = 0;
  const result = await f.queryClient.fetchQuery({ queryKey: f.qk.me(), queryFn: () => { calls++; return { user: 'B' }; } });
  assert.equal(result.user, 'B'); assert.equal(calls, 1); f.queryClient.clear();
});
for (const status of [200, 401]) test(`late A refresh (${status}) cannot replace or log out B`, async () => {
  const d = deferred(); const f = await fixture(() => d.promise);
  f.api.setTokens(token('A'), 'refresh-A'); const refreshing = f.api.tryRefresh();
  f.api.clearTokens(); f.api.setTokens(token('B'), 'refresh-B');
  d.resolve(new Response(JSON.stringify({ access_token: token('A2'), refresh_token: 'refresh-A2' }), { status }));
  assert.equal(await refreshing, 'stale');
  assert.equal(f.context.localStorage.getItem('access_token'), token('B'));
  f.queryClient.clear();
});
test('late account data cannot complete after login changes', async () => {
  const d = deferred(); const f = await fixture(() => d.promise);
  f.api.setTokens(token('A'), 'refresh-A'); const read = f.api.api.getMe();
  f.api.clearTokens(); f.api.setTokens(token('B'), 'refresh-B');
  d.resolve(new Response(JSON.stringify({ user: 'A' })));
  await assert.rejects(read, { name: 'AbortError' }); f.queryClient.clear();
});
test('logout prevents a pending refresh from resurrecting a session', async () => {
  const d = deferred(); const f = await fixture(() => d.promise);
  f.api.setTokens(token('A'), 'refresh-A'); const refreshing = f.api.tryRefresh(); f.api.clearTokens();
  d.resolve(new Response(JSON.stringify({ access_token: token('A2'), refresh_token: 'A2' })));
  assert.equal(await refreshing, 'stale'); assert.equal(f.context.localStorage.getItem('access_token'), null);
  f.queryClient.clear();
});

test('CSV, XLSX and multipart use session login, and only retry rejected authentication', async () => {
  const calls = [];
  let rejectUpload = true;
  const f = await fixture(async (url, options) => {
    calls.push({ url, ...options });
    if (url.endsWith('/auth/refresh')) return Response.json({ access_token: token('A-new'), refresh_token: 'rotated' });
    if (url.endsWith('/documents')) {
      if (rejectUpload) { rejectUpload = false; return new Response('', { status: 401 }); }
      return Response.json({ id: 2 });
    }
    return new Response('file');
  });
  f.api.setTokens(token('A'), 'refresh-A', false);
  await f.api.api.tripsCsv(1);
  await f.api.api.rentalInvoiceXlsx(1);
  await f.api.api.reportXlsx();
  for (const call of calls) assert.equal(call.headers.get('Authorization'), `Bearer ${token('A')}`);
  assert.equal(f.context.localStorage.getItem('access_token'), null);
  await f.api.api.uploadDocument(1, { file: new Blob(['example']), kind: 'other' });
  const uploads = calls.filter(c => c.url.endsWith('/documents'));
  assert.equal(uploads.length, 2);
  assert.equal(uploads[0].body, uploads[1].body, 'retry preserves multipart payload');
  assert.equal(uploads[1].headers.has('Content-Type'), false, 'browser supplies multipart boundary');
  assert.equal(uploads[1].headers.get('Authorization'), `Bearer ${token('A-new')}`);
  assert.equal(f.context.sessionStorage.getItem('access_token'), token('A-new'));
  f.queryClient.clear();
});

test('deferred document download reads rotated token but rejects a different account', async () => {
  const calls = [];
  const f = await fixture(async (_url, options) => { calls.push(options); return new Response('file'); });
  f.api.setTokens(token('A'), 'refresh-A');
  const download = f.api.api.documentDownloadUrl(1);
  f.context.localStorage.setItem('access_token', token('A-rotated'));
  await download();
  assert.equal(calls[0].headers.get('Authorization'), `Bearer ${token('A-rotated')}`);
  f.api.setTokens(token('B'), 'refresh-B');
  await assert.rejects(download(), { name: 'AbortError' });
  assert.equal(calls.length, 1);
  f.queryClient.clear();
});

test('a late file body is blocked after account switch; failed writes are not retried', async () => {
  const body = deferred(), started = deferred();
  const f = await fixture(async () => {
    const response = new Response('file');
    response.blob = () => { started.resolve(); return body.promise; };
    return response;
  });
  f.api.setTokens(token('A'), 'refresh-A');
  const pending = f.api.api.rentalInvoiceXlsx(1);
  await started.promise;
  f.api.setTokens(token('B'), 'refresh-B'); body.resolve(new Blob(['file']));
  await assert.rejects(pending, { name: 'AbortError' }); f.queryClient.clear();
  let calls = 0;
  const g = await fixture(async () => { calls++; throw new TypeError('network'); });
  g.api.setTokens(token('A'), 'refresh-A');
  await assert.rejects(g.api.api.uploadCarImage(1, new Blob(['file'])), /network/);
  assert.equal(calls, 1); g.queryClient.clear();
});

test('shared device reads deduplicate, preserve in-flight live updates, and accept authoritative wipes', async () => {
  let response = deferred(), calls = 0;
  const f = await fixture(() => { calls++; return response.promise; });
  f.api.setTokens(token('A'), 'refresh-A');
  const store = await f.module('state/devices.js');
  const at = n => `2026-10-06T10:00:${String(n).padStart(2, '0')}Z`;
  f.queryClient.setQueryData(f.qk.devices(), [{ id: 1, display_name: 'old', last_seen_at: at(1), last_fix_at: at(1), last_lat: 37 }]);
  const one = store.loadDeviceSnapshot(), two = store.loadDeviceSnapshot();
  store.updateDeviceList(ds => ds.map(d => ({ ...d, last_seen_at: at(3), last_fix_at: at(3), last_lat: 38 })));
  response.resolve(Response.json([{ id: 1, display_name: 'renamed', last_seen_at: at(2), last_fix_at: at(2), last_lat: 37.1 }]));
  const [a, b] = await Promise.all([one, two]);
  assert.equal(calls, 1); assert.equal(a, b);
  assert.equal(a[0].last_lat, 38); assert.equal(a[0].display_name, 'renamed');
  response = deferred(); const wiped = store.loadDeviceSnapshot();
  response.resolve(Response.json([{ id: 1, last_seen_at: null, last_fix_at: null, last_lat: null }]));
  assert.equal((await wiped)[0].last_lat, null, 'old cache must not resurrect intentionally deleted telemetry');
  response = deferred(); const removed = store.loadDeviceSnapshot();
  store.updateDeviceList(ds => ds.map(d => ({ ...d, last_seen_at: at(4) })));
  response.resolve(Response.json([]));
  assert.equal((await removed).length, 0, 'server owns membership even if live events race');
  f.queryClient.clear();
});

test('device mutations cancel pre-write snapshots and offline provenance survives shared state', async () => {
  const late = deferred(); let calls = 0, offline = false;
  const f = await fixture(() => {
    calls++;
    if (offline) throw new TypeError('network');
    return calls === 1 ? late.promise : Promise.resolve(Response.json([{ id: 2 }]));
  });
  f.api.setTokens(token('A'), 'refresh-A');
  const store = await f.module('state/devices.js');
  const cache = await f.module('lib/offlineCache.js');
  const old = store.loadDeviceSnapshot();
  const cancelled = assert.rejects(old, /CancelledError/);
  await store.cancelDeviceSnapshot(); await cancelled;
  assert.equal((await store.loadDeviceSnapshot())[0].id, 2);
  late.resolve(Response.json([{ id: 1 }])); await Promise.resolve();
  assert.equal(f.queryClient.getQueryData(f.qk.devices())[0].id, 2);
  offline = true;
  const saved = await store.loadDeviceSnapshot();
  assert.equal(cache.isCachedResponse(saved), true);
  store.updateDeviceList(ds => ds.map(d => ({ ...d, display_name: 'live' })));
  assert.equal(cache.isCachedResponse(f.queryClient.getQueryData(f.qk.devices())), true);
  f.queryClient.clear();
});
