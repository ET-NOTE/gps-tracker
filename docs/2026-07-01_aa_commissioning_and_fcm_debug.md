# 2026-07-01 작업 기록 — aa 신 하드웨어 커미셔닝 + FCM 트러블슈팅

한 세션에 다룬 세 축 (firmware, web, mobile/FCM) 정리. 개별 PR 커밋 메시지는 그대로 두고, 이 문서는 **원인 분석 흐름과 실측 데이터를 시간순으로 재구성** 하는 용도.

---

## 1. Firmware — sss 안정성 개선 (PR #108–#111)

### 1.1 PR #108 — stuck watchdog 에 esp_restart() 상한 추가

**증상**: 2026-07-01 09:22–11:11 sss 1h48m 두절.

**진단 흐름**:
- events 로그: `09:13:20 wake(motion) → 09:22:58 마지막 fix → 09:26:17 stuck → 11:11:26 자체 복구`
- 기존 stuck watchdog (60s 무응답 → soft reset → 반복 → hardPowerCycle) 은 **LTE 모듈만** 리셋
- ESP 는 loop 계속 → deep sleep 안 들어감 → PR #99 timer wake 10분 fallback 도 무효
- LTE 모듈 자체가 회복 안 되는 지역/상태 → **ESP 자체 재부팅 없이는 탈출 불가**

**Fix**:
```c
#define STUCK_ESP_RESTART_TIMEOUT_MS (5UL * 60UL * 1000UL)
static uint32_t stuckSinceMs = 0;

// 60s 무응답 감지 시:
if (stuckSinceMs == 0) stuckSinceMs = millis();
if ((millis() - stuckSinceMs) > STUCK_ESP_RESTART_TIMEOUT_MS) {
  breadcrumb("stuck_restart");
  delay(200);
  esp_restart();
}
```

- 성공 POST (status=200) 시 `stuckSinceMs = 0` rearm (`lastSuccessPostMs` 옆)
- 5분 상한은 재부팅 loop 방지 (최악 case 5분마다 재부팅 = 두절 시간 상한 5분 확보)

### 1.2 PR #109 — timer wake heartbeat 모드

**증상**: PR #99 timer wake 10분 발동 후에도 loop 5분 유지 → 배터리 소모 큼.

**Fix**:
```c
static bool timerWakeMode = false;

// setup wake cause 판정:
} else if (wc == ESP_SLEEP_WAKEUP_TIMER) {
  wakeReasonStr = "timer";
  timerWakeMode = true;
}

// doPost 성공 (status=200) 분기:
if (timerWakeMode) {
  DBGLN("[TIMER-WAKE] heartbeat POST 200 → 즉시 re-sleep");
  timerWakeMode = false;
  enterDeepSleep("timer_hb");
}
```

- 정상 motion wake 는 5분 post_interval 유지 (변경 없음)
- Timer wake heartbeat 는 첫 POST 후 즉시 re-sleep → LTE ON 시간 30–60s

### 1.3 PR #110 — timer wake 2분 timeout guard

**시나리오 검토 중 발견**: 지하주차장 등에서 timer wake → LTE 실패 → stuck watchdog 5분 대기 → esp_restart → 다시 loop 5분 → 매 10분 사이클 마다 5분+ 소모 = 배터리 50%.

**Fix**:
```c
#define TIMER_WAKE_MAX_MS (120UL * 1000UL)

void loop() {
  if (timerWakeMode && (millis() - bootMs) > TIMER_WAKE_MAX_MS) {
    DBGLN("[TIMER-WAKE] 2분 timeout — re-sleep");
    timerWakeMode = false;
    enterDeepSleep("timer_hb_fail");
  }
  ...
}
```

- 2분 상한이 stuck escalation 5분 esp_restart 보다 먼저 발동 → 무한 loop 없음
- Motion wake path 에서는 여전히 stuck escalation 정상 발동

### 1.4 PR #111 — 시나리오 × 진입점 hunt 결과 2개 버그

**버그 1**: sleep 2-beep 이 timer wake heartbeat 마다 발동 → 실외 매 10분 삐삐 소음.
```c
bool quietSleep = (strcmp(reason, "timer_hb") == 0 ||
                   strcmp(reason, "timer_hb_fail") == 0);
if (!quietSleep) { beep(2, 100, 100); waitBuzzerFlush(); }
```

