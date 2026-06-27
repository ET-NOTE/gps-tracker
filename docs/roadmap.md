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

## 차기 라운드 — Frontend UX 강화

### 1. 줌 레벨별 좌표 샘플링
- 줌 멀면 (도시 단위) → 1시간 aggregate view 활용
- 줌 중간 (동네 단위) → 1분 aggregate
- 줌 가까이 (블록 단위) → raw (1초 단위 fix)
- 자동 전환 로직 + 사용자 토글 가능

### 2. 마커 / 포인터 매칭
- 현재: **heading 화살표 (방향 표기)** 와 **포인터 sampling** 이 별개 로직 — 같은 fix 가 화살표 위치 ≠ 점 위치 가능
- 변경: 두 표시가 동일 fix set 에서 derive — 같은 좌표/방향 보장
- 영향: KakaoMap.jsx 의 marker/polyline/arrow 생성 로직 통합

### 3. Seeker / 실시간 데이터 source 일관화
- 현재: seeker (과거 재현), 실시간 (WS broadcast), 지도 polyline (initial fetch) — 세 source 가 다른 path
- 변경: 단일 store + WS append 패턴. seeker 가 같은 store 의 시간 cursor.
- Race condition 조심 — 초기 fetch 와 WS 첫 broadcast 사이 ordering 보장.

### 4. P2 결정 (이 라운드와 함께)
위 sampling 로직을 raw flatten 가정 vs jsonb array 가정 둘 다 검토. backend 응답 schema 통일하면 자유.
- 결정 시점: sampling 코드 draft 후
- 영향: ingest.rs / DiagnosticPage / Dashboard / KakaoMap / seeker — 모든 좌표 처리 path
