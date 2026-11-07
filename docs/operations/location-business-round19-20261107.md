# 19차 — 관리자 보안·DB 권한 분리

2026-11-07. 사용자 승인 범위: 구현, 검증, 화면 증빙, 인계 문서와 PR 갱신. 브랜치 `codex/location-business-prep`, PR [#248](https://github.com/ET-NOTE/gps-tracker/pull/248).

**구현·격리 검증 완료 / 운영 미배포**다. 후보 스키마는 **102**, 운영은 18A / **99**다. 실제 관리자 전용 회선·공인 IP·개인별 책임자 지정이 준비되지 않아 운영의 권한, DB 소유자, 방화벽, MFA, 로그 수집 설정은 변경하지 않았다. 18B 원장·자동 파기·조기 파기 역시 운영에서는 OFF다. 이 문서는 법적 적합성 인증이나 운영 보안 통제 완료 증명서가 아니다.

## 이번에 달라진 동작

기존 `users.role=admin`만으로 관리 기능을 실행하던 경로 앞에 서버 검증을 추가했다. `GPS_ADMIN_SECURITY=on`일 때 일반 로그인에 성공했더라도 **개인별 권한 + 허용 IP + 관리자 추가 인증**을 모두 확인해야 `/admin/*`에 접근할 수 있다. UI를 숨기는 것에 그치지 않고 API 직접 호출도 차단한다.

| 역할 | 조회 | 변경·실행 | 승인 |
|---|---|---|---|
| 위치정보관리책임자 `officer` | 관리자 조회·검토 | 일반 변경·파기 실행 불가 | 다른 관리자가 요청한 작업 승인·반려 |
| 위치정보관리자 `operator` | 관리자 조회·검토 | 관리 작업, 승인받은 권리 처리·권한 변경 실행 | 불가 |
| 위치정보취급자 `handler` | 지정한 계정의 상세·장치 정보만 | 불가 | 불가 |

- 회사 관리자의 Fleet 권한은 이 역할과 별개다. `X-Fleet-Owner`와 관리자 대리 로그인으로 우회하지 못한다. 보안 ON에서는 기존 대리 로그인 토큰의 일반 API·갱신·WebSocket 사용도 차단한다.
- 기존 관리자 계정에 새 권한을 자동 부여하지 않는다. 초기화 도구는 **서로 다른, 활성 상태의 이름 있는 개인 계정 2개**와 개별 호스트 IP(`/32` 또는 `/128`), 승인 근거를 요구한다. 이미 초기화되었으면 재실행을 거부한다. 실제로 두 사람이 관리하는지는 회사가 확인해야 하며 서로 다른 계정 번호만으로 증명되지 않는다.
- 취급자의 담당 범위는 계정 ID 목록이다. 실제 운전자 정보주체 확정이나 회사/공유 자료 전체 조회 권한을 부여한 것이 아니다. SIM 이력·소유 기준과 하드웨어 인증 구분은 유지한다.

## 추가 인증·IP·접근기록

- 비밀번호를 다시 확인하고 인증 앱의 TOTP를 확인한다. **RFC 6238 HMAC-SHA256 / 6자리 / 30초**, 앞뒤 1구간을 허용하되 이미 사용한 counter는 재사용할 수 없다. 이는 소유 기반 추가 인증이며 **PASS·네이버 본인확인과 동일한 신원확인 서비스가 아니다**. SHA256을 지원하는 실제 인증 앱으로 운영 인수 시험이 필요하다.
- 관리자 비밀번호는 영문·숫자·특수문자를 포함해 9자 이상, 관리자 인증 기준 90일 경과 시 변경하도록 한다. 기존 비밀번호의 과거 생성일은 소급 확정하지 않으며 최초 OTP 등록 시점부터 기준을 잡는다. 비밀번호 변경은 저장 해시 변화로 감지한다. 과거 비밀번호 재사용 금지 정책은 이번 범위가 아니다.
- 관리자 비밀번호 로그인과 추가 인증은 각각 실패 5회 후 15분 제한을 적용한다. 비밀번호 로그인은 계정별 DB 잠금으로 동시 요청도 직렬화하고, 실패 기록 쓰기에 실패하면 로그인을 진행하지 않는다. OTP 등록·검증은 같은 실패 카운터를 사용한다.
- 추가 인증 세션은 15분이며 계정·IP·권한 revision·비밀번호 해시에 묶인다. 서버에는 토큰 원문 대신 해시를 저장한다. 권한 변경·비활성·비밀번호 변경·만료·인증 종료 시 사용할 수 없다. 인증 실패 상태에서 관리자 화면을 계속 렌더링하지 않는다.
- OTP seed는 별도 32바이트 서버 키와 사용자 ID·무작위 nonce로 도출한다. DB에 seed 원문을 저장하지 않는다. 서버 키와 nonce를 함께 얻으면 seed를 재구성할 수 있으므로 키를 DB/백업과 분리해 보관해야 한다. 키 교체는 전체 OTP 재등록 절차를 수반한다.
- 클라이언트 IP는 TCP 연결의 실제 peer를 기준으로 한다. 설정된 신뢰 프록시에서 온 요청만 `X-Real-IP`를 읽으며 복수 주소·잘못된 주소는 거부한다. Nginx가 `$remote_addr`로 **덮어쓰도록** 해야 한다. 클라이언트가 보낸 `X-Forwarded-For`로 우회할 수 없다.
- API에서 IP를 제한하는 것과 VPS의 SSH/네트워크 방화벽을 제한하는 것은 별개다. 같은 공인 IP의 다른 PC까지 구별하지는 못한다. 전용 PC·별도 회선·원격 접속 MFA/이력과 방화벽은 23차에서 실제 확인한다.
- 관리 요청 전 사전 접근기록을 저장하지 못하면 실행하지 않는다. 응답 결과는 별도로 기록하며 `ready`는 서버가 성공 응답을 준비했다는 뜻이다. 브라우저 수신 증거가 아니다. 보안 이벤트에는 비밀번호·OTP seed·토큰·요청 본문을 기록하지 않는다.
- 보안 이벤트는 UPDATE/DELETE/TRUNCATE를 거부한다. 임의 보존 기간이나 자동 파기 기능은 넣지 않았다. 보안 로그, 승인 payload/사유, 만료 세션 등의 보관·정리 정책은 별도 확정해야 한다.

## 조회 → 요청 → 승인 → 실행

1. 관리자가 요청 자료·근거를 확인한다. 읽기 성격의 POST는 검토한 **정확한 경로 목록**만 조회로 분류한다. 새 경로가 `/review` 같은 접미사만으로 승인을 피할 수 없다.
2. `/admin/privacy/*`의 변경·발급·회수·파기와 `/admin/security/principals/:id`의 역할·IP·OTP 초기화 변경을 요청하면, 즉시 실행하지 않고 사유·HTTP method·경로·JSON payload·대상 지문을 결합한 승인 요청을 저장한다.
3. 다른 계정의 책임자가 승인한다. 본인 요청, 이미 처리한 요청, 변경된 대상은 승인할 수 없다.
4. 요청했던 관리자가 **동일한 내용**을 실행한다. 30분 만료, 요청자/승인자 권한 변경·비활성, 대상 변경, 내용 위조, 다른 실행자, 승인 재사용을 거부한다. 승인 row를 잠가 동시 실행도 한 번만 소비한다. 권한 변경은 처리 transaction 안에서 대상 지문을 다시 확인한다. 기존 권리 처리기는 자체 revision·원본 지문 검증을 함께 사용한다.
5. 승인 상태 `consumed`는 **실행 요청됨**이다. 비즈니스 처리 실패나 프로세스 중단까지 성공으로 표시하지 않는다. 실패 후 자동 재시도로 같은 승인을 반복 사용하지 않으며 결과 확인 후 새 승인을 요청한다.

SIM 충전 등 개인정보 권리 처리와 무관한 기존 관리 작업은 관리자 역할·MFA·IP·접근기록으로 제한하되 모두 2인 결재로 바꾼 것은 아니다. 신규 민감 작업을 추가할 때 승인 경계와 조회 allowlist를 함께 검토해야 한다. 승인 payload는 실행을 재현할 수 있도록 저장하므로 불필요한 개인정보·비밀값을 넣지 않는다.

## DB 실행 권한과 스키마 변경 권한

`ops/admin_db_roles.py`는 전용 `gps_` DB와 정확한 스키마 102, 검토한 schema 목록만 허용한다. 기본 실행은 점검이며 `--apply`일 때만 바꾼다. 인접 프로젝트 DB는 대상으로 삼지 않는다.

- `gps_schema_owner`: NOLOGIN, 애플리케이션 public 테이블·함수 소유자. API가 이 역할을 상속하거나 `SET ROLE` 할 수 없다. 확장 기능 소유 객체는 그대로 둔다.
- `gps_runtime`: 비슈퍼유저, 역할/DB 생성·복제·BYPASSRLS 없음. 업무 테이블의 필요한 DML과 sequence 사용을 허용하며 schema 생성·DDL·TRUNCATE·소유자 승격은 허용하지 않는다. 마이그레이션 원장은 SELECT만 가능하다.
- 보안/관리 감사 로그의 UPDATE·DELETE와 파기 증빙의 직접 INSERT·UPDATE·DELETE를 회수한다. 18B의 검토된 파기는 제한된 SECURITY DEFINER 함수로 계속 동작한다. 현재 public 함수의 실행 권한을 명시적으로 부여하며, 미래 객체에 대한 자동 권한 부여는 설정하지 않는다.
- 새 runtime 비밀번호는 전용 파일에 0600·배타 생성하고 fsync한 다음 DB commit한다. commit 응답이 모호하면 이 파일을 지우지 않는다. 기존 runtime 역할이 있으면 덮어쓰거나 임의 회전하지 않는다.
- `GPS_MIGRATE_ONLY=1`은 별도 유지보수 자격증명으로 migration만 실행하고 listener/worker 전에 종료한다. 실제 상시 API에는 `GPS_DATABASE_MODE=runtime`과 runtime DSN만 전달한다. runtime 모드는 migration 개수·체크섬과 비소유/비DDL 경계를 확인하고 불일치하면 기동하지 않는다.
- 보안 ON인 비시험 환경은 runtime 모드가 아니면 기동하지 않는다. `APP_ENV=test` 예외는 폐쇄된 합성 시험 환경 전용이다. 운영에 이 예외를 사용하면 안 된다.

**경계:** runtime은 업무 기능에 필요한 DML과 검토된 함수 실행 권한을 갖는다. 탈취된 API 프로세스/DB 자격증명의 모든 악용을 DB 자체가 막는 설계는 아니며, DB 관리자·OS root에 대한 내변조 보장도 아니다. 단말기 수집·웹 조회 DB 역할의 추가 세분화, 위치 암호화, 외부 증빙 보관은 후속 라운드다. 기존 DB 소유자 자격증명을 상시 API나 정리 서비스에 계속 남기면 분리 완료로 볼 수 없다.

## 검증과 증빙

고정 빌드 환경: Rust 1.88.0, Node 22.22.2, TimescaleDB 2.19.3 / PostgreSQL 14. DB는 internal Docker network와 tmpfs, 계정/위치는 합성 자료다. 운영 자격증명·외부 메일·실기기 제어를 사용하지 않았다.

| 검사 | 결과 |
|---|---|
| Rust | fmt·Clippy `-D warnings`·단위 시험 76 통과, 기존 외부 환경 의존 3개 ignored |
| 관리자 통합 | 12묶음: 초기화, 개인 역할, OTP 재사용/5회/만료, 비밀번호 동시 실패, IP 위조, 2인 승인, 변경/재사용/경합, 실제 권리 파기, 감사 불변성, DB 권한, runtime 재기동, 인증 종료 |
| OFF 회귀 | 3묶음. 기존 로그인/권한과 조회 원장 OFF 유지 |
| 사실 열람 회귀 | 6묶음. SIM 이동 전후 본인 범위, 타인 차단, 한도·타임아웃·회수 |
| 경로 목록 | 전체 306 / 위치 기록 대상 80. 신규·동적·service 등록 누락 거부 3시험 |
| 웹 | 228개 시험, 루트 배포 경로 빌드 성공 |
| 실제 React UI + 모의 API | 4확인: PC 권한·승인 상세, 승인 버튼 상태 변화, 390px 가로 넘침 없음, MFA 실패 시 보호 화면 미노출 |

웹은 Windows Node 22.12에서 기존 business-calendar 시험 프로세스가 비정상 종료되어, 정해진 Linux Node 22.22.2 환경에서 전체 228개를 다시 실행해 통과했다. 빌드의 기존 PDF 관련 chunk 크기 경고는 남는다. 세 ignored Rust 시험을 실행한 것으로 집계하지 않는다.

[검증 집계](../evidence/admin-security-20261107/validation-summary.json), [통합 원본](../evidence/admin-security-20261107/admin-security-validation.json), [OFF 원본](../evidence/admin-security-20261107/location-access-off-validation.json), [사실 열람](../evidence/admin-security-20261107/location-facts-validation.json), [UI 결과](../evidence/admin-security-20261107/ui-validation.json), [파일 해시](../evidence/admin-security-20261107/SHA256SUMS.txt).

- [PC 접근권한·허용 IP·승인 상세](../evidence/admin-security-20261107/admin-permissions-approval-desktop.png)
- [모바일 권한·승인 화면](../evidence/admin-security-20261107/admin-permissions-mobile.png)
- [모바일 관리자 추가 인증](../evidence/admin-security-20261107/admin-mfa-mobile.png)

캡처는 **새로 구현한 실제 React 컴포넌트 + 모의 API/합성 계정/IP**이며 화면 상단에 그 사실을 표시했다. 이미지 생성으로 만든 예시가 아니다. API·DB 검증은 별도 실제 격리 서버의 원본 JSON으로 증명한다. PC·MFA의 실운영 적용, Cafe24 방화벽·V3 설치, 저장 암호화 캡처로 제출할 수 없다. 18A/18B의 미완료 캡처를 완료로 바꾸는 것도 아니다.

## 재실행

최종 빌드·검증 산출물은 빌드 호스트 `/home/etcom-hub/build/gps-admin19-20261107`에 보관한다. 바이너리는 `out/gps-tracker-api`, 소스는 `src/gps-tracker-api`와 `src/gps-tracker-web`, 로그는 `check.log`, `release.log`, `integration.log`, `off.log`, `facts.log`, `web-check.log`다. SHA-256은 검증 집계에 기록한다. 운영 VPS에서 빌드하지 않는다.

1. Git canonical 바이트로 source를 구성한다(`git -c core.autocrlf=false archive`). 과거 SQL, 특히 0085의 CRLF 예외를 변환하지 않는다.
2. `ops/dev_admin_security.sh`를 이 디렉터리의 `dev19.sh`, 19차 Python 도구 3개를 같은 디렉터리에 둔다. 기존 OFF/사실 열람 helper의 컨테이너 접두사만 작업 사본에서 `gps-admin19-`로 맞춘다.
3. `bash dev19.sh api-check`, `bash dev19.sh api-release` 후 **빈 시험 DB**에서 `ADMIN_SECURITY=on LEDGER=on ERASURE=on bash dev19.sh up`, `bash dev19.sh suite test_admin_security.py`를 실행한다. 시험은 runtime 역할 생성 후 API를 실제로 그 자격증명만으로 다시 기동한다.
4. `bash dev19.sh down`으로 시험 DB를 제거한 뒤 새 환경을 OFF로 올리고 `test_location_access_log.py`, `test_privacy_location_facts.py`를 실행한다. ON 시험용 runtime credential 파일은 종료 후 삭제한다. 예전 검증 JSON은 덮기 전에 따로 보관한다.
5. UI 캡처는 로컬 웹 의존성과 별도 Playwright 설치 경로 `GPS_QA_NODE_MODULES`, 출력 경로 `GPS_QA_OUTPUT`을 지정해 `node ops/check-admin-security-ui.mjs`로 실행한다. localhost만 사용하며 실제 계정 정보를 넣지 않는다.

## 운영 적용 전에 필요한 것

이번에는 운영 실행용 일괄 배포 스크립트를 적용하지 않았다. 아래를 운영 인수 라운드에서 구체적인 대상·복구값과 함께 리허설한 뒤 적용한다.

1. 책임자·관리자 개인 계정을 각각 지정하고, 관리자 전용 회선의 실제 공인 IP를 확인한다. 개발자 PC는 직접 허용 목록에 넣지 않고 전용 PC에 원격 접속하는 정책을 유지한다. 회선 장애 시 승인된 비상 콘솔 경로와 처리자를 준비한다.
2. Nginx의 실제 peer와 `X-Real-IP` 덮어쓰기를 확인한다. 허용·비허용 네트워크에서 UI/API 직접 호출을 시험한다. 운영 API/관리 포트를 외부에 직접 노출해 프록시 경계를 무력화하지 않는다. DB 포트·다른 프로젝트 서비스는 별도 현황을 확인한다.
3. 스키마 99 → 100 → 101 → 102를 현재 데이터·Timescale 권한·PDF 소켓 서비스 구성에서 리허설한다. 이번 신규 관리자 시험은 빈 DB → 102이며, **18B의 99↔101 OFF 복구 시험이 102의 되돌림 증거는 아니다**.
4. 유지보수 DSN을 비공개 파일에 두고 migration을 일회 실행한다. `admin_db_roles.py --dsn-file <private-file>` 점검 후, 검토된 `--apply --secret-out <new-private-file>`로 분리한다. CLI 인자나 채팅에 비밀번호 원문을 넣지 않는다. 기존 API/정리 작업의 DB 권한 의존성을 함께 점검한다.
5. `admin_security_bootstrap.py --dsn-file <private-file> --officer <개인ID> --operator <다른개인ID> --ip <공인IP/32> --reference <승인문서번호>`로 점검하고 `--apply`한다. 유지보수 자격증명은 API 서비스 환경에 복사하지 않는다.
6. 별도 무작위 MFA 키를 비공개 서버 설정에 넣는다. 각 담당자가 자신의 인증 앱을 등록하고, MFA 실패·만료·IP 거부·2인 승인·runtime 기동을 확인한다. 등록 화면의 seed를 캡처하거나 Git에 넣지 않는다. 보안 ON은 runtime 모드와 함께 적용하며 기록/자동 파기는 별도 정책 플래그를 유지한다.
7. 실제 계정/SIM 귀속·단말기 수신·다른 서비스·PDF 소켓·정리 작업을 확인하고 최종 운영 캡처를 수집한다. 현재 후보의 시험 결과만으로 이 단계를 통과 처리하지 않는다.

### 잠김·실패·복구

- 관리자 한 명의 OTP 분실은 다른 책임자의 승인과 관리자의 실행으로 초기화한다. 유일한 책임자까지 OTP를 잃거나 IP가 변경되어 모두 막힌 경우, 기존 bootstrap 도구를 재실행하거나 보안 플래그를 공개 상태에서 OFF로 내려 우회하지 않는다.
- 위 경우 관리 경로를 먼저 네트워크에서 제한하고, 회사의 별도 2인 확인을 거친 유지보수 계정/콘솔에서 **대상 1명만** nonce·세션을 회수하거나 허용 IP를 정정한다. 사유·승인자·실행자·전후값을 감사 기록으로 남기고 기존 승인을 폐기한다. 이 비상 복구의 실제 담당자·명령·리허설은 운영 활성화 전 남은 필수 항목이다.
- DB 역할 분리는 과거 소유자 권한을 API에 되돌리는 자동 rollback을 제공하지 않는다. DB commit 성공 여부가 모호하면 새 자격증명 파일을 보존하고 별도 연결로 확인한다. 102 기록이 생긴 뒤에는 원장을 지워 스키마를 내리지 않고 앞으로 수정한다.
- 현재 운영은 아직 99이므로 이번 작업으로 운영 rollback이 필요해진 상태는 아니다.

## 다음 라운드

다음 개발은 **20차 전송·저장 암호화**다. 19차 운영 활성화는 전용 관리자 IP·실제 담당자·복구 리허설 준비 후 별도로 완료한다. 21차 동의별 중지·보관·파기, 22차 제3자 제공 통보, 23차 전용 PC/백신/방화벽/실제 증빙은 그대로 남아 있다. 보안 접근기록 정책을 임의의 90일/13개월로 확정하지 않았다.

기술 근거: [RFC 6238](https://www.rfc-editor.org/rfc/rfc6238), [PostgreSQL 14 GRANT](https://www.postgresql.org/docs/14/sql-grant.html), [Axum 0.7 ConnectInfo](https://docs.rs/axum/0.7.9/axum/extract/struct.ConnectInfo.html).
