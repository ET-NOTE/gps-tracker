# GPS 작업 인계 — 2026-11-06

다른 PC에서 작업을 이어갈 때 먼저 읽는 문서다. 운영에 배포된 최신 기능 커밋은 `d37f1d7`(14차)이며, 그 뒤 인계 문서 커밋은 실행 코드를 바꾸지 않는다. 이후의 15차 커밋은 API·웹·스키마를 바꾸지만 운영에는 배포하지 않았다. 라운드별 문서는 해당 시점의 기록이므로 현재 상태는 이 문서와 가장 최근 라운드를 우선 확인한다.

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
| 릴리스 | `privacy-receipts-20261106-r1` |
| DB | PostgreSQL 14 / TimescaleDB 2.19.3, 마이그레이션 96 |
| API SHA-256 | `65abe14ca7e8acd246a8aa5447f357da3a5956e99f2be202a4b9861841185b04` |
| API | `/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api`, systemd `gps-tracker-api` |
| 웹 | `/home/mmm/gps-tracker-web/dist-root` → `/home/mmm/releases/privacy-receipts-20261106-r1/web` |
| 배포 산출물 | `/home/mmm/gps-artifacts/privacy-receipts-20261106-r1` |
| 배포 전 사본 | `/home/mmm/backups/privacy-receipts-20261106-r1` |
| 정리 작업 | `/home/mmm/gps-ops`, `gps-privacy-accounts.timer` 활성 확인 |
| 다른 서비스 | 14차에서 dev-gps·Shield·환경설정·수집 정책은 변경하지 않음 |

위 상태는 14차 배포 검증 기록이다. 다음 변경 전 실제 health·실행 바이너리·스키마·웹 링크를 다시 대조한다. VPS 여유 공간은 당시 약 4.7GiB였으며 빌드는 VPS에서 수행하지 않는다.

`ops/release_privacy_receipts.py`는 **이전 API/스키마 95를 전제로 한 일회성 배포**다. 운영에 96이 적용된 뒤 그대로 재실행하거나 이전 바이너리만 복구하지 않는다. 다음 라운드는 현재 버전·마이그레이션 호환성을 기준으로 새 배포 절차를 작성한다.

## 완료 범위와 정확한 제한

- 1~6차: 권리 요청 접수·범위 검토, SIM 범위 삭제, 파일 정리 큐, 제한된 계정 이용 종료, SIM별 수집 중지/재개·서명 정책·단말기 ACK.
- 7~12차: 이용 종료 후 결과 전용 조회, 본인 위치/계정/개인 문서의 검토된 제공, 회사 자료 검토·증빙, 채팅/AI 본문 일부 제공.
- 13차: 검토된 이미지 영역만 PNG로 제공, 만료·회수·비밀번호 확인.
- [15차](location-rights-round15-20261106.md) — **개발·격리 검증 완료, 운영 미배포**: 큰 영수증을 서버가 100만 화소·한 변 2048px 안으로 축소하고 JPEG 촬영 방향을 바로 세운다. 읽기 증빙을 정규화 픽셀 해시에 결합(마이그레이션 0097). 이 브랜치에 반영했으며 운영 배포 전이다.
- [14차](location-rights-round14-20261106.md): 회사에 저장된 PNG/JPG 영수증을 확인된 직원·지출일 범위에서 직접 읽어 선택 영역을 제공. 원본 변경·제거·직원 변경 시 기존 제공본을 차단하고 임시 PNG를 정리.

아래는 운영 중인 14차 기준이다(15차 배포 후에는 큰 PNG/JPG를 축소하고 EXIF 방향을 적용한다). 직접 연결 이미지는 5MiB 이하, 한 변 2048px 이하, 100만 화소 이하다. PDF·대용량 휴대폰 사진·APNG·CMYK JPEG는 지원하지 않는다. JPEG EXIF 회전은 적용하지 않는다. 회사 원본 원장·영수증을 자동 정정/파기하지 않으며, 일부 자료 제공을 요청 전체 완료로 표시하지 않는다.

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

빌드는 `etcom-hub-lan` 빌드 호스트에서 한다. 이미지 정의는 `ops/hub-builder.Dockerfile`이며 Rust 1.88.0·Node 22.22.2를 사용한다. 기본 확인 명령:

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
| 승인 대기 | [15차](location-rights-round15-20261106.md) 운영 배포(스키마 96→97) | 96→97 기준의 새 배포 절차 작성, 운영 상태 재대조, 되돌림 절차 포함. 기존 일회성 배포 스크립트를 재사용하지 않음 |
| 결정 후 개발 | PDF 페이지 제공 | 렌더링 방식 결정(서버 렌더링은 Rust 1.92 이상 필요, 브라우저 렌더링은 서버 픽셀 재생성 불가). 입력/메모리 한도·픽셀 좌표·타인 정보 제외·원본 변경 무효화 검증. OCR은 검토 보조이며 자동 공개 승인으로 사용하지 않음 |
| 범위 확정 후 | 회사 공용 차량 문서/사진 연결, 원본 정정·파기 | 정보주체·회사 권한·보관 근거/기간·승인 범위를 먼저 확인 |
| 담당자 결정 대기 | 감사/처리 증빙·백업·외부 사본 보관과 파기, 로그인 불가/대리인 확인 | 회사 정책을 임의 보관 기간으로 대체하지 않음 |
| 별도 인프라 라운드 | API 최소 권한, 관리 접근·DB 경계·백업 및 서비스 분리 | 기존 공유 VPS의 GPS/dev/Shield 영향을 조사하고 검증 후 전환 |
| 별도 실물 라운드 | TLS 운영 승격, 실외 수집 중지/재개, 24시간·모션 절전 | 기존 파일럿 성공과 전체 운영 인수를 구분 |

테스트 자료 손실 허용은 사용자가 지정한 `sss`, `user@user4.com` 또는 새 모의 계정 범위였다. 다른 실제 계정·회사 원본·백업까지 삭제할 권한으로 확대하지 않는다. 읽기/격리 시험을 먼저 하고 운영 변경은 대상과 결과를 기록한다. 이번 인계 푸시는 서버 재배포·DB 변경·펌웨어 플래시를 수행하지 않는다.
