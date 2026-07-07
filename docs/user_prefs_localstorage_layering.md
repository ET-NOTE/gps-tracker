# User Preferences 계층 설계 — LocalStorage vs Server DB

**작성일**: 2026-07-03
**배경**: 여러 device 로그인 시 사용자 설정 동기화 불일치 (예: 노트북과 폰에서 device 색상 다름). 전체 인벤토리 + 재분류 진단 결과 정리.

## TL;DR (설계 원칙)

- **User-global** (계정 전체 sync) → **Server DB** (`users.prefs` JSONB / `notification_settings` 전용 테이블)
- **Device-local** (기기별 상황 다름) → **LocalStorage**
- **성능 캐시** → LocalStorage (짧은 TTL 자연스레 device-local)
- **인증 토큰** → LocalStorage (remember_me) 또는 SessionStorage (탭 고유)

## 대기업 (Google Maps / Waze / Slack / Discord) 검증 원칙

| 유형 | 예시 | 저장 위치 |
|---|---|---|
| 데이터 정체성 | 즐겨찾기, 이름, 색 라벨 | 서버 (계정 sync) |
| UI 상태 | 마지막 본 탭, 확대 레벨, 접힘 상태 | 로컬 (기기별 시나리오) |
| 알림 정책 (on/off) | 이메일 수신, kind 별 push 여부 | 서버 (계정 차원) |
| 알림 소리/진동 | 벨소리, 진동 세기 | 로컬 (기기 특성) |
| 성능 캐시 | reverse-geocode 결과 | 로컬 (해당 기기만 유효) |
| 다크모드 | 라이트/다크 | **경우 나뉨** — 계정 sync (기본) or OS follow (심화) |

## 현재 인벤토리 (2026-07-03 실사)

### Backend (already correct)
- **`users.prefs`** JSONB — device-local 원본 목적 (마이그레이션 0011 주석 명시). `GET/PATCH /auth/me/prefs`.
- **`notification_settings`** 별도 테이블 — user-global. `GET/PATCH /notifications/settings`.

두 계통 분리 이미 잘 되어있음. 다만 frontend 가 이 원칙을 완전히 따르지 못하고 있음.

### Frontend (재분류 대상)

| 필드 | 현재 저장 | 재분류 | 조치 |
|---|---|---|---|
| `filter_device_id` | userPrefs ✓ | User-global | 유지 |
| `lab_first_view_summary` | userPrefs ✓ | User-global | 유지 |
| `lab_cycle_seeker` | userPrefs ✓ | User-global | 유지 |
| `dev_color_{deviceId}` | localStorage | **User-global** | 🔴 userPrefs 이동 |
| `PairTutorial` | localStorage | **User-global** | 🔴 userPrefs 이동 |
| `theme` (light/dark) | localStorage | User-global (결정) | 🟡 userPrefs 이동 |
| `seeker_speed_color` | localStorage | User-global (결정) | 🟡 userPrefs 이동 |
| `seeker_show_stops` | localStorage | User-global (결정) | 🟡 userPrefs 이동 |
| `lab_summary_seen:{userId}:{deviceId}` | localStorage | Hybrid → user-global | 🟠 userPrefs.summary_seen nested |
| `show_fences` | localStorage | Device-local | 유지 |
| `profile_tab` / `admin_subtab` / `corporate_tab` | localStorage | Device-local | 유지 |
| `addrcache:{lat},{lng}` | localStorage | Device-local 캐시 | 유지 |
| `access_token` / `refresh_token` | localStorage/sessionStorage | Device-local (인증) | 유지 |
| `notification_settings.*` | 전용 테이블 ✓ | User-global | 유지 |

