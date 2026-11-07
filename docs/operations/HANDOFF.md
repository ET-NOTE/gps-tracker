# GPS 작업 인계 — 2026-11-07

다른 PC에서 작업을 이어갈 때 먼저 읽는 문서다. **현재 운영은 17차 기능 + 18A 로그 보호·보관기간 안내 패치**, 릴리스 `privacy-log-20261107-r1`, 스키마 **99**다. 2026-11-07 17:16:49 KST API 적용, 17:17:08 후속 확인 통과. Nginx 로그 보호는 같은 날 17:06 KST 적용했다. [18A 결과·복구·증거](location-business-round18a-20261107.md)를 먼저 읽는다.

**18B 조회 취급대장 보완은 구현·격리 검증·OFF 리허설 완료, 운영 미배포**다. 후보 스키마는 **101**이며 건별 사전 기록, 조회 시점 계정 범위/회사 배정 스냅샷, 외부·실시간 처리 결과, 검토된 조기 파기와 경합 차단, 전체 라우트 분류를 추가했다. [18B 결과·제한·재실행](location-business-round18b-20261107.md)을 읽는다. 운영 기록·자동 파기는 여전히 OFF다. 사용자 승인 순서는 [18A → 18B → 19~23차](location-business-rounds-20261107.md)이다. **19·20A·20B 후보는 구현·격리 검증을 마쳤으며 다음 기능 라운드는 21차 중지·보관·파기**이다. 18B 보고서·원본 JSON은 보관했고 화면 캡처는 브라우저의 로컬 URL 정책 거부로 미완료다.

**[19차 관리자 보안·DB 권한 분리](location-business-round19-20261107.md)는 구현·격리 검증 완료 / 운영 미배포(후보 스키마 102)**다. 개인별 역할·TOTP·허용 IP·2인 승인·보안 접근기록과 schema owner/runtime 분리를 구현했다. 실제 관리자 전용 PC·회선·공인 IP, 담당자 지정과 비상 복구 리허설 전에는 운영을 켜지 않는다. [실제 컴포넌트 캡처 및 원본 검증](../evidence/admin-security-20261107/validation-summary.json)은 합성 자료를 사용하는 격리 검증으로 표시했다.

**[20차 전송·저장 암호화](location-business-round20-20261107.md)는 20A 핵심 필드·TLS 후보 검증 완료 / 운영 미배포(스키마 103)**다. `bd00dfb`에 원본·최근 위치·이벤트 8필드 OpenPGP AES-256+MDC, 키 교체/전체 덤프 복원, TLS 강제 수집 경계를 구현했다. Rust 78 + 별도 외부 처리 3, 통합 12묶음, 19차 초기 설정 호환, 펌웨어 232 + Mbed TLS 13을 통과했다. **20A 당시 범위이며, 파생·파일 후속은 아래 20B를 참고한다. 구 백업까지 암호화 완료는 아니다.** 운영 API/DB/HTTP 경로와 실물은 변경하지 않았다. [캡처·원본 증빙](../evidence/crypto20-20261107/)은 합성 격리 검증 보고서다.

**[20B 파생 데이터·파일 암호화](location-business-round20b-20261107.md)는 구현·격리 검증·운영 전환 후보 준비 완료 / 운영 미배포(후보 스키마 104)**다. 구현 `3e41d86`. 20A 포함 23테이블·55필드와 GPS 전용 파일 본문을 보호한다. Rust 78+외부3, 신규5·복구7·업무8묶음, 실제 구 바이너리 기반 합성 99→104/15만 좌표, 중단·재개/압축 chunk/전체 백업 복원 통과. [캡처·검증 요약](../evidence/crypto20b-20261107/validation-summary.json)은 **격리 검증 보고서**다.

