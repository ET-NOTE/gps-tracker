# API_CONTRACT — REST / WebSocket / ESP ingest 스펙

이 문서는 백엔드 (gps-tracker-api) 가 외부와 주고받는 모든 인터페이스를 한 곳에 정리합니다.

## 1. Base URL

| 환경 | 도메인 | API base |
|---|---|---|
| 운영 | seriallog.com | `https://seriallog.com/gps-tracker/api/v1` |
| 운영 (모바일) | gps.serial.kr | `https://gps.serial.kr/api/v1` |
| 로컬 | localhost | `http://127.0.0.1:3040/api/v1` |

ESP 펌웨어 ingest 와 health 는 `/api/v1` 이 아닌 `/gps-tracker/` 직하:
- `POST /gps-tracker/ingest`
- `GET  /gps-tracker/health`

WebSocket:
- `wss://seriallog.com/gps-tracker/ws/realtime?token=<access_jwt>`

---

## 2. 인증

JWT (HS256) — `Authorization: Bearer <access_jwt>` 헤더.

- Access TTL: 15분 (env `JWT_ACCESS_TTL_MIN`)
- Refresh TTL: 30일 (env `JWT_REFRESH_TTL_DAYS`)
- Refresh 회전: `POST /auth/refresh` 시 새 refresh 발급, 기존 무효화

### 토큰 획득 흐름

```
1. POST /auth/send-otp     { phone }                    → OTP 전송
2. POST /auth/register     { phone, otp, password, ... } → access/refresh
3. POST /auth/login        { phone, password }           → access/refresh
4. POST /auth/refresh      { refresh_token }             → access/refresh (회전)
```

OTP 는 운영에선 Bizm SMS (`BIZMSG_*`), 개발에선 `SMS_DEV_MODE=1` 로 콘솔 출력.

---

## 3. REST 엔드포인트 (인증 필요)

> 모든 경로는 `/api/v1` prefix. owner_id 자동 검증 — 본인 소유 아니면 404.

### 3-1. 인증 / 계정

| Method | Path | 설명 |
|---|---|---|
| POST | `/auth/register` | 가입 |
| POST | `/auth/send-otp` | 가입용 OTP 발송 |
| POST | `/auth/login` | 로그인 |
| POST | `/auth/refresh` | 토큰 회전 |
| GET  | `/auth/me` | 내 프로필 |
| PATCH | `/auth/me` | 내 정보 수정 |
| POST | `/auth/me/password` | 비밀번호 변경 |
| DELETE | `/auth/me` | 계정 삭제 |
| POST | `/auth/me/cleanup` | 내 데이터 일괄 정리 |
| GET / PATCH | `/auth/me/prefs` | 알림 등 환경설정 |
| POST | `/auth/find-id/send-otp`, `/verify` | 아이디 찾기 |
| POST | `/auth/password-reset/send-otp`, `/verify` | 비밀번호 재설정 |
| POST | `/auth/fcm-token` | FCM 토큰 등록 ([FCM_SETUP.md](FCM_SETUP.md) 참고) |
| POST | `/auth/fcm-token/revoke` | FCM 토큰 해제 |
| GET  | `/auth/ping` | `"pong"` (헬스) |
| GET / POST | `/auth/phones` | 본인 휴대폰 목록 / 추가 OTP |
| POST | `/auth/phones/verify` | OTP 검증 |
| PUT  | `/auth/phones/:id/primary` | 메인 번호 지정 |
| DELETE | `/auth/phones/:id` | 번호 제거 |

### 3-2. 디바이스

| Method | Path | 설명 |
|---|---|---|
| GET | `/devices` | 내 디바이스 목록 (last_seen, last_event, last_stationary 포함) |
| POST | `/devices/pair` | 페어링 (device_uid 또는 ICCID) |
| GET | `/devices/:id` | 단건 상세 |
| PATCH | `/devices/:id` | display_name / color / icon 변경 |
| DELETE | `/devices/:id` | 페어링 해제 |
| POST | `/devices/:id/wipe` | 데이터 영구 삭제 (취소 불가) |
| GET | `/devices/:id/audit` | 페어/언페어/모뎀이동 감사 로그 |
| GET | `/devices/:id/sim` | 1NCE SIM 잔량 (캐시) |
| POST | `/devices/:id/sim/refresh` | 1NCE 즉시 갱신 |
| GET | `/devices/:id/events` | lifecycle 이벤트 (wake/sleep_enter/...) |
| GET | `/devices/:id/locations` | 위치 기록 (시간 범위 query) |
| GET | `/devices/:id/locations/latest` | 마지막 위치 |
| GET | `/devices/:id/stats/daily` | 일별 통계 (거리/시간/정지) |
| GET | `/devices/:id/active-dates` | 운행 있었던 날짜 목록 |
| GET | `/devices/:id/route/analyze` | AI 운행 분석 (OpenAI) |
| GET | `/devices/:id/ai-analyses` | 분석 이력 |

