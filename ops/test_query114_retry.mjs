// Only used in the disposable internal query114 Docker network.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { retryLocationRead } from '/work/gps-tracker-web/src/lib/locationRetry.js';
const fixture = JSON.parse(await fs.readFile('/test/request.json', 'utf8'));
assert.match(fixture.url, /^http:\/\/gps-provision22-api-20261111query114:3043\//);
const started = Date.now();
const results = await Promise.all(Array.from({ length: 8 }, async () => {
  const statuses = [];
  const response = await retryLocationRead(async () => {
    const res = await fetch(fixture.url, { headers: { Authorization: 'Bearer ' + fixture.token } });
    statuses.push(res.status);
    return res;
  }, { method: 'GET', url: fixture.url });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(payload, fixture.expected);
  assert.ok(statuses.includes(429));
  assert.ok(statuses.length <= 3);
  return { statuses };
}));
console.log(JSON.stringify({ passed: true, seconds: (Date.now() - started) / 1000, results }));
