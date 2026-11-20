import test from 'node:test';
import assert from 'node:assert/strict';
import { isLocationRead, retryLocationRead, retryAfterMs, abortableDelay, retryQuery } from '../src/lib/locationRetry.js';
const url = '/api/v1/devices/7/locations/page?limit=20';
const busy = (after = '2', code = 'location_read_busy') => Response.json({ code }, { status: 429, headers: { 'Retry-After': after } });

test('business reads share overload retry; mutations and other downloads do not', async () => {
  for (const path of ['/corporate/devices/7/trips', '/corporate/vehicles/8/trips',
    '/corporate/devices/7/trips.csv?from=2026-10-01', '/corporate/report.xlsx?month=2026-10',
    '/corporate/terminals', '/corporate/vehicle-stats', '/corporate/fleet/trip-stats']) {
    let calls = 0;
    const result = await retryLocationRead(async () => ++calls === 1 ? busy() : new Response('report'),
      { method: 'GET', url: path, wait: async () => {} });
    assert.equal(calls, 2); assert.equal(await result.text(), 'report');
    assert.equal(isLocationRead('POST', path), false);
  }
  for (const path of ['/corporate/devices/7/trips/annotation', '/corporate/report.xlsx/other',
    '/privacy/requests/7/download', '/corporate/devices/7/trips.csv/delete']) {
    assert.equal(isLocationRead('GET', path), false);
  }
});

test('location overload recovers with bounded jitter and respects Retry-After', async () => {
  let attempts = 0; const waits = [];
  const result = await retryLocationRead(async () => ++attempts < 3 ? busy() : Response.json({ items: [1] }),
    { method: 'GET', url, random: () => .5, wait: async ms => waits.push(ms) });
  assert.equal(attempts, 3); assert.deepEqual(waits, [2250, 2250]);
  assert.deepEqual(await result.json(), { items: [1] });
});

test('persistent overload stops after three requests and React Query cannot multiply retries', async () => {
  let attempts = 0;
  const result = await retryLocationRead(async () => { attempts++; return busy('0'); }, { method: 'GET', url, wait: async () => {} });
  assert.equal(result.status, 429); assert.equal(attempts, 3);
  assert.equal(retryQuery(0, { status: 429 }), false);
  assert.equal(retryQuery(0, { name: 'AbortError' }), false);
  assert.equal(retryQuery(0, { status: 408 }), false);
  assert.equal(retryQuery(0, { status: 503 }), true);
  assert.equal(retryQuery(1, { status: 503 }), false);
});

test('writes, other paths, auth throttles and long Retry-After are never replayed', async () => {
  for (const options of [{ method: 'POST', url }, { method: 'GET', url: '/api/v1/auth/me' },
    { method: 'GET', url, code: 'login_limited' }, { method: 'GET', url, after: '60' }]) {
    let attempts = 0;
    const result = await retryLocationRead(async () => { attempts++; return busy(options.after, options.code); },
      { ...options, wait: async () => assert.fail('must not wait') });
    assert.equal(result.status, 429); assert.equal(attempts, 1);
  }
});

test('HTTP-date and malformed delays; network and timeout failures are not replayed', async () => {
  assert.equal(retryAfterMs('Wed, 11 Nov 2026 00:00:05 GMT', Date.parse('2026-11-11T00:00:00Z')), 5000);
  assert.equal(retryAfterMs('bad'), 0); assert.equal(retryAfterMs('-1'), 0);
  let calls = 0;
  await assert.rejects(retryLocationRead(async () => { calls++; throw new TypeError('network'); }, { method: 'GET', url }), TypeError);
  assert.equal(calls, 1);
  const result = await retryLocationRead(async () => { calls++; return new Response('', { status: 408 }); }, { method: 'GET', url });
  assert.equal(result.status, 408); assert.equal(calls, 2);
});

test('cancel during backoff clears the timer and prevents the next request', async () => {
  const controller = new AbortController(); let calls = 0;
  const result = retryLocationRead(async () => { calls++; return busy(); }, { method: 'GET', url,
    signal: controller.signal, wait: (ms, signal) => { const pending = abortableDelay(ms, signal); controller.abort(); return pending; } });
  await assert.rejects(result, { name: 'AbortError' }); assert.equal(calls, 1);
  await assert.rejects(abortableDelay(10000, controller.signal), { name: 'AbortError' });
});

test('changed account prevents retry even if cancellation event was missed', async () => {
  let active = true, calls = 0;
  await assert.rejects(retryLocationRead(async () => { calls++; return busy(); }, { method: 'GET', url,
    assertActive: () => { if (!active) throw new DOMException('changed account', 'AbortError'); },
    wait: async () => { active = false; } }), { name: 'AbortError' });
  assert.equal(calls, 1);
});
