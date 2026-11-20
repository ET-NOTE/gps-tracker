// Retry only rejected, read-only location requests. A failed write, an auth
// throttle, a timeout or a partial/network response must never be replayed here.
export const isLocationRead = (method, url) => {
  if (method !== 'GET') return false;
  const path = new URL(url, 'https://local.invalid').pathname;
  return /\/devices\/\d+\/locations(?:\/(?:page|aggregated))?$/.test(path) ||
    /\/corporate\/(?:devices|vehicles)\/\d+\/trips(?:\.csv)?$/.test(path) ||
    /\/corporate\/(?:report\.xlsx|terminals|vehicle-stats|fleet\/trip-stats)$/.test(path);
};

export function retryAfterMs(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : 0;
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('요청이 취소되었습니다.', 'AbortError'));
    };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function retryLocationRead(send, { method, url, signal, assertActive = () => {},
  wait = abortableDelay, random = Math.random } = {}) {
  const eligible = isLocationRead(method, url);
  for (let attempt = 0; ; attempt++) {
    assertActive();
    if (signal?.aborted) throw new DOMException('요청이 취소되었습니다.', 'AbortError');
    const response = await send();
    assertActive();
    if (!eligible || response.status !== 429 || attempt >= 2) return response;
    const payload = await response.clone().json().catch(() => null);
    assertActive();
    if (payload?.code !== 'location_read_busy') return response;
    const minimum = retryAfterMs(response.headers.get('retry-after'));
    // If the server asks for longer, leave manual retry to the user; do not
    // shorten its deadline. Two waits at most, each at most 10 seconds.
    if (minimum > 9500) return response;
    const delay = Math.max(minimum, 1000 * 2 ** attempt) + Math.floor(random() * 500);
    await response.body?.cancel();
    await wait(delay, signal);
  }
}

// Do not multiply the API's three attempts through React Query's own retries.
export const retryQuery = (count, error) => count < 1 && error?.name !== 'AbortError' &&
  ![401, 403, 404, 408, 429].includes(error?.status);