후보 묶음은 빌드 호스트 `/home/etcom-hub/build/gps-crypto20b-20261107/candidate-crypto20b-20261107-r1.tar.gz`(SHA-256 `57202597c5046135d3fb5ed0da2b798a281e73b042797281916c87f8ed4b50cf`). API SHA `2651194a…b766`. 키/자격증명/실제 자료 없음. 운영 활성화 전 **DB 바인드 로그 -1→0, 실제 키 분리 보관·복원, runtime/정리 워커 동시 전환, 보호 백업·유지보수 시간/용량 재확인**이 필요하다. 합성 측정은 운영 전체 규모 리허설을 대신하지 않는다. 19차 102용 배포 스크립트를 재실행하지 않는다. 다음 기능 개발은 **21차**이며, 전체 단말 TLS 승격·실외/24시간 절전 및 운영 활성화는 별도 인수 항목이다.

17차는 2026-11-06 20:12 KST 적용, 22:32 KST 모의 확인 완료다. 17차 이전으로의 스키마 되돌림은 불가하며 앞으로 고친다. 18A는 스키마 99 API만 바꿔 17차 API로 복구할 수 있다. PDF는 16차 파일과 인프라 1차의 별도 서비스 구성을 유지한다. 라운드 문서는 해당 시점의 기록이며 현재 상태는 이 문서를 우선한다.

## 저장소와 이어받기