### 3-3. 지오펜스

| Method | Path | 설명 |
|---|---|---|
| GET / POST | `/geofences` | 목록 / 생성 |
| GET / PATCH / DELETE | `/geofences/:id` | 단건 |
| GET | `/geofences/history` | 전체 진입/이탈 이력 |
| GET | `/geofences/:id/history` | 단건 이력 |

### 3-4. 공유 링크

| Method | Path | 설명 |
|---|---|---|
| GET / POST | `/devices/:id/shares` | 목록 / 발급 (TTL 지정) |
| DELETE | `/shares/:share_id` | 회수 |
| POST | `/shares/:share_id/extend` | 만료 연장 |
| GET (public) | `/share/:token` | 공유 단말 정보 |
| GET (public) | `/share/:token/locations` | 공유 단말 위치 |
| GET (public) | `/share/:token/daily_stats` | 공유 단말 통계 |

### 3-5. 결제 / 크레딧 / SIM 충전

| Method | Path | 설명 |
|---|---|---|
| GET | `/payments/toss/config` | Toss client key 조회 |
| POST | `/payments/toss/init` | 결제 초기화 |
| POST | `/payments/toss/confirm` | 결제 승인 |
| POST | `/payments/toss/fail` | 결제 실패 마킹 |
| POST | `/payments/toss/webhook` | Toss → 우리 (서명 검증) |
| GET | `/payments/orders` | 내 주문 목록 |
| GET | `/payments/orders/:id` | 단건 |
| GET | `/credits/balance` | 포인트 잔액 |
| GET | `/credits/log` | 사용 이력 |
| POST | `/credits/topup` | 자가 충전 (env `ALLOW_SELF_TOPUP=1` 일 때) |
| POST / GET | `/credits/requests` | 충전 요청 / 내 요청 목록 |
| POST | `/credits/requests/:id/cancel` | 요청 취소 |
| POST / GET | `/sim-requests` | SIM 데이터 충전 요청 / 내 요청 |
| GET | `/sim-requests/pricing` | 가격표 |

### 3-6. 채팅 / 알림 설정

| Method | Path | 설명 |
|---|---|---|
| GET | `/chat/thread` | 내 1:1 스레드 |
| GET / POST | `/chat/messages` | 메시지 목록 / 송신 |
| POST | `/chat/read` | 읽음 처리 |
| GET / PATCH | `/notifications/settings` | 알림 종류별 on/off |

### 3-7. 기업 (코퍼레이트)

| Method | Path | 설명 |
|---|---|---|
| GET / PUT | `/corporate/info` | 회사 정보 |
| GET / POST | `/corporate/staff` | 직원 목록 / 추가 |
| PATCH / DELETE | `/corporate/staff/:id` | 직원 수정 |
| GET | `/corporate/devices/:id/trips` | 운행 일지 |
| PATCH | `/corporate/devices/:id/trips/annotation` | 메모 |
| GET | `/corporate/devices/:id/trips.csv` | CSV 익스포트 |
| GET / POST | `/corporate/subscription` | 구독 현황 / 구매 |

### 3-8. 관리자 (admin role)

| Method | Path | 설명 |
|---|---|---|
| GET | `/admin/users` | 사용자 목록 |
| GET | `/admin/users/:id` | 단건 |
| POST | `/admin/users/:id/impersonate` | 임시 로그인 |
| GET | `/admin/devices`, `/:id` | 전체 디바이스 |
| POST | `/admin/devices/:id/recompute-stats` | 통계 재계산 |
| POST | `/admin/sims/:iccid/topup` | 직접 1NCE 충전 |
| GET | `/admin/payments` | 전체 결제 |
| GET | `/admin/credits/requests` | 충전 요청 큐 |
| POST | `/admin/credits/requests/:id/approve`/`reject` | 승인/거절 |
| GET / POST | `/admin/sim-requests`/`:id/process` | SIM 요청 처리 |
| GET | `/admin/sim-requests/:id/order` | 1NCE 주문/SIM 상세 (DB 캐시) — `?refresh=1` order 강제, `?refresh_sim=1` SIM 라이브 |
| GET / POST | `/admin/chat/threads` | 채팅 관리 |

