import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QueryClient } from '@tanstack/react-query';
import { webcrypto } from 'node:crypto';
import { createServer } from 'node:http';

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
    navigator: {}, crypto: webcrypto, fetch, Event, CustomEvent, DOMException, AbortController, FormData, Headers, URL, URLSearchParams,
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
    await m.link((specifier, referring) => load(path.resolve(path.dirname(referring.identifier), specifier.endsWith('.js')?specifier:specifier + '.js').replaceAll('\\', '/')));
    return m;
  }
  const api = await load(path.join(src, 'api.js').replaceAll('\\', '/')); await api.evaluate();
  const keys = await load(path.join(src, 'state/keys.js').replaceAll('\\', '/')); await keys.evaluate();
  return { api: api.namespace, qk: keys.namespace.qk, queryClient, context, module: async name => {
    const m = await load(path.join(src, name).replaceAll('\\', '/')); await m.evaluate(); return m.namespace;
  } };
}

// Exercise the real API client over loopback HTTP with synthetic responses.
// This does not run the Rust route, authentication server, or database.
async function mockDownloadHttp(t, respond) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, method: request.method, headers: request.headers });
    respond(response, requests.length);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const f = await fixture((url, options) => {
    const target = new URL(url, origin);
    assert.equal(target.origin, origin, 'test requests must stay on the loopback fixture');
    return fetch(target, options);
  });
  t.after(() => f.queryClient.clear());
  return { ...f, requests, origin };
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
test('company requests carry explicit scope; personal history remains unscoped', async () => {
  const calls=[];
  const f=await fixture(async(url,options)=>{
    calls.push({url,owner:options.headers.get('X-Fleet-Owner')});
    if(url.includes('/locations/page'))return Response.json({items:[],has_more:false,next_cursor:null});
    return Response.json([]);
  });
  f.api.setTokens(token('A'),'refresh-A');
  const fleet=await f.module('lib/fleetSession.js');fleet.setFleetOwner(12);
  await f.api.api.listFleetVehicles();
  await f.api.api.listLocationPoints(1,{since:'2026-10-01T00:00:00Z',until:'2026-10-01T01:00:00Z'});
  await f.api.api.getDeviceLocationsAggregated(1,'1m','2026-10-01T00:00:00Z','2026-10-01T01:00:00Z');
  assert.equal(calls[0].owner,'12');assert.equal(calls[1].owner,null);assert.equal(calls[2].owner,null);
  f.queryClient.clear();
});
test('company switch cancels late JSON and deferred private download before transmission', async()=>{
  const pending=deferred();let calls=0;
  const f=await fixture(()=>{calls++;return pending.promise;});
  f.api.setTokens(token('A'),'refresh-A');
  const fleet=await f.module('lib/fleetSession.js');fleet.setFleetOwner(12);
  const read=f.api.api.listFleetVehicles(),download=f.api.api.documentDownloadUrl(1);
  fleet.setFleetOwner(13);pending.resolve(Response.json([{id:1}]));
  await assert.rejects(read,{name:'AbortError'});await assert.rejects(download(),{name:'AbortError'});
  assert.equal(calls,1);f.queryClient.clear();
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

test('reportXlsx mock HTTP contract preserves Korean filenames, filters, company scope and binary bytes', { timeout: 5000 }, async t => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x80, 0xff, 0x0d, 0x0a, 0x00]);
  const filename = '운행기록부_2026-11_nts_목적-업무-출퇴근.xlsx';
  const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const f = await mockDownloadHttp(t, response => {
    response.writeHead(200, {
      'Content-Type': mime,
      'Content-Disposition': `attachment; filename="fallback.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    response.end(bytes);
  });
  f.api.setTokens(token('A'), 'refresh-A', false);
  const fleet = await f.module('lib/fleetSession.js'); fleet.setFleetOwner(12);
  const result = await f.api.api.reportXlsx({
    type: 'nts', month: '2026-11', scope: 'vehicles', vehicle_ids: [11, 23],
    purposes: ['business', 'commute'], departments: ['영업 1팀', '(부서없음)', 'R&D 지원'],
  });
  assert.equal(f.requests.length, 1);
  const request = f.requests[0], url = new URL(request.url, f.origin);
  assert.equal(request.method, 'GET');
  assert.equal(url.pathname, '/gps-tracker/api/v1/corporate/report.xlsx');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    scope: 'vehicles', vehicle_ids: '11,23', type: 'nts', month: '2026-11',
    purposes: 'business,commute', departments: '영업 1팀,(부서없음),R&D 지원',
  });
  assert.equal(request.headers['x-fleet-owner'], '12');
  assert.equal(request.headers.authorization, `Bearer ${token('A')}`);
  assert.equal(result.filename, filename, 'UTF-8 filename takes precedence over the ASCII fallback');
  assert.equal(result.blob.type, mime);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
});

test('reportXlsx missing-header filenames describe requested scope without inventing vehicle identities', { timeout: 5000 }, async t => {
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  const f = await mockDownloadHttp(t, response => {
    response.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    response.end(bytes);
  });
  f.api.setTokens(token('A'), 'refresh-A');
  const cases = [
    [{ month: '2026-11' }, '운행기록부_전체차량_202611_우리양식.xlsx'],
    [{ month: '2026-11', type: 'nts', scope: 'vehicles', vehicle_ids: [23, 11, 23], purposes: ['commute', 'business', 'business'] },
      '운행기록부_선택요청2대_202611_국세청양식_목적-업무-출퇴근.xlsx'],
    [{ month: '2026-11', scope: 'vehicles', vehicle_ids: [23, 11], departments: ['../PRIVATE-DEPARTMENT'] },
      '운행기록부_조건선택_202611_우리양식.xlsx'],
    [{ month: '2026-11', scope: 'vehicles', vehicle_ids: [] }, '운행기록부_대상차량없음_202611_우리양식.xlsx'],
    [{ month: '2026-11', device_ids: [23, '23'], departments: [' '] }, '운행기록부_선택요청1대_202611_우리양식.xlsx'],
    [{ month: '2026-11', purposes: ['other', 'commute', 'business', 'unspecified', 'business'] },
      '운행기록부_전체차량_202611_우리양식.xlsx'],
    [{ month: '../PRIVATE\r\n2026:11', type: '../PRIVATE', purposes: ['../PRIVATE', 'business'] },
      '운행기록부_전체차량_조회월_우리양식_목적-업무-알수없는목적.xlsx'],
  ];
  for (const [params, expected] of cases) {
    const result = await f.api.api.reportXlsx(params);
    assert.equal(result.filename, expected);
    assert.doesNotMatch(result.filename, /[\\/:"<>?*|\r\n]|PRIVATE/);
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
  }
  assert.equal(f.requests.length, cases.length);
  const selected = new URL(f.requests[1].url, f.origin).searchParams;
  assert.equal(selected.get('vehicle_ids'), '23,11,23', 'filename normalization does not change the request');
  assert.equal(selected.get('purposes'), 'commute,business,business');
});

test('reportXlsx plain filename header takes precedence over fallback selection metadata', async () => {
  const f = await fixture(async () => new Response('file', {
    headers: { 'Content-Disposition': 'attachment; filename="server-resolved.xlsx"' },
  }));
  try {
    f.api.setTokens(token('A'), 'refresh-A');
    const result = await f.api.api.reportXlsx({ month: '2026-11', scope: 'vehicles', vehicle_ids: [23, 11] });
    assert.equal(result.filename, 'server-resolved.xlsx');
  } finally { f.queryClient.clear(); }
});

test('reportXlsx mock HTTP contract surfaces a 403 JSON error and preserves parameters on manual retry', { timeout: 5000 }, async t => {
  const message = '선택한 회사의 운행기록부를 내려받을 권한이 없습니다.';
  const bytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  const filename = '운행기록부_2026-11_nts_목적-업무.xlsx';
  const f = await mockDownloadHttp(t, (response, attempt) => {
    if (attempt === 1) {
      response.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: message }));
      return;
    }
    response.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    });
    response.end(bytes);
  });
  f.api.setTokens(token('A'), 'refresh-A');
  const fleet = await f.module('lib/fleetSession.js'); fleet.setFleetOwner(12);
  const params = { type: 'nts', month: '2026-11', scope: 'vehicles', vehicle_ids: [23], purposes: ['business'], departments: ['영업부'] };
  await assert.rejects(f.api.api.reportXlsx(params), { message });
  assert.equal(f.requests.length, 1, '403 must not trigger automatic refresh or download retries');
  assert.equal(f.api.activeStorage().getItem('access_token'), token('A'));
  const result = await f.api.api.reportXlsx(params);
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[1].url, f.requests[0].url, 'manual retry retains the selected month, vehicle and purpose filters');
  for (const request of f.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(request.headers['x-fleet-owner'], '12');
    assert.equal(request.headers.authorization, `Bearer ${token('A')}`);
  }
  assert.equal(result.filename, filename);
  assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
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

test('report busy retry preserves company and stops after company/account changes', async () => {
  for (const change of ['none', 'company', 'account']) {
    const calls = [];
    const f = await fixture(async (url, options) => {
      calls.push({ url, owner: options.headers.get('X-Fleet-Owner') });
      return calls.length === 1
        ? Response.json({ code: 'location_read_busy' }, { status: 429, headers: { 'Retry-After': '2' } })
        : new Response('report');
    });
    f.api.setTokens(token('A'), 'refresh-A');
    const fleet = await f.module('lib/fleetSession.js'); fleet.setFleetOwner(12);
    f.context.setTimeout = fn => {
      if (change === 'company') fleet.setFleetOwner(13);
      if (change === 'account') f.api.clearTokens();
      return setTimeout(fn, 0);
    };
    f.context.clearTimeout = clearTimeout;
    const pending = change === 'company' ? f.api.api.reportXlsx() : f.api.api.tripsCsv(1);
    if (change === 'none') {
      assert.equal(await (await pending).blob.text(), 'report');
      assert.equal(calls.length, 2); assert.ok(calls.every(c => c.owner === '12'));
    } else {
      await assert.rejects(pending, { name: 'AbortError' }); assert.equal(calls.length, 1);
    }
    f.queryClient.clear();
  }
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


test('admin step-up never leaks to personal requests; sign-out clears elevated session',async()=>{
 const seen=[];const f=await fixture(async(url,o)=>{seen.push({url,step:o.headers.get('X-Admin-Session')});return Response.json([]);});
 f.api.setTokens(token('A'),'refresh-A');f.context.sessionStorage.setItem('gps_admin_session','step-up-only');
 await f.api.api.adminPrincipals();await f.api.api.listFleetVehicles();
 assert.equal(seen[0].step,'step-up-only');assert.equal(seen[1].step,null);
 f.api.clearTokens();assert.equal(f.context.sessionStorage.getItem('gps_admin_session'),null);f.queryClient.clear();
});
test('protected writes propose first; only explicit approved execution sends original mutation',async()=>{
 const seen=[];const f=await fixture(async(url,o)=>{seen.push({url,method:o.method,approval:o.headers.get('X-Admin-Approval'),body:JSON.parse(o.body||'null')});return Response.json({id:17});});
 f.api.setTokens(token('A'),'refresh-A');f.context.sessionStorage.setItem('gps_admin_enforced','on');
 const a={id:17,method:'PATCH',path:'/admin/security/principals/12',payload:{role:'handler'}};
 // UI action without approval cannot submit the mutation at all.
 await assert.rejects(f.api.api.adminExecuteApproval({...a,id:undefined}),/승인 요청/);
 assert.equal(seen.length,1);assert.ok(seen[0].url.endsWith('/admin/security/approvals'));
 await f.api.api.adminExecuteApproval(a);assert.equal(seen[1].approval,'17');assert.equal(seen[1].method,'PATCH');f.queryClient.clear();
});
test('wrong MFA credentials are not retried through ordinary refresh',async()=>{
 let calls=0;const f=await fixture(async()=>{calls++;return Response.json({error:'unauthorized'},{status:401});});
 f.api.setTokens(token('A'),'refresh-A');await assert.rejects(f.api.api.adminMfaVerify('wrong','000000'));
 assert.equal(calls,1);f.queryClient.clear();
});


test('location history aborts the HTTP request on logout; saved data is not resurrected', async () => {
  let signal;
  const f = await fixture((_url, options) => new Promise((_resolve, reject) => {
    signal = options.signal;
    signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
  }));
  f.api.setTokens(token('A'), 'refresh-A');
  const read = f.api.api.listLocationsGrouped(7, { limit: 2 });
  assert.equal(signal.aborted, false);
  f.api.clearTokens();
  assert.equal(signal.aborted, true);
  await assert.rejects(read, { name: 'AbortError' });
  f.queryClient.clear();
});

test('logout cancels a real 429 backoff before a replacement account can send it', async () => {
  let calls = 0, notifyWait, cleared = 0;
  const waiting = new Promise(resolve => { notifyWait = resolve; });
  const f = await fixture(async () => { calls++; return Response.json({ code: 'location_read_busy' },
    { status: 429, headers: { 'Retry-After': '2' } }); });
  f.api.setTokens(token('A'), 'refresh-A');
  f.context.setTimeout = (_callback, ms) => { if (ms < 10000) notifyWait(); return 99; };
  f.context.clearTimeout = () => { cleared++; };
  const read = f.api.api.listLocationPoints(7, { since: '2026-10-01', until: '2026-10-02' });
  await waiting;
  f.api.clearTokens(); f.api.setTokens(token('B'), 'refresh-B');
  await assert.rejects(read, { name: 'AbortError' });
  assert.equal(calls, 1); assert.ok(cleared > 0);
  f.queryClient.clear();
});
