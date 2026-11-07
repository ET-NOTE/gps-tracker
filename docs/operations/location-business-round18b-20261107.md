# 위치정보사업 준비 18B — 조회 기록의 귀속·내구성·철회

2026-11-07. **구현·격리 검증·OFF 업그레이드/복구 리허설 완료. 운영 미배포.**

운영은 18A `privacy-log-20261107-r1`, 스키마 99 그대로다. 이번 후보는 `access-ledger18b-20261107-dev`, 스키마 101이며 웹·펌웨어는 바꾸지 않았다. 기록, 자동 보존기간 파기, 검토된 조기 파기는 각각 기본 OFF다. 보존 정책과 19차 권한 분리 전 운영 취급대장 완료로 표시하지 않는다.

## 구현

| 항목 | 18B 동작 |
|---|---|
| 귀속 | 요청 당시 계정 범위·조회자·공유 ID·차량 연결 구간을 저장한다. 나중에 현재 SIM 소유자를 재조회하여 과거 기록을 다시 붙이지 않는다. 계정 소유자를 실제 운전자로 간주하지 않으며 `actual_subject_user_id`는 미확정이다. |
| 건별 원장 | `location_access_events`에 HTTP 요청/실시간 메시지/외부 HTTP 호출마다 별도 행을 둔다. 시간별 집계는 `location_access_hourly` 뷰다. 좌표·주소·본문·이메일·JWT·공유 토큰은 저장하지 않는다. |
| 내구성 | 응답 처리 전에 `prepared`를 DB에 커밋한다. 기록 시작·완료가 실패하면 HTTP는 데이터 없는 503, 실시간은 연결 중단이다. 강제 종료 뒤 `prepared`를 성공으로 바꾸지 않는다. 메모리 큐·주기 flush는 제거했다. |
| 외부 전송 | OpenAI·Kakao·FCM의 실제 HTTP 호출 전 사전 기록, 응답 후 상태 기록. 캐시 조회·FCM 큐 삽입을 외부 전달로 세지 않는다. 실패한 요청 URL을 오류에 그대로 출력하지 않는다. |
| 검토된 조기 파기 | 관리자 요청 `POST /admin/privacy/requests/:id/access-ledger-erasure`. 검토 중인 erasure/account_closure 요청, 최신 revision, 기간, 근거, 명시 확인과 별도 ON 설정이 필요하다. 계정 범위가 명확한 개인 기록만 삭제한다. 전체 권리 요청을 자동 완료하지 않는다. |
| 삭제 경합 | 계정별 DB 트랜잭션 잠금과 삭제 기간 증빙으로, 파기 전에 시작해 대기하던 요청이 삭제 뒤 과거 기간 기록을 다시 넣지 못한다. 이후 새 조회는 가능하다. |
| 경로 분류 | 296개 라우트를 목록화했고 80개에 기록 규칙을 연결했다. CI에서 누락·삭제·동적 등록을 역검증하고, 기록 ON 시 미분류 HTTP 경로는 응답 전에 차단한다. WebSocket은 별도 메시지별 처리다. |
| 열람 자료 | 호환 뷰에 event/legacy_hourly, 귀속 근거, 처리 상태, 실제 정보주체 미확정을 명시한다. 개인 자동 제공에서 회사·전체 계정·귀속 미상·검증되지 않은 과거 집계를 제외한다. 운영 OFF 상태의 17차 제공 동작은 유지한다. |

0100의 배포 전 이력도 변경하지 않고 0101을 추가했다. 기존 시간별 집계를 건별 사실로 소급 생성하지 않는다. `devices`의 SIM 중심 데이터 귀속이나 하드웨어 인증 기준은 변경하지 않았다.

### 처리 상태의 의미

- `prepared`: 전송 전 사전 기록만 있음. 중단됐거나 처리 중이며 전달 여부 미확정.
- `response_ready`: 서버가 HTTP 성공 응답을 준비함. 브라우저 수신·열람 증거가 아님.
- `denied`: HTTP가 비성공으로 끝남. 위치 제공 성공으로 세지 않음.
- `socket_sent`: 서버 소켓 쓰기 완료. 최종 사용자의 수신·열람 증거가 아님.
- `http_accepted` / `http_rejected`: 외부 서버의 성공 / 비성공 응답.
- `transport_unknown`: 통신 결과를 확인하지 못함. 상대에게 전혀 전달되지 않았다고 단정하지 않음.

