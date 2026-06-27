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

## 차기 라운드 — Frontend UX 강화 (Phase별 PR)

### Phase 1 — Backend: listLocations grouped response schema (foundation)
- 응답을 POST 단위 grouping: `[{ post_at, vbat_mv, uptime_s, batch_size, fixes: [...] }, ...]`
- Storage 는 변경 X (현재 N rows 그대로) — `raw->>'ts'` 또는 `raw->>'at_ms'` 로 group by
- backward compat: query param `?grouped=true` 옵션 (UI 마이그레이션 끝나면 default)
- 이게 P2 (storage 변경) 의 contract 미리 확보 → frontend 변경 한 번만

### Phase 2 — Frontend: KakaoMap / Dashboard / DeviceDetail 가 새 schema 사용
- polyline / marker / heading 화살표 모두 grouped fix set 활용
- POST grouping 정보 활용 — 같은 사이클 좌표끼리 polyline gap 없이 연결, 다른 사이클 사이 dashed gap
- 영향 파일: KakaoMap.jsx, Dashboard.jsx, DeviceDetail.jsx, SeekerSheet.jsx

### Phase 3 — 마커 / 포인터 매칭 일관화
- 현재: **heading 화살표 (방향)** 와 **포인터 sampling** 이 별개 로직 — 같은 fix 가 화살표 위치 ≠ 점 위치 가능
- 변경: 두 표시가 동일 fix set 에서 derive

### Phase 4 — Seeker / 실시간 source 통합
- 현재: seeker (과거 재현) / 실시간 (WS broadcast) / 지도 polyline (initial fetch) — 세 source 가 별도 path
- 변경: 단일 store + WS append 패턴. seeker 가 같은 store 의 시간 cursor
- Race condition 조심 — 초기 fetch 와 WS 첫 broadcast ordering 보장

### Phase 5 — 줌별 자동 bucket 선택 (sensor 차트 stack 정점)
- 줌 멀면 (도시) → `/aggregated?bucket=1h` (continuous aggregate ms 응답)
- 줌 중간 (동네) → `/aggregated?bucket=1m`
- 줌 가까이 (블록) → `/locations?grouped=true` (raw)
- 추가 aggregate view (5min, 1day) 필요 시 migration 1줄
- Gap-fill (LOCF / linear) — LTE 두절 구간 자연스럽게 보간

### Phase 6 — P2 결정 (storage 변경)
- Phase 1~5 검증 후 row 수 / compression ratio / query 부담 측정
- 효과 충분하면 skip, 의미 크면 ingest.rs 의 fixes 처리만 변경 (API contract 그대로 → 무중단)
