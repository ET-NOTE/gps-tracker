# 5. 서버 — Rust + axum + Timescale

> VPS 2.9GB RAM 에서 Node 대신 Rust 를 고른 이유. Postgres + TimescaleDB 로 위치 시계열 다루기. Phase 1/6 스키마 진화. WebSocket broadcast fan-out. Worker 5개.

## 왜 Rust?

VPS 실사:
- **2.9 GB RAM 전체** — 다른 서비스도 공존 (nginx, postgres, node.js 백엔드 하나, python fastapi 등)
- **우리 API 예산 = 200-300 MB** 정도

Node.js 로 axum 급 기능 구현 시 대개 500MB+. Rust 로 짜면 200MB 아래. **VPS 전체 예산의 10%** 로 API 담당 가능.

또:
- **sqlx compile-time SQL 검증** — 문자열 SQL 이 컴파일 타임에 스키마 대조. Timescale extension 함수도 검증됨. 런타임 typo 방지.
- **axum async + tokio** — WebSocket + REST + background worker 를 한 프로세스에서. 컨텍스트 스위칭 최소.
- **Tower middleware ecosystem** — CORS, tracing, gzip compression, timeout 등 표준 조합.

단점:
- **컴파일 시간** — `cargo build --release` 가 8분 (VPS 저사양). 배포 스크립트는 매번 새 build → 8분 downtime. 나중에 incremental build 도입 예정.
- **Rust 배우기** — Node 대비 진입 장벽 있음. 하지만 axum + sqlx 만 알면 CRUD 는 금방.

## 스키마 진화

### Phase 0 (초기)

가장 단순한 형태:

```sql
CREATE TABLE location_records (
  id BIGSERIAL PRIMARY KEY,
  device_id INT REFERENCES devices(id),
  recorded_at TIMESTAMPTZ NOT NULL,
  lat DOUBLE PRECISION, lng DOUBLE PRECISION,
  sat INT, vbat_mv INT,
  ...
);
```

Fix 하나마다 row 하나. 하루 5,000 fix × device 5개 = 25K rows/day. 1년이면 9백만 rows. Postgres 로 감당은 되지만 조회 (특정 device 특정 날짜 시계열) 마다 index scan 오래 걸리기 시작.

### Phase 1 — TimescaleDB hypertable

`location_records` 를 hypertable 로 변환:

```sql
SELECT create_hypertable('location_records', 'recorded_at', 
                          chunk_time_interval => INTERVAL '7 days');
```

7일 단위 chunk 자동 파티션. 시계열 조회 시 최근 chunk 만 스캔 → 훨씬 빠름.

`hypertable_size('location_records')` 실측 = 50 MB, 54,662 rows (2.5개월 데이터). 아직 자원 여유 많음. 이 정도면 인덱스 잘 잡고 청크 관리 자동이라 device 100개+ 까지도 문제 없을 것.

### Phase 6 — Batch fixes JSONB

가장 큰 리팩터. 문제:

Firmware batch fix payload:
```json
{
  "vbat_mv": 4240,
  "l80": { "fix": true, "lat": ..., "lng": ..., "sat": 8 },
  "fixes": [
    { "at_ms": -14000, "lat": ..., "lng": ... },
    { "at_ms": -13000, "lat": ..., "lng": ... },
    ... (15개 fix, 15초 window)
  ]
}
```

기존 스키마는 fix 하나 = row 하나. 15 fix 오면 **INSERT 15번**. 좋은 트랜잭션 처리에도 batch overhead 있음. 그리고 이 15개는 모두 **같은 POST 에 속한다** 는 grouping 정보 유지 필요 (같은 vbat_mv, csq, reg 공유).

**Phase 6 fix**:

1. **Anchor row 하나** + 그 안 `fixes_jsonb` 컬럼에 나머지 14 fix
2. Column-sibling (Legacy compat) 도 함께 저장 — 이전 SQL 이 그대로 동작

```sql
INSERT INTO location_records (device_id, recorded_at, lat, lng, sat, vbat_mv, csq, reg, raw, fixes_jsonb)
VALUES (..., anchor_lat, anchor_lng, anchor_sat, vbat, csq, reg, raw_json, jsonb_fixes);
```