**버그 2**: esp_restart / brownout / crash 모두 wakeReasonStr = "boot" → cold boot 랑 구분 안 됨. wc==UNDEFINED 시 rr 세분화:
```c
if      (rr == ESP_RST_SW)                                     wakeReasonStr = "sw_reset";
else if (rr == ESP_RST_BROWNOUT)                               wakeReasonStr = "brownout";
else if (rr == ESP_RST_TASK_WDT || rr == ESP_RST_INT_WDT ||
        rr == ESP_RST_PANIC || rr == ESP_RST_WDT)              wakeReasonStr = "crash";
else                                                           wakeReasonStr = wakeCauseStr(wc);
```

### 1.5 시나리오 × 진입점 매트릭스 (검증 완료)

| 진입점 | rr | wc | wakeReasonStr | timerWakeMode | sleep beep |
|---|---|---|---|---|---|
| Cold boot | POWERON | UNDEFINED | "boot" | false | — |
| Motion wake | DEEPSLEEP | GPIO | "motion" | false | 울림 |
| Timer wake | DEEPSLEEP | TIMER | "timer" | **true** | **skip** |
| esp_restart | SW | UNDEFINED | "sw_reset" | false | — |
| Brownout | BROWNOUT | UNDEFINED | "brownout" | false | — |
| INT-WDT crash | INT_WDT | UNDEFINED | "crash" | false | — |
| Bounce re-sleep | — | GPIO 마킹 | "motion" (다음 wake) | false | 울림 |

교차 검토 통과:
- STATIONARY sleep gate (5분) ↔ timer wake mode (2분 timeout) 상호 배타
- Stuck watchdog (5분 esp_restart) ↔ timer wake mode (2분 timeout) — timer 가 먼저 sleep 진입
- esp_restart → static 완전 리셋 → 새 사이클 정상
- inSleepProcedure flag 로 sleep 재진입 방지

---

## 2. aa 신 하드웨어 커미셔닝

### 2.1 배경

- aa 이전 하드웨어 = L80 GPS + SIM7080. 소유자가 물리적으로 교체 → **LC86G GPS + 신 PCB**
- uSIM 카드 그대로 옮김 → deviceUid `sim-<ICCID 뒤 8자리>` 유지 → 서버 device_id 유지
- 서버 이전 통신: 2일 전 마지막. 새 하드웨어로 GPS/LTE 검증 필요

### 2.2 03_x 진단 sketches (모두 CDCOnBoot=cdc)

| Sketch | 결과 | 발견 |
|---|---|---|
| 03_1 LIS3DH | ✅ 사용자 확인 | WHO_AM_I=0x33, INT 정상 |
| 03_6 LC86G (baud=115200) | ❌ garbled bytes | 통신 자체는 오지만 NMEA 파싱 불가 |
| 03_6 LC86G (baud=9600) | ✅ 3D fix | **aa 는 baud 9600 default** (sss 는 115200) |
| 03_4 SIM7080 (원래 배선) | ❌ 30s+ 무응답 | — |
| 03_4 SIM7080 (RX/TX swap) | ❌ 30s+ 무응답 | 배선 문제 아님 |
| 03_4 SIM7080 (DTR HIGH + PWRKEY 반전) | 부분 (SIM READY 후 침묵) | — |
| **03_4 SIM7080 (DTR LOW + PWRKEY 반전)** | ✅ `+CGATT: 1`, `+CGPADDR: 1,10.217.184.1` | **최종 극성 확정** |

### 2.3 LC86G baud 영구 변경

`$PAIR864,0,0,115200*1B` (Quectel) + `$PMTK251,115200*1F` (MediaTek 계열) + `$PAIR002*38` (flash 저장) 전송 후 재부팅 → 115200 유지 확인 (`SET_BAUD_ON_BOOT=0` 로 재-flash 검증).

### 2.4 최종 확정 극성 (사용자 초기 정보 부분 정정)

| Pin | sss (기존) | aa (신) | 비고 |
|---|---|---|---|
| DTR | LOW | **LOW (동일)** | 처음 "반전" 정보 있었지만 SIM7080 datasheet default (LOW=active) 가 맞음 |
| PWRKEY idle | HIGH | **LOW (반전)** | 회로 반전 |
| PWRKEY pulse | LOW → HIGH | **HIGH → LOW (반전)** | |
| PWR_EN | LOW=ON | LOW=ON (동일) | GPS+LTE 공유, 무관 |
| 부저 | driver 회로 (BUZZER=1) | **마그네틱 (BUZZER=0)** | LTE bringUp 방해 |

