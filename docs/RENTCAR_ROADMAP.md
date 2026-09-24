# 렌트카 (Rentcar) 계정 유형 로드맵

> 지금까지 corporate_fleet 에 집중해서 만들어진 것들 (StatCard · fleet 요약 · 월간 리포트 · 차량 관리 · 예약 · 알림 · XLSX · 서류) 을 렌트카 관점으로 확장 · 특화.

**현재 상태 (Stage-2 이후)**: `RentcarPanel` 은 shell 만 있음 — 4 stat card (전체/운행중/임대가능/이번달 주행) + 차량 리스트 + 임대계약/반납일정 placeholder. 실 데이터 X.

**목적**: 임대업체·프리랜서 임대업자가 실제 운영 가능한 수준.

---

## Stage-R1: 임대 계약 (rental_contracts) — 기반 스키마

### Backend
- **migration**: `rental_contracts`
  - `id / user_id / device_id / renter_name / renter_phone / renter_id_last4` (개인정보 최소화)
  - `starts_at / ends_at` (계약 기간)
  - `pickup_odometer / return_odometer` (반납 시 채움)
  - `rate_type` (`daily`|`hourly`|`monthly`)
  - `rate_amount_krw`, `included_km_per_day`, `over_km_price_krw`
  - `deposit_krw`, `deposit_returned_at`, `deposit_returned_amount`
  - `status` (`draft`|`active`|`returned`|`overdue`|`cancelled`)
  - `pickup_location`, `return_location`
  - `note`
- **endpoints** `/rentcar/contracts` (list/create/update/return)
- **자동 전환 worker** (기존 `reservation_alerts` 유사): `starts_at ≤ NOW → active`, `ends_at ≤ NOW && status=active → overdue`

### Frontend
- `RentcarPanel` → `RentalsTab` 실 구현
  - stat card: 활성 계약 · 오늘 반납 · 연체 · 이번달 매출
  - 계약 리스트 (검색·상태 필터)
  - 신규 계약 다이얼로그
  - 반납 처리 (return_odometer 입력 → 초과 km 자동 계산)
- device 관리 탭에 계약 이력 링크

**규모**: migration + backend CRUD + worker + panel = 2~3일

---

## Stage-R2: 반납 일정 캘린더

기존 `ReservationCalendar` 컴포넌트 재사용해서 rental_contracts 오버레이.
- 오늘 반납 예정 highlight
- 반납 지연 (overdue) 강조
- 셀 클릭 → 신규 계약 preset (그 날 09:00~다음날 09:00)

**규모**: 컴포넌트 재사용 · 반나절

---

## Stage-R3: 반납 절차 자동화

- 반납 임박 알림 (기존 4H-2 패턴)
- 반납 지연 (overdue) → 임차인 전화·문자 자동 발송 (Bizmsg 이미 있음)
- GPS 로 반납 위치 확인 (return_location 과 device.last_lat/lng 비교, 임의 반납 감지)

**규모**: 1~2일. Bizmsg 템플릿 미리 등록 필요.

---

## Stage-R4: 요금 정산 자동화

- 계약 종료 시:
  - 초과 km × over_km_price
  - 연체료 (일 단위)
  - 유류비 (반납 시 fuel_level 입력)
  - 청소비 · 기타
  - 총액 계산 + 인쇄 가능한 명세서 (XLSX/PDF)
- 정산 상태 (`pending`|`paid`|`disputed`)

**규모**: 2~3일

---

## Stage-R5: 다중 임대 관리

- 한 차량이 시간대별 여러 계약 가능 (기존 예약 시스템 like)
- 세척·정비로 인한 blackout 기간 지정
- 캘린더 뷰: 차량별 세로 스와이프 (스와이프 뷰) — 여러 차량 겹쳐 보기

**규모**: 3~4일

---

## Stage-R6: 임차인 관리 (customers 테이블)

- 재방문 고객 자동 인식 (phone 매칭)
- 고객별 이력 (총 이용 횟수·금액·평점)
- 블랙리스트 (사고 이력 등)
- 개인정보 안전 저장 (사업자번호·주민등록번호 뒤 4자리만 hash)

**규모**: 2~3일

---

## Stage-R7: 결제 연동

- 계약 시 예약금·잔금 카드 결제 (기존 Toss 연동 재사용)
- 초과 요금 후청구 (계약 종료 후 등록된 카드 자동 결제)
- 세금계산서 발행 연동