**결과**: 
- Row 수 = POST 수 (fix 수 아님). ~15배 감소
- 조회 시 `unnest jsonb_fixes` 로 개별 fix 접근. `at_ms` offset + anchor 시각 = 개별 fix 시각.
- Column-sibling 은 legacy consumer 호환용 (이전 flat schema 로 조회하는 코드).

### Phase D — 공유 링크

외부 사용자 (인증 없이) 가 특정 device 특정 기간 지도를 볼 수 있게. `share_tokens` 테이블 + `SharePage` 프론트. Token 발급 + 만료 관리.

## Grouped API

`GET /api/v1/devices/:id/locations?grouped=true` 응답:

```json
[
  {
    "post_at": "2026-07-16T12:04:00Z",
    "uptime_s": 8500,
    "vbat_mv": 4240,
    "cbc_mv": 4210,
    "csq": 24,
    "reg": 5,
    "batch_size": 15,
    "fixes": [
      { "recorded_at": "...", "lat": ..., "lng": ..., "sat": 8 },
      ...
    ]
  },
  ...
]
```

**같은 POST 에 속하는 fix 들이 하나의 group** 으로 응답. 프론트는 이걸 그대로 사용하거나 `flattenGrouped()` 로 flat array 로 unpack.

Grouped 응답의 이점:
- vbat/csq/reg 는 POST 단위 공유 → 각 fix 마다 반복 안 함 (payload 절약)
- 프론트가 "이 fix 는 어느 POST 소속?" 즉시 알 수 있음 → polyline gap 판정 정확

## LATERAL JOIN 으로 device 메타 aggregate

`GET /api/v1/devices` 응답에는 각 device 의 최신 lat/lng/vbat/antenna 등이 필요. Naive 하게 하면:

```sql
SELECT * FROM devices d;
-- 이후 각 device 별 별도 쿼리
```

= N+1 쿼리. 100 device 면 101번 쿼리. 대신 `LATERAL JOIN`:

```sql
SELECT d.*, la.antenna AS last_antenna, lv.vbat_mv AS last_vbat_mv, lv.cbc_mv AS last_cbc_mv
  FROM devices d
LEFT JOIN LATERAL (
  SELECT antenna FROM (
    SELECT raw->>'antenna' AS antenna, recorded_at AS at FROM location_records WHERE device_id = d.id AND raw ? 'antenna'
    UNION ALL
    SELECT data->>'antenna' AS antenna, occurred_at AS at FROM events WHERE device_id = d.id AND data ? 'antenna'
  ) x WHERE x.antenna IS NOT NULL AND x.antenna <> ''
  ORDER BY x.at DESC LIMIT 1
) la ON TRUE
LEFT JOIN LATERAL (
  SELECT vbat_mv, (raw->>'cbc_mv')::int AS cbc_mv
    FROM location_records
   WHERE device_id = d.id AND vbat_mv IS NOT NULL
   ORDER BY recorded_at DESC LIMIT 1
) lv ON TRUE
WHERE d.owner_id = $1;
```

한 쿼리로 모든 device 의 aggregate. Postgres query planner 가 각 device 별 서브쿼리를 hypertable 최신 chunk 에만 국한 → 빠름.

**교훈**: N+1 은 언어 무관 흔한 함정. LATERAL JOIN 은 Postgres 무기 (MySQL 도 8.0+ 지원).

## WebSocket broadcast fan-out

```rust
#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Location {
        device_id: i64,
        recorded_at: DateTime<Utc>,
        source: String,
        fix: bool,
        lat: Option<f64>,
        lng: Option<f64>,
        sat: Option<i16>,
        ttff_s: Option<i32>,
        vbat_mv: Option<i32>,
        cbc_mv: Option<i32>,   // 2026-07: 배터리 두 소스
        heading: Option<f32>,
        fixes: Option<Vec<LocationFix>>,   // Phase 1: batch
    },
    DeviceEvent { device_id: i64, kind: String, data: serde_json::Value },
}

pub fn channel(capacity: usize) -> broadcast::Sender<Event> {
    let (tx, _) = broadcast::channel(capacity);
    tx
}
```

`tokio::sync::broadcast` — multi-producer, multi-consumer. 각 WebSocket 구독자가 자기 subscriber 로 receive. `state.events.send(...)` 한 번으로 모든 구독자에게 fan-out.

