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
  const rows = [];
  while (start < end) {
    signal?.throwIfAborted();
    // Split on bucket boundaries so each aggregate belongs to exactly one request.
    const next = Math.min(end, Math.floor(start/interval)*interval + interval*2000);
    const page = await fetchWindow(new Date(start).toISOString(), new Date(next).toISOString());
    signal?.throwIfAborted();
    rows.push(...page);
    start = next;
  }
  return rows;
}
