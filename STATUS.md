# GPS 트래커 프로젝트 진행 상태

**최종 갱신**: 2026-05-15
**도메인**: https://gps.serial.kr (모든 엔드포인트 HTTPS)
**서버 SSH**: `deploy@<VPS_HOST>` (Ubuntu 22.04, PostgreSQL 14.18, nginx 1.18)

## 핵심 문서

- [docs/SETUP.md](docs/SETUP.md) — 로컬 dev / 배포 prerequisites / 외부 키 발급처
- [docs/FCM_SETUP.md](docs/FCM_SETUP.md) — Firebase / FCM / APNs 종단간 셋업
- [docs/API_CONTRACT.md](docs/API_CONTRACT.md) — REST + WebSocket + ESP ingest 스키마
- [docs/1NCE_INTEGRATION.md](docs/1NCE_INTEGRATION.md) — 1NCE eSIM 인증/충전/조회/캐시
- [docs/DB_RESPONSIBILITY.md](docs/DB_RESPONSIBILITY.md) — main↔dev DB 스키마 sync 책임 + 부사수 prod 차단 4계층
- [architecture.md](architecture.md) — 전체 시스템 아키텍처
- [DATA_BOUNDARIES.md](DATA_BOUNDARIES.md) — 데이터 책임 경계
- 모바일 앱: [yeyebee/gps-tracker-app](https://github.com/yeyebee/gps-tracker-app) (Flutter, iOS/Android)

---

## 1. 한 줄 요약

ESP32-C3 GPS 트래커 → gps.serial.kr Rust API → (예정) Flutter 앱.
**서버 백엔드 핵심 완료** (인증/디바이스/위치/실시간 WS/이벤트/FCM 스텁).
다음: **12_ 펌웨어로 데이터 누적 검증** → Flutter.

---

## 2. 시스템 구성

```
[ESP32-C3 mini]                    [gps.serial.kr VPS]                  [예정: Flutter 앱]
  L80-R GPS  ──┐                       nginx 443
  SIM7080G   ──┤  HTTPS POST  ───►  ┌──────────────────────────┐
  OLED         │   ingest           │ = /gps-tracker/ingest    │── 3040 ──► Rust API
  배터리 + SW  │                    │ ^~ /gps-tracker/api/     │── 3040 ──► (axum + sqlx)
                                    │ ^~ /gps-tracker/ws/      │── 3040 ──►
                                    │ ^~ /gps-tracker/         │── 3030 ──► Python (legacy 대시보드)
                                    └──────────────────────────┘                ▲
                                              │                                 │
                                              ▼                                 │
                                       PostgreSQL gps_tracker              WS + REST
                                       broadcast → WS                          ▲
                                       events 테이블 → FCM 워커(dry-run)      │
                                                                          (예정 카카오맵 + FCM)
```

---

## 3. 완료된 작업

### 3-1. 펌웨어 (Arduino, ESP32-C3 mini)

- **[arduino/01_oled_test](arduino/01_oled_test/)** ~ **[arduino/10_tcp_tracker](arduino/10_tcp_tracker/)**: 단계별 검증 (OLED, ADC, GPS, SIM AT, LTE 데이터, deep sleep, TCP 단독)
- **[arduino/11_final_tracker/11_final_tracker.ino](arduino/11_final_tracker/11_final_tracker.ino)** ✅ — 현재 사용 중 펌웨어
  - 스위치 `LOW` = wake / `HIGH` = deep sleep (0.5s 디바운스)
  - L80-R UART NMEA → 좌표/위성/TTFF
  - SIM7080G LTE + **SH* HTTP 스택** (CGNSPWR=0 유지, GNSS 미사용 → 데이터 안정)
  - 30초 간격 POST `https://gps.serial.kr/gps-tracker/ingest`
  - OLED 4줄 디버그 (CDC USB 시리얼)
- ⚠️ MMA8452 자이로 — INT 하드웨어 이슈로 보류
- ⚠️ 전원 — D6 경로가 SIM7080G 피크 부족, 현재 Jinyushi USB 5V 상시 공급 가정 ([project_power_design_gap.md](../../C:/Users/msb/.claude/projects/e--project/memory/project_power_design_gap.md))

### 3-2. Backend (Rust + axum + sqlx + PostgreSQL)

위치: [gps-tracker-api/](gps-tracker-api/)

**런타임**:
- 빌드 환경: **WSL2 Ubuntu 24.04 + rustc 1.88** (`rust-toolchain.toml` 고정). 서버 빌드 금지 (디스크 95%).
- 배포 경로: `/home/deploy/projects/gps-tracker-api/{bin/gps-tracker-api, .env}`
- 서비스: `systemd gps-tracker-api.service` → `127.0.0.1:3040`
- DB: `gps_tracker` / role `gps_tracker_app` (.env에 패스워드)
- 마이그레이션: 부팅 시 `sqlx::migrate!()` 자동 적용 ([migrations/0001_init.sql](gps-tracker-api/migrations/0001_init.sql))

**스키마** (PostgreSQL):
- `users` (CITEXT email unique, argon2id password_hash)
- `devices` (device_uid unique, owner_id FK, last_lat/lng/seen_at)
- `location_records` (PK = device_id+recorded_at+source, JSONB raw)
- `events` (low_batt 등, notified_at NULL = 미발송)
- `refresh_tokens` (token sha256 hash, jti 회전, revoked_at)
- `fcm_tokens` (사용자별 푸시 토큰, active partial idx)

**엔드포인트** (모두 `https://gps.serial.kr/gps-tracker/` 아래):

| Path | Method | Auth | 비고 |
|---|---|---|---|
| `/ingest` | POST | 익명 | ESP 11_final_tracker 호환. device_uid 없으면 `anon-<ip>`로 생성. low_batt 자동 분류. |
| `/api/v1/auth/register` | POST | 없음 | email + password (≥8) → access(15min) + refresh(30day, jti) |
| `/api/v1/auth/login` | POST | 없음 | 동일 응답, refresh hash DB 저장 |
| `/api/v1/auth/refresh` | POST | refresh_token | 회전 (이전 토큰 revoke + 새 쌍 발급) |
| `/api/v1/devices` | GET | Bearer | 본인 소유 디바이스 |
| `/api/v1/devices/pair` | POST | Bearer | `{device_uid, display_name?}` — 익명 행 클레임 또는 신규 생성 |
| `/api/v1/devices/:id` | GET / PATCH / DELETE | Bearer | 소유자 필터, DELETE = unpair |
| `/api/v1/devices/:id/locations/latest` | GET | Bearer | 최신 1건 |
| `/api/v1/devices/:id/locations` | GET | Bearer | history. `?limit&since&until&source&fix_only` |
| `/ws/realtime?token=<access_jwt>` | WS | query token | hello → subscribe(소유권 검증, accepted/rejected ack) → location/device_event 스트림 |
| `/health`, `/gps-tracker/health` | GET | 없음 | DB ping |

**소스 트리** (관심 파일):
- [src/main.rs](gps-tracker-api/src/main.rs) — bootstrap + FCM worker spawn
- [src/auth/](gps-tracker-api/src/auth/) — jwt.rs (HS256+jti), password.rs (argon2), extractor.rs (Bearer)
- [src/routes/](gps-tracker-api/src/routes/) — auth/devices/locations/ingest/ws/health
- [src/services/fcm.rs](gps-tracker-api/src/services/fcm.rs) — dry-run worker (5s polling, notified_at 마킹)
- [src/events.rs](gps-tracker-api/src/events.rs) — broadcast::Sender<Event>

**스모크 테스트**:
- [tests/smoke_auth.sh](gps-tracker-api/tests/smoke_auth.sh)
- [tests/smoke_devices.sh](gps-tracker-api/tests/smoke_devices.sh)
- [tests/smoke_locations.sh](gps-tracker-api/tests/smoke_locations.sh)
- [examples/ws_smoke.rs](gps-tracker-api/examples/ws_smoke.rs) (`cargo run --example ws_smoke --release`)

### 3-3. nginx

- 사이트 파일: `/etc/nginx/sites-enabled/gps.serial.kr`
- 추가된 블록 (양쪽 server에 idempotent 패치 스크립트로 삽입):
  - `location = /gps-tracker/ingest` → 3040
  - `location ^~ /gps-tracker/api/` → 3040
  - `location ^~ /gps-tracker/ws/` → 3040 (WS upgrade 헤더 + 3600s timeout)
- 기존 `^~ /gps-tracker/`는 그대로 → 레거시 대시보드 (3030 Python)
- 패치 스크립트: [gps-tracker-api/deploy/nginx_add_api_route.py](gps-tracker-api/deploy/nginx_add_api_route.py), [nginx_add_ws_route.py](gps-tracker-api/deploy/nginx_add_ws_route.py)

### 3-4. 검증된 동작

- ✅ ESP 11_ → ingest → DB 저장 → 좌표 누적
- ✅ register/login/refresh + jti 회전 (반복 요청에도 토큰 유일성 보장)
- ✅ devices CRUD + 소유권 격리 (다른 사용자 → 404, 페어링 충돌 → 409)
- ✅ locations latest/history + since/until/source/fix_only 필터
- ✅ WS 실시간 스트림 + subscribe 소유권 검증 + 다른 사용자 디바이스 누설 없음
- ✅ low_batt 이벤트 자동 분류 (vbat_mv<3500) → events insert → broadcast → WS push
- ✅ FCM 워커 dry-run (notified_at 마킹으로 큐 적체 방지, 키 받으면 실제 호출 자리만 채우면 됨)

---

## 4. 핵심 결정사항 (변경 금지)

| 항목 | 결정 | 메모리 |
|---|---|---|
| 도메인/프로토콜 | `https://gps.serial.kr` 전용 | [project_gps_tracker_decisions.md](../../C:/Users/msb/.claude/projects/e--project/memory/project_gps_tracker_decisions.md) |
| 페어링 Phase 1 | user-driven `device_uid` 입력 | 동일 |
| 페어링 Phase 2 (TODO) | SIM7080G ICCID/IMSI/IMEI 중 하나로 자동 | 동일 |
| 지도 스택 | **카카오맵** (flutter_map/Mapbox/Google 후보 폐기) | 동일 |
| 프론트 dev 포트 | 8003 | [reference_seriallog_server_infra.md](../../C:/Users/msb/.claude/projects/e--project/memory/reference_seriallog_server_infra.md) |
| `/api/` 직접 사용 | 금지 (다른 프로젝트 점유). `/gps-tracker/api/v1/*` nest | 동일 |
| Rust 빌드 위치 | WSL2 only | 동일 |
| SIM7080G GNSS | OFF 유지 (CGNSPWR=0). SH* HTTP 안정성 우선 | [feedback_sim7080g_gnss_http_conflict.md](../../C:/Users/msb/.claude/projects/e--project/memory/feedback_sim7080g_gnss_http_conflict.md) |

---

## 5. 진행할 작업 (우선순위)

### Phase A — 12_ 펌웨어 + 누적 검증

- [x] **[arduino/12_continuous_tracker/12_continuous_tracker.ino](arduino/12_continuous_tracker/12_continuous_tracker.ino)** ✅ 작성 완료. 11_ 기반 변경점:
  - deep sleep 제거, 스위치 무시 (전원 인가 시 항상 동작)
  - POST 간격 30s → 15s
  - **device_uid = `esp-<MAC 6-byte hex>`** — 1NCE PDP churn으로 IP가 바뀌어도 서버에서 동일 디바이스로 누적 보장
  - OLED 레이아웃 재구성: 세션 uptime / POST OK/시도 / failStreak / last status / bring-up count / hard reset count / fix age + 좌표 / vbat
  - 회복 단계 3단: PDP 재활성 → PWRKEY 토글 → PWR_EN 사이클
- [ ] 보드에 플래시 + 창가/실외 24h+ 운영
- [ ] DB 누적량 검증 (예: `SELECT date_trunc('hour', recorded_at), count(*) FROM location_records WHERE device_id = (SELECT id FROM devices WHERE device_uid LIKE 'esp-%') GROUP BY 1 ORDER BY 1 DESC LIMIT 48;`)
- [ ] 누적 데이터로 nightly 마이그레이션/aggregation 필요한지 판단

### Phase B — Flutter 앱

(서버는 이미 받을 준비 완료. Flutter 도달 시점에 각 항목 시작 전 사용자에게 필요한 키/리소스 요청)

- [ ] 프로젝트 스캐폴드 + **카카오맵 SDK** 통합
  - 사용자에게 요청해야 할 것: **카카오 디벨로퍼스 JS 키 + REST API 키**, **앱 패키지명** (Android), **번들 ID** (iOS), **키 해시** (Android)
  - 결정 필요: `flutter_kakao_maps_flutter` (네이티브) vs WebView + Kakao Maps JS API
- [ ] 인증 UI + JWT secure storage (`flutter_secure_storage`)
- [ ] 디바이스 리스트 + 페어링 화면 (`POST /api/v1/devices/pair`)
- [ ] 지도 화면: 디바이스 마커 + WS 실시간 갱신
- [ ] 궤적/이력 화면: history 쿼리 + 폴리라인
- [ ] WebView 결제 셸 (Intent URL → app scheme 처리)
- [ ] FCM 수신 (포그라운드/백그라운드/탭 핸들링)
- [ ] 딥링크 (incoming + outgoing 결제 복귀)

### Phase C — 결제 + 실외 측정 + 보고서

- [ ] 결제 PG 결정: 사용자에게 Toss / Kakao Pay / Nice 중 선택 요청 (요금제 결정 시점)
- [ ] 실외 데이터 수집 + 보고서 (12_ 누적 + 카카오맵 시각화)

### Phase D — 보류 / 옵션

- [ ] **ESP Phase 2: SIM info 인증** (12_ 누적 끝, Flutter 어느 정도 진행 후)
  - SIM7080G AT 명령 결정: `AT+CCID` (ICCID) / `AT+CIMI` (IMSI) / `AT+CGSN` (IMEI) 중
  - 펌웨어가 ingest payload에 SIM info 포함 → 서버가 사전 등록 매핑으로 자동 페어링
- [ ] NDJSON 과거 데이터 → PostgreSQL 이관 (필요해지면)
- [ ] **프론트 대시보드 스캐폴드 (포트 8003)** — Flutter 진행 중 디버그용으로 필요해지면. 현재 레거시 Python 대시보드(3030)가 비교 시각화 담당 중이라 미루기 가능.
- [ ] FCM **실제 발송** 활성화: `FCM_SERVER_KEY` 환경변수 설정 + [src/services/fcm.rs](gps-tracker-api/src/services/fcm.rs)의 `// TODO: 실제 FCM 호출` 자리에 reqwest 호출 추가. (FCM v1 OAuth2로 가는 게 권장이지만 결정 시점에 재논의)
- [ ] MMA8452 자이로 INT 하드웨어 이슈 해결 (모션 wake 이벤트 부활용)

---

## 6. 내일 재개 cheatsheet

### 빌드 & 배포

```bash
# WSL2에서 빌드
wsl -d Ubuntu -- bash -lc 'source $HOME/.cargo/env && cd /mnt/e/project/2025/esp32c3-mini_gps/gps-tracker-api && cargo build --release'

# scp + 스왑 + 재시작
wsl -d Ubuntu -- bash -lc '
  scp /mnt/e/project/2025/esp32c3-mini_gps/gps-tracker-api/target/release/gps-tracker-api \
      deploy@<VPS_HOST>:/home/deploy/projects/gps-tracker-api/bin/gps-tracker-api.new && \
  ssh deploy@<VPS_HOST> "cd /home/deploy/projects/gps-tracker-api/bin && \
    mv -f gps-tracker-api gps-tracker-api.bak && \
    mv gps-tracker-api.new gps-tracker-api && \
    chmod +x gps-tracker-api && \
    sudo systemctl restart gps-tracker-api"
'
```

### 스모크 테스트

```bash
wsl -d Ubuntu -- bash -lc 'bash /mnt/e/project/2025/esp32c3-mini_gps/gps-tracker-api/tests/smoke_auth.sh'
wsl -d Ubuntu -- bash -lc 'bash /mnt/e/project/2025/esp32c3-mini_gps/gps-tracker-api/tests/smoke_devices.sh'
wsl -d Ubuntu -- bash -lc 'bash /mnt/e/project/2025/esp32c3-mini_gps/gps-tracker-api/tests/smoke_locations.sh'
wsl -d Ubuntu -- bash -lc 'source $HOME/.cargo/env && cd /mnt/e/project/2025/esp32c3-mini_gps/gps-tracker-api && cargo run --example ws_smoke --release'
```

### 서버 진단

```bash
# 로그 (실시간)
ssh deploy@<VPS_HOST> 'sudo journalctl -u gps-tracker-api -f'

# DB
ssh deploy@<VPS_HOST> 'PGPASSWORD=<.env에서> psql -h 127.0.0.1 -U gps_tracker_app -d gps_tracker'

# 최근 좌표
SELECT d.device_uid, lr.recorded_at, lr.lat, lr.lng, lr.fix
  FROM location_records lr JOIN devices d ON d.id = lr.device_id
  ORDER BY lr.recorded_at DESC LIMIT 20;

# 미발송 이벤트
SELECT * FROM events WHERE notified_at IS NULL ORDER BY occurred_at DESC LIMIT 20;
```

### 환경 / 시크릿

- `/home/deploy/projects/gps-tracker-api/.env`: `BIND_ADDR`, `DATABASE_URL`, `JWT_SECRET`, `JWT_ACCESS_TTL_MIN=15`, `JWT_REFRESH_TTL_DAYS=30`, (TODO) `FCM_SERVER_KEY`
- nginx 백업: `/etc/nginx/sites-enabled/gps.serial.kr.bak.<timestamp>`

### 다른 프로젝트 충돌 회피

- 점유 포트: 3010 (seriallink Node), 3030 (gps-tracker Python 레거시), 3040 (이 프로젝트), 8000–8002 (다른 백엔드/프론트), 8080 (sensor), 5175/5177/5180 (vite dev)
- DB roles: `aaa`/`bbb`/`gps_tracker_app` (이 프로젝트만 우리 것)
- 빈 포트: **8003** (이 프로젝트 프론트 dev로 예약)