**참고 — 최근 결정 (2026-07-03 PR #118)**:
- `map_view` (lat/lng/level) 저장/복원 완전 **제거**. 매번 auto fit — 사용자 실수로 빈 공간 봤을 때 재진입 시 빈 화면 방지.

## 최종 userPrefs 스키마 (변경 후)

```json
{
  "filter_device_id": 3005,
  "lab_first_view_summary": true,
  "lab_cycle_seeker": false,
  "theme": "dark",
  "device_colors": {
    "3005": "#ff6b6b",
    "2995": "#4ecdc4"
  },
  "seeker": {
    "speed_color": true,
    "show_stops": true
  },
  "summary_seen": {
    "3005": "2026-07-03",
    "2995": "2026-07-02"
  },
  "pair_tutorial_seen": true
}
```

`PATCH /auth/me/prefs` 는 top-level 병합이라 부분 업데이트 안전.

## LocalStorage 유지 항목 (변경 없음)

| 항목 | 용도 |
|---|---|
| `access_token` / `refresh_token` (remember_me) | 인증 |
| `access_token` / `refresh_token` (sessionStorage, no-remember) | 세션 인증 |
| `show_fences` | 지도 펜스 표시 (기기별 지도 UI 상태) |
| `profile_tab` / `admin_subtab` / `corporate_tab` | 마지막 본 UI 탭 (기기별 자연) |
| `addrcache:{lat},{lng}` | 성능 캐시 (TTL 만료) |

## 마이그레이션 전략

**dev_color 만 데이터 마이그레이션 필요** (다른 필드는 초기값 fallback 으로 자연 이동).

### dev_color 마이그레이션 (1회성 부트 로직)

`Dashboard.jsx` 로그인 후 `getMyPrefs()` 첫 호출 시:

```js
async function migrateDeviceColorsIfNeeded() {
  const prefs = await api.getMyPrefs();
  if (prefs.device_colors) return;   // 이미 서버 저장됨 — skip

  // localStorage 안 dev_color_* 스캔
  const collected = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith('dev_color_')) continue;
    const id = key.slice('dev_color_'.length);
    const val = localStorage.getItem(key);
    if (val) collected[id] = val;
  }

  if (Object.keys(collected).length === 0) return;   // 없음

  await api.patchMyPrefs({ device_colors: collected });
  // 1회 push 성공 후 localStorage 삭제
  Object.keys(collected).forEach(id => localStorage.removeItem(`dev_color_${id}`));
}
```

### 다른 필드 (theme / seeker / tutorial) 마이그레이션

부트 시 서버 값이 있으면 서버 우선, 없으면 localStorage 값 서버 push 후 삭제. 같은 패턴.

## 여러 device 로그인 대응 시나리오

**Case 1** — 노트북에서 device 색 변경 (빨강) 후 폰 로그인
- 노트북: `patchMyPrefs({device_colors: {3005: 'red'}})` → 서버 반영
- 폰: 로그인 시 `getMyPrefs()` → `device_colors.3005 = 'red'` 자동 적용 ✓

**Case 2** — 폰에서 다크모드 설정 후 노트북 로그인
- `theme` 이 서버 sync → 노트북도 다크모드 표시 (사용자 명시 결정)

**Case 3** — 노트북에서 profile tab 을 "알림" 으로, 폰에서 "크레딧" 으로 유지
- `profile_tab` device-local → 각각 유지 ✓ (원하는 동작)

**Case 4** — 폰에서 pair tutorial 봤음 → 노트북 첫 진입
- `pair_tutorial_seen: true` sync → 노트북도 skip ✓

## 진행 순서 (Todo) — ✅ 완료 (2026-07-03)

- ✅ **P1** dev_color → userPrefs.device_colors + 마이그레이션 ([colors.js](../gps-tracker-web/src/colors.js), [Dashboard.jsx](../gps-tracker-web/src/pages/Dashboard.jsx))
- ✅ **P1** PairTutorial → userPrefs.pair_tutorial_seen ([PairTutorial.jsx](../gps-tracker-web/src/components/PairTutorial.jsx))
- ✅ **P2** theme → userPrefs.theme + 마이그레이션 ([theme.js](../gps-tracker-web/src/theme.js), [SharePage.jsx](../gps-tracker-web/src/pages/SharePage.jsx))
- ✅ **P2** seeker_speed_color / show_stops → userPrefs.seeker.* ([SeekerSheet.jsx](../gps-tracker-web/src/components/SeekerSheet.jsx))
- ✅ **P3** lab_summary_seen → userPrefs.summary_seen (nested) ([Dashboard.jsx](../gps-tracker-web/src/pages/Dashboard.jsx))

각 이동에 공통 적용된 규약:
- FE 로직: 서버 값 우선 hydrate, 없으면 localStorage 값 서버 push 후 로컬 삭제 (마이그레이션 idempotent — 1회 push 후 재실행되지 않음)
- 기존 사용자 무단절 (마이그레이션 자동)
- device 색 변경 / 튜토리얼 완료 / 테마 변경 / seeker 옵션 / 요약 팝업 노출 여부 모두 다른 device 로그인 시 자동 반영
- 서버 patch 실패 시 (offline) localStorage 유지 → 다음 부트에서 재시도
- theme 은 localStorage 를 부트 seed 로 유지 (재로드 flash 방지)

## 참고: 특수 케이스 처리 원칙

- **하위호환 필요 없는 것** (초기값 fallback 로 자연): PairTutorial (기본값 false), theme (기본 auto/light)
- **하위호환 필요한 것** (기존 사용자 설정 잃으면 안 됨): dev_color (사용자가 각 device 마다 색 지정한 것 유지 필요)
- **암묵 device-local 로 착각하기 쉬운 것** — `lab_summary_seen` 같이 userId+deviceId key 로 저장돼 device-local 같아 보이지만 실은 user-global. **사용자가 다른 device 에서 로그인하면 팝업 또 뜨는 취약점**. 이런 케이스는 서버 이동 우선.

## 관련 memory
- [[ui-mapping-first-check]] — "값 이상/미보고" 진단 시 FE 매핑 딕셔너리 grep 필수 (같은 관점: layer 별 fallback 값 어디서 결정되는지 확인)