**DTR HIGH 시도 시 발견 사고**: 첫 AT 만 응답 후 완전 침묵. SIM7080 이 HIGH=sleep 진입 신호로 해석. 즉 사용자 "DTR 반전" 정보는 부정확이었고, 실질 반전은 PWRKEY 하나뿐.

### 2.5 Fork 구조 (사용자 요청: sss 오염 방지)

```
arduino/
├── 13_4_motion_aware_tracker/          ← sss (vanilla)
│   └── DTR=LOW, PWRKEY 원래, BUZZER_ENABLED=1
└── 13_4_aa_motion_aware_tracker/       ← aa fork
    ├── LTE_DTR_IDLE=LOW
    ├── LTE_PWRKEY_IDLE=LOW              (반전)
    ├── LTE_PWRKEY_PULSE=HIGH            (반전)
    └── BUZZER_ENABLED=0
```

- 처음엔 `INVERT_LTE_PINS` build flag 로 조건부 처리 → 사용자 "오염 우려" 로 fork 분리
- 이후 aa 관련 patch 는 `13_4_aa_motion_aware_tracker/` 만 수정. 공통 patch (예: stuck escalation) 는 양쪽 수동 반영

### 2.6 최종 실측 검증

aa fork flash 후 **부팅 22초 만에 wake event 서버 도달**:
```
device_id=2995 kind="wake" wake_cause="boot" uptime_s=22
gps_fix=true gps_sat=10 vbat_mv=4638 boots=1
```
GPS fix 즉시 확보 (위성 10개) + LTE 매우 빠른 bringUp.

---

## 3. Web dashboard — 폴리라인/dot 재검토 (PR #104–#107, #112)

브라우저 UI 시각화 이슈들 정리:

### 3.1 PR #104 — dot 클릭 복원
PR #100 에서 화살표 zIndex 4→6 올린 게 문제. dot 이 화살표에 가려져 클릭 안 됨 → 4로 원복 + Zoom debounce 500ms.

### 3.2 PR #105 — refresh 시 polyline 역방향
`updateMarker` 는 시간 오름차순 append 만 처리. `force refresh` 시 기존 polyline 최신 좌표에 오래된 fix append 되면 역방향 라인 생성 → `clearLiveTrail(deviceId)` 신설하여 device 별 완전 reset 후 rebuild.

### 3.3 PR #106 — stop dot 빨강 잔존
PR #100 이 `addHistoryPoint` 만 fix 했지만 `applyZoomStyles` / `setMarkerColor` 에 `isStop ? '#EF4444' : color` 잔존. `fitToAllMarkers` → zoom_changed → `applyZoomStyles` 가 dot 을 빨강으로 덮어쓰던 것이 초기 로드 = image 1 (빨강 dot) 원인. 두 함수 모두 항상 device color 로 통일.

### 3.4 PR #107 — dot + arrow 이중 marker 통일
사용자 UX 요청: 네모 dot 이 화살표를 가리고, 방향 표시 안 보임. **화살표 marker 하나** 로 통일 (clickable=true + tooltip 이벤트). 첫 fix 는 heading 미확정 → angle=0. `arrowsRef` 완전 삭제, `pointsRef` 안 marker 에 angle 필드 추가.

### 3.5 PR #112 — 알림 설정 명시적 "저장" 버튼
Auto-save (patch()) 가 조용히 실패하는 경우 대비 명시적 저장 버튼 + 결과 msg 표시. 계정 이전 후 UI 는 켜져 있지만 backend 는 muted 상태 진단에 활용.

---

## 4. FCM push 트러블슈팅 — 하루 두 번 반복된 이슈

같은 증상 ("계정 이전 후 push 안 옴") 을 **원인 두 개 각각** 파악한 흐름.

### 4.1 1차 원인: Flutter `_startJwtPolling` 이 `t.cancel()` 후 재시작 안 함

**증상**: sss 를 user1 → user4 계정으로 이전 후 push 미도달.

**진단**:
- Backend 는 정상 — `events.user_id` 를 event 생성 시점 `owner_id` 로 저장 (`ingest.rs:313,340,372,446,514,525`), `fcm_tokens` UPSERT 도 정상
- Web dashboard 에는 FCM 로직 자체 없음 (grep firebase/getMessaging 0건)
- Flutter app 이 fcm-token 을 register 안 함

