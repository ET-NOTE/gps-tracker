import { authScope, assertSession } from '../authSession';
const PREFIX = 'gps_cache_v3:';
const TTL = 24 * 60 * 60 * 1000;
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
        window.dispatchEvent(new Event('gps-offline-data'));
        return item.data;
      }
    } catch { /* invalid cache */ }
    throw e;
  }
}