---

## 4. 공개 엔드포인트 (인증 X)

| Path | 설명 |
|---|---|
| `GET /health`, `GET /gps-tracker/health` | 헬스체크 — `{"ok":true}` |
| `POST /gps-tracker/ingest` | ESP 위치 업로드 (다음 섹션) |
| `GET /share/:token/...` | 공유 링크 (token 자체가 인증) |

---

## 5. ESP `POST /gps-tracker/ingest` 페이로드

펌웨어 버전별로 필드가 점진적으로 추가됐습니다. 서버는 모든 버전 호환.

### 5-1. 공통 (모든 버전)

```json
{
  "ts": 180,                  // optional. 서버 epoch 받을 필요 없음
  "boot": 3,                  // 부팅 카운트
  "awake": 2,                 // wake 카운트
  "csq": 24,                  // LTE 신호 (0~31)
  "reg": 5,                   // 망 등록 상태
  "vbat_mv": 3970,            // 배터리 전압 mV
  "at_ms": 11051,             // 디바이스 uptime ms
  "l80": {                    // GPS fix
    "fix": true,
    "lat": 37.5665,
    "lng": 126.9780,
    "sat": 8,
    "ttff_s": 15
  }
}
```

- `vbat_mv < 3500` 이면 서버가 자동으로 `low_batt` 이벤트 발행 (24h 디바운스)
- `l80.fix == true && lat,lng 유효` 면 `location_records` insert + WS `location` 이벤트 발행
- 익명 ingest 시 서버가 IP 로 `anon-<ip>` device_uid 자동 생성

### 5-2. 11_final_tracker 이후 (디바이스 정체성)

```json
{
  "device_uid": "esp-aabbccddeeff",     // MAC 기반 안정 식별자
  "iccid": "8944476100000123456",       // SIM 식별자 (모뎀 이동에도 logical 동일)
  "imei":  "865632040000123",
  "imsi":  "262019999999999"
}
```

매칭 우선순위: **ICCID > device_uid > 새로 INSERT**. IMEI 는 fingerprint 만 (모뎀 식별).

### 5-3. 12_continuous_tracker 이후 (lifecycle)

```json
{
  "event": "wake" | "sleep_enter",
  "wake":  "motion" | "switch" | "boot" | "timer",
  "sleep_reason":     "stationary" | "stationary_lis_only" | "switch" | "motion_idle",
  "stopped_offset_s": 332,            // 마지막 모션 후 경과 (sleep_enter)
  "diag": {                            // RTC slow-memory 누적 카운터
    "boots": 1,
    "wakes": 0,
    "cyc_fix": 16,
    "cyc_no_fix": 1,
    "cyc_post_ok": 17,
    "cyc_post_fail": 0,
    "motion_wakes": 0,
    "switch_wakes": 0,
    "no_fix_cycles": 0,
    "modem_fail_cycles": 0,
    "brownouts": 0,
    "last_sleep_uptime_s": 938
  }
}
```

### 5-4. 13_1_motion_aware_tracker 이후 (stationary 진단)

매 POST 마다 (이벤트와 무관) `stationary` 블록 첨부 — 서버 측 `devices.last_stationary` 에 덮어쓰기:

```json
{
  "stationary": {
    "active":       true,         // 정지 윈도우 카운트 중인지
    "held_s":       240,          // 현재까지 정지 유지 (초)
    "window_s":     300,          // 진입 임계 (STATIONARY_WINDOW_MS / 1000)
    "sleep_in_s":   60,           // window_s - held_s
    "drift_m":      26.3,         // 최근 fix history 의 max pairwise distance
    "threshold_m":  50.0,         // GPS_DRIFT_THRESHOLD_M
    "fixes":        14,           // drift 평가에 사용한 valid fix 개수
    "gps_avail":    true,         // 마지막 fix 가 60s 안인지
    "motion_age_s": 35,           // 마지막 LIS 모션 인터럽트 이후 경과
    "lis_ok":       true,         // I2C 통신 정상?
    "lis_reinits":  0             // 부팅 이후 LIS 재초기화 카운트 (RTC 보존)
  }
}
```