**Flutter 코드 (`main.dart:156`)**:
```dart
void _startJwtPolling() {
  _jwtPollTimer = Timer.periodic(const Duration(seconds: 2), (t) async {
    final jwt = await _currentJwtFromWebView();
    if (jwt == null || jwt == _lastSeenJwt) return;
    _lastSeenJwt = jwt;
    final fcm = await getFcmToken();
    if (fcm == null) return;
    final ok = await registerFcmTokenWithBackend(fcmToken: fcm, jwt: jwt);
    if (ok) t.cancel();   // ← 여기가 문제
  });
}
```

**흐름**:
1. 앱 첫 실행 → user1 로그인 → jwt1 감지 → fcm register → **timer cancel**
2. SPA (React) 내부 로그아웃/user4 재로그인 은 client-side routing → `onLoadStop` 안 뜸 → polling 재시작 안 됨
3. → user4 fcm-token backend 등록 X

**Fix**: `if (ok) t.cancel();` 제거. 폴링 유지 + `_lastSeenJwt` 로 dedup. 계정 전환 시 새 JWT 감지 → 재-register 자동 처리. apk build + install.

### 4.2 2차 원인: `fcm.dart` short-circuit — device token 캐시

앱 재시작 후에도 push 안 옴 재현. 서버 진단:

**Backend 확인**:
```sql
SELECT id, kind, notified_at, user_id FROM events WHERE device_id=3005 ORDER BY id DESC LIMIT 8;
```
- `notified_at` 모두 세팅됨, `user_id=28` (user4) 정확
- 그러나 fcm 로그 3시간 동안 딱 1건 (14:56 muted) → 이후 sss event 다수인데 fcm 완전 침묵

**분석**:
- Worker 는 live mode (재시작 후 `fcm: live mode` 확인)
- `notified_at` 세팅 = claim 단계는 성공
- 로그 없음 = `tokens.len() == 0` → for loop 안 돌아감 (`fcm.rs:346–353`):
  ```rust
  let tokens = sqlx::query_as("SELECT ... WHERE user_id = $1 AND active = TRUE")
      .bind(uid).fetch_all(pool).await.unwrap_or_default();
  // tokens 비어있으면 아래 for 문 조용히 skip, notified_at 만 마킹
  ```

**진짜 root cause (`fcm.dart:108`)**:
```dart
if (prefs.getString(_kRegisteredTokenKey) == fcmToken) {
  return true;   // ← device token 은 계정 무관 = 이전 값과 같음 → backend 호출 skip
}
```

FCM token 은 **device 당 하나** (user 무관). user1 시절 register 성공 시 prefs 에 저장 → user4 로 계정 전환해도 같은 token → short-circuit → backend UPSERT 안 됨 → user4 의 `fcm_tokens` row 영영 안 생김.

**Fix**: 캐시 key 에 JWT hash 도 함께 저장.
```dart
final jwtHash = jwt.hashCode.toString();
if (prefs.getString(_kRegisteredTokenKey) == fcmToken &&
    prefs.getString(_kRegisteredJwtHashKey) == jwtHash) {
  return true;   // 같은 token + 같은 JWT 일 때만 skip
}
// ... POST ...
await prefs.setString(_kRegisteredJwtHashKey, jwtHash);
```

이전 build 사용자는 `_kRegisteredJwtHashKey = null` → 반드시 mismatch → 강제로 backend 호출 1회 → 이후 정상.

### 4.3 별도 확인
- `NotificationSettings` UI 의 `sleep_alert`/`wake_alert`/`cycle_first_fix_alert` 는 backend default FALSE. sss 는 heartbeat 사이클 위주라 이 3개 켜야 push 옴 (사용자 UI 저장 완료 확인).
- `gps-tracker-api` 재시작 후 `fcm: live mode project=gps-tracker-e21be` 재확인.

---

## 5. 오후 후속 작업 (같은 날 저녁까지)

### 5.1 PR #113 — sss cycle_first_fix 중복 push fix

**증상**: sss 에서 motion wake 후 `cycle_first_fix` push 알림이 2번 옴.

**실측** (device_id=3005):
```
7020 cycle_first_fix 18:13:39
7021 wake motion     18:13:39   ← 같은 recorded_at, 같은 POST
7022 cycle_first_fix 18:15:13   ← 다음 POST 에서 재-발행 (버그)
```

