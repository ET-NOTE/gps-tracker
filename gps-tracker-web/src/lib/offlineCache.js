import { authScope, assertSession } from '../authSession';
const PREFIX = 'gps_cache_v3:';
const TTL = 24 * 60 * 60 * 1000;
// Keep provenance on the actual response, not a global offline latch. A history
// read in another panel must not mark the live map as offline.
const cachedResponses = new WeakSet();
export const isCachedResponse = data => data != null && typeof data === 'object' && cachedResponses.has(data);
export async function cachedRead(key, fetcher) {
  const scope = authScope();
  const storageKey = PREFIX + scope + ':' + key;
  try {
    const data = await fetcher();
    assertSession(scope);
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
