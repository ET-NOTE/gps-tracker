# dev 정합·격리·개선 결과 — 2026-09-24

## 적용 범위

`codex/gps-dev-hardening`에서 운영 main `c089845`를 기준으로 dev 고유 기능을 이식했다.
배포 대상은 **dev-gps.serial.kr만**이다. 운영 API/웹/펌웨어를 배포하지 않았으며 운영 배포는 사용자의 명시적 허가가 필요하다.
KC 스캔, 식별자 기반 ingest, 시험 진단 공개 경로는 유지했다. 부저/reset/POST 주기 명령을 실제 장치에 전송하지 않았다.

현재 dev 릴리스: `dev-20260924-reconcile`.

## 분리 확인 및 보강

| 경계 | 결과 |
|---|---|
| API | prod `gps-tracker-api`, 3040 / dev `gps-tracker-api-dev`, 3041, OS 계정 별도 |
| 실제 환경 파일 | prod `.env` / dev **`.env.dev`**. 초기 검토 문서의 dev `.env` 표기는 정정 |
| DB | prod `gps_tracker` / 새 dev `gps_tracker_dev_next_20260924` |
| DB 역할 | prod `gps_tracker_app` / dev `gps_tracker_dev_app` |
| 운영 테이블 권한 | dev 역할이 SELECT 가능한 운영 public 테이블·뷰 0개, 쓰기 가능한 객체 0개 |
| 운영 DB 접속 | 기존 PUBLIC CONNECT는 카탈로그상 남지만, dev 역할→운영 DB만 거부하는 pg_hba 규칙 추가. 실제 연결 거부 검증. PostgreSQL 재시작 없이 설정 reload |
| DB 간 데이터 연결 | dblink/postgres_fdw 확장, foreign server, subscription 발견되지 않음 |
| JWT | prod/dev 비밀키 다름. 값을 출력하거나 저장소에 포함하지 않음 |
| 업로드 | dev `/home/gps-dev/uploads`, prod `/home/mmm/uploads` |
| 프로세스 파일 접근 | dev에 NoNewPrivileges/ProtectSystem/ProtectHome/PrivateTmp 적용, 쓰기는 dev uploads로 제한. 운영 홈과 FCM 설정 경로는 InaccessiblePaths |
| 잘못된 설정 | APP_ENV=development에서 운영 DB명·계정, 운영 업로드 경로, 운영 CORS, 실제 SMS/FCM/Toss/1NCE 설정은 시작 전에 거부 |
| 로컬 개발 | Vite API/WS/ingest 프록시를 dev로 변경. WebSocket의 운영 주소 하드코딩 제거 |
| 외부 서비스 | 공유 OpenAI·Kakao REST 키를 dev 환경에서 비움. FCM/Toss/1NCE 키도 비어 있음. SMS_DEV_MODE=1은 기존에도 켜져 있었고 유지 |

**물리적으로 완전히 분리된 환경은 아니다.** VPS, PostgreSQL 인스턴스, nginx, CPU/메모리/디스크는 공유한다. 한 서버의 장애는 함께 영향을 줄 수 있다.
브라우저 지도와 장소 검색의 **Kakao JavaScript 앱/쿼터도 아직 공용**이다. 별도 dev 앱 키와 허용 origin을 준비해야 이 경계도 분리된다.
AI 분석은 dev 전용 키 설정 전 명시적인 미설정 오류를 반환하며 포인트를 차감하지 않는다. 서버 역지오코딩은 기존 캐시/빈 결과를 사용한다.

## DB 정합과 보존

dev 33~35와 prod 33~35의 내용이 달라 기존 마이그레이션 checksum을 덮어쓰지 않았다.
새 DB에 운영 마이그레이션 1~60과 신규 61~62를 적용한 뒤 **dev 데이터만** 이관했다. 운영 사용자·장치·위치 데이터는 복제하지 않았다.

- 기존 dev DB `gps_tracker_dev`는 그대로 보관한다.
- 초기 이관: 28개 원본 테이블의 모든 기존 열을 행 해시로 비교해 일치.
- 장치 4개, 위치 원본 39,415행 보존. 정비 날짜·차량 이미지 경로도 보존.
- 전환 직전 재비교: 원본 행 보존 확인. 검증 중 새 워커가 추가한 stuck 이벤트 2건, 만료 refresh 토큰 1건 정리, daily_stats 재계산은 별도 확인.
- 신규 조회 계층 `location_points`: JSONB 배치 좌표를 시간점으로 펼치고 동일 장치·사용자·시간·소스의 중복을 제거.
- 파생 통계 재계산 큐는 처리 완료 후 0건. 자동 원본 삭제 정책은 활성화하지 않았다.
- 임시 API/UI 계정과 장치는 시험 뒤 제거했고 장치/위치 수가 원래 값으로 돌아온 것을 확인했다.

