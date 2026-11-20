import { authScope, assertSession } from '../authSession';
const PREFIX = 'gps_cache_v3:';
const EPOCH = 'gps_location_cache_epoch';
export function clearLocationCache() {
  // Also invalidate reads that started before the successful control change.
  localStorage.setItem(EPOCH, crypto.randomUUID());
  for (const key of Object.keys(localStorage)) if (key.startsWith(PREFIX)) localStorage.removeItem(key);
}
const TTL = 24 * 60 * 60 * 1000;
// Keep provenance on the actual response, not a global offline latch. A history
// read in another panel must not mark the live map as offline.
const cachedResponses = new WeakSet();
export const isCachedResponse = data => data != null && typeof data === 'object' && cachedResponses.has(data);
export function carryCacheProvenance(source, result) {
  if (isCachedResponse(source) && result && typeof result === 'object') cachedResponses.add(result);
  return result;
}
export async function cachedRead(key, fetcher) {
  const scope = authScope();
  const epoch = localStorage.getItem(EPOCH);
  const storageKey = PREFIX + scope + ':' + key;
  try {
    const data = await fetcher();
    assertSession(scope);
    if (localStorage.getItem(EPOCH) !== epoch) { const e = new Error('위치정보 설정이 변경되었습니다.'); e.status=423; throw e; }
    if (scope !== 'anonymous') {
      try { localStorage.setItem(storageKey, JSON.stringify({ at: Date.now(), data })); } catch { /* quota: online data still works */ }
    }
    return data;
  } catch (e) {
    assertSession(scope);
    // Authorization and server errors must not resurrect previously visible records.
    if (e.name === 'AbortError' || (e.status && e.status !== 0)) throw e;
    try {
      const item = JSON.parse(localStorage.getItem(storageKey));
      if (item && Date.now() - item.at < TTL) {
        if (item.data != null && typeof item.data === 'object') cachedResponses.add(item.data);
        return item.data;
      }
    } catch { /* invalid cache */ }
    throw e;
  }
}
