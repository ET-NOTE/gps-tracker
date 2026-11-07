import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalysisRequester } from '../src/lib/aiRequest.js';

test('lost response and reload reuse ID; intentional new analysis uses a new ID', async () => {
  const values = new Map();
  const storage = { getItem: k => values.get(k), setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
  const requests = []; let counter = 0;
  const options = { storage, uuid: () => `id-${++counter}`, send: async (device, body) => {
    requests.push({ device, ...body });
    if (requests.length === 1) throw Error('response lost');
    return { analysis_id: 5, analysis: '완료' };
  }};
  const first = createAnalysisRequester(options);
  const one = first('user-a', 1, '2026-10-08');
  assert.equal(first('user-a', 1, '2026-10-08'), one);
  await assert.rejects(one);
  const reloaded = createAnalysisRequester(options);
  await reloaded('user-a', 1, '2026-10-08');
  assert.equal(requests[0].request_id, requests[1].request_id);
  await reloaded('user-a', 1, '2026-10-08');
  assert.notEqual(requests[1].request_id, requests[2].request_id);
});

test('accounts/dates are isolated; malformed success retains the request ID', async () => {
  const values = new Map(); let seq = 0;
  const calls = [];
  const run = createAnalysisRequester({
    storage: { getItem:k=>values.get(k), setItem:(k,v)=>values.set(k,v), removeItem:k=>values.delete(k) },
    uuid: () => `id-${++seq}`, send: async (_, body) => { calls.push(body); return {}; },
  });
  await assert.rejects(run('a', 1, '2026-10-08'));
  await assert.rejects(run('b', 1, '2026-10-08'));
  await assert.rejects(run('a', 1, '2026-10-09'));
  await assert.rejects(run('a', 1, '2026-10-08'));
  assert.notEqual(calls[0].request_id, calls[1].request_id);
  assert.notEqual(calls[0].request_id, calls[2].request_id);
  assert.equal(calls[0].request_id, calls[3].request_id);
});