- 저장소: https://github.com/ET-NOTE/gps-tracker
- 작업 브랜치: `codex/location-business-prep`
- PR 대상: `main`. 앞선 GPS/Fleet 개선과 위치정보사업 준비가 누적되어 있다. 최신 패치만의 작은 PR로 해석하지 않는다.
- [PR #248](https://github.com/ET-NOTE/gps-tracker/pull/248)은 검토용 초안으로 유지한다. 운영 배포 완료와 GitHub 병합 완료는 서로 다르다.
- 이 브랜치의 API·웹·`idf_caltest` 소스가 이어받을 기준이다. Flutter 앱은 별도 저장소이며 이 인계로 APK가 새로 만들어지지 않는다.
- **운영 패치 소스만 재현할 때:** `codex/privacy-log-hotfix-20261107`의 `ee295ece717eef7140171b289514bf1c62c007b5`. 개발 브랜치 HEAD는 운영 미배포 스키마 100·101·102·103·104를 포함한다. 18B OFF 리허설은 통과했지만 운영 배포 절차 없이 그대로 올리지 않는다.

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
| 릴리스 | `privacy-log-20261107-r1` (18A, 2026-11-07 17:16:49 KST). 웹은 17차, 처리기 파일은 16차, 처리기 서비스 구성은 인프라 1차 2단계 그대로 |
| DB | PostgreSQL 14 / TimescaleDB 2.19.3, 마이그레이션 99 (0099는 17차, 2026-11-06 20:12 KST) |
| API SHA-256 | `fa1e51e3d39473ca2852ac6b2899790547fa6667bb7337c646d29258a3e1c0fe` (17차 `1fc16f78…`은 `/home/mmm/backups/privacy-log-20261107-r1/api.previous`) |
| API | `/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api`, systemd `gps-tracker-api` |
| 실행 계정 | API와 정리 작업 2개는 **`gps-api`**(로그인·sudo·docker 없음, 능력 0, 읽기 전용 파일 시스템 + 업로드 두 곳 쓰기)로 실행. 2026-11-06 15:32 KST [인프라 1차](infra-round1-runtime-account-20261106.md). 배포는 `mmm`+sudo. 환경파일·FCM 키는 `root:gps-api 640`이라 `mmm`은 sudo 없이 읽지 못한다. 적용 전 기록은 `/home/mmm/backups/runtime-account-20261106` |
| PDF 처리기 | 같은 디렉터리의 `gps-pdf-render`(root 소유 755), SHA-256 `3eaaf5535c01c58e1c4f3eae5e3a4799c59b916233960897581d5ee7707d4ffb`. **2026-11-06 16:48 KST부터 API가 실행하지 않는다.** API는 쪽 요청을 `/run/gps-pdf-render/render.sock`(root:gps-api 660)으로 보내고, systemd가 요청마다 처리기를 **`gps-pdf`** 계정(로그인·그룹 없음)으로 실행한다: 네트워크 없음, 처리기 파일만 보이는 빈 루트, 메모리 832MiB·스왑 0, 20초([2단계](infra-round1-pdf-service-20261106.md)). 유닛은 `gps-pdf-render.socket`·`gps-pdf-render@.service`·`gps-pdf-render-selftest.service`, API drop-in `20-pdf-socket.conf`. 자체 점검이 실패하면 소켓이 없고 PDF 쪽만 "사용할 수 없음"이 된다. 적용 기록은 `/home/mmm/backups/pdf-service-20261106` |
| 웹 | `/home/mmm/gps-tracker-web/dist-root` → `/home/mmm/releases/privacy-facts-20261106-r1/web` (이전: `/home/mmm/releases/privacy-pdf-20261106-r1/web`) |
| 배포 산출물 | `/home/mmm/gps-artifacts/privacy-facts-20261106-r1`(17차: API·웹), `/home/mmm/gps-artifacts/privacy-facts-20261106-r1-smoke`(17차 운영 모의 확인에 쓴 스크립트 수정본·리허설 기록·실행 식별자), `/home/mmm/gps-artifacts/pdf-service-20261106`(처리기 서비스 스크립트와 이전 API), `/home/mmm/gps-artifacts/privacy-pdf-20261106-r1`(16차: 처리기 파일) |
| 배포 전 사본 | `/home/mmm/backups/privacy-facts-20261106-r1` (이전 API `0d28667f…`, 적용 전 항목 제약 정의). **17차 스크립트 되돌림(`release_privacy_facts.py rollback`)은 더 이상 쓸 수 없다**(운영 모의 확인으로 새 항목을 쓴 발급 기록이 생겼고, 그 기록은 지우지 않는다). **이전 바이너리는 스키마 99에서 기동하지 않으므로 바이너리만 되돌리지 않는다**(리허설 확인). 복구는 [17차 문서](location-rights-round17-20261106.md)의 "모의 확인 이후의 복구"대로 스키마 99를 유지한 채 한다: 운영 조치(항목 미선택·회수) → 웹만 이전으로 → API 수정 배포(바이너리만 교체, 실패 시 지금 바이너리로 복귀). 16차 사본은 `/home/mmm/backups/privacy-pdf-20261106-r1` |
| 정리 작업 | `/home/mmm/gps-ops`, `gps-privacy-accounts.timer` 활성·실행 성공. `privacy_account_closure.py`는 2026-11-06 12:45 KST 수정본(SHA-256 `1704d2bbbd99…`, 커밋 `d66b2a9`)으로 교체, 이전 파일은 `/home/mmm/backups/privacy-account-closure-fix-20261106` |
| 18A 로그 | GPS vhost만 별도 접근 로그·오류 분류기. `gps-nginx-log.service` 활성·부팅 등록. host rsyslog·dev-gps·Shield·방화벽·수집 정책은 변경하지 않음 |
| 18A 산출물/복구 | `/home/mmm/gps-artifacts/privacy-log-20261107-r1`와 `/home/mmm/gps-artifacts/nginx-privacy-20261107`. API 백업 `privacy-log-20261107-r1`, Nginx 성공 백업 `nginx-privacy-20261107-r2`. 절차는 18A 문서 참고 |

위 표는 2026-11-07 18A 적용 후 기준이다. 20B 최종 20:58 KST 읽기 전용 재확인도 schema99·해시·웹 링크·NRestarts0이 같았다. 20차 작업 중 19:42 KST 읽기 전용 재확인에서 실행 해시·기동 시각·NRestarts 0이 같았다. health의 release/environment는 기존 환경값 `dev-20261021-190449-d541456` / `development`를 반환하므로 배포 식별은 health 문자열만 믿지 말고 위 실행 파일 해시와 같이 대조한다. 이 환경명 표기는 별도 정리 항목이다. 디스크 정리 후 VPS 여유 공간은 약 8.8G였으며 빌드는 VPS에서 하지 않는다. 다음 변경 전 health·실행 바이너리·스키마·웹 링크를 다시 대조한다.

**18차 활성화 전 검토:** [독립 검토](../reviews/location-business-readiness-20261107.md)의 로그·보관기간 안내는 18A에서 보완했다. 조회 시점 귀속, 건별 기록/내구성, 철회 삭제 경로는 18B 구현·격리 검증을 마쳤으나 운영에는 아직 적용하지 않았다. 관리자 역할·MFA·IP 제한·DB 권한 분리는 19차 후보에서 검증했고 운영 적용은 남아 있다. 사업 전체 준비에는 위치 저장 암호화, TLS 전량 승격, 이용·제공 중지, 제3자 제공 통보 등이 남아 있다.

`ops/release_privacy_receipts.py`는 **이전 API/스키마 95를 전제로 한 일회성 배포**다. 운영에 96이 적용된 뒤 그대로 재실행하거나 이전 바이너리만 복구하지 않는다. 15차(96→97)의 배포 절차는 [15차 문서](location-rights-round15-20261106.md)의 "배포 절차"와 `ops/stage_privacy_raster.py`·`ops/release_privacy_raster.py`·`ops/smoke_privacy_raster.py`에 있다. 이 스크립트들도 15차 전용이며 이후 라운드에 재사용하지 않는다.

## 완료 범위와 정확한 제한

- 1~6차: 권리 요청 접수·범위 검토, SIM 범위 삭제, 파일 정리 큐, 제한된 계정 이용 종료, SIM별 수집 중지/재개·서명 정책·단말기 ACK.
- 7~12차: 이용 종료 후 결과 전용 조회, 본인 위치/계정/개인 문서의 검토된 제공, 회사 자료 검토·증빙, 채팅/AI 본문 일부 제공.
- 13차: 검토된 이미지 영역만 PNG로 제공, 만료·회수·비밀번호 확인.
- [18A](location-business-round18a-20261107.md) — **운영 패치 완료, 스키마 99 유지**. Nginx 접근·오류 로그와 API trace의 요청 비밀값 차단, 원본 1년 자동 파기 오안내 정정. 운영 패치 단위 65 + 사실 열람 6묶음 + 배포 제어 4시험 통과. 캡처는 도구 중단으로 미완료이며 실제 결과 파일 보관.
- [20A](location-business-round20-20261107.md) — **핵심 필드/TLS 후보 구현·격리 검증 완료, 운영 미배포**. 키 없는 복호화·변조·HTTP·무서명 거부, SIM 연속성, 작은 배치 변환/키 교체, Timescale 전체 백업 복원 통과. `https-operating` 빌드 완료(절전 ON·기본 24시간), 실물 미설치. 파생/파일 구현·전환 후보 준비는 20B에서 후속 완료했고 실제 활성화·키 보관·구 백업 처리는 남아 있다.
- [19차](location-business-round19-20261107.md) — **구현·격리 검증 완료 / 운영 미배포(후보 스키마 102)**. Rust 76개·Clippy, 웹 228개·빌드, 관리자 통합 12묶음, OFF 3·사실 열람 6묶음, 실제 React UI 4확인. 비밀번호 동시 실패 제한, OTP 재사용·IP 위조·동일인 승인·대상/권한 변경·승인 재사용 거부, runtime으로 DDL·트리거 변경 거부와 검토된 파기 성공을 확인했다. 개인 계정·지정 IP·실제 인증 앱·비상 복구·운영 데이터 99→102 리허설은 운영 활성화 전 남는다.
- [18B](location-business-round18b-20261107.md) — **구현·격리 검증·OFF 리허설 완료 / 운영 미배포(후보 스키마 101)**. Rust 71 통과·3 ignored 중 외부 HTTP 시험 1개 별도 통과, 통합 10묶음, OFF 3·기존 사실 열람 6묶음, 경로 296개/기록 규칙 80개 역검증. 실제 18A 바이너리로 99→101→99→101 리허설, 계정/SIM/요청 지문 유지. 후보 SHA-256 `36522dd395e2d0c024198ad00ec12147c291bf2373ba64ae8607846e4b349712`. 19차 권한 분리와 책임자 정책 확정 전 기록·자동 파기·조기 파기를 운영에서 켜지 않는다.
- [17차](location-rights-round17-20261106.md) — **운영 배포 완료(2026-11-06 20:12 KST, 스키마 99), 모의 계정 확인 통과(22:32 KST). 스크립트 되돌림은 더 이상 쓸 수 없다**: 기존 계정 자료 제공에 담당자가 기간을 정해 선택하는 항목 '위치정보 수집·이용·제공사실'을 추가했다. 남아 있는 기록(수집 일별 건수, 구역 출입·AI 분석, 공유 링크·위치 파일 제공·회사 연결)을 좌표 없이 제공하고, 건별 기록이 없는 처리를 자료 안에 명시한다.
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

20차에서 **`https-operating`**(TLS 검증+HMAC, 정상 절전 ON, 기본 24시간) 프로필을 별도로 추가·빌드했다. 최종 [manifest](../evidence/crypto20-20261107/firmware-manifest.json)를 확인한다. 이는 실물 설치 완료가 아니며 위 마지막 실물 상태는 계속 절전 비활성 파일럿이다.

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

Git으로 이동하는 것은 소스·라운드 문서·아래 작은 검증 JSON이다. `.env`, SSH 개인키, DB 덤프, 인증 토큰, APK/펌웨어/API 바이너리, 전체 운영 로그와 민감정보 캡처를 Git에 넣지 않는다. 사용자 요청에 따른 19차 합성 자료의 실제 컴포넌트 캡처 3장은 환경을 표시하고 작은 검증 JSON·파일 해시와 함께 Git에 보관한다.

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
| 완료 | **[인프라 2차: VPS와 독립된 외부 장애 감시](infra-round2-external-watch-20261106.md)** | 운영자 결정(2026-11-06): 알림은 메일(SMTP), 감시 위치는 사무실 빌드 호스트만, Uptime Kuma에도 알림 등록. 감시 스크립트(`ops/gps_watch.py`)는 구현·격리 리허설 통과(커밋 `7356503`). **2026-11-06 17:22 KST부터 빌드 호스트(`etcom-hub`)의 사용자 타이머 `gps-watch.timer`로 1분마다 가동 중**이고 네 점검이 정상이다. 메일은 Google Workspace(`smtp.gmail.com:587`)로 보낸다. 상태는 `ssh etcom-hub-lan "bash ~/build/gps-watch-20261106/install_gps_watch.sh show"`. 시험 메일은 운영자의 받은편지함에 도착했다. **메일 경로 알림 훈련을 했다**(점검 주소 하나를 5분간 닫힌 포트로 바꿈: 장애 메일 2026-11-06 23:59, 복구 메일 11-07 00:01 KST 발송. 받은편지함 도착은 2026-11-07 운영자 확인). **Kuma 주기 신호는 2026-11-07 16:10 KST부터 들어가고**(운영자가 알림 수단·Push 모니터 생성, 주소 입력) 같은 날 Kuma 경로 훈련도 마쳤다(타이머 정지 16:12 → Kuma 장애 판정 16:15 → 재시작 16:21 → 복구 판정 16:22). 두 경로의 알림 메일 모두 운영자가 받은편지함 도착을 확인했다(2026-11-07). 남은 것 없음. 운영 서버 장애는 메일 감시가, 감시 정지는 Kuma가 알린다. 운영 서버 로그에는 사무실 주소의 `GET /health`·`GET /ingest` 405·SSH 접속 종료가 분당 한 줄씩 남는다(단말기 보고가 아니다) |
| 완료(검토 대기) | **[권리 대응 17차: 수집·이용·제공사실 열람](location-rights-round17-20261106.md)** | **운영 적용(2026-11-06 20:12 KST)과 운영 모의 확인(22:32 KST) 완료**: 릴리스 `privacy-facts-20261106-r1`, 스키마 99. 모의 계정 3개로 본인 범위 제공, 타 계정 차단, 인증·만료·회수, 기존 발급 2건 불변을 확인했고 실행 전후 실제 계정·SIM 소유·단말기 수신·다른 서비스가 같았다. **복구 제약**: 스크립트 되돌림 불가, 이전 바이너리는 스키마 99에서 기동하지 않음 → 스키마 99를 유지한 채 고친다. **남은 것**: 자료에 그대로 나가는 '기록되지 않는 처리' 문구의 위치정보관리책임자 검토, 포함 행이 많은 계정의 집계 시간(운영에서 재지 못함). 조회 건별 기록(취급대장·접근기록)은 이번 범위가 아니다 |
| 격리 검증 완료 | **[18B: 위치정보 조회 기록](location-business-round18b-20261107.md)** | `4594f55`에서 조회 시점 귀속·건별 원장·내구성·철회 삭제·경로 분류를 보완했다. Rust 71개, 통합 10묶음, OFF 3묶음, 사실 열람 6묶음, 외부 HTTP 별도 시험과 99→101→99→101 리허설 통과. 운영 미배포·기록/파기 OFF. 보존 정책과 운영 배포 절차는 별도로 확정한다. |
| 격리 검증 완료 | **[19차: 관리자 보안·DB 권한 분리](location-business-round19-20261107.md)** | 후보 102. 역할·MFA·IP·2인 승인·보안 접근기록·runtime DB 분리 검증, PC/모바일 실제 컴포넌트 캡처 완료. 운영은 전용 IP·개인별 담당자·실제 인증 앱·99→102 및 비상 복구 리허설 전 미적용. |
| 다음 | **20차: 전송·저장 암호화** | TLS 전량 전환·레거시 종료·위치 암호화·키/백업 분리. 실물 준비가 필요한 검증과 서버의 합성 데이터 검증을 구분한다. [확정 라운드](location-business-rounds-20261107.md) 참고. |
| 별도 항목(섞지 않음) | 방화벽 부팅 순서([별도 구성 위험](incident-20261106-hosting-maintenance.md), `ops/fix_firewall_boot_order.sh`), 디스크 정리([2026-11-06 1차 완료](disk-cleanup-20261106.md): 운영 여유 4.7G → 8.8G, 빌드 호스트 16G → 30G. 백업·`.rustup`·로그는 남김), 열린 포트 축소, 관리 접근·DB 경계·백업 | 11월 6일 장애의 원인은 호스팅 업체의 긴급 업데이트 문제로 확인됐다. 방화벽 순서 문제는 그 원인으로 확정하지 않은 별도 위험이다. 방화벽·시스템 설정 변경은 운영자가 실행 |
| 별도 실물 라운드 | TLS 운영 승격, 실외 수집 중지/재개, 24시간·모션 절전 | 기존 파일럿 성공과 전체 운영 인수를 구분 |

테스트 자료 손실 허용은 사용자가 지정한 `sss`, `user@user4.com` 또는 새 모의 계정 범위였다. 다른 실제 계정·회사 원본·백업까지 삭제할 권한으로 확대하지 않는다. 읽기/격리 시험을 먼저 하고 운영 변경은 대상과 결과를 기록한다. 이번 18A는 GPS 로그와 API 패치를 배포했으며 DB·펌웨어는 변경하지 않았다.
