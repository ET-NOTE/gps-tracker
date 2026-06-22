# GPS Tracker — Texnik Tahlil va Ko'rsatma

> Tahlil sanasi: 2026-06-22  
> Stek: React (Vite, JS) + Rust (Axum + SQLx + PostgreSQL) + KakaoMap

---

## 1. Modularlik — Refaktoring Rejasi

### Muammo: `Dashboard.jsx` monoliti (1773 qator)

`Dashboard.jsx` 44 ta `useState`, 18 ta `useCallback`, WebSocket, API chaqiruvlari,
xarita logikasi, geofence, seeker, corporate panel — hammasini o'z ichiga olgan.
Bu faylni quyidagi tarzda bo'lish tavsiya etiladi:

```
src/
├── hooks/
│   ├── useDevices.js          // listDevices + incremental reload
│   ├── useGeofences.js        // listGeofences + show/hide state
│   ├── useTrackerWS.js        // TrackerWS lifecycle
│   ├── useFilterDevice.js     // filterDeviceId + server prefs sync
│   └── useLiveTracking.js     // userTrackPref + seekerPaused logikasi
├── components/
│   └── ... (mavjud)
└── pages/
    └── Dashboard.jsx          // faqat layout + view routing
```

#### `useDevices.js` — misol

```js
// src/hooks/useDevices.js
import { useState, useCallback, useRef } from 'react';
import { api } from '../api';
import { offlineCache } from '../lib/offlineCache';
import { getDeviceColor, isStale } from '../colors';
import { enrichWithSpeedStops } from '../lib/stops';

export function useDevices(mapRef) {
  const [devices, setDevices] = useState([]);
  const [loaded, setLoaded]   = useState(false);
  const devRef = useRef([]);

  const loadDevices = useCallback(async () => {
    try {
      const list = await api.listDevices();
      setDevices(list);
      setLoaded(true);
      devRef.current = list;
      offlineCache.saveDevices(list);
      // xaritaga markerlarni joylashtirish
      for (const d of list) {
        const locs = await api.listLocations(d.id, { limit: 500, fix_only: true });
        if (!locs?.length) continue;
        const ordered = [...locs].reverse();
        const color = getDeviceColor(d);
        const stale = isStale(d.last_seen_at);
        ordered.forEach((loc, i) => {
          if (!loc.lat || !loc.lng) return;
          const isLast = i === ordered.length - 1;
          mapRef.current?.updateMarker(d.id, loc.lat, loc.lng,
            d.display_name || d.device_uid, color,
            isLast ? { recordedAt: loc.recorded_at, sat: loc.sat,
                       vbatMv: loc.vbat_mv, fix: loc.fix, stale } : { stale });
        });
        mapRef.current?.clearHistoryPoints(d.id);
        enrichWithSpeedStops(ordered).slice(0, -1).forEach(loc => {
          if (!loc.lat || !loc.lng) return;
          mapRef.current?.addHistoryPoint(d.id, loc.lat, loc.lng, color, {
            recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv,
            fix: loc.fix, speedKmh: loc._speed, isStop: loc._isStop,
          });
        });
      }
    } catch {
      const cached = offlineCache.loadDevices();
      if (cached?.length) { setDevices(cached); setLoaded(true); devRef.current = cached; }
    }
  }, [mapRef]);

  return { devices, loaded, devRef, loadDevices, setDevices };
}
```

#### `useTrackerWS.js` — misol

```js
// src/hooks/useTrackerWS.js
import { useEffect, useRef, useState } from 'react';
import { TrackerWS } from '../ws';

export function useTrackerWS(onEvent) {
  const [status, setStatus] = useState('disconnected');
  const wsRef = useRef(null);

  useEffect(() => {
    const ws = new TrackerWS(onEvent, setStatus);
    ws.connect(localStorage.getItem('access_token'));
    wsRef.current = ws;
    return () => ws.disconnect();
  }, [onEvent]);

  return { wsRef, status };
}
```

#### Qisqartirilgan `Dashboard.jsx` strukturasi

