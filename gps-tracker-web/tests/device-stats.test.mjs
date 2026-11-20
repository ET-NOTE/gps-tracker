import test from 'node:test';
import assert from 'node:assert/strict';
import { todayStats, formatDistance, formatDuration } from '../src/lib/deviceStats.js';

test('today uses the KST date rather than the newest available historic row', () => {
  const rows = [{ date: '2026-10-05', distance_m: 1200 }, { date: '2026-10-06', distance_m: 0 }];
  assert.equal(todayStats(rows, '2026-10-05T15:01:00Z').distance_m, 0);
  assert.equal(todayStats(rows, '2026-10-06T15:01:00Z'), undefined);
  assert.equal(todayStats(undefined), undefined);
});
test('zero movement is a valid reading, missing metrics stay unknown', () => {
  assert.equal(formatDistance(0), '0.0'); assert.equal(formatDuration(0), '0분');
  assert.equal(formatDistance(null), '—'); assert.equal(formatDuration(undefined), '—');
  assert.equal(formatDistance(NaN), '—'); assert.equal(formatDuration(-1), '—');
  assert.equal(formatDuration(30), '30초'); assert.equal(formatDuration(3660), '1시간 1분');
});
