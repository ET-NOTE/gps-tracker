# 데이터 격리 / 수명 / 복구 매트릭스

GPS 트래커 백엔드의 사용자·디바이스·SIM 간 데이터 흐름을 명시한다.
계정 유형(account_type) 변경, 디바이스 페어링/해제, SIM 이동 시 어떤 데이터가
유실/유지/복구되는지 한눈에 보기 위한 문서.

## 핵심 원칙

1. **계정 종속(per-user)** 데이터는 사용자 ID 가 키. 계정 유형이 바뀌어도 안 사라진다 — UI 메뉴 노출 여부만 달라진다. 다시 원래 유형으로 돌아가면 그대로 복구.
2. **디바이스 종속(per-device) + 사용자 태그** 데이터는 row 마다 `user_id`(생성 시점 owner) 가 박힘. 다른 사용자가 같은 디바이스를 페어링해도 이전 사용자의 row 는 안 보임. **본인 재페어링 시 자동 복구**.
3. **하드웨어 종속** 메타(IMEI, IMSI, ICCID, hw/fw 버전)는 기기 자체의 속성이라 페어링과 무관하게 유지.
4. **SIM**은 외부 자산(1NCE) — 우리 DB 에는 ICCID 만 보관. SIM 자체 정보(잔량, 번호) 는 매번 1NCE API 로 조회.

## 매트릭스

### 계정 유형(account_type) 변경 시

| 데이터 | 변경 후 | 다시 원래 유형 복귀 |
|--------|--------|-------------------|
| `corporate_info` (사업자번호/회사명) | 그대로 보존 (UI 만 숨김) | 즉시 노출 |
| `staff` (직원 등록부) | 그대로 보존 | 즉시 복구 |
| `subscriptions` (법인 리포트 구독) | 그대로 보존, 만료일까지 유효 | 즉시 사용 가능 |
| `trip_annotations` (운행 용무/유류/운전자) | 보존 | 복구 |
| `notification_settings` | 보존 | 복구 |
| `users.prefs` (UI 환경설정) | 보존 | 복구 |
| `users.credits`, `credit_log` | 보존 | 복구 |
| `chat_*` (관리자 채팅) | 보존 | 복구 |
| `ai_analyses` (AI 분석 영구 보관) | 보존 | 복구 |

→ 결론: 계정 유형은 **UI 게이트일 뿐 데이터 파괴 트리거 아님**.

### 디바이스 페어링 해제 — `purge=false` (기본, 데이터 보관)

| 데이터 | 동작 |
|--------|------|
| `devices.owner_id`, `paired_at` | NULL 로 초기화 |
| `devices.display_name`, `color` | NULL 로 초기화 (UI 표시 정리) |
| `devices.account_type_override` | NULL — 다음 사용자가 자기 계정 유형 따름 |
| `devices.last_seen_at`, `last_lat/lng/fix_at` | NULL — 마지막 위치 스냅샷 노출 차단 |
| `devices.iccid`, `imei`, `imsi`, `hw/fw_version` | 유지 — 하드웨어 속성 |
| `devices.rtc_brownouts`, `rtc_no_fix_cycles` | 유지 — 누적 진단 |
| `share_links` (본인 발급) | `revoked_at = NOW()` 로 즉시 무효화 |
| `location_records`, `events`, `daily_stats` | **본인 user_id 태그된 row 보관** |
| `trip_annotations` (본인) | **보관** |
| `geofences` (본인 owner) | **보관** |
| `ai_analyses` (본인) | 보관 (사용자 ID + 디바이스 ID 모두 매칭해야 보임) |
| `sim_topup_requests` (본인) | 보관 (결제 이력) |
| `device_audit_log` | 보관 (audit) |

→ **본인이 같은 디바이스에 다시 페어링하면 모든 항목 자동 복구** (user_id 태그가 일치).
→ **다른 사용자가 페어링해도** 본인 데이터는 user_id 필터로 가려짐 → 신규 사용자에게 노출 0.

### 디바이스 페어링 해제 — `purge=true` (완전 삭제)

`purge=false` 동작 + 본인 user_id 태그된 row 영구 DELETE:

| 데이터 | purge=true 시 |
|--------|---------------|
| `location_records` (본인) | DELETE |
| `events` (본인) | DELETE |
| `daily_stats` (본인) | DELETE |
| `trip_annotations` (본인) | DELETE |
| `geofences` (본인) | DELETE |
| `share_links` (본인) | revoke (purge 와 동일 효과) |
| **결제 이력**: `ai_analyses`, `sim_topup_requests`, `credit_log` | **유지** (회계/audit) |