**Root cause** (`ingest.rs` 처리 순서):
1. First fix 처리 (line 297~) 가 이전 wake 의 `pending=TRUE` 를 잡아 event 발행 + `pending=FALSE`
2. 같은 POST 안 lifecycle event 처리 (line 486~) 가 이번 wake 로 `pending=TRUE` 재-마킹
3. 다음 POST 의 fix 가 pending=TRUE 다시 잡아 재-발행 → 2번째 알림

**Fix**: wake `pending=TRUE` 마킹을 first_fix 판정 **전** 으로 이동:
```rust
if let Some(kind_str) = parsed.event.as_deref() {
    if kind_str == "wake" {
        sqlx::query("UPDATE devices SET cycle_first_fix_pending = TRUE WHERE id = $1")
            .bind(device_id).execute(&state.db).await;
    }
}
// 이후 first_fix 판정 → 이번 wake pending 을 자기 자신이 소진
```
Line 486 의 원래 UPDATE 는 제거 (redundant).

### 5.2 aa 류 LC86G baud 최종 결정 = 9600

**과정**:
1. **첫 aa (device_id=2995)** 커미셔닝 시 배송 default 9600 확인 → `PAIR864+PMTK251+PAIR002` 로 115200 변경 + flash 저장 성공 → persistence 확인
2. 사용자 결정: **"9600 유지 절대 원칙 — 롤백 확률 0.01 이라도 있으면 115200 금지"**
3. 03_7 sketch 를 115200→9600 방향으로 반전해 롤백 시도 → monitor log garbled 로 성공 여부 불명
4. **새 aa 류 하드웨어 (COM48)** 에 `13_4_aa` (GPS_BAUD=9600) 그대로 flash + sss uSIM 이식 → 서버 device_id=3005 로 정상 데이터 수신

**결론**: `13_4_aa_motion_aware_tracker/` 의 `#define GPS_BAUD 9600` 이 표준. 이후 aa 류 하드웨어 커미셔닝은 baud 변경 절차 없이 그대로 flash.

### 5.3 03_x 진단 sketch fork 분리

sss 원본을 aa 진단 상태로 오염시키지 말라는 사용자 요청. 아래 구조로 정리:

```
arduino/
├── 03_4_sim7080_at_basic_test/         ← sss 원본 (vanilla revert 완료)
├── 03_4_aa_sim7080_at_basic_test/      ← aa fork: PWRKEY 반전, DTR LOW, raw print + 순환 AT 명령
├── 03_6_lc86g_antenna_test/            ← sss 원본 (vanilla)
├── 03_6_aa_lc86g_antenna_test/         ← aa fork: GPS_BAUD=9600 (baud 변경 시퀀스 없음)
└── 03_7_lc86g_set_baud/                ← baud 변경 유틸 (persistence 실험용, 방향 전환 가능)
```

각 aa fork 파일 header 에 sss 원본과의 차이 명시.

### 5.4 새 하드웨어 CDC 무응답 → USB 재연결로 복구

새 aa 류 하드웨어에 03_1 flash 후 CDC serial 무응답 (log 0 bytes) → USB 케이블 재삽입 후 즉시 CDC 복구, 이후 sketch 실행 정상. 첫 boot handshake 이슈 추정 (재현성 미확인).

### 5.5 L86 vs LC86G — 안테나 URC 파싱 추가

**배경**: 새 aa 류 하드웨어의 GPS 모듈 marking = **`L86 M33 Q1 A0437`** (Quectel L86, MediaTek MTK 기반). 기존 aa/sss 의 LC86G 와 다른 계열.

| 항목 | LC86G (기존) | **L86 (aa 신 하드웨어)** |
|---|---|---|
| 계열 | Quectel 신규 (PAIR) | Quectel 구형 = MediaTek MTK |
| 명령 | `$PAIR864`, `$PAIR513`, `$PAIR002` | **`$PMTK`** 계열 |
| 안테나 URC | `$PQTMANTENNASTATUS,<ver>,<mode>,<status>,<source>*XX` | **`$GPTXT,01,01,02,ANTSTATUS=OK/OPEN/SHORT*XX`** |
| 내부/외부 fallback | 자동 (OK_INT / OK_EXT 구분) | **없음** — 외부 안테나 회로 감지만 |

