# 5. 서버 — Rust + axum + Timescale (draft)

> Draft.

## 요약

- **stack**: Rust + axum + sqlx + PostgreSQL 14 + TimescaleDB
- **VPS**: 2.9GB RAM (nginx + rust api + web + postgres + 다른 서비스 몇 개 공존). 메모리 절약 관점 rust 선택
- **핵심 테이블**:
  - `location_records` (Timescale hypertable) — 위치 시계열. Phase 6 부터 anchor row + `fixes_jsonb` 로 batch 저장
  - `events` — wake · sleep · brownout · geofence 등 lifecycle
  - `devices` — device 메타. LATERAL JOIN 으로 `last_lat/vbat/antenna` 등 최신값 pull
- **WebSocket**: `tokio::sync::broadcast` 로 fan-out. 구독 device 만 필터링
- **Worker 5개**: fcm · geofence · daily_stats · housekeeping · nce (1NCE SIM 사용량)

## Phase 진화

- Phase 1: POST-단위 grouping API (같은 POST fix 들 하나로 묶어 응답)
- Phase 6: batch fix 를 `fixes_jsonb` 안에 저장 (row 폭증 방지)
- Phase D: 공유 링크 (외부 사용자용)

## 관련 코드

- `gps-tracker-api/src/routes/ingest.rs` — firmware POST 받는 곳
- `gps-tracker-api/src/routes/locations.rs` — 시계열 조회 (grouped mode)
- `gps-tracker-api/src/routes/devices.rs` — device 리스트 (LATERAL JOIN)
- `gps-tracker-api/src/events.rs` — WebSocket broadcast

## 다음

- [6. 프론트](06-frontend.md)