```jsx
// src/pages/Dashboard.jsx — faqat layout
export default function Dashboard({ onLogout }) {
  const mapRef = useRef(null);

  const { devices, loaded, devRef, loadDevices } = useDevices(mapRef);
  const { fences, loadFences }                   = useGeofences();
  const { wsRef, status: wsStatus }              = useTrackerWS(handleWsEvent);
  const { filterDeviceId, setFilter }            = useFilterDevice(devices, loaded, mapRef);
  const { trackLive, setUserTrackPref }          = useLiveTracking();

  // handleWsEvent — faqat xarita va devices yangilash
  function handleWsEvent(evt) { /* ... */ }

  return (
    <div className="layout">
      <KakaoMap ref={mapRef} onReady={handleMapReady} ... />
      <BottomNav ... />
      {/* panellar */}
    </div>
  );
}
```

---

## 2. Unumdorlik — Re-render Optimallashtirish

### 2.1. `setTick` anti-pattern (Dashboard.jsx:165, 399)

**Muammo:** `const [, setTick] = useState(0)` + `setTick(x => x + 1)` — butun
komponentni qayta render qilish uchun "soxta" state. Bu `devices`, `fences`, barcha
child komponentlarning re-render'ini qo'zg'atadi.

```js
// ❌ Hozirgi kod
const [, setTick] = useState(0);
// ...
setTick(x => x + 1);  // barcha children re-renders!
```

**Yechim:** Re-render'ning haqiqiy maqsadini aniqlang — asosan "ageString" (qurilma
vaqti yangilanishi). Buning uchun `useRef` + forced re-render o'rniga `useSyncExternalStore`
yoki shunchaki `devices` state'ini yangilang:

```js
// ✅ To'g'ri yondashuv — tick o'rniga devices'ni yangilang
// devices state yangilansa, u depend bo'lgan hamma joy avtomatik yangilanadi.
// Agar faqat "vaqt ko'rinishi" yangilanishi kerak bo'lsa:
const [now, setNow] = useState(() => Date.now());
useEffect(() => {
  const id = setInterval(() => setNow(Date.now()), 30_000);
  return () => clearInterval(id);
}, []);
// ageString(device.last_seen_at, now) — now prop'i sifatida beriladi
```

### 2.2. `loadDevices` va `loadDevicesIncremental` — kod takrorlanishi

Ikkala funksiya deyarli bir xil marker/history drawing logikasini takrorlaydi.
Uni bitta helper'ga ajrating:

```js
// src/lib/deviceMapSync.js
export async function syncDeviceToMap(mapRef, d, lastMetaRef) {
  const locs = await api.listLocations(d.id, { limit: 500, fix_only: true });
  if (!locs?.length) return;
  const ordered = [...locs].reverse();
  const color = getDeviceColor(d);
  const stale = isStale(d.last_seen_at);

  ordered.forEach((loc, i) => {
    if (!loc.lat || !loc.lng) return;
    const isLast = i === ordered.length - 1;
    const meta = isLast
      ? { recordedAt: loc.recorded_at, sat: loc.sat,
          vbatMv: loc.vbat_mv, fix: loc.fix, stale }
      : { stale };
    mapRef.current?.updateMarker(
      d.id, loc.lat, loc.lng, d.display_name || d.device_uid, color, meta
    );
    if (isLast) lastMetaRef.current[d.id] = meta;
  });

  mapRef.current?.clearHistoryPoints(d.id);
  enrichWithSpeedStops(ordered).slice(0, -1).forEach(loc => {
    if (!loc.lat || !loc.lng) return;
    mapRef.current?.addHistoryPoint(d.id, loc.lat, loc.lng, color, {
      recordedAt: loc.recorded_at, sat: loc.sat, vbatMv: loc.vbat_mv,
      fix: loc.fix, speedKmh: loc._speed, isStop: loc._isStop,
    });
  });
}
```

### 2.3. `MiniChart` — `useMemo` bilan optimallashtirish

`MiniChart` hozir har re-render'da SVG path'larni qayta hisoblaydi:

