# 1NCE 통합

ESP32 SIM7080G 가 사용하는 1NCE eSIM 의 **잔량 조회 / 데이터 충전 / 영수증 조회** 를 우리 백엔드가 어떻게 호출하는지.

대상 코드: [gps-tracker-api/src/services/nce.rs](../gps-tracker-api/src/services/nce.rs), [src/routes/sim_requests.rs](../gps-tracker-api/src/routes/sim_requests.rs)

---

## 1. 인증

[nce.rs](../gps-tracker-api/src/services/nce.rs) `resolve_token()` 가 두 가지 모드 지원, 우선순위 B → A:

| 모드 | 환경변수 | 비고 |
|---|---|---|
| A) Cognito 토큰 | `ONCE_API_TOKEN` | 1NCE 포털에서 발급. **1시간 만료** → 운영 불가. 디버그/일회성 용 |
| B) OAuth2 client_credentials | `ONCE_API_CLIENT_ID` + `ONCE_API_CLIENT_SECRET` | **영구**. POST `/management-api/oauth/token` → `access_token`. 운영 모드 |

요청은 `Bearer <access_token>` 헤더. Endpoint base: `https://api.1nce.com/management-api/v1`.

---

## 2. ICCID 정규화

1NCE 는 **19자리 canonical ICCID** 사용. 우리 펌웨어가 SIM7080G `AT+CCID` 결과로 받는 값은 **20자리** (끝 1자리 = Luhn 체크디짓).

→ `nce.rs::normalize_iccid()` 가 20자리면 끝 1자리 자르고 호출. DB 에는 펌웨어가 받은 그대로 (20자리) 저장.

---

## 3. SIM 데이터 충전 (Top-up) 흐름

### 사용자 → 관리자 → 1NCE

```
┌─ 사용자 ─────────────────┐    ┌─ 관리자 ────────────────┐    ┌─ 1NCE ───────┐
│ POST /sim-requests       │    │                          │    │              │
│ { device_id, data_mb }   │    │                          │    │              │
│ → credits 차감 (143k pt) │    │                          │    │              │
│ → sim_topup_requests     │    │                          │    │              │
│   row INSERT             │    │                          │    │              │
│   status='pending'       │    │                          │    │              │
└──────────────────────────┘    │                          │    │              │
                                │ POST /admin/sim-requests │    │ POST /sims/  │
                                │     /:id/process         │───▶│   {iccid}/   │
                                │ (UI 의 "1NCE 호출")      │    │   topup      │
                                │                          │◀───│ 201 Created  │
                                │ status='done'            │    │ Location:    │
                                │ api_response 저장        │    │  /orders/{id}│
                                └──────────────────────────┘    └──────────────┘
```

### 핵심 보장