외부 호출은 사전 기록 뒤에도 DB 장애가 날 수 있다. 이때 이미 발송한 내용을 취소할 수는 없지만, `prepared`가 남아 전달 여부를 미확정으로 설명한다.

## 검증 결과

빌드 호스트 `etcom-hub-lan`, Rust 1.88 이미지, 내부 전용 Docker 네트워크와 폐기 가능한 PostgreSQL DB에서 실행했다. 실사용자·실위치·외부 발송은 사용하지 않았다.

| 검증 | 결과 |
|---|---|
| fmt / Clippy `-D warnings` / Rust 단위 | 통과 / 통과 / 71 통과·3 ignored |
| 외부 HTTP 격리 시험 | 위 ignored 중 1개를 별도 실행해 통과. 수신 전에 DB에 prepared가 보이고 204·404·연결 실패가 분리됨 |
| 18B 통합 | 10묶음 통과: 건별 기록, SIM 소유 변경, 회사 배정 종료, 공유 삭제, 임의 변경·삭제 거부, DB INSERT/UPDATE 실패, SIGKILL, 실제 서명된 합성 수집→WebSocket, 검토된 철회/재실행 차단, 삭제·조회 경합, 동시 조회, 관리자 열람 |
| 동시 조회 | 12병렬·120요청에서 120행. 중앙값 6.44ms / p95 15.82ms. 사무실 격리 환경 수치로 VPS 용량 보장은 아님 |
| OFF 회귀 | 3묶음 통과. 기록·coverage 생성 없음, 관리자·일반 회원 구분, 17차 미기록 안내 유지 |
| 기존 사실 열람 | 6묶음 통과. 계정·SIM 귀속, 타인 차단, 한도·타임아웃, 제공본 회수 |
| 경로 역검증 | 296개/80개 일치. 신규 중첩 경로, 동적 경로, route_service 등록의 미분류를 각각 검출 |
| OFF 리허설 | 실제 18A 바이너리로 99 → 101 → 99 → 101 통과. 계정·SIM·요청 지문 동일, 새 원장 4개 저장소 모두 비어 있음 |
| 운영 읽기 전용 확인 | API 해시·웹 링크 유지, API 시작 시각 17:16:49 KST 유지, NRestarts 0, health 정상 |

최종 후보 SHA-256: `36522dd395e2d0c024198ad00ec12147c291bf2373ba64ae8607846e4b349712`.

[원본 검증 결과](evidence/location-business-round18b-20261107/validation-summary.json), [통합 결과](evidence/location-business-round18b-20261107/location-access-events-validation.json), [OFF 리허설](evidence/location-business-round18b-20261107/access-events-off-rehearsal.json), [검증 보고서](evidence/location-business-round18b-20261107/report.html), [파일 해시](evidence/location-business-round18b-20261107/SHA256SUMS.txt).

### 시험 중 발견 및 수정

1. Windows 작업 사본의 일부 과거 SQL이 CRLF여서 SQLx가 0065 checksum 불일치를 정확히 차단했다. 과거 SQL을 수정하거나 DB checksum을 덮어쓰지 않았다. `git -c core.autocrlf=false archive`의 원본 바이트로 다시 구성한 뒤 리허설했다. 기본 Windows archive도 core.autocrlf를 따르므로 API 파일 214개를 Git blob과 대조했다. 0085는 원래 CRLF이므로 `.gitattributes` 예외를 유지한다.
2. 모의 HTTP 서버를 중단해도 클라이언트 keep-alive 연결이 살아 실패 조건이 만들어지지 않았다. 시험 클라이언트의 연결 재사용을 없애고 coverage별 결과를 검증하도록 수정한 뒤 통과했다.
3. Kakao HTTP 거부·JSON 해석 오류에도 좌표 쿼리 URL이 오류 문자열로 전파되지 않도록 정리했다.
4. 기록 삭제와 대기 중 요청의 경합을 추가 시험하면서, 삭제 기간에 해당하는 이전 요청을 재삽입하지 않도록 경계 확인을 추가했다.

### 캡처