```jsx
// ❌ Hozirgi kod — har render'da hisoblash
function MiniChart({ data, color }) {
  const pathD = data.map(([, v], i) => `...`).join(' ');
  // ...
}

// ✅ useMemo bilan optimallashtirish
function MiniChart({ data, color }) {
  const { pathD, areaD, linePts } = useMemo(() => {
    if (!data || data.length < 2) return {};
    const W = 200, H = 44;
    const vals = data.map(([, v]) => v);
    const min = Math.min(...vals), max = Math.max(...vals);
    const range = max - min || 1;
    const toX = i => (i / (data.length - 1)) * W;
    const toY = v => H - ((v - min) / range) * H;
    const linePts = data.map(([, v], i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
    const pathD = data.map(([, v], i) => `${i === 0 ? 'M' : 'L'}${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(' ');
    const areaD = `${pathD} L${toX(data.length-1).toFixed(1)},${H} L${toX(0).toFixed(1)},${H} Z`;
    return { pathD, areaD, linePts };
  }, [data]);

  if (!pathD) return <div style={{ height: 56 }}><span>기록 없음</span></div>;
  // SVG rendering...
}
```

### 2.4. `KakaoMap.jsx` arrow direction canvas — `useMemo` ekvivalenti

`addHistoryPoint` ichida `canvas.toDataURL` har nuqtada chaqiriladi.
Hozir `arrowCache` ob'ekti funksiya scope'ida har `drawSeekerPath` chaqiruvida qayta yaratiladi:

```js
// ❌ Hozirgi: har drawSeekerPath chaqiruvida yangi cache
const arrowCache = {};
const makeArrowImage = (angleDeg, arrowColor) => { /* ... */ };

// ✅ To'g'ri: module-level cache (KakaoMap.jsx fayli yuklanganda bir marta)
const _arrowImageCache = new Map();
function makeArrowImage(angleDeg, arrowColor) {
  const key = `${Math.round(angleDeg / 5) * 5}_${arrowColor}`;
  if (_arrowImageCache.has(key)) return _arrowImageCache.get(key);
  // canvas drawing...
  const img = /* ... */;
  _arrowImageCache.set(key, img);
  return img;
}
```

### 2.5. `devicesRef` pattern — mavjud yaxshi yondashuv

`devicesRef` (Dashboard.jsx:259-261) — WebSocket callback'larida stale closure
muammosini hal qilish uchun ishlatilgan ref mirror pattern. Bu **to'g'ri** yondashuv.
Uni saqlab qoling:

```js
// ✅ Mavjud kod — to'g'ri pattern
const devicesRef = useRef(devices);
useEffect(() => { devicesRef.current = devices; }, [devices]);
```

---

## 3. Xavfsizlik — Tekshiruv va Tavsiyalar

### 3.1. Backend autentifikatsiya — YAXSHI ✅

`AuthUser` extractor har protected endpoint'da avtomatik ishlaydi:

```rust
// src/auth/extractor.rs — to'g'ri implementatsiya
async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
    let token = header.strip_prefix("Bearer ").ok_or(AppError::Unauthorized)?;
    let claims = jwt::verify(token, &state.config.jwt_secret, "access")
        .map_err(|_| AppError::Unauthorized)?;
    // ...
}
```

GPS koordinatalariga kirish `ensure_owner()` orqali owner tekshiruvi bilan himoyalangan:

```rust
// src/routes/locations.rs — to'g'ri owner tekshiruv
async fn ensure_owner(state: &AppState, device_id: i64, user_id: i64) -> AppResult<()> {
    let exists: Option<i64> = sqlx::query_scalar(
        r#"SELECT id FROM devices WHERE id = $1 AND owner_id = $2"#,
    )
    .bind(device_id).bind(user_id).fetch_optional(&state.db).await?;
    exists.map(|_| ()).ok_or(AppError::NotFound)  // 404 (owner emasligini oshkor qilmaydi)
}
```

### 3.2. Ingest endpoint — XAVFLI ⚠️

`/ingest` endpoint'i **hech qanday autentifikatsiyasiz** yangi device yaratib, GPS
ma'lumotlarini qabul qiladi:

```rust
// src/routes/ingest.rs — hozirgi holat (xavfli)
let device_uid = parsed.device_uid.clone()
    .unwrap_or_else(|| format!("anon-{}", remote_ip));  // ❌ IP asosida yaratish
