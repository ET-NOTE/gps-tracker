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

**Retention policy**: 1년 이전 chunk 자동 drop
- 변경 방법:
  ```sql
  SELECT remove_retention_policy('location_records');
  SELECT add_retention_policy('location_records', INTERVAL '6 months');   -- 또는 다른 값
  ```
- 영구 보관 원하면 retention policy 제거만 하면 됨
- 운영 중 retention 도달 직전 사용자에게 통보 / archive 검토 필요

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

### 1. Continuous aggregates (P1 — 후속)

DiagnosticPage / Dashboard 의 historical chart 가속용.
- 1분 평균 / 5분 평균 / 1시간 평균 자동 갱신 view
- 시간 범위 큰 쿼리 (예: "지난 1주일 위치") 가 raw 대신 aggregate scan → ms 단위 응답

```sql
CREATE MATERIALIZED VIEW location_1min
WITH (timescaledb.continuous) AS
SELECT device_id,
       time_bucket('1 minute', recorded_at) AS bucket,
       AVG(lat) AS lat, AVG(lng) AS lng,
       AVG(sat) AS sat, COUNT(*) AS fix_count
FROM location_records WHERE fix = true
GROUP BY device_id, bucket;

SELECT add_continuous_aggregate_policy('location_1min',
    start_offset => INTERVAL '7 days',
    end_offset   => INTERVAL '1 minute',
    schedule_interval => INTERVAL '1 minute');
```

**Trade-off**: storage 약간 증가 (aggregate cache), query 응답 크게 빨라짐.

### 2. fixes array 1 POST → 1 row (P2 — 효과 측정 후 결정)

TimescaleDB compression 도입 후 row 압축이 이미 효과적이라 의미 약화 가능.
1주일 정도 compression ratio 측정 후 결정.

### 3. Continuous aggregates 활용 UI (P3 — P1 후)

DiagnosticPage / Dashboard 의 historical chart 가 raw 대신 aggregate scan 하도록 코드 변경.
- listLocations(range='week') → 1분 평균 view 활용
- listLocations(range='day') → raw 활용

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

- **Retention 1년 vs 영구**: 1년 동안 디스크 추세 측정 후 결정. 영구 원하면 retention policy 제거.
- **continuous aggregates 도입 시점**: 사용자가 historical chart 사용 빈도 확인 후.