실제 dev 설정은 새 DB를 사용한다. 롤백 시 **구 바이너리와 구 환경 파일을 함께** 복원해야 한다.

## 반영한 수정

1. 공유 링크의 발급자/현재 소유자/위치 및 통계 user_id를 조회 시점에 함께 검사한다. 소유권 변경 직후 기존 링크도 거부한다.
2. 로그인 세션별 쿼리 키, 계정 전환 시 쿼리 취소·캐시 삭제, 늦은 응답 폐기를 적용했다. refresh는 세션/refresh 토큰을 비교하고 지원 브라우저에서는 탭 간 Web Lock으로 회전을 직렬화한다.
3. WebSocket·스마트폰 추적기를 계정 전환 시 정리하고, 이전 세션의 지연 작업이 재개되지 않도록 검사한다.
4. 일반/공유 위치, 날짜 목록, AI 입력, 운행 기록, 일별 통계, 시간대 집계가 배치 좌표를 읽도록 맞췄다. 시간 필터는 anchor가 아닌 각 좌표의 시각에 적용한다.
5. 일별/운행 거리 계산을 공유한다. 5분간 고정 반경 내 머무름을 정지로 판단하고, 10분 초과 관측 공백과 250km/h 초과 구간은 이동거리로 이어 붙이지 않는다. 이 기준은 추정치이며 실차 데이터 검증이 필요하다.
6. 범위 삭제는 JSONB 내부 좌표를 부분 삭제한다. 해당 날짜 통계를 즉시 무효화하고 영속 큐에 재집계를 등록한다. 장치 잠금으로 삭제/집계/소유권 변경의 경합을 막는다.
7. 문서 업로드 body 한도를 파일 10MiB + multipart 여유 1MiB로 맞췄다. dev nginx API는 40MiB 요청을 허용하되 일반 API의 1MiB 제한과 각 업로드 라우트별 제한은 유지한다.
8. 제품 진단 화면은 `/device-diagnostics`, KC/DHT 화면은 `/diagnostic` 및 하위 경로로 분리했다.
9. `/health`에 환경·릴리스 ID, `/version.json`에 배포 산출물 해시를 제공한다. 이번 배포 소스를 별도 릴리스 폴더에 보관했다. 기존 배포 스크립트의 기본 prod 대상, 잘못된 health URL, env 포함 압축도 수정했다.

시간대 집계 API는 정확한 배치 좌표를 직접 집계한다. 기존 `location_1min/5min/1hour` CAGG는 저장 용량 확인용으로 남아 있지만 이 API의 응답 원본으로 사용하지 않는다. 긴 기간·대규모 장치 수의 성능 검증은 운영 반영 전 필요하다.
위치 API의 limit은 기존처럼 전송 원본 행 수(최대 10,000행)에 적용한다. 선택된 배치의 모든 좌표를 반환하되 날짜 경계 밖의 내부 좌표는 제외한다. limit=1인 3점 배치가 잘리지 않는 회귀도 확인한다.

## 보존·통합한 dev 기능

- 정비일/정비 주행거리/보험·검사 만료일, 임박 표시, 차량 정보 및 대표 사진.
- 빈 값과 미전송을 구분하는 PATCH로 날짜·사진 연결 해제 가능.
- GPS `speed_kmh`를 단일/배치 ingest, DB, 위치 조회, WS에 반영. 현행 실물 펌웨어가 속도를 보내도록 바꾼 것은 아니다.
- 경로 계획(장소 검색, 방문 순서 제안, 지도 표시). **직선거리 기반**임을 화면에 표시.
- 고정 장치, 스와이프, 첫 사용 안내.
- 오프라인 장치/경로 캐시는 인증 세션별로 구분하고 로그아웃 시 지운다. 서버의 인증/권한 오류에는 캐시로 대체하지 않는다.

사용되지 않던 NavigationSheet를 완성된 내비게이션으로 취급하지 않았으며, 새 자동 정비 알림 기능을 추가한 것은 아니다.

