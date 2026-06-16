# SETUP — 로컬 dev / 배포 prerequisites

이 문서는 **gps-tracker-web** (React + Rust API + Arduino) 을 로컬에서 돌리고 서버로 배포하기까지 필요한 외부 의존성·키·계정·툴체인을 정리합니다.

연관 문서:
- [FCM_SETUP.md](FCM_SETUP.md) — Firebase / 푸시 알림 셋업 (Flutter 앱이 푸시 받게 하려면 필요)
- [API_CONTRACT.md](API_CONTRACT.md) — ingest payload / REST / WebSocket 스키마
- 모바일 앱 빌드는 [gps-tracker-app](https://github.com/yeyebee/gps-tracker-app) 레포의 README + docs/PUSH.md

---

## 1. 툴체인

| 컴포넌트 | 필요 도구 | 버전 |
|---|---|---|
| Rust API | rustup / cargo | rust-toolchain.toml 의 stable (현재 1.88) |
| Web | Node + npm | Node 20 LTS |
| Arduino 펌웨어 | arduino-cli | 최신 stable |
| DB | PostgreSQL | 14+ (서버는 16) |
| 배포 셸 | WSL (Windows) / bash (Linux/Mac) | — |

Rust 는 deploy.sh 가 서버에서 자동 설치 (rustup) 하므로 로컬엔 권장이지만 필수는 아님.

---

## 2. 외부 서비스 키 발급처

API 가 사용하는 모든 외부 서비스의 발급처와 환경 변수를 한 표에:

| 서비스 | 용도 | 환경 변수 | 발급처 |
|---|---|---|---|
| **PostgreSQL** | 메인 DB | `DATABASE_URL` | 로컬 install / 서버 systemd |
| **JWT** | 자체 발급 | `JWT_SECRET` (32+ char random) | `openssl rand -hex 32` |
| **Firebase FCM** | 푸시 알림 | `FCM_SERVICE_ACCOUNT_PATH` | Firebase Console → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 |
| **1NCE SIM API** | SIM 잔량/충전 (OAuth2) | `ONCE_API_CLIENT_ID`, `ONCE_API_CLIENT_SECRET` | [portal.1nce.com](https://portal.1nce.com) → API → OAuth Application |
| **1NCE (legacy token)** | 위 OAuth 대체 | `ONCE_API_TOKEN` | (옵션) 레거시 베어러 |
| **Kakao Maps** | 좌표→주소, 지도 렌더 | `KAKAO_REST_API_KEY` (백엔드용) | [developers.kakao.com](https://developers.kakao.com) → 내 앱 → REST API 키 |
| **Kakao JS** | 프론트엔드 지도 | (프론트 빌드 시 코드 상수) | 동 앱의 JavaScript 키 |
| **Toss Payments** | 결제 | `TOSS_CLIENT_KEY`, `TOSS_SECRET_KEY`, `TOSS_WEBHOOK_SECRET` | [docs.tosspayments.com](https://docs.tosspayments.com) → API 키 |
| **Bizm 알림톡** | 카카오 알림톡 발송 | `BIZMSG_USERID`, `BIZMSG_PROFILE`, `BIZMSG_SMS_SENDER` | [bizmsg.com](https://www.bizmsg.com) — Userid/프로필/발신번호 |
| **OpenAI** | AI 운행 분석 (선택) | `OPENAI_API_KEY`, `OPENAI_MODEL` | [platform.openai.com](https://platform.openai.com) |

---

## 3. `.env` 작성

`gps-tracker-api/.env.example` 를 복사:

```bash
cd gps-tracker-api
cp .env.example .env
```

전체 키 목록 (코드에서 실제로 읽는 값들):

```ini
# ── 필수 ───────────────────────────────
BIND_ADDR=127.0.0.1:3040
DATABASE_URL=postgresql://gps_tracker_app:PASSWORD@127.0.0.1:5432/gps_tracker
JWT_SECRET=GENERATE_WITH_openssl_rand_hex_32
JWT_ACCESS_TTL_MIN=15
JWT_REFRESH_TTL_DAYS=30

# ── CORS / 로그 ─────────────────────────
CORS_ALLOWED_ORIGINS=*
RUST_LOG=info,gps_tracker_api=debug,tower_http=info,sqlx=warn

# ── FCM (푸시) ─────────────────────────
# 비어있으면 dry-run 모드 — events 만 마킹, 실제 발송 X
FCM_SERVICE_ACCOUNT_PATH=/secure/path/to/gps-tracker-<id>-firebase-adminsdk-<hash>.json
FCM_SERVER_KEY=                   # 미사용 (FCM v1 으로 이전됨, env 호환만)

# ── 1NCE SIM ───────────────────────────
ONCE_API_CLIENT_ID=
ONCE_API_CLIENT_SECRET=
# 또는 (둘 중 하나만):
ONCE_API_TOKEN=
ONCE_REFILL_PAYMENT_METHOD=        # (옵션) 충전 결제 수단 식별자

# ── 카카오 ─────────────────────────────
KAKAO_REST_API_KEY=

# ── Toss ───────────────────────────────
TOSS_CLIENT_KEY=
TOSS_SECRET_KEY=
TOSS_WEBHOOK_SECRET=

# ── Bizm 알림톡 (Bizmsg) ────────────────
BIZMSG_USERID=
BIZMSG_PROFILE=
BIZMSG_SMS_SENDER=
SMS_DEV_MODE=0                     # 1 = 발송 안 하고 콘솔에 OTP 출력 (개발)

# ── OpenAI (AI 분석, 선택) ──────────────
OPENAI_API_KEY=
OPENAI_MODEL=gpt-4o-mini

# ── 가격 정책 ──────────────────────────
SIM_TOPUP_COST=                    # 빈 값이면 코드 기본값
CORPORATE_REPORT_PRICE=
ALLOW_SELF_TOPUP=0                 # 1 = 사용자가 직접 포인트 충전 가능
```

> `.env` 는 절대 commit 하지 마세요. `.gitignore` 에 등록되어 있습니다.

---

## 4. PostgreSQL 셋업

```bash
# 로컬 (Linux/Mac/WSL)
sudo -u postgres psql <<EOF
CREATE USER gps_tracker_app WITH PASSWORD 'CHANGE_ME';
CREATE DATABASE gps_tracker OWNER gps_tracker_app;
EOF
```

API 가 시작될 때 `sqlx::migrate!()` 가 `gps-tracker-api/migrations/0001~0030*.sql` 을 순차 실행합니다 (수동 마이그레이션 불필요).

---

## 5. 로컬 dev 실행

### 5-1. API

```bash
cd gps-tracker-api
cargo run             # → 127.0.0.1:3040
# health 체크
curl http://127.0.0.1:3040/gps-tracker/health
```

### 5-2. Web

```bash
cd gps-tracker-web
npm install
npm run dev           # → http://localhost:8003
```

`vite.config.js` 가 `/api/v1/*` 와 `/gps-tracker/*` 를 로컬 API 로 프록시합니다.

### 5-3. Arduino 펌웨어

각 sketch 폴더는 단독 컴파일/업로드 가능. 통합 펌웨어는 `arduino/13_1_motion_aware_tracker/`.

```bash
# arduino-cli 예
arduino-cli compile --fqbn esp32:esp32:esp32c3 arduino/13_1_motion_aware_tracker/
arduino-cli upload  --fqbn esp32:esp32:esp32c3 -p COM15 arduino/13_1_motion_aware_tracker/
```

필요 라이브러리: `TinyGPSPlus`, `Adafruit_SSD1306` (펌웨어 13_1+ 는 OLED 제거).

---

## 6. 서버 배포

### Prerequisites

- SSH key 가 서버 `mmm@210.114.18.16` 에 등록되어 있어야 함
- 서버에 systemd unit `gps-tracker-api.service` 존재, `ExecStart=/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api`
- 서버에 nginx + Let's Encrypt 인증서 (`seriallog.com`, `gps.serial.kr`)
- 서버 `/home/mmm/projects/gps-tracker-api/.env` 가 위 형식대로 채워져 있음
- 서버 어딘가에 Firebase 서비스 계정 JSON 배치 + `.env` 의 `FCM_SERVICE_ACCOUNT_PATH` 가 가리킴

### 배포 명령

```bash
# API (Rust)
cd gps-tracker-api && bash deploy.sh

# Web (React)
cd gps-tracker-web && bash deploy.sh
```

Windows 에선 ssh 가 막힐 때 WSL 경유:

```powershell
wsl -d Ubuntu -- bash -lc "cd /mnt/e/.../gps-tracker-api && bash deploy.sh"
```

배포 후 확인:

```bash
curl https://seriallog.com/gps-tracker/health
curl https://seriallog.com/gps-tracker/api/v1/auth/ping
```

### 함정: bin/ 경로

systemd ExecStart 는 `bin/gps-tracker-api` 하위를 실행합니다. 그 위 디렉토리(`target/release/...`)에 새 바이너리를 덮어쓰면 옛 바이너리가 계속 도는 버그가 있었음. `deploy.sh` 의 atomic swap (`bin/gps-tracker-api.new → bin/gps-tracker-api`) 단계를 건너뛰지 마세요.

---

## 7. URL / 도메인 매핑

| URL | 용도 |
|---|---|
| `https://seriallog.com/gps-tracker/health` | API health |
| `https://seriallog.com/gps-tracker/api/v1/*` | 인증된 REST |
| `https://seriallog.com/gps-tracker/ingest` | ESP 펌웨어 POST (익명) |
| `https://seriallog.com/gps-tracker/ws/realtime?token=<jwt>` | 실시간 WebSocket |
| `https://seriallog.com/gps-tracker/app/` | 프론트엔드 (sub-path) |
| `https://gps.serial.kr/` | 프론트엔드 (전용 서브도메인) — Flutter 앱이 로딩 |

nginx 가 `/gps-tracker/api/v1/*` → `127.0.0.1:3040/api/v1/*` 로 path rewrite + reverse proxy.

---

## 8. 자주 막히는 부분

| 증상 | 원인 / 해결 |
|---|---|
| `cargo build` 시 sqlx 컴파일 에러 | `.env` 의 `DATABASE_URL` 이 실제 DB 와 다름 (sqlx-cli offline 모드 미사용) |
| API 가 502 | 서버 디스크 풀, PostgreSQL down, 또는 systemd 가 옛 바이너리 잡고 있음 — `journalctl -u gps-tracker-api -n 100` 으로 확인 |
| POST `/ingest` 가 200 인데 DB 에 안 들어옴 | payload 파싱 실패가 silent 로 떨어짐 — `RUST_LOG=debug` 로 재시작 후 재현 |
| FCM 푸시 안 옴 | `FCM_SERVICE_ACCOUNT_PATH` 미설정 → dry-run 모드. journal 에 `fcm: live mode project=...` 떠야 활성 |
| Kakao 지도 404 / 권한 오류 | 카카오 디벨로퍼스에서 "플랫폼 → Web → 사이트 도메인" 에 운영 도메인 등록 누락 |
| Toss 결제 confirm 실패 | `TOSS_SECRET_KEY` 가 테스트키와 운영키 헷갈림. webhook secret 도 동일 환경의 것 |
