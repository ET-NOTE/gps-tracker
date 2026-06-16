# gps-tracker-api

ESP32-C3 GPS 트래커 백엔드 (Rust + axum + sqlx + PostgreSQL).

## 역할

```
ESP32 device  ─── POST ───┐
                          ▼
Flutter app  ◀─── REST ──▶ gps-tracker-api ◀─── SQL ──▶ PostgreSQL
                ◀── WS ──▶
                          │
                          └─── HTTPS ──▶ FCM (push)
```

## 엔드포인트

| 경로 | 용도 | 인증 |
|------|------|------|
| `POST /gps-tracker/ingest` | ESP 디바이스 위치 업로드 (레거시 호환) | API key (device) |
| `POST /gps-tracker/api/v1/auth/register` | 사용자 등록 | - |
| `POST /gps-tracker/api/v1/auth/login` | 로그인 → JWT | - |
| `POST /gps-tracker/api/v1/auth/refresh` | refresh token으로 access 갱신 | refresh |
| `GET  /gps-tracker/api/v1/devices` | 내 디바이스 목록 | JWT |
| `GET  /gps-tracker/api/v1/devices/:id` | 디바이스 상세 | JWT |
| `GET  /gps-tracker/api/v1/locations/:device_id/latest` | 최근 위치 | JWT |
| `GET  /gps-tracker/api/v1/locations/:device_id/history` | 이력 (시간 범위) | JWT |
| `POST /gps-tracker/api/v1/push/register` | FCM 토큰 등록 | JWT |
| `WS   /gps-tracker/ws` | 실시간 위치 스트림 | JWT (query param) |

## 빌드 (WSL2 Ubuntu)

```bash
# rustup 설치 (한 번만)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# 의존성 설치
sudo apt-get install pkg-config libssl-dev

# 환경변수
cp .env.example .env
$EDITOR .env

# 마이그레이션 적용 (sqlx-cli 사용시)
cargo install sqlx-cli --no-default-features --features rustls,postgres
sqlx migrate run

# 개발 실행
cargo run

# 릴리즈 빌드
cargo build --release
# → target/release/gps-tracker-api
```

## 배포 (server)

```bash
# WSL2에서 빌드한 binary scp
scp target/release/gps-tracker-api root@210.114.18.16:/home/mmm/projects/gps-tracker-api/bin/

# 서버에서 systemd 등록 (한 번만)
sudo systemctl enable --now gps-tracker-api

# 업데이트 시
ssh root@210.114.18.16 'systemctl restart gps-tracker-api'
```

## 마이그레이션

`migrations/` 디렉토리의 SQL 파일은 sqlx-cli가 적재. 새 변경은 다음 번호 파일로 추가
(`0002_*.sql`, `0003_*.sql` ...). 한 번 배포된 마이그레이션은 절대 수정 X.