// device_uid topilmasa → yangi device INSERT qilinadi — kimgadir tegishli bo'lmagan!
```

**Tavsiya:** Ingest'da `api_key` yoki `device_uid` majburiy qilish:

```rust
// src/routes/ingest.rs — tavsiya etilgan yondashuv
pub async fn ingest(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<IngestPayload>,
) -> AppResult<Json<Value>> {
    // device_uid MAJBURIY
    let device_uid = payload.device_uid.as_deref()
        .ok_or_else(|| AppError::BadRequest("device_uid required".into()))?;

    // Mavjud device'ni top — topilmasa 401 (yangi yaratish yo'q)
    let device_id: i64 = sqlx::query_scalar(
        "SELECT id FROM devices WHERE device_uid = $1 OR iccid = $2"
    )
    .bind(device_uid)
    .bind(payload.iccid.as_deref())
    .fetch_optional(&state.db)
    .await?
    .ok_or(AppError::Unauthorized)?;

    // ... qolgan mantiq
}
```

> **Eslatma:** Agar ESP32 firmware'lar hali `device_uid` yuboray olmasalar,
> o'tish davri uchun IP whitelist yoki ICCID-only matching qo'llash mumkin.

### 3.3. JWT localStorage — ma'lum xavf ⚠️

`access_token` localStorage'da saqlanadi — XSS hujumlariga nisbatan kamroq xavfsiz.
Hozirgi implementatsiya buni qisman qoplagan (`remember_me=false` → sessionStorage).

**Tavsiya:** Eng xavfsiz variant — `httpOnly` cookie:

```rust
// src/routes/auth.rs — httpOnly cookie orqali token
use axum_extra::extract::cookie::{Cookie, SameSite};
use axum_extra::TypedHeader;
use headers::SetCookie;

// Login response'ida:
let cookie = Cookie::build("access_token", access_token)
    .http_only(true)
    .secure(true)         // faqat HTTPS
    .same_site(SameSite::Strict)
    .path("/")
    .max_age(Duration::minutes(15))
    .finish();
```

```js
// Frontend api.js — Authorization header o'rniga cookie avtomatik yuboriladi
// fetch() da credentials: 'include' qo'shish kifoya
const res = await fetch(BASE + path, {
  method,
  credentials: 'include',  // cookie'ni yuboradi
  headers: { 'Content-Type': 'application/json' },
  body: body !== undefined ? JSON.stringify(body) : undefined,
});
```

### 3.4. Refresh token — JTI tekshiruvi yo'q ⚠️

`issue_refresh` JTI (jti) bilan token yaratadi, lekin `verify`'da JTI revocation
ro'yxatiga tekshirish yo'q — logout qilingan refresh token'lar hali ham ishlaydi:

```rust
// src/auth/jwt.rs — hozir JTI tekshirilmaydi
pub fn verify(token: &str, secret: &str, expected_typ: &str) -> Result<Claims, Error> {
    let data = decode::<Claims>(/* ... */)?;
    if data.claims.typ != expected_typ { return Err(...); }
    Ok(data.claims)  // ❌ JTI revocation tekshirilmaydi
}
```

**Tavsiya:** Logout'da JTI'ni `revoked_tokens` jadvaliga qo'shish va `verify`'da tekshirish:

```rust
// Migration: revoked_tokens jadvali
// CREATE TABLE revoked_tokens (jti TEXT PRIMARY KEY, expires_at TIMESTAMPTZ);

// src/auth/jwt.rs — JTI tekshiruv qo'shish
pub async fn verify_refresh_with_revocation(
    token: &str, secret: &str, db: &sqlx::PgPool
) -> Result<Claims, AppError> {
    let claims = verify(token, secret, "refresh")
        .map_err(|_| AppError::Unauthorized)?;
    if let Some(jti) = &claims.jti {
        let revoked: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM revoked_tokens WHERE jti = $1)"
        )
        .bind(jti).fetch_one(db).await?;
        if revoked { return Err(AppError::Unauthorized); }
    }
    Ok(claims)
}

// Logout handler'da:
pub async fn logout(State(state): State<AppState>, user: AuthUser, ...) {
    if let Some(jti) = &claims.jti {
        sqlx::query("INSERT INTO revoked_tokens (jti, expires_at) VALUES ($1, $2)")
            .bind(jti).bind(expires_at)
            .execute(&state.db).await.ok();
    }
}
```

---

## 4. Texnik Qarz — Ro'yxat va Yaxshilanish Rejalari

### 4.1. `window.__btw_openRoadview` global ifloslanishi — ORTA ⚠️

`KakaoMap.jsx` global `window` ob'ektiga yozadi — bu noto'g'ri pattern:

```js
// ❌ Hozirgi kod (KakaoMap.jsx)
window.__btw_openRoadview = (lat, lng) => onRoadviewRef.current?.({ lat, lng });
```

**Yechim:** KakaoMap InfoWindow HTML'da inline JS o'rniga `CustomEvent` ishlatish:

```js
// ✅ KakaoMap.jsx — CustomEvent orqali
function roadviewBtn(lat, lng) {
  // data-attribute orqali parametr uzatish
  return `<button 
    data-roadview-lat="${lat}" 
    data-roadview-lng="${lng}"
    class="roadview-btn"
    onclick="this.dispatchEvent(new CustomEvent('roadview-request', {
      bubbles: true, detail: { lat: ${lat}, lng: ${lng} }
    }))"
    style="...">
    ${SVG_CAM} 로드뷰 보기
  </button>`;
}

