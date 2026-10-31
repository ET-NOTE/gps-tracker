// Keep partial results private: errors/cancellation must not look like a complete day.
export async function collectHistory(fetchPage, { signal, onProgress, maxPoints = 250000 } = {}) {
  const points = [], cursors = new Set();
  let cursor;
  do {
    signal?.throwIfAborted();
    const page = await fetchPage(cursor);
    signal?.throwIfAborted();
    if (!Array.isArray(page.items) || page.has_more !== Boolean(page.next_cursor)) {
      throw new Error('이력 응답 형식이 올바르지 않습니다. 다시 조회해 주세요.');
    }
    if (points.length + page.items.length > maxPoints) {
      throw new Error('좌표가 많습니다. 상세 시커에서 시간별 요약을 선택해 주세요.');
    }
    points.push(...page.items);
    onProgress?.(points.length);
    cursor = page.next_cursor;
    if (cursor && cursors.has(cursor)) throw new Error('이력 조회가 진행되지 않습니다. 다시 조회해 주세요.');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return points.sort((a,b) => Date.parse(a.recorded_at)-Date.parse(b.recorded_at) || a.source.localeCompare(b.source));
}

export async function collectAggregates(fetchWindow, bucket, since, until, signal) {
  const interval = { '1m': 60000, '5m': 300000, '1h': 3600000 }[bucket];
  let start = Date.parse(since);
  const end = Date.parse(until);
  if (!interval || !Number.isFinite(start) || !Number.isFinite(end) || end <= start || end-start > 366*86400000) {
    throw new Error('조회 기간을 확인해 주세요.');
  }
  if (bucket === '1m' && end-start > 31*86400000) {
    throw new Error('1분 요약은 최대 31일까지 조회할 수 있습니다. 더 긴 기간은 5분 또는 1시간 요약을 선택해 주세요.');
  }
  const rows = [];
  while (start < end) {
    signal?.throwIfAborted();
    // Split on bucket boundaries so each aggregate belongs to exactly one request.
    const next = Math.min(end, Math.floor(start/interval)*interval + interval*2000);
    const page = await fetchWindow(new Date(start).toISOString(), new Date(next).toISOString());
    signal?.throwIfAborted();
    // Reject malformed/overlapping responses instead of rendering a plausible
    // but incomplete route. The first bucket can start before a partial window.
    const firstBucket = Math.floor(start/interval)*interval;
    let previous = -Infinity;
    if (!Array.isArray(page) || page.length > 2000 || rows.length + page.length > 120000 || page.some(row => {
      const at = Date.parse(row?.bucket);
      const invalid = !Number.isFinite(at) || at % interval !== 0 || at < firstBucket || at >= next || at <= previous;
      previous = at;
      return invalid;
    })) {
      throw new Error('요약 이력을 모두 확인하지 못했습니다. 조회 기간을 줄여 다시 시도해 주세요.');
    }
    rows.push(...page);
    start = next;
  }
  return rows;
}