**증상**: L86 장착 hardware 에서 서버 events `antenna="?"` 계속 나옴 → 원인: firmware 에 LC86G 용 `$PQTMANTENNASTATUS` 파싱만 있었고 L86 의 `ANTSTATUS=` 형식 매칭 안 됨. `ANTENNA ` 8자 패턴 매칭 (L80 legacy 용) 은 `ANTSTATUS=` 로 시작하는 형식과 안 맞음.

**Fix** (`13_4_aa_motion_aware_tracker.ino`, nmeaLine 파싱 블록):
```c
// L86 (aa 신 하드웨어) — $GPTXT 안 "ANTSTATUS=OK/OPEN/SHORT" 파싱.
else if (nmeaLineLen > 6 && nmeaLine[0] == '$'
         && strncmp(nmeaLine + 3, "TXT,", 4) == 0) {
  const char* ants = strstr(nmeaLine, "ANTSTATUS=");
  if (ants) {
    ants += 10;
    const char* tag = "?";
    if      (strncmp(ants, "OK",    2) == 0) tag = "OK";
    else if (strncmp(ants, "OPEN",  4) == 0) tag = "OPEN";
    else if (strncmp(ants, "SHORT", 5) == 0) tag = "SHORT";
    // ... lastAntennaStatus 갱신 + [L86] log
  }
}
```

두 URC 형식 (LC86G / L86) 모두 같은 `lastAntennaStatus` 로 통일. Payload `"antenna":"..."` 필드도 동일 → 서버/UI 는 firmware 변경 없이 그대로 매핑:

| Firmware 값 | UI 표시 |
|---|---|
| `OK` / `OK_INT` / `OK_EXT` | 정상 |
| `OPEN` | **단선 / 결선 이상** |
| `SHORT` | 단락 |
| `?` | 미보고 |

**검증**: L86 이 실제로 `ANTSTATUS=OPEN` emit → 서버 event 에 `antenna="OPEN"` 도착 확인. UI 는 "단선 / 결선 이상" 으로 표시. L86 은 LC86G 처럼 내부 안테나 자동 fallback 로직 없어서 외부 안테나 케이블/커넥터 상태가 직접 반영됨.

**주의**: L86 은 안테나 미장착 = OPEN, 장착 후 정상 회로 = OK. 장착 상태에서 OPEN 지속 시 하드웨어 회로/케이블/SMA 커넥터 문제.

### 5.6 OLED 진단 layer (13_4_aa 전용, aa fork 만 반영)

**배경**: 자동차 안 시리얼 monitor 는 CDC=cdc 필요 → LTE 방해 위험 (`project-cdc-default-required` 참조). 실외/지하주차장에서 실시간 진단 위해 OLED 를 진단 window 로 사용.

**활성화/비활성화**:
```c
#define OLED_DEBUG_ENABLED 1   // 0 = 컴파일에서 완전 배제 (배터리 영향 0)
```

**하드웨어**:
- SSD1306 128×64 I2C, 주소 `0x3C`
- `SDA=GPIO8`, `SCL=GPIO9` (LIS3DH 와 I2C 공유 — 400kHz)
- 소모: 활성화 시 ~5–15mA 추가 (sleep 진입 시 `SSD1306_DISPLAYOFF` 로 자동 OFF)

**8줄 매핑 (시나리오별 관찰 포인트)**:
```
L1  10s motion b19          ← uptime, wake reason, RTC boots (=1 이면 완전 전원 손실)
L2  LTE:OK csq15 r1         ← 지하 진입 → csq99 r0 로 변화
L3  P 5/6 fs0 s200          ← POST 성공/시도, failStreak, 마지막 HTTP status
L4  GPS:FIX s8 h1.2         ← fix / sat / hdop
L5  m42 a3s b3 h1           ← motion 총량 / age / bringUpCount / hardResets
L6  V4056 ant:OK_INT        ← 배터리 mV / 안테나 상태 (LC86G/L86 통합)
L7  STUCK 65/300s           ← stuck escalation 카운트다운 (esp_restart 까지)
    또는 STAT 240/300s      ← stationary sleep 진입 중
    또는 TIMER_HB mode      ← timer wake heartbeat 세션
    또는 op:do_post         ← breadcrumb (죽기 직전 phase)
L8  sim-15207520            ← deviceUid 뒤 12자 (identity 확인)
```

**Hook 위치**:
- `oledInit()` : `setup()` 안 `Wire.begin()` 직후
- `oledUpdate()` : `printStatus()` 마지막 (매 1초 STATUS 라인과 동기)
- `oledSleep()` : `enterDeepSleep()` 첫 부분 (sleep beep 전)