자세한 sleep 알고리즘은 [arduino/13_1_motion_aware_tracker/13_1_motion_aware_tracker.ino](../arduino/13_1_motion_aware_tracker/13_1_motion_aware_tracker.ino) 의 `checkStationarySleep()` 참고.

### 5-5. 응답

```json
{ "ok": true, "device_id": 2995 }
```

---

## 6. WebSocket `/gps-tracker/ws/realtime`

### 연결

```
wss://seriallog.com/gps-tracker/ws/realtime?token=<access_jwt>
```

JWT 검증 실패 → 401 close.

### 프로토콜 (text JSON frames)

```
연결 직후 ←  {"type":"hello", "user_id":42}

클라 →      {"action":"subscribe", "device_ids":[1, 2, 3]}
            (소유 안 한 device_id 는 rejected 로 응답)

서버 ←      {"type":"ack", "action":"subscribe",
             "accepted":[1, 2], "rejected":[3]}

서버 ←      {"type":"location",
             "device_id":1, "recorded_at":"2026-05-15T19:00:00Z",
             "source":"l80", "fix":true, "lat":37.5, "lng":127.0,
             "sat":8, "ttff_s":15, "vbat_mv":3920}

서버 ←      {"type":"device_event",
             "device_id":1, "kind":"low_batt",
             "data":{"vbat_mv":3420, "delta_min":47}}
```

- `subscribe` 호출 시 기존 구독 전체 교체 (additive 아님)
- 슬로우 컨슈머 → broadcast::Lagged → 서버는 메시지 스킵 (연결은 유지)
- 클라이언트 → 서버 메시지는 `subscribe` action 만 지원

---

## 7. 이벤트 종류 (events.kind)

WebSocket `device_event` 와 FCM 푸시의 입력. 푸시 매핑은 [FCM_SETUP.md](FCM_SETUP.md) 의 알림 종류 표 참고.

| kind | 트리거 | data 예시 |
|---|---|---|
| `low_batt` | `vbat_mv < 3500` (24h 디바운스) | `{"vbat_mv":3420}` |
| `motion` | LIS3DH 인터럽트 (펌웨어 발행) | `{}` |
| `wake` | `event=wake` 페이로드 | `{"wake_cause":"motion", "diag":{...}}` |
| `sleep_enter` | `event=sleep_enter` 페이로드 | `{"sleep_reason":"stationary", "stopped_offset_s":332, "diag":{...}}` |
| `offline` | 30분 무소식 (offline worker) | `{"silence_min":35}` |
| `signal_loss` | 5~30분 무소식 (회복 가능 구간) | `{"silence_min":12}` |
| `online` | offline / signal_loss 에서 복구 | `{"recovered_from":"offline"}` |
| `geofence_in` | 펜스 안으로 진입 | `{"geofence_name":"집", "distance_m":15}` |
| `geofence_out` | 펜스 밖으로 이탈 | `{"geofence_name":"집", "distance_m":420}` |
| `geofence_armed` | 펜스 활성화 시 현재 위치 | `{"geofence_name":"집", "inside":true, "radius_m":50}` |
| `brownout` | RTC `brownouts` 카운터 증가 감지 | `{"delta":1, "total":3}` |
| `gps_anomaly` | RTC `no_fix_cycles` 증가 감지 | `{"delta":2}` |
| `lost` | sleep 후 24h+ 응답 없음 | `{"hours_since_sleep":48}` |

---

## 8. 에러 응답

```json
{ "error": "human readable message" }
```

| HTTP | 의미 |
|---|---|
| 400 | 페이로드 유효성 실패 |
| 401 | 토큰 없음/만료/형식 오류 |
| 403 | 권한 부족 (admin 전용에 일반 호출) |
| 404 | 본인 소유 아닌 device_id (의도적으로 "없음" 처럼 응답) |
| 409 | 충돌 (이미 페어된 SIM 등) |
| 422 | validator 거부 |
| 500 | 서버 오류 — `journalctl -u gps-tracker-api` 확인 |

---

## 9. 변경 정책

- **하위호환 우선**: 새 필드는 모두 optional 로 추가, 기존 필드 의미 변경 금지
- 끊는 변경이 필요할 땐: 새 경로 (`/v2/...`) 신설 후 일정 기간 병행
- 모바일 앱은 store 심사 지연으로 구버전 API 호출 가능 — 모니터링 기간 1~2주 권장
- ingest 페이로드는 펌웨어와 server 가 묶여 있어서 한 PR 로 처리 (양쪽 추가 → 펌웨어 배포 → 서버 배포 순)