| 보장 | 어디서 | 메모 |
|---|---|---|
| Race-free 처리 | `process_request` 의 `UPDATE … WHERE status='pending'` conditional UPDATE | 사용자 cancel 과 admin process 동시 발생 시 한쪽만 성공 (Conflict 반환) |
| 자동 환불 | `process_request` 실패 시 `credits::refund` | 1NCE 호출 실패 → status='failed' + credit 환불 |
| 1회 단위 고정 | `TOPUP_UNIT_MB = 500` ([sim_requests.rs:53](../gps-tracker-api/src/routes/sim_requests.rs#L53)) | 1NCE plan 정책상 1회 = 500MB. UI 의 `data_mb` 는 표시용 |
| 결제 수단 | env `ONCE_REFILL_PAYMENT_METHOD` (default `banktransfer`) | options: `banktransfer / creditcard / monthlyinvoice / boleto` |

---

## 4. 캐시 전략

1NCE Management API 는 rate limit + 응답 지연이 있어서 매 요청마다 직접 호출 = 비효율. **두 단계 캐시**.

### 4-1. SIM 잔량/상태 — 백그라운드 워커 (30분 주기)

[nce.rs::spawn_cache_worker](../gps-tracker-api/src/services/nce.rs) 가 부팅 시 spawn.

```
loop {
    SELECT id, iccid FROM devices
      WHERE iccid IS NOT NULL AND owner_id IS NOT NULL
      ORDER BY sim_info_fetched_at NULLS FIRST
      LIMIT 100
    for each:
        fetch_sim_usage() → devices.sim_info_cache (JSONB)
        sim_info_fetched_at = NOW()
        sleep 500ms  (rate-limit 보호)
    sleep 30min
}
```

읽는 곳:
- 모바일/웹 `GET /api/v1/devices/:id/sim` — devices.sim_info_cache 우선
- `POST /api/v1/devices/:id/sim/refresh` — 강제 라이브
- Admin "1NCE 조회" 모달 — 같은 캐시 재사용

### 4-2. 1NCE 주문/Invoice — Lazy + 영구 (마이그레이션 0032)

```sql
ALTER TABLE sim_topup_requests
    ADD COLUMN order_info       JSONB,
    ADD COLUMN order_fetched_at TIMESTAMPTZ;
```

`admin_order_info` 핸들러 ([sim_requests.rs](../gps-tracker-api/src/routes/sim_requests.rs)):

1. `order_info IS NOT NULL` → DB 만 read, 1NCE 호출 0
2. NULL 이면 `GET /orders/{id}` 1회 → DB 저장 → 이후 영구 캐시
3. `?refresh=1` → 강제 재조회 (보통 불필요 — order 는 불변)

**왜 영구 캐시:** order_number, invoice_number, invoice_amount, order_date 는 발급 후 1NCE 측에서도 절대 안 바뀜. 한 번 받으면 끝.

---

## 5. Admin "1NCE 조회" 엔드포인트

```
GET /api/v1/admin/sim-requests/:id/order
    ?refresh=1       order 강제 재조회 (보통 불필요)
    ?refresh_sim=1   SIM 잔량 라이브 호출 (워커 캐시 무시)
```

응답:
```json
{
  "request_id": 7,
  "status": "done",
  "order_id": "2069197393",
  "order": {            // 1NCE GET /orders/{id} 그대로
    "order_number": 2069197393,
    "order_type": "TOPUP",
    "order_date": "2026-06-12T00:00:00+0200",
    "invoice_number": "50005030",
    "invoice_amount": "15.00",
    "currency": "USD",
    "sims": [...]
  },
  "order_cached_at": "2026-06-12T13:15:42Z",
  "sim":  { "info": {...}, "usage": {...} },
  "sim_cached_at":   "2026-06-12T13:00:00Z",
  "error": null
}
```

UI: 관리자 대시보드 → SIM 충전 요청 탭 → done 행의 **"1NCE 조회"** 버튼.

---

## 6. Invoice PDF 한계 ⚠️

1NCE 가 영수증 PDF 에는 **별도 인증 (AWS SigV4)** 을 요구. Bearer 토큰으로는 403.

→ 우리는 **invoice_number 만 노출**. 관리자가 1NCE 포털 ([portal.1nce.com](https://portal.1nce.com/portal/login)) 에서 해당 번호로 검색해 다운로드. 모달에 안내 + 외부 링크 + 복사 버튼.

SigV4 직접 구현은 가능하지만 효용 대비 비용 (key 발급 + 로컬 sign 라이브러리) 큼 → 보류.

---

## 7. ENV 정리

```bash
# 운영 모드 (권장)
ONCE_API_CLIENT_ID=...
ONCE_API_CLIENT_SECRET=...

# 결제 수단 (선택)
ONCE_REFILL_PAYMENT_METHOD=banktransfer   # default

# 디버그 모드 (1시간 만료)
ONCE_API_TOKEN=...
```

자격증명 모두 미설정이면:
- topup API: 500 응답
- 캐시 워커: `tracing::debug!("credentials missing — skip cycle")` 후 그냥 sleep

---

## 8. OAuth 자격증명 발급 / 저장 위치

### 8-1. 발급 경로 (1NCE 포털)

1. [portal.1nce.com](https://portal.1nce.com/portal/login) 로그인 (운영팀 1NCE 계정)
2. **Configuration → API Management → OAuth Applications**
   - 정확한 메뉴 이름은 1NCE 포털 UI 개편에 따라 바뀔 수 있음. "OAuth" 또는 "API key" 키워드로 검색
3. **Create Application** → 이름 (예: `seriallog-gps-tracker`), Scope 선택
4. 생성 직후 표시되는 `client_id` 와 `client_secret` 을 **그 자리에서 복사**
   - ⚠️ `client_secret` 은 재표시 불가. 분실 시 application 삭제 후 재생성
5. 1NCE 측 OAuth token endpoint 는 고정 — 따로 받을 게 없음 (코드에 하드코딩, [nce.rs:17](../gps-tracker-api/src/services/nce.rs#L17))

> **로컬 검증 — 한 줄 curl**
> ```bash
> curl -u "$ONCE_API_CLIENT_ID:$ONCE_API_CLIENT_SECRET" \
>      -H "Content-Type: application/json" \
>      -d '{"grant_type":"client_credentials"}' \
>      https://api.1nce.com/management-api/oauth/token
> ```
> → `{"access_token":"...","token_type":"Bearer","expires_in":3600}` 정상.

### 8-2. 저장 위치

| 환경 | 경로 | 비고 |
|---|---|---|
| **운영 서버** | `/home/deploy/projects/gps-tracker-api/.env` | systemd `gps-tracker-api.service` 가 `EnvironmentFile=` 으로 로드. **`.env` 직접 read 는 sandbox 차단** — 변경은 `sudo nano` 후 `sudo systemctl restart gps-tracker-api` |
| **WSL 빌드/배포** | 동일 파일을 deploy.sh 가 동기화하지 않음 — 서버 .env 가 single source of truth | 로컬에서 1NCE 자격증명 굳이 둘 필요 X (1NCE 호출 테스트는 prod 에서만) |
| **로컬 dev 옵션** | `gps-tracker-api/.env` (gitignored) | smoke 테스트용. 절대 commit 금지 |

### 8-3. 자격증명 회전 (rotate) 절차

1. 포털에서 **새 application 생성** → 새 client_id/secret 확보 (기존 것은 그대로 유효)
2. 서버 `.env` 의 `ONCE_API_CLIENT_ID/SECRET` 두 값 교체
3. `sudo systemctl restart gps-tracker-api` → 첫 1NCE 호출 (캐시 워커가 30분 내 트리거) 로그에서 `1nce topup: POST` 또는 `nce cache refreshed` 정상 출력 확인
4. 포털에서 **기존 application 삭제**

회전 사유: secret 노출 의심 / 계정 권한 변경 / 정기 보안 점검 (권장 분기당 1회).

---

## 9. 관련 마이그레이션

| 버전 | 추가 |
|---|---|
| 초기 | `sim_topup_requests`, `devices.sim_info_cache / sim_info_fetched_at / sim_info_error` |
| **0032** | `sim_topup_requests.order_info / order_fetched_at` (이 문서 §4-2) |
