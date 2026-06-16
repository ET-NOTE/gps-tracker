# gps-tracker

ESP32-C3 + L80-R GPS + SIM7080G 트래커 — Rust(axum) API + React(Vite) 웹 + Arduino 펌웨어.
운영 URL: https://seriallog.com

## 1분 길찾기

| 보고 싶은 것 | 어디로 |
|---|---|
| **지금 어디까지 만들어졌는지** | [STATUS.md](STATUS.md) |
| **로컬에서 돌려보고 싶다** | [docs/SETUP.md](docs/SETUP.md) |
| **API 스펙 (REST + WebSocket)** | [docs/API_CONTRACT.md](docs/API_CONTRACT.md) |
| **시스템 전체 구조** | [architecture.md](architecture.md) |
| **외부 키 발급 경로** | [docs/SETUP.md §1](docs/SETUP.md) + [docs/1NCE_INTEGRATION.md §8](docs/1NCE_INTEGRATION.md) |
| **푸시 알림 셋업 (FCM/APNs)** | [docs/FCM_SETUP.md](docs/FCM_SETUP.md) |
| **데이터 책임 경계** | [DATA_BOUNDARIES.md](DATA_BOUNDARIES.md) |
| **PR 올리는 규칙** | [CONTRIBUTING.md](CONTRIBUTING.md) |

## 리포지토리 구조

```
gps-tracker-api/        Rust + axum + sqlx (PostgreSQL). systemd 서비스로 운영
gps-tracker-web/        React + Vite. nginx 뒤에서 SPA 서빙
arduino/                ESP32-C3 펌웨어 단계별 (01_oled_test ~ 13_motion_aware_tracker)
docs/                   SETUP / API_CONTRACT / FCM_SETUP / 1NCE_INTEGRATION
server_assets/          레거시 Python 대시보드 (gps-tracker/ 경로)
```

## 빠른 시작 (개발자)

```bash
# 1) 백엔드
cd gps-tracker-api
cp .env.example .env       # 값 채우기 — docs/SETUP.md 참고
cargo run                  # → http://127.0.0.1:3040

# 2) 프론트
cd ../gps-tracker-web
npm install
npm run dev                # → http://localhost:5173
```

PR 올리기 전 [CONTRIBUTING.md](CONTRIBUTING.md) 한 번 읽어보세요.

## 도움

막힐 때:
- `docs/` 안 모든 문서 + memory 그랩 (Claude Code 사용 시)
- [STATUS.md](STATUS.md) 의 "핵심 결정사항" — 바꾸지 말아야 할 것들
- 그래도 막히면 maintainer (`@ETC11111`) 에게 PR comment 나 이슈로 ping
