# 2. 아키텍처 큰 그림

4개 layer 가 서로 다른 언어로 돌고, WebSocket + REST + HTTPS POST 로 붙는다.

## 물리 흐름

```
    ┌──────────────────────┐
    │  ESP32-C3 + SIM7080G │  15초 주기 HTTP POST (SHREQ)
    │  LC86G/L86 GPS       │───────────┐
    │  LIS3DH 관성         │           │
    │  (필드 device)       │           ▼
    └──────────────────────┘   ┌────────────────────┐
                                │  nginx (Ubuntu)    │
    ┌──────────────────────┐   │  gps.serial.kr     │
    │  브라우저 / Flutter  │◄─►│                    │
    │  React SPA           │   │                    │
    │  Kakao Maps          │   │  ┌──────────────┐  │
    │  WebSocket 구독      │◄─►│  │ Rust axum    │  │
    └──────────────────────┘   │  │ :3040        │  │
                                │  └───────┬──────┘  │
                                │          │         │
                                │  ┌───────▼──────┐  │
                                │  │ PostgreSQL   │  │
                                │  │ + Timescale  │  │
                                │  └──────────────┘  │
                                └────────────────────┘
```

## Firmware 관점

15초마다 하나의 payload 를 HTTPS POST 한다:

```json
{
  "device_uid": "sim-47743516",
  "ts": 12345,
  "csq": 24,
  "reg": 5,
  "vbat_mv": 4240,
  "cbc_mv": 4210,
  "at_ms": 8500,
  "l80": { "fix": true, "lat": 35.949, "lng": 127.009, "sat": 8, "hdop": 1.2, "ttff_s": 15 },
  "fixes": [
    { "at_ms": -14000, "lat": 35.948, "lng": 127.008, "sat": 7 },
    { "at_ms": -7000,  "lat": 35.949, "lng": 127.009, "sat": 8 }
  ],
  "motion": { "total": 42, "delta": 3, "age_s": 5 },
  "diag": { "boots": 3, "wakes": 2, "brownouts": 0 }
}
```

- **`fixes[]`**: 지난 15초 안 잡은 여러 GPS fix (배치). 초기엔 한 번에 하나만 보냈다가, 자동차 이동 시 폴리라인이 "순간이동" 처럼 그려지는 버그로 배치 도입 (사고 #7 참조).
- **`vbat_mv` + `cbc_mv`**: 배터리 두 소스. ESP ADC + SIM7080 자체 측정. IR drop 진단용 (하드웨어 챕터 3 참조).

이 payload 를 서버가 받아서:
1. `location_records` (Timescale hypertable) 에 앵커 row + `fixes_jsonb` 로 저장
2. `events` 테이블에 wake/sleep/stuck 이벤트 저장
3. WebSocket 구독자에게 `Event::Location` broadcast

## 서버 관점

Rust axum 이 6가지 하는 일:

1. **`POST /ingest`** — device 인증 (device_uid) + payload 저장
2. **`GET /api/v1/devices/:id/locations`** — 시계열 조회 (grouped mode 지원)
3. **`GET /api/v1/devices`** — device 리스트 (LATERAL JOIN 으로 last_lat/vbat/antenna 등 최신값)
4. **`WebSocket /ws/realtime`** — 실시간 push (device 구독)
5. **`PATCH /auth/me/prefs`** — 사용자 설정 (theme, device_colors 등 JSONB merge)
6. **`POST /api/v1/notifications/*`** — FCM push (geofence 알림 등)

Worker 5개가 background 로:
- **fcm** — geofence 진입/이탈 시 알림 발송
- **geofence** — 30초마다 offline device 체크
- **daily_stats** — 5분마다 하루 통계 aggregate
- **housekeeping** — 24시간마다 오래된 데이터 정리
- **nce** — 1NCE SIM 사용량 30분마다 refresh

## 웹 관점

React SPA + Kakao Maps + WebSocket. 3가지 주요 뷰:

- **홈**: 실시간 지도 + device card. 마커 = 마지막 위치. 폴리라인 = 하루 궤적.
- **Seeker**: 특정 device 특정 일자 · 시간대별 재생. `drawSeekerPath` 로 폴리라인 + 화살표 + 정지 마커.
- **Diagnostic**: firmware 진단 이벤트 (wake/sleep/brownout) 시계열.

핵심 도전은 **폴리라인 성능**. 하루 2000 fix × device 5개 = 10K vertex. Kakao setPath 가 O(N) 이라 매 fix 마다 setPath 하면 O(N²). 실제로 이 버그 (사고 #10) 로 초 단위 lag 발생. Fix: bulk 로 마지막에 한 번 setPath.

## 데이터 흐름 (한 fix 의 수명)

```
GPS chip (LC86G/L86)
  └─ NMEA URC ($GNRMC, $GNGGA)
       └─ firmware NMEA parser
            └─ GpsFix { lat, lng, sat, hdop, fix }
                 └─ (15초 window 안 누적) → fixes[]
                      └─ HTTP POST (SHREQ over HTTPS)
                           └─ Rust ingest handler
                                ├─ location_records (anchor row + fixes_jsonb)
                                ├─ events (wake/sleep_enter 이면)
                                └─ broadcast Event::Location
                                     └─ WebSocket 구독자 (브라우저/Flutter)
                                          └─ Kakao map marker.setPosition
                                               └─ polyline segment append
```

## 인증 흐름

- **Firmware**: 익명. device_uid (SIM ICCID 기반) 로 서버가 자동 device row 생성/매칭. 이후 사용자가 페어링 (SIM 번호 입력) 하면 owner_id 설정.
- **Web/Mobile**: JWT access (15분) + refresh (30일). WebSocket 도 `?token=` 쿼리로 JWT 전달. 24시간+ 방치 세션 refresh 자동 (사고 #8 참조).

## 왜 이렇게 나눴나

**Rust axum**: VPS 는 저메모리 (2.9GB) 인데 device 여러 개 + 웹 사용자 + Timescale 다 돌려야 함. Node.js 대비 메모리 절반 이하 + WebSocket 성능 우수. sqlx 는 compile-time SQL 검증 + async.

**PostgreSQL + Timescale**: 위치 시계열은 자연스레 append-only + 시간 기반 파티션. Timescale hypertable 이 자동 청크 관리. `location_records` 는 50MB / 54K rows 로 아직 여유 (하루 2K row 씩 늘어남).

**React + Kakao**: 국내 지도 정확도가 Google Maps 보다 우수 (특히 골목/신축 아파트). Vite 는 dev 서버 hot reload + 빠른 build.

## 다음

- [3. 하드웨어 진화](03-hardware.md)
- [5. 서버 (Rust + Timescale)](05-server.md) — draft
- [8. 실전 사고](08-troubleshooting.md)