**필터링**: 각 구독자 자기가 구독한 device 만 통과. Server 에서 device 별로 broadcast 채널 만들지 않고 하나의 채널 + 클라이언트 필터. 100+ device 되면 채널 분리 검토.

**Ingest → broadcast 흐름**:

```rust
let _ = state.events.send(Event::Location {
    device_id,
    recorded_at,
    ...
    vbat_mv: parsed.vbat_mv,
    cbc_mv: parsed.cbc_mv,   // 이 필드 없으면 frontend 페어링 깨짐 (사고 #? 참조)
    fixes: Some(fixes),
});
```

이 하나의 필드 (`cbc_mv`) 를 broadcast 에 넣는 걸 잊어서 웹 UI 배터리 값이 stale 로 뜨는 사고 겪음. **payload 스펙 변경 시 3층 (firmware/서버 저장/서버 broadcast/웹 fallback) 모두 확인 원칙**.

## Worker 5개

Rust API 프로세스 안 tokio task 로 background:

```rust
tokio::spawn(services::fcm::worker(state.clone()));
tokio::spawn(services::geofence::offline_worker(state.clone()));
tokio::spawn(services::stats::worker(state.clone()));
tokio::spawn(services::housekeeping::worker(state.clone()));
tokio::spawn(services::nce::worker(state.clone()));
```

- **fcm**: 알림 발송 큐 처리. FCM v1 API 사용 (`gps-tracker-e21be-firebase-adminsdk-*.json` 서비스 계정)
- **geofence** offline: 30초마다 마지막 seen > 5분 device 를 offline 판정 + push 알림
- **stats** daily_stats: 5분마다 하루 통계 aggregate (distance, moving time, max speed 등). `daily_stats` 테이블에 저장
- **housekeeping**: 24시간마다 오래된 데이터 정리 (예: refresh_tokens 만료 삭제)
- **nce** (1NCE): 30분마다 각 device SIM 사용량 refresh (1NCE OAuth API). `devices.sim_info_cache` JSONB 갱신

Worker 는 REST/WS 와 같은 프로세스 (같은 DB pool 공유). 실패 시 재시작은 systemd 에 위임 (`Restart=on-failure`).

## 배포 = 8분 downtime

```bash
# deploy.sh 
tar -czf src.tar.gz .
scp src.tar.gz $SERVER:/tmp/
ssh $SERVER 'tar -xzf ... && cd src && touch src/main.rs && cargo build --release'
ssh $SERVER 'cp bin/gps-tracker-api-new bin/gps-tracker-api && systemctl restart gps-tracker-api'
```

VPS 저사양 (cargo build --release 8분) + `systemctl restart` → 8분+ 서비스 중단. Blue-green 배포 or docker 로 개선 예정. 지금은 device 가 15초 주기 POST 라 8분 놓쳐도 batch fixes 로 복구되어서 데이터 유실 없음.

## 실측 부하

지금 (device 3-5개):
- **API TTFB** = 42 ms (`/api/v1/devices` 인증 없이 401)
- **Memory** = 199 MB (worker 5 + WS 구독자 소수)
- **CPU** = <1% (거의 idle)
- **DB size** = 50 MB (hypertable) + 3 MB (events) + 2 MB (refresh_tokens)

Device 100개까지도 지금 인프라로 처리 예상. 500개+ 되면 partitioning + Redis pub-sub 검토.

## 배운 것

1. **Rust + axum 은 VPS 저사양에 적합** — Node 대비 메모리 절반 이하. 컴파일 시간 아쉽지만 런타임 안정
2. **sqlx compile-time SQL 은 좋다** — 스키마 변경 시 컴파일 에러로 즉시 발견
3. **Timescale hypertable 은 시계열의 자연** — 자동 chunk 관리. 별도 sharding 로직 X
4. **JSONB anchor + column-sibling 은 legacy 호환의 정석** — 스키마 진화 시 이전 consumer 코드 안 깨짐
5. **LATERAL JOIN 은 N+1 해결의 무기** — 100 device 도 한 쿼리
6. **Payload 스펙 변경은 3층 (firmware/서버/웹) 모두 확인** — 하나만 잊으면 사용자 체감 버그

## 다음

- [6. 프론트 (React + Kakao Maps)](06-frontend.md)
- [gps-tracker-api/src/routes/](../../gps-tracker-api/src/routes/) — 실제 코드