// KakaoMap.jsx containerRef'da event delegation
containerRef.current.addEventListener('roadview-request', (e) => {
  onRoadviewRef.current?.(e.detail);
});
```

### 4.2. `LegalPage.jsx` — Deploy'dan oldin to'ldirish kerak 🔴

```js
// src/pages/LegalPage.jsx:4
const TODO = '[ TODO — 발효 전 사업자 정보 / 법률 검토 필요 ]';
// privacy va terms sahifalarida ishlatilgan — real ma'lumot kiritilmagan
```

### 4.3. `devices.rs` — SIM auto-pairing TODO

```rust
// src/routes/devices.rs:3
// Phase 2 (TODO): SIM7080G ICCID/IMSI/IMEI 기반 자동 페어링.
```
Ingest endpoint ICCID matching allaqachon ishlayapti — bu TODO endi faqat
foydalanuvchi UI qismini qamrab oladi.

### 4.4. `filterDeviceId` effect'ida `eslint-disable` — KICHIK ⚠️

```js
// Dashboard.jsx:586
}, [filterDeviceId]);   // eslint-disable-line react-hooks/exhaustive-deps
```

`userPrefs` deps'dan chiqarilgan — agar `userPrefs` o'zgarsa effect qayta ishlamaydi.
`filterAppliedRef` logikasi buni qisman qoplaydi, lekin `patchMyPrefs` response'ini
state'ga yozish xavfli bo'lishi mumkin. Eng xavfsiz variant:

```js
useEffect(() => {
  if (!filterAppliedRef.current) return;
  clearTimeout(filterSaveTimerRef.current);
  filterSaveTimerRef.current = setTimeout(() => {
    api.patchMyPrefs({ filter_device_id: filterDeviceId }).catch(() => {});
    // setUserPrefs ni BU YERDA chaqirmang — yangi fetchlarga sabab bo'ladi
  }, 200);
}, [filterDeviceId]);
```

### 4.5. `api.js` — `tripsCsv` da `localStorage` to'g'ridan-to'g'ri

```js
// api.js — sessionStorage foydalanuvchilar uchun ishlamas
const tok = localStorage.getItem('access_token');  // ❌ sessionStorage e'tiborga olinmagan
```

```js
// ✅ activeStorage() ishlatish
const tok = getToken();  // getToken() activeStorage() dan oladi
```

### 4.6. `pinImageCache` — xotira oqishi xavfi (kichik)

`pinImageCache` Map'i KakaoMap.jsx module-level'da, komponent unmount bo'lganda
tozalanmaydi. Amalda faqat bir necha rang varianti bo'lgani uchun katta muammo emas,
lekin tozaroq pattern:

```js
// KakaoMap.jsx — foydalanadigan komponent ichiga ko'chirish yoki WeakMap
// Hozirgi ko'rinishda: ~10 rang × ~300 byte = ~3KB — amalda muammo emas
// Yaxshilanish: LRU cache yoki komponent unmount'da tozalash
```

### 4.7. `addrCacheRef` + `localStorage` — ikki qatlamli cache to'g'ri ✅

`resolveAddress` funksiyasi (KakaoMap.jsx) in-memory + localStorage 30 kunlik TTL
bilan yuqori sifatli implementatsiya. Saqlab qoling.

---

## Ustuvorlik bo'yicha xulosa

| # | Muammo | Muhimlik | Murakkablik |
|---|--------|----------|-------------|
| 1 | Ingest endpoint'i autentifikatsiyasiz | 🔴 Yuqori | O'rta |
| 2 | `LegalPage` TODO to'ldirilmagan | 🔴 Yuqori | Past |
| 3 | JWT refresh token revocation yo'q | 🟡 O'rta | O'rta |
| 4 | `Dashboard.jsx` monoliti | 🟡 O'rta | Yuqori |
| 5 | `setTick` anti-pattern | 🟡 O'rta | Past |
| 6 | `window.__btw_openRoadview` global | 🟢 Past | Past |
| 7 | `tripsCsv` localStorage to'g'ridan | 🟢 Past | Past |
| 8 | Arrow canvas cache scope | 🟢 Past | Past |
