# 계정 등록 후 쉴드 공개 수신 화면이 비는 문제

2026-09-28 11:48 KST 조사에서 쉴드는 HTTP 200으로 계속 보고하고 DB에도 위치가 저장되고 있었지만 `/arduino-shield/data`는 `available=false`, `count_24h=0`을 반환했다. 고정 시험 장치 `uno-shield-test`가 소유 계정에 등록되면서 SQL의 `owner_id IS NULL` 조건에 걸린 것이 원인이다. 등록 장치 제외는 초기 공개 페이지의 정책이었으나, 화면에서 수신 전 상태와 구분하지 못했다.

사용자는 이 시험 장치의 상태 정보는 계정 등록 후에도 계속 공개하도록 선택했다. 이에 고정 UID 조회에서 소유자 조건만 제거했다. UID는 API 코드에 고정하며 임의 UID 쿼리를 허용하지 않는다. 기존 상태 항목만 반환하고 정밀 좌표·유심 식별자·소유자·원문은 계속 제외한다. 화면 하단에도 공개 범위를 명시하고, 무측위 중 최대 10분 동안 보고 간격이 길어질 수 있음을 안내한다.

검증: etcom-hub의 격리 PostgreSQL에서 계정 등록 전/후 이력 유지, 다른 장치 제외, 24시간 범위, 최신 100건, PV 이상값 처리를 확인했다. 11:48:12~11:50:42 COM26 관찰 중 HTTP 200 위치 전송 3회를 확인했다. 장치 소유 관계나 펌웨어를 변경할 필요는 없다.

운영 적용은 사용자에게 별도 명시적 허가를 받은 후 진행했다. 배포 도구는 a7be64e API를 기준으로 백업/해시 확인 후 API 실행 파일만 교체하고 실패 시 복구한다. 제품 웹·nginx·KC 라우트·환경 파일·DB 스키마를 유지하며 개발 서버를 먼저 검증했다.

## 검증 및 운영 반영 준비

- 소스 `dd57257`, 릴리스 `dev-20260928-115217-dd57257`.
- API SHA-256 `4629570e16ccc39dbfa31a2b1b219d559fbe0bf599c71f87ed080ace03228b46`.
- etcom-hub에서 Rust fmt/clippy, 일반 단위 시험 8개, 격리 FCM DB 시험 1개, 웹 회귀 시험 29개 및 빌드 통과.
- dev API 배포 및 공개 라우트 검증 완료. dev는 실제 쉴드 수신 대상이 아니므로 수신 목록은 비어 있다. 등록 전후 조회 정책은 격리 DB 시험으로 검증했다.
- dev `/`, `/version.json`, `/diagnostic`, `/diagnostic/device`의 응답 해시와 nginx/env 해시 유지, DB migration 65/65 유지. 임의 UID 쿼리 거부와 잘못된 HTTP/HTTPS ingest의 기존 400 응답 확인.
- 운영 API 백업을 VPS와 Windows 양쪽에 확보하고 SHA-256 일치 확인: `28705afef07e36e65255ef7886f776c63b91c047d1b1440eee6f8e34822a1e88`.
- VPS 백업: `/home/mmm/backups/gps-shield-prod-dev-20260928-115217-dd57257`. Windows: `%LOCALAPPDATA%\GPS-PrivateBackups\gps-shield-prod-dev-20260928-115217-dd57257`.

## 운영 적용 완료 및 KC 재확인

사용자가 prod 진행을 명시적으로 승인한 뒤 2026-09-28 **12:00:36 KST**에 운영 API를 위 릴리스로 교체했다. `/health`의 environment는 production이며 release 문자열은 검증한 dev 산출물 식별자를 그대로 사용한다.

- 운영 소스 a7be64e 대비 API 변경 파일은 쉴드 HTML·Rust 조회 핸들러 주석·SQL 3개뿐이다. KC ingest/scan/pair/diagnostic 및 migration 소스 변경은 없다.
- 배포 직전 개발 서버에서 `test_app_fcm_kc.py` 재실행: GPS 없는 익명 KC ingest, 미페어링 장치 스캔, UID 페어링, 원격 명령 미발행, 익명 DHT 수신/진단 조회 통과. 시험용 데이터는 개발 DB에서만 생성 후 정리했다.
- 배포 직전/직후 운영 `/`, `/version.json`, `/diagnostic`, `/diagnostic/device` 응답 해시 일치. nginx/env 해시와 migration 65/65 유지. HTTP/HTTPS 익명 ingest의 잘못된 본문은 기존 400 응답이며 임의 쉴드 UID 쿼리도 400으로 거부된다.
- 운영 `/diagnostic/data` 및 KC 공개 장치 로그 조회 확인. KC 실장치에 명령을 보내거나 운영 시험 데이터를 삽입하지 않았다.
- 배포 직후 쉴드 공개 이력 92건이 복구됐고, 열린 브라우저에서도 최근 수신 정상·위치 확보·PV 전압·이력을 확인했다.
- 배포 후 **12:01:07 KST** 새 보고로 93건이 됐다. 최신 값은 v10, fix=true, 위성 10개, CSQ 28, PV 4,166mV이다. 재시작 후 이 시점까지 API ERROR/panic 로그 0건.
- 서버의 `deployment.json`, `postcheck.json`을 위 백업 폴더에 보관한다. 펌웨어와 장치 소유 관계는 변경하지 않았다.

## 후속 소유 계정 지정 — 12:05 KST

사용자가 앞으로 쉴드를 `user@user.com` 계정의 장치로 관리하고 지도에서 좌표를 확인하도록 요청했다. 기존 다른 시험 계정(owner 33)에서 지정 계정(owner 25)으로 `uno-shield-test`(device 3015)의 소유권을 **12:05:19 KST**에 변경하고 표시 이름을 `아두이노 쉴드`로 지정했다. 단일 트랜잭션과 대상 행 잠금으로 처리하고 `device_audit_log` owner_change(id 56)에 명시적 요청과 이전/이후 소유자를 기록했다. 이전 귀속 값은 VPS의 비공개 `/home/mmm/backups/shield-owner-20260928-user25`에 보관했다.

소유 계정 지정과 공개 상태 모니터는 양립한다. 앞서 허용한 고정 시험 UID의 공개 상태 요약은 유지하며, 정밀 좌표는 소유자 계정의 지도 경로로 조회한다. 별도 서버 재배포나 펌웨어 변경은 없었다. 이후 ingest는 등록된 소유권을 유지하고 새 위치 행을 해당 계정에 귀속한다.

12:05:43 KST의 실제 GNSS 좌표가 owner 25로 저장됨을 확인했다. 지도 API가 사용하는 `location_speed_points_between`에서도 이 계정의 유효 좌표가 조회된다. 이전 계정은 장치 소유권 검사에서 제외되며 기존 시험 위치의 user_id는 변경하지 않았다. 따라서 새 계정의 지도 이력은 귀속 변경 이후부터 누적된다. 이전 이력의 별도 이전은 수행하지 않았다. KC 장치나 소유권, 데이터는 수정하지 않았다.