**규모**: 3~4일 (기존 Toss route 확장)

---

## Stage-R8: 대시보드 (rentcar 홈 뷰)

이미지 1 좌측 스타일 참조로:
- "오늘 반납 N건" 큰 배지
- "오늘 매출" · "이번달 매출"
- "가용 차량 N대"
- 실시간 차량 상태 리스트 (임대 중 / 대기 / 정비)
- 지도 오버레이: 임대 중 차량 위치

**규모**: 2일

---

## Stage-R9: 렌트카 특화 UX

- **키 인계 프로세스**:
  - QR 코드 생성 (계약 링크) → 임차인 폰으로 스캔 → 계약 조건 확인 후 동의
  - 인수 사진 촬영 (외관 · 오도미터 · 유량) → 자동 upload
- **키 반납 프로세스**:
  - 동일 방식으로 반납 사진 촬영 → 손상 비교
  - 자동 정산 발동

**규모**: 4~5일 (신규 QR + 서명 UI + 사진 워크플로)

---

## Stage-R10: 세무·회계 (렌트카 특화)

- 렌트카는 세법상 매출 인식 시점 특수 (선수금·미수금)
- 국세청 홈택스 연동 (매출 데이터 자동 전송)
- 렌트카 등록증 스캔 (Stage-4C-3 응용) + OCR 파싱

**규모**: 3~5일 (홈택스 API 연동 복잡)

---

## 우선순위 제안

| # | Stage | 규모 | 가치 | 우선 |
|---|---|---|---|---|
| 1 | R1 임대 계약 기반 | 2~3일 | 필수 | ⭐⭐⭐⭐⭐ |
| 2 | R2 반납 캘린더 | 반나절 | 시각화 | ⭐⭐⭐⭐ |
| 3 | R3 반납 자동화 | 1~2일 | 실무 | ⭐⭐⭐⭐ |
| 4 | R4 요금 정산 | 2~3일 | 매출 | ⭐⭐⭐⭐⭐ |
| 5 | R8 렌트카 홈 뷰 | 2일 | UX | ⭐⭐⭐ |
| 6 | R9 QR 인수·반납 | 4~5일 | 차별 | ⭐⭐⭐⭐ |
| 7 | R6 임차인 관리 | 2~3일 | CRM | ⭐⭐⭐ |
| 8 | R7 결제 연동 | 3~4일 | 매출 | ⭐⭐⭐ |
| 9 | R5 다중 임대 | 3~4일 | 대형업체 | ⭐⭐ |
| 10 | R10 세무 연동 | 3~5일 | 규제 | ⭐⭐ |

**추천 순서**: R1 → R4 → R2 → R3 → R8 → R9 → R6 → R7 → R5 → R10

R1+R4 는 렌트카 core (계약 · 정산). 이 둘 완료되면 최소한 렌트카 사업 운영 가능.

---

## 재사용 자산

Corporate 에서 만들어둔 것 중 렌트카가 그대로 쓸 것:
- `StatCard` / `StatCardGrid` / `FilterChip` — 톤 통일
- `useFleetStats` — 차량 통계
- `VehicleInfoDialog` — 차량 기본정보 (번호판 · 연식 등)
- `DocumentsSection` — 서류 업로드 (등록증 · 보험)
- `ReservationCalendar` — 반납 캘린더 재사용
- `services/opinet` — 유가 (렌트카는 임대료 산정에도 참고)
- `reservation_alerts` 패턴 — 반납 임박·연체 알림
- Bizmsg (`services/alimtalk`) — 임차인 문자
- Toss (`services/toss`) — 결제

**새로 만들 것**:
- `rental_contracts` 테이블
- `customers` 테이블 (R6)
- QR/서명 UI + 사진 워크플로 (R9)
- 홈택스 연동 (R10)

---

## 개인정보 처리 주의

렌트카는 임차인 개인정보 (신분증) 를 취급 → **PIPA 준수**:
- 신분증 사진 저장 X → 뒤 4자리 hash 만
- 계약 만료 후 N개월 후 자동 파기 (housekeeping worker 확장)
- 접근 로그 (audit_log)

---

**작성**: 2026-07-28. Stage-4J 통합 라운드 완료 시점 스냅샷.
