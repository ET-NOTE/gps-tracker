# Roadmap — 1Hz 좌표 영구 보관 시나리오 대비

사용자 경험 (촘촘한 좌표) 를 production 으로 가져갈 때 DB 부담을 미리 잡는 단계.

## 현재 상태 (2026-06-27)

- ✓ Step 1 — BRIN index (PR #49 → migration 0038): 시계열 range scan 가속
- ✓ Step 2 — Monthly partitioning (PR #50 → migration 0039): drop partition 으로 디스크 회수, partition pruning 가속
- ✓ Step bonus — fixes batch dedup 2s (was 500ms): batch 30 → 15 fix per POST, DB row 절반

## To-Do (우선순위 순)

### 1. TimescaleDB migration (P0 — 다음 작업)

**왜 down-sampling 보다 먼저인가**: 데이터 양이 적을 때 migration 비용 작음. 100GB 도달 후엔 다운타임 + 비용 큼. 지금 ~40MB 라 거의 무료.

작업:
- VPS 에 `CREATE EXTENSION timescaledb` 설치 (apt repo + extension 활성)
- 기존 monthly partition → hypertable 로 conversion (`create_hypertable` migration 함수)
- Compression policy: 7일 이전 chunk 자동 compress (10~20x 절감)
- Retention policy: 1년 이전 chunk 자동 drop (optional, 의사결정 필요)
- Continuous aggregates: 1분/5분/1시간 평균 자동 갱신 view — DiagnosticPage / Dashboard 의 historical chart 가속

**Trade-off**:
- 장점: native column-store 압축 10~20x, retention 자동, continuous aggregates
- 단점: PG fork extension — 일부 PG 기능 호환성 (대부분 OK), VPS 운영 복잡도 +1
- partition 작업 (Step 2) 이 헛수고는 아님 — TimescaleDB 가 PG declarative partition 그대로 인식. step 2 의 효과는 step 1+TimescaleDB 도입 전까지 유효

**Estimated effort**: 1주
- Day 1: VPS extension 설치 + dev 환경 검증
- Day 2~3: migration script (hypertable conversion) + compression policy
- Day 4~5: continuous aggregates + UI 코드 활용
- Day 6~7: 운영 모니터링 + retention 정책 결정

### 2. fixes array 1 POST → 1 row (P1)

현재: 1 POST = N (1~30) location_records row (각 fix 별).
변경: 1 POST = 1 row + fix array 가 jsonb 컬럼에 저장.
효과: DB row ~30배 절감 + INSERT 부담 ↓.

**Trade-off**:
- 장점: row 수 크게 감소, INSERT 빠름
- 단점: query 패턴 변경 (`jsonb_array_elements` 로 풀어야), DiagnosticPage / Dashboard / 지도 polyline 모든 코드 변경 — **breaking change**
- TimescaleDB compression 도입 시 row 압축이 이미 효과적 → 이 작업 의미 약화 가능

**의사결정**: TimescaleDB 도입 후 효과 측정. row 압축이 충분하면 skip.

### 3. legacy table DROP (P2 — 24h 안정성 검증 후)

현재 `location_records_legacy` 가 39MB 차지 (검증용 보존).
24h+ 안정성 확인 후 별도 migration 으로 DROP. 디스크 즉시 회수.

```sql
DROP TABLE location_records_legacy;
```

### 4. Down-sampling worker (P3 — TimescaleDB 도입 안 하기로 결정 시)

TimescaleDB 의 continuous aggregates 가 자동화하는 작업의 수동 버전.
30일+ raw 1Hz → 1분 평균으로 압축 + raw drop.

**Trade-off**:
- 장점: 디스크 ~60배 절감
- 단점: **정확도 손실 (non-reversible)** — 옛 사이클의 1초 단위 좌표 사라짐
- TimescaleDB compression 이 정확도 보존하면서 더 큰 압축 — 우월

**의사결정**: TimescaleDB 도입 결정 시 skip. 도입 안 하면 P1.

## 운영 모니터링 To-Do

- partition_worker tick 매일 정상 동작 확인 (다음 3개월 partition 미리 생성)
- `location_records_default` 가 채워지면 alert (partition worker 실패 신호)
- TimescaleDB 도입 후 compression ratio 추적

## 의사결정 보류

- **1 year retention** vs 영구 보관 — TimescaleDB compression 도입 후 디스크 곡선 측정해서 결정
- **fixes array 1 row** vs N row — TimescaleDB 효과 측정 후 결정
