# Roadmap — 1Hz 좌표 영구 보관 시나리오 대비

사용자 경험 (촘촘한 좌표) 를 production 으로 가져갈 때 DB 부담을 미리 잡는 단계.

## 현재 상태 (2026-06-27)

- ✓ Step 1 — BRIN index (PR #52 → migration 0038): 시계열 range scan 가속
- ✓ Step 2 — Monthly partitioning (PR #52 → migration 0039): 임시 단계. TimescaleDB 도입과 함께 hypertable 로 흡수됨
- ✓ Step bonus — fixes batch dedup 2s (was 500ms): batch 30 → 15 fix per POST, DB row 절반
- ✓ **Step 3 — TimescaleDB hypertable + compression + retention** (migration 0040): partitioning 흡수, 7일 chunk compression (10~20x), 1년 retention

## TimescaleDB 도입 결과

### 활성 정책 (운영 중)

**Compression policy**: 7일 이전 chunk 자동 compress
- `segmentby = device_id` → device 별 contiguous column-store
- `orderby = recorded_at DESC` → 시계열 순서 보존
- Expected ratio 10~20x

**Retention policy**: 영구 보관 (2026-06-27 결정)
- 장치 수 적은 초기 단계 — 영구 보관 우선. 추후 디스크 추세 보고 재검토.
- 다시 활성화하려면:
  ```sql
  SELECT add_retention_policy('location_records', INTERVAL '1 year');
  ```

### Chunk 자동 관리
- Default chunk interval: 7일
- TimescaleDB 가 자동 생성 (별도 worker 불필요 — partition_worker 제거됨)
- 변경 방법:
  ```sql
  SELECT set_chunk_time_interval('location_records', INTERVAL '14 days');
  ```

### Background workers (TimescaleDB 내장)
- Compression policy worker (자동)
- Retention policy worker (자동)
- 추가 cron / app worker 필요 없음

## To-Do (우선순위 순)

### ✓ 1. Continuous aggregates (P1 — 완료, migration 0041)

DiagnosticPage 의 historical chart 가속용.
- `location_1min` — 1분 평균 (lat/lng/sat/vbat + fix_count). raw scan, refresh 5분 주기, 7일 window.
- `location_1hour` — 1시간 평균. raw scan, refresh 30분 주기, 30일 window.
- (참고: TimescaleDB 의 hierarchical CAGG 가 time_bucket 인식 제약 있어 둘 다 raw 에서 직접 집계.)
- API endpoint: `/devices/:id/locations/aggregated?bucket=1m|1h&since=...`.

**Trade-off**: storage 약간 증가 (aggregate cache), query 응답 크게 빨라짐.

### 2. fixes array 1 POST → 1 row (P2 — 효과 측정 후 결정)

TimescaleDB compression 도입 후 row 압축이 이미 효과적이라 의미 약화 가능.
1주일 정도 compression ratio 측정 후 결정.

### ✓ 3. Continuous aggregates 활용 UI (P3 — 완료)

DiagnosticPage 의 "시간대 추세" bar chart 가 aggregate view 활용.
- 윈도우 1h/6h/24h → 1m bucket
- 그 외 → 1h bucket
- 추후 Dashboard 나 별도 history 페이지에도 적용 가능 (`api.getDeviceLocationsAggregated` 호출).

## 운영 모니터링 To-Do

- Compression ratio 추적:
  ```sql
  SELECT chunk_schema, chunk_name,
         pg_size_pretty(uncompressed_total_bytes) AS before,
         pg_size_pretty(compressed_total_bytes)   AS after,
         ROUND(uncompressed_total_bytes::numeric / NULLIF(compressed_total_bytes, 0), 1) AS ratio
  FROM chunks_detailed_size('location_records');
  ```
- Chunk 수 / 디스크 사용량 추세
- Retention policy 동작 (1년 이전 chunk drop 로그 확인)

## 의사결정 보류

- **fixes array 1 POST → 1 row (P2)**: 별개 layer 변경 — backend 저장 방식 (현재 1 POST = 15 rows → 변경 후 1 POST = 1 row + jsonb array). batch size 와 무관. 차기 Frontend UX 라운드에서 sampling 로직과 같이 결정.

---

## ✓ Frontend UX 라운드 완료 (2026-06-27)

### ✓ Phase 1 — Backend grouped schema (PR #55)
- `listLocations?grouped=true` 응답: `[{ post_at, vbat_mv, uptime_s, batch_size, fixes: [...] }, ...]`
- Storage 변경 X — `raw->>'at_ms'` + `raw->>'ts'` 로 group by
- Backward compat 유지 (legacy flat 응답 default). P2 시 storage 만 변경 → 무중단

### ✓ Phase 2 — Frontend consumers (PR #56, #57)
- Dashboard, SeekerSheet, RoutePlayback 모두 `listLocationsGrouped` + `flattenGrouped` 사용
- `flattenGrouped` 가 fix 마다 `post_at`, `batch_size`, `is_last_in_post`, `post_idx` metadata 부여

### ✓ Phase 3 — 마커 / 화살표 일관화 (PR #58, #59)
- KakaoMap 의 heading 화살표를 `picked marker` (skipMarker=false) 와 같은 fix 위치에 align
- ARROW_INTERVAL_M (별도 거리) 제거 — sampling 알고리즘이 이미 거리 처리
- `is_last_in_post` metadata 로 같은 POST 묶음 인지 가능

### ✓ Phase 4 — Aggregate + 정밀도 + WS polyline (PR #61, #62, #63, #64)
- **4A**: `location_5min` continuous aggregate view + DiagnosticPage 간격 토글 (1m/5m/1h)
- **4B-1**: SeekerSheet day 모드 1m aggregate (24h × 1Hz = 86,400 raw → 1440 bucket, 누락 해결) + month 의 `lat_last` 정정
- **4B-2**: SeekerSheet 정밀도 토글 (auto / 1m / 5m / 1h)
- **4C**: WS broadcast 시 history polyline 도 자동 자라남 (`skipMarker: true` 라 marker burst 방지)

### ✓ Phase 5 — SeekerSheet 월간 aggregate (PR #60)
- 1h continuous aggregate view 사용 (raw 10000 cap → 720 bucket)
- ms 단위 응답 (column-store + pre-computed)

### Phase 6 — Storage 결정 (1 POST → 1 row + jsonb)
- 1주일 compression ratio 측정 후 결정
- 효과 충분하면 skip, 의미 크면 ingest.rs 의 fixes 처리만 변경 (API contract 그대로 → 무중단)

---

## ✓ 연계 작업 라운드 (2026-06-27)

라운드 종료 후 버그 hunt + 효율 개선.

### ✓ flattenGrouped DESC sort 버그 (PR #66)
- backend listLocations?grouped=true 응답: groups DESC, group 안 fixes ASC
- flatMap 결과: group 사이 DESC, group 안 ASC (hybrid)
- consumer reverse() 후 한 사이클 polyline 거꾸로 → "순간이동" cross-section 직선
- 수정: flattenGrouped 끝에 recorded_at DESC sort

### ✓ P1 — WS batch broadcast + dedup (PR #68)
- backend: `events::Event::Location` 에 `fixes: Option<Vec<LocationFix>>` 추가
- ingest: 1 POST 의 N fix broadcast 를 N회 → 1회 (배열 묶음)
- frontend `KakaoMap.addHistoryPoint`: `recorded_at` 기반 dedup (initial + WS race 해결)
- frontend `Dashboard.handleWsEvent`: msg.fixes 활용 (legacy single fix 호환)
- 효과: WS 메시지 1/15, handler 진입 1/15, polyline redraw burst 해결

### ✓ P2 — 운영 지표 카드 (DiagnosticPage) — PR #69
- 새 endpoint `GET /timescaledb/storage-stats` (인증된 user 전체 hypertable 통계)
- 8 tile 카드 — hypertable size / chunk 수 / 압축된 chunk / **압축 비율** / 1m·5m·1h aggregate size / retention
- 5초 polling (다른 진단 데이터와 동기)

**1차 실측 (2026-06-27, migration 0040 적용 7일 후)**: 9/11 chunk 자동 압축, **35.1MB → 2.48MB = 14.1×**
→ **Phase 6 skip 결정 (예정)** — 1주일 더 관찰 후 최종 확정. compression 만으로 디스크 부담 해소됨.

### P3 — WS 멀티플렉싱 검토 (필요 시)
- device 별 별도 channel 인지 확인. 다수 device 시 효율

## 라운드 적용 결과
- POST grouping (batch dimension), 시간 필터 (sensor 차트 dimension), 거리 sampling (seeker dimension) 셋 모두 적용
- 모든 consumer 단일 API contract 사용 — P2 시 backend storage 만 변경 가능
- TimescaleDB continuous aggregate (1m / 5m / 1h) — 시간 범위 큰 query ms 응답
- WS broadcast → 실시간 polyline 자라남 (이전엔 marker 만 갱신, 30s refresh 까지 polyline stale)