→ 같은 사용자가 재페어링해도 그 디바이스의 데이터는 빈 상태로 시작.
→ 다른 사용자에 영향 없음 (그들의 user_id row 만 삭제).

### 다른 사용자가 같은 디바이스를 페어링했을 때

| 가시성 | 신규 사용자(B) 입장 |
|--------|---------------------|
| A 의 `location_records` / `events` / `daily_stats` | **안 보임** (user_id ≠ B) |
| A 의 `trip_annotations` / staff 이름 | **안 보임** (user_id ≠ B) |
| A 의 `geofences` | **안 보임** (owner_id ≠ B) |
| 디바이스의 하드웨어 메타 (IMEI/ICCID 등) | 보임 (장치 속성) |
| SIM 정보 (1NCE) | 보임 — 외부 API 가 ICCID 기준이라 누구든 owner 면 조회 가능 |
| A 의 SIM 충전 이력 | A 만 보임 (user_id 종속) |

### SIM 이 디바이스와 함께 이동할 때

SIM 은 ICCID 로 식별되며 `devices.iccid` 컬럼에 저장. 페어링 해제·재페어링은 ICCID 를 건드리지 않음.

| 항목 | 동작 |
|------|------|
| SIM 자체 (1NCE) | 외부 자산 — DB 변동 없음. 다음 사용자도 같은 ICCID 로 조회 가능 |
| 1NCE 충전 이력 | 1NCE 가 보관 — 우리 시스템 외부 |
| 우리 시스템 `sim_topup_requests` | 사용자별 — A 가 충전한 이력은 A 만 봄 |
| ICCID 가 다른 디바이스로 옮겨갔을 때 | `devices.iccid` 갱신해야 함 (admin SIM swap 동작) |

→ **SIM 단독 이동 시 SIM 이 가지고 가는 정보**: 1NCE 의 잔여 데이터·번호 정도. 우리 시스템의 이력(충전 요청, 가격 결제) 은 SIM 자체가 아닌 사용자 계정에 종속.

## 코드 구현 위치

| 동작 | 파일 |
|------|------|
| user_id 자동 셋(INSERT 시) | `routes/ingest.rs`, `services/geofence.rs`, `services/stats.rs`, `routes/geofences.rs` |
| user_id 격리 SELECT | `routes/locations.rs`, `routes/stats.rs`, `routes/devices.rs`(events), `routes/corporate.rs`, `routes/ai.rs`, `routes/geofences.rs`(history) |
| 페어링 해제 | `routes/devices.rs::unpair` (`?purge=true` 옵션) |
| 사용자 본인 wipe | `routes/devices.rs::wipe` → `unpair(purge=true)` 위임 |
| FCM 푸시 라우팅 | `services/fcm.rs` — 이벤트의 user_id 기준 (현재 owner 무관) |
| 마이그레이션 | `migrations/0018_data_boundaries.sql` |

## 점검 체크리스트

- [x] 같은 사용자 재페어링 → location/event/stat/trip/fence 모두 복구되는가?
- [x] 다른 사용자 페어링 → 이전 사용자의 PII (운전자 이름, 펜스 이름) 안 보이는가?
- [x] 페어링 해제 시 share 링크 즉시 무효화 되는가?
- [x] 페어링 해제 시 last_lat/lng 가 다음 사용자 화면에 안 남는가?
- [x] purge=true → 본인 데이터만 삭제되고 다른 사용자 데이터 영향 없는가?
- [x] 결제 이력은 unpair/purge 어디서도 안 사라지는가?
- [x] FCM 워커가 이전 owner 의 이벤트를 신규 owner 에게 잘못 푸시하지 않는가?

## 추후 보완 (deferred)

- `device_audit_log` 도 user_id 격리 가능. 현재 admin 이 다 봄.
- 디바이스 별 "데이터 핸드오버" 모드 — 일부러 다음 사용자에게 데이터를 넘겨주고 싶은 렌트카·차량 매각 시나리오. 현재는 무조건 가려짐.
- corporate_info 의 사업자번호 등은 `users.prefs` 처럼 단일 row 라 직접 수정/삭제 가능. 한 사용자가 여러 회사 운영하는 시나리오는 미지원.