실제 검증 결과를 읽는 HTML 보고서를 작성했다. **화면 캡처는 미완료**다. 브라우저 도구가 `file:` URL을 보안 정책으로 거부했으며 다른 브라우저·프로토콜로 우회하지 않았다. 보고서를 직접 열어 캡처할 수 있다. 이를 운영 관리자 UI나 운영 ON 증거로 취급하지 않는다.

## 재실행·배포 인계

- 후보 작업 폴더: `/home/etcom-hub/build/gps-ledger18b-20261107`. `out/gps-tracker-api.18b`가 최종 후보, `out/gps-tracker-api.baseline99`가 18A 복구 기준이다.
- API 소스·기존 SQL은 `git -c core.autocrlf=false archive` 기준으로 구성한다. 로컬 SQL 개행을 일괄 변환하거나 이미 적용된 migration을 편집하지 않는다.
- `ops/dev_access_events.sh`를 위 작업 폴더의 `dev18.sh`로 사용한다. `src/gps-tracker-api`, `out`, `test_privacy*.py` 의존 파일과 Python venv가 필요하다. 기존 시험 helper의 컨테이너 접두사 `gps-account-closure-`를 작업 사본에서만 `gps-ledger18b-`로 맞춘다. Docker 네트워크는 internal이어야 하며 검증 스크립트는 실서버 실행을 지원하지 않는다.
- 기본 검사: `python ops/check_location_access_routes.py`, `python ops/test_location_access_routes.py`, `bash dev18.sh api-check`, `bash dev18.sh api-release`.
- ON 시험: `LEDGER=on bash dev18.sh api`; `bash dev18.sh suite test_location_access_events.py`; `bash dev18.sh external-check`. 조기 파기 ON/OFF는 통합 시험이 격리 API에만 설정한다.
- OFF 리허설: **빈 시험 DB와 baseline99 API로 시작**하여 `bash dev18.sh suite rehearse_access_events_off.py`. 그 뒤 OFF 상태에서 `test_location_access_log.py`, `test_privacy_location_facts.py`를 실행한다. 기존 18차 ON 시간집계 시험은 101에서 사용하지 못하도록 가드를 추가했다.
- 99 복구는 새 원장·coverage·파기 증빙·과거 집계가 전부 비어 있을 때만 시험했다. 기록을 켠 뒤에는 원장을 지워 되돌리지 말고 앞으로 수정한다.
- 이 리허설은 운영 배포 스크립트가 아니다. 운영용 스테이징·해시 확인·사전 점검·실패 복구 절차는 별도 작성해야 한다. 운영 환경의 기록·보존·파기 설정은 이번 작업에서 변경하지 않았다.

## 남은 한계와 다음 라운드

1. **19차**: 개인별 관리자 계정·MFA·허용 IP·역할·2인 승인과 DB migration/runtime 역할 분리. 현재 DB 테이블 소유자는 트리거·SECURITY DEFINER 처리기를 바꿀 수 있고 관리자 한 명이 요청 검토와 실행을 할 수 있다. 18B는 이 공격 경계를 해결했다고 주장하지 않는다.
2. 책임자의 보존 기간·철회 범위·보안 로그 구분을 확정해야 한다. 기본 OFF를 자동으로 켜지 않는다. 파기 증빙과 coverage 자체의 보존 정책도 남아 있다.
3. 실제 운전자 정보주체 매핑·회사/공유 자료 귀속·제3자 제공 통보는 22차다. 회사·공유·과거 집계 자료는 개인 파기 처리기로 임의 삭제하지 않는다.
4. 경로 목록은 등록 누락을 잡지만, 기존 handler가 새 위치 필드를 반환하도록 바뀌는 의미적 변화는 코드 검토가 필요하다. 브라우저의 직접 지도/주소 요청, SQL 관리 접속, 별도 레거시 프로세스까지 전부 추적하는 도구가 아니다.
5. DB 쓰기 오류와 프로세스 강제 종료를 실제 주입했지만 VPS 디스크 고갈·전원 손실·복제 복구·장기 고부하 시험은 하지 않았다. 18A 로그 분류기 자체 장애 알림과 과거 raw 로그의 보관/접근 제한 정책도 별도 운영 보완이다.
6. TLS 운영 승격·DB 위치 암호화·동의별 보존 엔진·전용 관리자 PC와 보안 제품 증빙은 20~23차다. 이번 18B 통과로 위치정보사업 전체 요구사항 충족을 선언하지 않는다.