## 검증

- Rust cargo check / test / release build 성공. 정지·저속 주행·관측 공백 회귀 2건 통과.
- 프런트 production build 성공. 실제 모듈의 계정 캐시/refresh 경쟁/늦은 위치 응답 회귀 5건 통과.
- 별도 3042 검증 프로세스에서 API 시험 후, 최종 **공개 HTTPS dev 주소**에서 재검증:
  - 이전 소유자 공유 조회 차단 / 소유권 변경 시 링크 차단
  - JSONB 배치 전개, 날짜 경계, grouped/집계 좌표 수, 속도 필드
  - 정비 날짜 설정·초기화 및 미전송 필드 유지
  - 2MB 문서 업로드, 타인 다운로드 차단, 대표 이미지 업로드·제공
  - 배치 부분 삭제, 기존 소유자 원본 보존, 재집계 큐
  - 선택적 speed를 포함한 기존 ingest 형식 호환
- 잘못된 dev DB/업로드/SMS/Toss 설정 4종의 프로세스 시작 거부 확인.
- 브라우저 임시 계정: 로그인, 차량 정보 저장, 정비 임박 표시, 진단 이동/새로고침, 장소 두 개 검색·순서 제안·지도 표시, 로그아웃 확인.
- KC 장치와 실제 문자/결제/푸시/SIM 충전은 시험하지 않았다.
- `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`는 기존 main에서도 실패한다. baseline clippy 102건을 확인했으며 새로 생긴 미사용 함수 경고는 제거했다. 이 릴리스를 CI가 모두 통과한 머지 후보라고 표현하지 않는다.

## 운영 불변 확인

전환 후 운영 health 정상. 운영 API PID `2630525`, 시작 시각 `2026-09-14 19:08:15 KST` 유지.
전환 전후 운영 API 바이너리, 웹 index.html, GPS 운영 nginx 파일의 SHA-256이 모두 일치했다.
공유 PostgreSQL의 pg_hba에 dev 역할 전용 거부 규칙을 추가하고, dev nginx 변경 적용을 위해 nginx를 reload한 것은 인프라 변경 기록에 포함한다.

## 백업·복구

- 전환 전: `/home/gps-dev/backups/pre-reconcile-20260924`에 DB dump, 환경 파일, 구 API, 웹·uploads, nginx 설정을 권한 제한하여 보관.
- 구 dev 백업을 별도 DB에 실제 복원하여 장치/위치 수 확인.
- 새 dev 전체 dump는 VPS 밖 `C:/Users/msb/AppData/Local/GPS-PrivateBackups/20260924`에도 보관.
- Timescale 복구에는 별도 빈 DB에서 extension 생성 → `timescaledb_pre_restore()` → 단일 pg_restore → `timescaledb_post_restore()` 절차를 사용한다. [공식 복구 절차](https://docs.timescale.com/self-hosted/latest/backup-and-restore/logical-backup/).
- 새 Timescale dev dump도 별도 DB에 실제 복원했다. 장치 4개·위치/전개점 39,415개·마이그레이션 62개 및 전체 public 테이블 행 해시 일치를 검증했다. 복원 시험 DB의 백그라운드 작업은 중지했다.
- 정기 오프사이트 백업·보존 및 주기적 복구 검증 스케줄은 아직 구성하지 않았다. 이번 수동 백업을 상시 백업 체계로 간주하지 않는다.

개발 롤백은 dev만 중지하고 백업의 `env.dev`, `api.old`를 기존 경로에 복원한 뒤 웹 dist를 `dist.before-20260924-reconcile`로 되돌리고 dev를 시작한다. 새 DB는 삭제하지 않는다. 새 dev에 생성된 데이터를 구 DB로 자동 역이관하지 않으므로 롤백 전 별도 백업·대조가 필요하다.

## 운영 반영 전 남은 조건

1. 사용자의 **명시적 운영 배포 허가**.
2. KC 시험 중 열어 둔 인증/스캔 정책은 유지. 시험 종료 뒤 장치별 인증·페어링 증명·시험 계정 제한을 별도로 결정.
3. dev 전용 외부 서비스 키와, 필요하다면 별도 서버/PostgreSQL 인스턴스 마련.
4. 현장 펌웨어를 연결한 장시간 수신·통계 검증, 긴 기간 조회 성능, CI baseline 정리.
5. 정기 오프사이트 백업 및 복구 검증 체계 확정.