**한계**:
- OLED 8줄, `lastOpStr` 24자 → 세부 phase (SHCONN vs SHREQ vs SHBOD 실패 구분) 는 breadcrumb 문자열 확장 필요 시 향후
- Sleep 중엔 OLED off → 그 사이 상태는 서버 events 로만 확인

**Sss 는 그대로 두고 aa fork 만 반영** — 사용자 요청 "sss 오염 방지". sss 도 OLED 원하면 별도 판단 후 이식.

### 5.7 Boot-stuck escalation (PR #108 조건 확장, aa fork 전용)

**동기 사고 (2026-07-01 sss 실측)**:
```
7082 wake  22:22:48  wc=crash  rst=INT-WDT  op=do_post  vbat=3988 csq=26 boots=1
7071 offline  21:13:05
7069 signal_loss  20:48:05
20:20~ POWERON reset 반복 (배터리 홀더 접점 loss 추정)
```
= **21:13 offline → 22:22 자체 회복** (약 1시간 9분). 회복 원인 = ESP32 INT-WDT (인터럽트 워치독) 최후 fallback. PR #108 의 `esp_restart` 는 발동 안 함.

**PR #108 조건 문제**:
```c
if (lastSuccessPostMs > 0 && (millis() - lastSuccessPostMs) > STUCK_POST_TIMEOUT_MS) {
    if ((millis() - stuckSinceMs) > STUCK_ESP_RESTART_TIMEOUT_MS) {
        esp_restart();
    }
}
```
- `lastSuccessPostMs > 0` = 부팅 후 성공 POST 최소 1회 필요
- 20:20 POWERON 반복 → 매번 static 변수 초기화 → `lastSuccessPostMs = 0` 유지 → **조건 아예 안 만족** → 5분 esp_restart 발동 X → 1h9m 방치 → INT-WDT 로 우연히 회복

**Fix (aa fork loop 상단)**:
```c
if (!timerWakeMode
    && lastSuccessPostMs == 0
    && (millis() - bootMs) > STUCK_ESP_RESTART_TIMEOUT_MS) {
    breadcrumb("noboot_restart");
    delay(200);
    esp_restart();
}
```
- 부팅 후 5분+ 아직 성공 POST 0회 = 지역 stuck or 하드웨어 문제 → 능동 재부팅
- Timer wake 세션은 별도 2분 timeout guard 로 처리 (제외 처리)
- 최악 case 회복 시간 상한 = **5분** (기존 1h9m 대비 획기적 개선)

**OLED L7 카운트다운 (신규)**:
```
NOPOST <uptime>/<300>s   ← 부팅 후 60초+ 성공 POST 없을 때 표시
                            (300s = STUCK_ESP_RESTART_TIMEOUT_MS 상한)
```
우선순위: `STUCK > NOPOST > STAT > TIMER_HB > op:breadcrumb`.

**부작용 검토**:
- 지속 지하 = 5분마다 esp_restart loop. 배터리 손실 있음 (LTE bringUp 매번 30~60s 시도).
- 다만 이전 방식 = 1h+ 동안 loop 계속 돌면서 SIM7080 이 전류 뿜는 것보다는 유리
- Sleep 진입 로직 (`checkStationarySleep`) 이 정상 작동하면 대부분 이 case 안 감

**sss 는 미반영** — aa fork 만. sss 도 같은 사고 있으니 원하면 이식 별도 결정.

---

## 6. 참고 인덱스

- 관련 memory: `project-stuck-esp-restart-ceiling`, `project-aa-hardware-polarity`, `project-hardware-lc86g-unified`, `project-cdc-default-required`, `project-stationary-gps-required`, `project-buzzer-lte-diagnostic`
- PR 번호: firmware #99, #108–#111 / web #104–#107, #112 / api #113 (cycle_first_fix dedup) / flutter 는 로컬 (gitignore)
- 검증 device_id: sss=3005, aa=2995
- 이후 aa 류 커미셔닝 표준 절차:
  1. `arduino/13_4_aa_motion_aware_tracker/` 를 CDC=default (`esp32:esp32:esp32c3`, USB CDC On Boot = Disabled) 로 flash
  2. uSIM 삽입 후 서버 event 도착 확인
  3. baud 변경 절차 불필요 (9600 유지)
