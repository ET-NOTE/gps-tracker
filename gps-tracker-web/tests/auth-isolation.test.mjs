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
    navigator: {}, crypto: webcrypto, fetch, Event, DOMException, AbortController, FormData,
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
  return { api: api.namespace, qk: keys.namespace.qk, queryClient, context };
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
