# 6. 프론트 — React + Kakao Maps

> React SPA + Kakao Maps + WebSocket. 하루 2000 fix × device 5개 = 10K vertex 를 60fps 로 그리는 게 은근 도전. 폴리라인 O(N²) → O(N), userPrefs 서버 sync, WS 24시간 방치 대응, opacity 로 시간 진행 표현.

## Stack

- **React 18 + Vite** — SPA + hot reload + 빠른 build
- **Kakao Maps SDK v2** — 국내 지도 정확도 우수 (Google Maps 대비 골목/신축 아파트 반영 빠름)
- **react-router-dom v6** — SPA 라우팅
- **일반 CSS + inline style** — Tailwind/CSS-in-JS 안 씀. 단순 유지

번들:
- 초기 vite build 결과: **555 KB → gzip 166 KB** (30%)
- gzip 사고 (nginx 미적용) 로 실 서빙이 570 KB raw 였음 → nginx 수정 후 164 KB (사고 #4 참조)
- 이후 vite `manualChunks` + `React.lazy` 로 **초기 index 272 KB, vendor 163 KB (캐시)** → 재방문 시 -52%

## 3가지 뷰

### 홈 (실시간 지도)

- Device 리스트 sidebar (배터리 · 마지막 seen · 안테나 등 요약)
- Kakao map 에 각 device 마커 + 하루 궤적 폴리라인
- WebSocket 으로 실시간 위치 push → 마커 이동 + 폴리라인 append

### Seeker (일자별 재생)

- 특정 device, 특정 날짜 선택
- 24시간 시간 슬라이더 (또는 슬롯 06-12, 12-18, 18-24)
- 폴리라인 + 화살표 (진행 방향) + 정지 마커 (5분+ 정지)
- 재생 기능 (cursor 마커가 시간 흐름 따라 이동)

### Diagnostic (진단)

- Firmware 이벤트 (wake, sleep_enter, brownout, stuck 등) 시계열 표
- 사이클별 분류 (14_* 진단 sketch 시절 build_tag 기반)

## 핵심 도전 1 — 폴리라인 성능

Kakao maps 의 `Polyline.setPath(coords)` 는 canvas 재렌더 O(N). 매 fix 마다 setPath 호출하면:

```
1번째 fix: setPath([1]) — 1 vertex
2번째 fix: setPath([1,2]) — 2 vertex
...
2000번째 fix: setPath([1..2000]) — 2000 vertex
Total: 1+2+...+2000 = 2,001,000 vertex 재렌더 = O(N²)
```

**Fix (PR #120)**:

```js
// 옵션 deferPolyline=true → coords 만 push, setPath skip
if (deferPoly) {
  lastSeg.coords.push(pos);
  // setPath 안 호출
} else {
  lastSeg.coords.push(pos);
  lastSeg.poly.setPath(lastSeg.coords);
}

// 나중에 한 번만
flushLiveTrail(deviceId) {
  entry.segments.forEach(seg => seg.poly.setPath(seg.coords));
}
```

Dashboard bulk 루프:

```js
ordered.forEach((loc, i) => {
  const isLast = (i === ordered.length - 1);
  mapRef.current?.updateMarker(d.id, loc.lat, loc.lng, label, color, meta, {
    deferPolyline: !isLast   // 마지막 fix 만 setPath 트리거
  });
});
mapRef.current?.flushLiveTrail?.(d.id);   // 명시 flush
```

**결과**: 2,001,000 vertex → **2000 vertex + 1 setPath = O(N)**. 약 500배 계산량 감소. 실사용 초 단위 lag → 100ms 이하.

## 핵심 도전 2 — Batch fixes 실시간 처리 (순간이동 사고)

Firmware batch fix payload 가 15초마다 도착. 처음엔:

```js
if (msg.lat && msg.lng) {
  updateMarker(deviceId, msg.lat, msg.lng);   // top-level lat/lng 하나만
}
```

**증상**: 자동차 30km/h 이동 중이면 15초에 125m 이동. 지도에 폴리라인이 **125m 직선** 으로 그려짐 = "순간이동" 처럼 보임.

**Fix (PR #116)**: `msg.fixes[]` (batch) 를 순차 처리 → 각 fix 마다 marker/polyline update.

```js
if (Array.isArray(msg.fixes) && msg.fixes.length > 0) {
  for (let i = 0; i < msg.fixes.length; i++) {
    const f = msg.fixes[i];
    if (f.lat == null || f.lng == null) continue;
    const isLast = (i === msg.fixes.length - 1);
    updateMarker(msg.device_id, f.lat, f.lng, label, color, isLast ? meta : slimMeta);
    addPoint(f.lat, f.lng, f.recorded_at, f.sat, true, null);
  }
} else if (msg.lat != null && msg.lng != null) {
  // legacy: batch 없는 구 firmware
  updateMarker(msg.device_id, msg.lat, msg.lng, label, color, meta);
}
```

**추가 방어** (PR #117): out-of-order fix (WS 재접속 replay 등으로 시간 역행) → 새 segment 시작. 이전 segment 에 append 하면 "역방향 선" 그려짐.

## 핵심 도전 3 — Kakao undefined.x 캐스케이드

Kakao maps 는 invalid LatLng 를 즉시 오류 안 던지고 event listener 에서 lazy fail:

```
TypeError: Cannot read properties of undefined (reading 'x')
```

한 번 폭발하면 지도 idle/zoom_changed 이벤트마다 재발 → **217번 연속 콘솔 폭주** 관측. UI 완전 프리즈.

Root cause: `new kakao.maps.LatLng(undefined, undefined)` — no-fix 이벤트 (sleep_enter, geofence_out) 가 lat/lng 없이 오는 케이스에서 방어 부재.

**Fix (PR #120)**:

```js
updateMarker(deviceId, lat, lng, ...) {
  if (typeof lat !== 'number' || typeof lng !== 'number' 
      || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
  // 이후 LatLng 생성
}
```

`addHistoryPoint` 도 동일. Dashboard legacy path 도 `msg.lat != null && msg.lng != null` 조건 추가.

**교훈**: Kakao SDK 의 lazy failure 모델 은 진단이 어렵다. 원인 지점 (invalid LatLng 생성) 과 크래시 지점 (event listener 안 property 접근) 이 시간·공간적으로 분리. **입력 시점 유효성 검증** 이 유일 답.

## 핵심 도전 4 — Seeker 폴리라인 3가지 스타일

Seeker 에서 하루 궤적을 어떻게 표시할지:

1. **단일 색** (device color): 심플. 시간 진행 정보 없음.
2. **속도별 색**: 저속=빨강, 시내=주황, 국도=녹색, 고속=파랑, 초고속=보라. `BUCKET_COLORS`.
3. **시간대별**: 하루 왕복 경로가 겹칠 때 시간 순서 구분.

문제는 3번. 처음엔 `TIME_SEGMENT_COLORS` (파→시안→녹→주황→빨) 로 5구간. 하지만 **여러 device 겹칠 때 device identity 상실** (색이 device 색 아니라 시간대 색). Song 이 PR #9 로 opacity 방식 제안했으나 CONFLICT 로 방치.

**Fix (PR #132)**: PR #9 아이디어 재구현 — device color 유지 + opacity 5단계 `[0.36, 0.48, 0.60, 0.72, 0.84]` (진할수록 최근).

```js
const TIME_SEGMENT_OPACITIES = [0.36, 0.48, 0.60, 0.72, 0.84];

new Polyline({
  strokeColor: color,                        // device color 유지
  strokeOpacity: TIME_SEGMENT_OPACITIES[seg],
});
```

여러 device 겹쳐도 각 device 색 유지 + 시간 진행 표현. Uber/카카오T style.

## 핵심 도전 5 — 정지 클러스터 흡수

정지 (5분+ 같은 위치) 시 GPS 는 계속 fix 를 뱉지만 좌표는 몇 미터 안에서 흔들림. 지도에 마커 20개가 원 모양으로 겹침 = 시각 노이즈.

**Fix**: `compactStopMarkerIndexes()` — 반경 35m 안 `_isStop=true` 마커들을 대표 하나로 흡수. 대표 마커 클릭 → tooltip 에 "10:23 ~ 10:34 · 11분간 정지 · 12개 fix 합침" range 표시.

초기 구현 (PR #120): live 홈 뷰 + seeker 둘 다 개수 뱃지 + range tooltip. 사용자 피드백:
> "홈 실시간에 5개 묶음, 10개 묶음 표시가 지나쳐."

**정정 (PR #125)**: seeker 만 뱃지+range 유지. 홈 live 는 흡수 (dot 수 감소) 만 하고 화살표 그대로 표시. `clusterMeta` 를 meta 에 안 넣기.

## 핵심 도전 6 — WebSocket refresh (24h+ 방치)

React SPA 를 브라우저에 24시간+ 열어두는 사용자 (자동차 대시보드 등). Access JWT 는 15분 만료.

**REST 는 이미 있음**:

```js
async function req(method, path, body, retry = true) {
  const res = await fetch(...);
  if (res.status === 401 && retry) {
    const r = await tryRefresh();
    if (r === true) return req(method, path, body, false);  // 재시도
    if (r === 'unauth') { clearTokens(); reload(); }
  }
  return res;
}
```

**WS 는 없었음**:

```js
// ws.js (초기)
_open() {
  const t = activeStorage().getItem('access_token');
  const sock = new WebSocket(`${WS_URL}?token=${t}`);
  sock.onclose = () => setTimeout(() => this._open(), 5000);
}
```

만료 토큰 그대로 사용 → 401 → onclose → 5초 후 재시도 → 만료 토큰 → 401 → 무한 loop.

**Fix (PR #120)**:

```js
// api.js
export async function tryRefresh() { ... }
export function isTokenExpiringSoon(token, marginMs = 60_000) {
  const expMs = decodeExp(token);
  return !expMs || (expMs - Date.now()) <= marginMs;
}

// ws.js
async _open() {
  const t = activeStorage()?.getItem('access_token');
  if (t && isTokenExpiringSoon(t)) {
    const r = await tryRefresh();
    if (r === 'unauth') { this._dead = true; return; }
  }
  const sock = new WebSocket(`${WS_URL}?token=${latest_token}`);
}
```

24시간+ 방치도 자동 복구.

## userPrefs — LocalStorage → 서버 sync

기존:
- Device 색: `localStorage[dev_color_<id>]`
- Theme (dark/light): `localStorage[theme]`
- Seeker 옵션: `localStorage[seeker_speed_color]`, `seeker_show_stops`
- Pair tutorial 완료: `localStorage[pair_tutorial_seen]`
- 요약 팝업 봤음: `localStorage[lab_summary_seen:<userId>:<deviceId>]`

문제: 여러 device 로그인 시 동기화 안 됨. 노트북에서 device 색 바꿔도 폰에서는 이전 색.

**Fix (P1/P2/P3 이관)**: `users.prefs` JSONB 컬럼에 서버 sync. `PATCH /auth/me/prefs` top-level merge.

```json
{
  "filter_device_id": 3005,
  "theme": "dark",
  "device_colors": { "3005": "#ff6b6b", "2995": "#4ecdc4" },
  "seeker": { "speed_color": true, "show_stops": true },
  "summary_seen": { "3005": "2026-07-03" },
  "pair_tutorial_seen": true
}
```

마이그레이션: localStorage 값 → 서버 push (1회) → localStorage 삭제. Idempotent.

LocalStorage 잔존:
- 인증 토큰 (`access_token`, `refresh_token`)
- 기기별 UI 상태 (`show_fences`, `profile_tab` 등 — 기기별 시나리오 자연)
- 성능 캐시 (`addrcache:<lat>,<lng>` — 짧은 TTL)

## Vite manualChunks + React.lazy

Bundle 크기 최적화:

```js
// vite.config.js
export default defineConfig({
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) return 'vendor';
        },
      },
    },
  },
});
```

Node_modules → `vendor` chunk 분리. 앱 배포마다 안 바뀌므로 브라우저 캐시.

```js
// App.jsx
const Auth = lazy(() => import('./pages/Auth'));
const SharePage = lazy(() => import('./pages/SharePage'));
const DiagnosticPage = lazy(() => import('./pages/DiagnosticPage'));
// ...

<Suspense fallback={<Loading />}>
  <Routes>...</Routes>
</Suspense>
```

Admin/Corporate/Diagnostic 등 non-critical route → lazy import. 일반 사용자는 해당 코드 다운로드 안 함.

**결과**: 초기 index 555 → 272 KB (-52% 재방문 시).

## 배운 것

1. **성능은 profile 로 잡는다** — "느리다" 리포트 → 즉시 DevTools Performance. 서버 지표만 보면 못 잡음
2. **Bulk mode + defer flush 패턴** — 실시간 update 성 UI 는 이 패턴 필수. Kakao maps 뿐 아니라 D3, canvas 등 다 유효
3. **인증 client 는 통합 layer** — REST/WS/기타 통신 모두 같은 refresh 로직 통과. 하나만 잊으면 조용히 fail
4. **UX 결정은 사용자 피드백에 열려있어야** — cluster 뱃지 같은 결정은 만든 사람 관점과 사용자 관점 다름
5. **LocalStorage 는 최소** — 계정 sync 필요한 건 서버로. 기기별/캐시성만 로컬

## 다음

- [7. 모바일 (Flutter WebView + FCM)](07-mobile.md)
- [8. 실전 사고](08-troubleshooting.md)
- [gps-tracker-web/src/](../../gps-tracker-web/src/) — 실제 코드
