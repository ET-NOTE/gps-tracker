// (2026-07-28) Phase F5-c — Service Worker.
//
// 전략:
//   - HTML (navigate) : network-first, cache fallback (오프라인 shell 유지)
//   - /assets/* (hash-filename JS/CSS): cache-first (파일명이 hash 라 stale 걱정 X)
//   - /icon-*, /favicon.ico, /og-image.png: cache-first
//   - /gps-tracker/api/, /api/, WS: SW 개입 안 함 (실시간 데이터 SW 캐시 부적합)
//   - /gps-tracker/ingest, /gps-tracker/ws/: 우회
//
// 버전 관리: CACHE_VERSION 을 배포마다 bump (지금은 build hash 대체용 timestamp).

const CACHE_VERSION = 'v1-2026-07-28';
const CACHE_HTML    = `html-${CACHE_VERSION}`;
const CACHE_ASSETS  = `assets-${CACHE_VERSION}`;
const CACHE_ICONS   = `icons-${CACHE_VERSION}`;

self.addEventListener('install', (event) => {
  // 새 SW 준비되면 즉시 대기 (waiting) — 활성화는 skipWaiting 이후.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // 이전 버전 캐시 정리.
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.endsWith(CACHE_VERSION) === false)
      .map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 다른 origin (kakao maps SDK 등) 은 개입 안 함.
  if (url.origin !== self.location.origin) return;

  // API / ingest / WS 는 SW 개입 안 함.
  if (url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/gps-tracker/api/') ||
      url.pathname.startsWith('/gps-tracker/ingest') ||
      url.pathname.startsWith('/gps-tracker/ws') ||
      url.pathname.startsWith('/ws')) {
    return;
  }

  // HTML navigate — network-first, fallback to cache.
  if (req.mode === 'navigate' || (req.headers.get('accept') || '').includes('text/html')) {
    event.respondWith(networkFirst(req, CACHE_HTML));
    return;
  }

  // /assets/* (Vite hash 파일들) — cache-first.
  if (url.pathname.includes('/assets/')) {
    event.respondWith(cacheFirst(req, CACHE_ASSETS));
    return;
  }

  // icon/favicon/og-image — cache-first.
  if (/^\/(icon-\d+\.png|favicon\.ico|apple-touch-icon\.png|og-image\.png|logo\.png)$/.test(url.pathname)) {
    event.respondWith(cacheFirst(req, CACHE_ICONS));
    return;
  }

  // manifest.webmanifest, sw.js 자체 등은 그냥 네트워크로.
});

async function networkFirst(req, cacheName) {
  try {
    const res = await fetch(req);
    // 성공 (2xx) 만 캐시 저장.
    if (res && res.ok) {
      const clone = res.clone();
      caches.open(cacheName).then(c => c.put(req, clone)).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req, { cacheName });
    if (cached) return cached;
    // HTML fallback: 마지막 저장된 shell.
    const shell = await caches.match('/');
    if (shell) return shell;
    throw err;
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    if (cached) return cached;
    throw err;
  }
}
