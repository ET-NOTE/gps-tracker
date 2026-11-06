# GPS 작업 인계 — 2026-11-06

다른 PC에서 작업을 이어갈 때 먼저 읽는 문서다. 운영에 배포된 기능은 16차까지다(커밋 `9ac4322` 기준 산출물, 2026-11-06 13:54 KST 적용, 14:01 KST 운영 모의 확인 통과). 그 위에 인프라 1차의 API 릴리스 `pdf-service-20261106-r1`(커밋 `4a3814c`, 16:44 KST 적용)이 올라가 있고, PDF 처리기는 16:48 KST부터 별도 계정의 서비스로 실행된다(16:49 KST 기능 확인 통과). 사용자 기능은 16차와 같다. 라운드별 문서는 해당 시점의 기록이므로 현재 상태는 이 문서와 가장 최근 라운드를 우선 확인한다.

## 저장소와 이어받기

- 저장소: https://github.com/ET-NOTE/gps-tracker
- 작업 브랜치: `codex/location-business-prep`
- PR 대상: `main`. 이번 인계 전 `main` 대비 199개 커밋이 있으며 앞선 GPS/Fleet 개선과 위치정보사업 준비가 함께 포함된다. 최신 영수증 기능만의 작은 PR로 해석하지 않는다.
- [PR #248](https://github.com/ET-NOTE/gps-tracker/pull/248)은 검토용 초안으로 유지한다. 운영 배포 완료와 GitHub 병합 완료는 서로 다르다.
- 이 브랜치의 API·웹·`idf_caltest` 소스가 이어받을 기준이다. Flutter 앱은 별도 저장소이며 이 인계로 APK가 새로 만들어지지 않는다.

새 PC에서는 다음과 같이 시작한다.

```bash
git clone --branch codex/location-business-prep https://github.com/ET-NOTE/gps-tracker.git
cd gps-tracker
git status --short --branch
git log -3 --oneline
```

기존 clone이라면 작업물을 먼저 확인하고 `git fetch origin`, `git switch codex/location-business-prep`, `git pull --ff-only`를 실행한다. 로컬 브랜치가 없으면 `git switch --track origin/codex/location-business-prep`를 사용한다. 강제 초기화나 강제 푸시는 하지 않는다. 커밋 작성자 설정은 [CONTRIBUTING](../../CONTRIBUTING.md)을 따른다.

기존 PC의 원격 URL은 `git@github-etc11111:ET-NOTE/gps-tracker.git`이다. `github-etc11111`은 이 PC의 SSH 별칭이므로 새 PC에 그대로 요구하지 않는다. push 권한은 본인 GitHub 인증으로 설정한다.

## 현재 운영 기준

| 항목 | 마지막 확인 상태 |
|---|---|
| 대상 | `gps.serial.kr` 운영 서버 |
| 릴리스 | `pdf-service-20261106-r1` (인프라 1차 2단계의 API 릴리스, 2026-11-06 16:44 KST). 스키마·웹·처리기 파일은 16차 `privacy-pdf-20261106-r1`(13:54 KST) 그대로 |
| DB | PostgreSQL 14 / TimescaleDB 2.19.3, 마이그레이션 98 |
| API SHA-256 | `0d28667f3c21af82a43b987a12eec2836547d3717c69ae304688c6e5363ce826` (16차는 `b6ac9edb…`, `/home/mmm/backups/pdf-service-20261106-r1/api.previous`) |
| API | `/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api`, systemd `gps-tracker-api` |
| 실행 계정 | API와 정리 작업 2개는 **`gps-api`**(로그인·sudo·docker 없음, 능력 0, 읽기 전용 파일 시스템 + 업로드 두 곳 쓰기)로 실행. 2026-11-06 15:32 KST [인프라 1차](infra-round1-runtime-account-20261106.md). 배포는 `mmm`+sudo. 환경파일·FCM 키는 `root:gps-api 640`이라 `mmm`은 sudo 없이 읽지 못한다. 적용 전 기록은 `/home/mmm/backups/runtime-account-20261106` |
| PDF 처리기 | 같은 디렉터리의 `gps-pdf-render`(root 소유 755), SHA-256 `3eaaf5535c01c58e1c4f3eae5e3a4799c59b916233960897581d5ee7707d4ffb`. **2026-11-06 16:48 KST부터 API가 실행하지 않는다.** API는 쪽 요청을 `/run/gps-pdf-render/render.sock`(root:gps-api 660)으로 보내고, systemd가 요청마다 처리기를 **`gps-pdf`** 계정(로그인·그룹 없음)으로 실행한다: 네트워크 없음, 처리기 파일만 보이는 빈 루트, 메모리 832MiB·스왑 0, 20초([2단계](infra-round1-pdf-service-20261106.md)). 유닛은 `gps-pdf-render.socket`·`gps-pdf-render@.service`·`gps-pdf-render-selftest.service`, API drop-in `20-pdf-socket.conf`. 자체 점검이 실패하면 소켓이 없고 PDF 쪽만 "사용할 수 없음"이 된다. 적용 기록은 `/home/mmm/backups/pdf-service-20261106` |
| 웹 | `/home/mmm/gps-tracker-web/dist-root` → `/home/mmm/releases/privacy-pdf-20261106-r1/web` |
| 배포 산출물 | `/home/mmm/gps-artifacts/pdf-service-20261106`(API 릴리스와 처리기 서비스 스크립트), `/home/mmm/gps-artifacts/privacy-pdf-20261106-r1`(16차: 웹·처리기) |
| 배포 전 사본 | `/home/mmm/backups/privacy-pdf-20261106-r1` (15차 바이너리, 적용 전 범위 함수 정의). 스크립트 되돌림은 모의 확인 이후 쓸 수 없음 |
| 정리 작업 | `/home/mmm/gps-ops`, `gps-privacy-accounts.timer` 활성·실행 성공. `privacy_account_closure.py`는 2026-11-06 12:45 KST 수정본(SHA-256 `1704d2bbbd99…`, 커밋 `d66b2a9`)으로 교체, 이전 파일은 `/home/mmm/backups/privacy-account-closure-fix-20261106` |
| 다른 서비스 | 16차에서 dev-gps·Shield·환경설정·서비스 설정·수집 정책·방화벽은 변경하지 않음 |

위 상태는 16차 배포 검증 기록이다. 다음 변경 전 실제 health·실행 바이너리·스키마·웹 링크를 다시 대조한다. VPS 여유 공간은 당시 약 4.8GiB였으며 빌드는 VPS에서 수행하지 않는다.

`ops/release_privacy_receipts.py`는 **이전 API/스키마 95를 전제로 한 일회성 배포**다. 운영에 96이 적용된 뒤 그대로 재실행하거나 이전 바이너리만 복구하지 않는다. 15차(96→97)의 배포 절차는 [15차 문서](location-rights-round15-20261106.md)의 "배포 절차"와 `ops/stage_privacy_raster.py`·`ops/release_privacy_raster.py`·`ops/smoke_privacy_raster.py`에 있다. 이 스크립트들도 15차 전용이며 이후 라운드에 재사용하지 않는다.

## 완료 범위와 정확한 제한

- 1~6차: 권리 요청 접수·범위 검토, SIM 범위 삭제, 파일 정리 큐, 제한된 계정 이용 종료, SIM별 수집 중지/재개·서명 정책·단말기 ACK.
- 7~12차: 이용 종료 후 결과 전용 조회, 본인 위치/계정/개인 문서의 검토된 제공, 회사 자료 검토·증빙, 채팅/AI 본문 일부 제공.
- 13차: 검토된 이미지 영역만 PNG로 제공, 만료·회수·비밀번호 확인.
- [16차](location-rights-round16-20261106.md) — **운영 배포 완료(2026-11-06 13:54 KST), 모의 확인 통과(14:01 KST)**: 회사에 저장된 PDF 영수증을 서버가 원본에서 한 쪽씩 그려 영역을 제공한다. PDF 해석은 API와 분리된 처리기 `gps-pdf-render`(별도 툴체인 Rust 1.92, 파일·네트워크·프로세스 호출이 없는 허용 목록과 메모리·시간 한도)가 한다. 읽기 증빙과 발급본에 쪽 번호를 결합(마이그레이션 0098).
- [15차](location-rights-round15-20261106.md) — **운영 배포 완료(2026-11-06 12:02 KST), 모의 계정 확인 통과(12:09 KST)**: 큰 영수증을 서버가 100만 화소·한 변 2048px 안으로 축소하고 JPEG 촬영 방향을 바로 세운다. 읽기 증빙을 정규화 픽셀 해시에 결합(마이그레이션 0097). 스크립트 되돌림은 더 이상 쓸 수 없다.
- [14차](location-rights-round14-20261106.md): 회사에 저장된 PNG/JPG 영수증을 확인된 직원·지출일 범위에서 직접 읽어 선택 영역을 제공. 원본 변경·제거·직원 변경 시 기존 제공본을 차단하고 임시 PNG를 정리.

아래는 운영 중인 16차 기준이다. 직접 연결 원본은 5MiB 이하 PNG/JPG/PDF다. 이미지는 서버가 한 변 2048px·100만 화소 안으로 축소하고 JPEG 촬영 방향을 바로 세운다(원본 한 변 16,384px, JPEG 6,400만·PNG 2,400만 화소까지). PDF는 격리 처리기가 한 쪽씩 같은 한도 안으로 그리며 200쪽까지, 암호화 문서는 거부한다. APNG·CMYK JPEG는 지원하지 않는다. 회사 원본 원장·영수증을 자동 정정/파기하지 않으며, 일부 자료 제공을 요청 전체 완료로 표시하지 않는다.

**NULL 연결 해제·암호화·계정 이용 종료를 익명화나 전체 파기로 취급하지 않는다.** 위치 이력과 소유권의 논리 기준은 계속 SIM이며, 인증키만 하드웨어별이다. 현재 SIM 소유권으로 과거 정보주체나 회사 직원 귀속을 대체하지 않는다.

진행표는 [권리 처리 정책과 ToDo](location-rights-minimal-change-policy.md), 사업 전체 준비는 [위치정보사업 준비](location-business-preparation.md), 이전 보류 결정은 [열린 항목](../reviews/gps-open-items.md)을 확인한다.

## 펌웨어 실물 상태

- 마지막으로 설치·검증한 단말기는 단말-520211이다. [6차 기록](location-rights-round6-20261105.md)의 펌웨어 소스 커밋은 `1c8e6928e2a8622a40d4c2a58418c9e8ecfb8358`, 프로필은 `https-pilot`, ESP-IDF **5.5.4**다.
- **절전 비활성** 상태로 인계한다. 서버/NVS의 정기 보고 기본 24시간을 단축한 상태가 아니다. 현재 연결 포트·전원 상태는 재개 시 다시 확인한다.
- ESP32 Mbed TLS의 인증서 체인·호스트명·만료 검증과 HMAC을 사용한다. SIM7080 SHSSL만 사용했던 경로의 검증 결함과 교체 근거는 [인증서 거부 시험](https-certificate-rejection-20261105.md), [MCU TLS 검증](https-mcu-verification-20261105.md)에 있다.
- 60초 타이머 3회 절전 복귀는 [별도 시험](https-sleep-wake-20261105.md)에서 통과했다. 실제 24시간·모션 기상·실외 운행·전체 기기 전환 완료는 아니다.
- 6차의 중지/재개 실물 검증은 실내 `gps_fix=false` 상태 보고 기준이다. 실외 좌표 버퍼를 동반한 검증은 남아 있다. 7~14차에는 펌웨어를 새로 플래시하지 않았다.

활성화한 ESP-IDF 5.5.4 환경에서 빌드만 하려면 `python idf_caltest/tools/build_firmware.py https-pilot`을 사용한다. `operating`을 무심코 선택해 TLS 파일럿 운영 승격으로 취급하지 않는다. `https-sleep-test`·`tls-cert-test`는 시험용이다. 플래시 전 대상 포트와 실물 식별을 다시 확인한다.

## 검증 증거와 재실행

[14차 evidence](evidence/location-rights-round14-20261106/validation.json)에 기존 실행 결과를 함께 보관했다. 이 인계 작업에서 애플리케이션 시험을 재실행한 것은 아니다.

- Rust 45 통과 / 기존 2 ignored, fmt·Clippy 통과, 웹 빌드 및 웹 시험 24 통과.
- 신규 영수증 7 + 기존 회귀 73 = API 통합 시험 **80개 묶음** 통과.
- 실제 컴포넌트 + 모의 API: PC 1280px·모바일 390px 원본 읽기, 영역 선택, 미리보기·두 확인, 발급·요청자 확인, 비밀번호 실패 처리. 가로 넘침/콘솔 오류 없음. 운영 로그인 세션 검증과 구분한다.
- 운영 모의 계정 검증: 원본 연결·타 계정 차단·위조 RGB 무시·출력 픽셀·원본 변경 후 무효화. 생성한 원본 영수증·지출은 제거, 모의 계정은 이용 종료. 감사 이력은 보관 검토 대상이며 전체 파기 완료가 아니다. 실제 계정/SIM 귀속은 유지했다.

빌드는 `etcom-hub-lan` 빌드 호스트에서 한다. 이미지 정의는 `ops/hub-builder.Dockerfile`이며 Rust 1.88.0·Node 22.22.2를 사용한다. PDF 처리기 `gps-pdf-render`만 별도 이미지 `ops/pdf-builder.Dockerfile`(Rust 1.92.0, 정적 musl)로 빌드하며 API의 툴체인은 올리지 않는다. 통합 시험 환경에서는 처리기를 API 바이너리 옆(`/gps-pdf-render`)에 마운트해야 PDF 시험이 동작한다. 기본 확인 명령:

```bash
# gps-tracker-api 디렉터리
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
# gps-tracker-web 디렉터리
npm ci --ignore-scripts
npm test
# Linux 셸, 루트 경로 배포용 빌드
VITE_BASE=/ npm run build
```

서버 통합 시험은 `ops/test_privacy_receipts.py` 및 같은 디렉터리의 privacy/account 시험을 사용한다. **운영 DB를 넣지 않는다.** 현재 시험은 다음 격리 환경과 실행 바이너리 SHA를 검사한다. 경계 검사를 삭제해서 실행하지 않는다.

- 내부 Docker 네트워크: `gps-account-closure-test-20261105` (`Internal=true`).
- DB/API 컨테이너: `gps-account-closure-db-20261105`, `gps-account-closure-api-20261105`. DB는 TimescaleDB 2.19.3-pg14의 임시 저장소, API는 `APP_ENV=test`.
- 시험용 파일 배치: 작업 디렉터리에 시험 스크립트를 복사하고 `out/gps-tracker-api`에 검증할 실행 파일을 둔다. Python에는 `psycopg2` 등이 필요하다.
- 앞선 격리 컨테이너·네트워크·검수 서버는 종료/제거했다. 재실행 전에 전용 환경을 다시 준비한다.

운영 적용된 SQL 파일은 바이트까지 유지한다. 특히 `0085_preserve_legacy_aggregates.sql`은 기존 CRLF 체크섬을 보존하도록 `.gitattributes`로 예외 처리했다. 새 PC에서 일괄 줄바꿈 변환하지 않는다. 수정은 새 마이그레이션으로 한다.

## 산출물·접속 정보의 이동 범위

Git으로 이동하는 것은 소스·라운드 문서·아래 작은 검증 JSON이다. `.env`, SSH 개인키, DB 덤프, 인증 토큰, APK/펌웨어/API 바이너리, 전체 로그와 캡처를 Git에 넣지 않는다.

- [검증 집계](evidence/location-rights-round14-20261106/validation.json), [배포 기록](evidence/location-rights-round14-20261106/deployment.json), [운영 모의 시험](evidence/location-rights-round14-20261106/production-smoke.json), [화면 검수](evidence/location-rights-round14-20261106/ui-verification.json).
- 빌드 호스트 보관: `/home/etcom-hub/build/gps-privacy-receipts-20261106` (소스·빌드·시험 스크립트와 로그·산출물). 캐시: `/home/etcom-hub/build/gps-tracker/cache`.
- 기존 PC 전용 보관: `C:/Users/msb/AppData/Local/GPS-Builds/location-rights-round14-20261106/` (로그·캡처·소스 묶음·바이너리). 새 PC에 자동으로 생기지 않는다.
- 기존 작업 폴더: `C:/Users/msb/.codex/worktrees/gps-app-fcm/esp32c3-mini_gps`. 새 clone은 이 경로일 필요가 없다.
- `seriallog`(운영), `etcom-hub-lan`(빌드)은 기존 PC의 SSH 별칭이다. 새 PC에서는 권한 있는 담당자에게 접속 대상·본인 키 등록을 받아 설정한다. 비밀값을 채팅/문서로 복사하지 않는다. 운영 환경파일은 서버의 `/home/mmm/projects/gps-tracker-api/.env`에 있다.
- 이전 빌드 작업의 `build.sh`는 보관된 `focused-source.tar.gz`를 다시 푼다. 새 소스를 수정한 뒤 과거 스크립트만 재실행하면 수정이 덮인다. 새 작업 디렉터리와 새 소스 묶음을 사용한다.

## 다음 라운드와 보류 경계

| 순서 | 작업 | 완료 판단 |
|---|---|---|
| 표본 확보 후 | 실제 한글 영수증 PDF로 렌더링 품질 재확인 | 16차 평가는 합성 표본만 사용. JBIG2·JPEG 2000 스캔과 블렌드 모드는 미검증 |
| 범위 확정 후 | 회사 공용 차량 문서/사진 연결, 원본 정정·파기 | 정보주체·회사 권한·보관 근거/기간·승인 범위를 먼저 확인 |
| 담당자 결정 대기 | 감사/처리 증빙·백업·외부 사본 보관과 파기, 로그인 불가/대리인 확인 | 회사 정책을 임의 보관 기간으로 대체하지 않음 |
| 완료 | **인프라 1차: [API 실행 계정 분리](infra-round1-runtime-account-20261106.md)와 [PDF 처리기의 별도 계정·서비스 분리](infra-round1-pdf-service-20261106.md)** | 1단계 2026-11-06 15:32 KST, 2단계 16:44 KST(API 릴리스)·16:48 KST(처리기 서비스) 운영 적용, 기능 확인 통과. 되돌릴 때는 `/home/mmm/gps-artifacts/pdf-service-20261106`에서 `pdf_service.py rollback`이 먼저, 그다음 `release_pdf_service.py rollback`(순서가 어긋나면 스크립트가 거부). 남은 확인: 다음 계획된 재부팅 뒤 `gps-pdf-render.socket`이 스스로 올라오는지(리허설에서만 확인) |
| 진행 중 | **[인프라 2차: VPS와 독립된 외부 장애 감시](infra-round2-external-watch-20261106.md)** | 운영자 결정(2026-11-06): 알림은 메일(SMTP), 감시 위치는 사무실 빌드 호스트만, Uptime Kuma에도 알림 등록. 감시 스크립트(`ops/gps_watch.py`)는 구현·격리 리허설 통과(커밋 `7356503`). **2026-11-06 17:22 KST부터 빌드 호스트(`etcom-hub`)의 사용자 타이머 `gps-watch.timer`로 1분마다 가동 중**이고 네 점검이 정상이다. 메일은 Google Workspace(`smtp.gmail.com:587`)로 보낸다. 상태는 `ssh etcom-hub-lan "bash ~/build/gps-watch-20261106/install_gps_watch.sh show"`. **남은 것(운영자)**: 시험 메일 도착 확인, Kuma 알림 등록과 Push 모니터 생성 뒤 `gps_watch.py secret heartbeat`로 주소 입력 — 그 전에는 감시 자체가 멈춰도 알릴 수단이 없다. 운영 서버 로그에는 사무실 주소의 `GET /health`·`GET /ingest` 405·SSH 접속 종료가 분당 한 줄씩 남는다(단말기 보고가 아니다) |
| 그다음 기능 라운드 | 권리 대응 17차: 수집·이용·제공사실 열람 | 기존 권리 요청·결과 제공 기능을 활용 |
| 별도 항목(섞지 않음) | 방화벽 부팅 순서([별도 구성 위험](incident-20261106-hosting-maintenance.md), `ops/fix_firewall_boot_order.sh`), 디스크 정리, 열린 포트 축소, 관리 접근·DB 경계·백업 | 11월 6일 장애의 원인은 호스팅 업체의 긴급 업데이트 문제로 확인됐다. 방화벽 순서 문제는 그 원인으로 확정하지 않은 별도 위험이다. 방화벽·시스템 설정 변경은 운영자가 실행 |
| 별도 실물 라운드 | TLS 운영 승격, 실외 수집 중지/재개, 24시간·모션 절전 | 기존 파일럿 성공과 전체 운영 인수를 구분 |

테스트 자료 손실 허용은 사용자가 지정한 `sss`, `user@user4.com` 또는 새 모의 계정 범위였다. 다른 실제 계정·회사 원본·백업까지 삭제할 권한으로 확대하지 않는다. 읽기/격리 시험을 먼저 하고 운영 변경은 대상과 결과를 기록한다. 이번 인계 푸시는 서버 재배포·DB 변경·펌웨어 플래시를 수행하지 않는다.
