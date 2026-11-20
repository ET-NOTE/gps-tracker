# 22C — 제공 통보 대기열 처리량·경보·부하 검증

2026-11-08. `codex/location-business-prep` / draft PR #248. 운영은 변경하지 않았다. 마지막 확인된 운영 기준은 18A/schema99이며, 이번 후보는 **schema107**이다. 구현·격리 검증·후보 준비를 완료했다. 실제 FCM·메일을 보내지 않고 내부 Docker·합성 계정·로컬 모의 전송 서버에서 검증했다. 후보를 운영에 그대로 올리거나 자동 파기를 켜는 절차가 아니다.

## 변경 사항

- 기존 5초/1건 직렬 처리에서 `GPS_NOTICE_WORKERS=4`의 제한된 병렬 워커로 전환했다. 설정 범위는 1~4이며, 여러 API 프로세스도 같은 DB의 100ms 간격 예약을 공유한다. DB가 허용하는 작업 시작은 총 초당 10건으로 제한하고 유휴 시간의 할당량을 누적하지 않는다. OAuth·스케줄링 지연으로 실제 HTTP 시작은 모일 수 있으므로 엄격한 네트워크 초당 요청 수나 FCM 할당량 보장으로 해석하지 않는다. 이번 모의 시험의 1초 구간 최대 HTTP 시작은 아래에 별도로 기록했다.
- 처리 완료 후 100ms, 전송 제한 대기 25ms, 빈 큐/공유 오류 대기 1초, 정책 OFF·발송 설정 없음 5초로 구분한다. 처음 시험에서 처리하지 못한 경우의 대기를 모두 250ms로 둔 구현이 1,200건/240초 기준에 실패해, 제한 대기와 유휴 대기를 분리했다. 첫 실패 로그도 보관한다.
- 기존 `FOR UPDATE SKIP LOCKED`·90초 lease와 영속 재시도 상태를 유지한다. 토큰·정책·정보주체 계정 제한을 발송 직전에 다시 잠그고 확인한다. 전체 발송 시한 50초에는 DB 대기·OAuth·HTTP가 포함된다. 외부 전송 동안 열린 DB 연결은 워커 수로 제한된다.
- 429/503·전송/인증 장애는 DB에 공유 대기시간을 저장한다. `Retry-After`를 반영하며 60초~24시간으로 제한한다. 이미 시작된 요청은 최대 워커 수만큼 남을 수 있다. 오래된 lease의 완료는 다른 lease의 상태나 공유 대기시간을 바꾸지 못한다.
- 최대 10회 시도 후 자동 재시도를 끝내고 검토 대기로 남긴다. 정책 OFF·수신 토큰 없음은 성공으로 기록하지 않는다. 기존 건별 제공 기록을 합치거나 삭제하지 않는다. 영구 오류·토큰 폐기·결과 미상은 운영자가 구별해서 처리해야 한다.
- HTTP 전송 뒤 DB 확정 전 프로세스가 죽으면 재시도 때 중복 통보될 수 있다. **at-least-once이며 정확히 1회 발송을 보장하지 않는다.** 고정 notice ID와 Android notification tag를 쓰지만 휴대폰 도착/읽음 확인을 대신하지 않는다.

`0107_subject_queue.sql`은 운영 상태 singleton과 대기·시도시각 인덱스만 추가한다. 기존 원장·정책·실제 운전자 매핑·SIM 귀속을 바꾸지 않는다. API runtime은 singleton의 SELECT/UPDATE만 가능하고 INSERT/DELETE는 금지한다. 증빙 시도 행은 여전히 append-only다.

## 상태 화면과 감시

관리자 보안 화면에 **제공 통보 처리 상태**를 추가했다. `GET /admin/security/notice-queue`는 개인정보 없는 집계만 반환하고 `Cache-Control: no-store`를 사용한다(19차 보안 미들웨어 적용 시 `no-store, private`). 19차 보안이 활성화된 환경에서 책임자/관리자의 MFA·허용 IP를 요구하며 일반회원·취급자는 거부한다. 상태는 30초마다 갱신하며 조회 실패 시 이전 정상값을 지워 장애를 표시한다.

| 조건 | 경보 |
|---|---|
| 워커 응답이 60초 초과 | 긴급 |
| 발송 ON인데 FCM 설정 없음 | 긴급 |
| 가장 오래된 대기 5분/15분 이상 | 주의/긴급 |
| 검토 대기·lease 만료·15분 이상 미확정 제공 | 주의 |
| 공유 대기 중 또는 5분간 20회 이상 시도 중 실패 50% 이상 | 주의 |
| 발송 OFF인데 대기 있음 | 주의, 발송 꺼짐 표시 |

새 설치 직후의 무한대 초기값을 시간 차이로 빼면서 상태 조회가 실패하던 문제도 수정했다. 대기 중인 경우에만 남은 시간을 계산하며, 신규 마이그레이션 기본값을 넣은 API/DB 검증을 유지한다.

SQL은 API와 독립 점검에서 같은 `gps-tracker-api/sql/subject_queue_health.sql`을 사용한다. 쿼리는 2초 제한이며 실패를 정상 0건으로 바꾸지 않는다. 프로세스 내부 경보는 상태 변경/복구 시 기록하고 지속 오류는 15분마다 다시 기록한다. 토큰·좌표·개별회원·provider 응답 본문은 경보에 넣지 않는다.

`ops/notice_queue_probe.py`는 별도 SELECT 전용 DB 계정으로 API가 멈춘 상태에서도 점검한다. 비공개 자격증명 파일(600), readonly 트랜잭션, 실패 시 exit2를 사용한다. `ops/gps_watch.py`의 새 `notice_queue_ssh` 옵션은 기존 외부 감시의 3회 연속 실패/1시간 반복/2회 정상 복구 흐름에 연결한다. 기본값은 빈 값으로 OFF이며 현재 운영 Kuma·메일 감시는 변경하지 않았다.

운영에 연결할 때는 다음 구성이 필요하다.

1. VPS에 전용 감시 계정·전용 SSH 키를 두고 서버측 `authorized_keys`에서 읽기 전용 probe만 실행하는 forced command를 고정한다. 셸·포트포워딩·PTY는 허용하지 않는다. API 실행 계정이나 개발자 관리 계정을 재사용하지 않는다.
2. DB 권한은 `location_provision_notices`, `location_notice_attempts`, `location_subject_policy`, `location_notice_worker`의 SELECT만 부여한다. 자격증명은 repo/캡처에 넣지 않는다. 후보에는 SQL과 probe만 포함하며 실제 계정을 만들지 않는다.
3. 외부 호스트에 known_hosts를 확인하고 전용 SSH 별칭을 설정한 뒤 `notice_queue_ssh`에 넣는다. 출력 시각 120초 초과·알 수 없는 경보·SSH/DB 실패는 장애로 취급한다. stderr/미확인 본문은 외부 알림에 싣지 않는다.
4. 운영 후보 적용 뒤 `--expect-running`과 실제 발송 정책을 대조하고, 워커 중단/DB 조회 실패/복구 알림의 실제 수신을 인수한다. 이번 시험은 모의 SSH와 기존 로컬 메일 리허설이며 운영 대기열 메일 수신 완료로 주장하지 않는다.

## 검증과 증빙

| 검증 | 최종 결과 |
|---|---|
| 부하 | 합성 1,200건 / 130.49초, 평균 9.20건/초. 정상 응답 1,200건 모두 고유 처리 |
| 제한 | 1초 구간 최대 HTTP 시작 10건, 동시 모의 HTTP 최대 3건 |
| 함께 실행한 API health | 912회 중 실패 0, p95 0.97ms, 최대 10.75ms |
| Rust | 81개 단위 시험 + 별도 외부/실시간/대기열6개, fmt·Clippy 통과 |
| 웹 | 238개, 루트/기존 하위경로 빌드 통과. 기존 큰 chunk 경고 유지 |
| 이전 기능 회귀 | 22차 일반/암호화 7묶음씩, 22B 일반/암호화 7묶음씩, 복원·106→107 업그레이드·기존 업무/권리 8시험군 통과 |
| 관리자 API·독립 점검 | MFA·역할·IP·캐시 차단, API 중단·FCM 미설정·DB 실패 감지, SELECT 전용 및 runtime 금지 권한 통과 |
| 라우트 | 317개 중 원장 대상80개 대조, 신규 경로 누락 거부 3건 통과 |
| 외부 감시 | 모의 SSH 장애/복구·출력 검증 통과. 로컬 HTTP/SMTP/설치 리허설 9단계 통과 |

최종 수치·산출물은 [검증 요약](../evidence/provision22c-20261108/validation-summary.json)과 [후보 manifest](../evidence/provision22c-20261108/candidate-manifest.json)에 기록한다.

- [PC 상태](../evidence/provision22c-20261108/queue-desktop.png) · [모바일 상태](../evidence/provision22c-20261108/queue-mobile.png)
- [복구](../evidence/provision22c-20261108/queue-recovered.png) · [조회 실패](../evidence/provision22c-20261108/queue-unavailable.png)

캡처는 실제 React 컴포넌트에 합성 API를 연결했고 화면 상단에 **격리 검증·운영 증빙 아님**을 명시했다. 1280px/390px에서 가로 넘침·콘솔 오류와 장애 후 이전 정상값 잔류를 확인한다. 운영 캡처나 실제 스마트폰 FCM 수신 화면이 아니다.

부하 시험은 모의 provider 200ms 응답·1,200건·2 DB 풀/8 워커로 두 API 인스턴스에 해당하는 공유 DB 경합을 시험한다. 실제 OS 프로세스 두 개를 구동한 시험은 아니며, 중단 복구는 발송 중 작업을 취소한 뒤 lease를 만료시켜 확인했다. 동시 API health는 같은 DB의 SELECT 1까지 확인하지만 복잡한 운행 집계나 운영 VPS의 디스크 경합 전체를 대표하지 않는다. 모의 발송 부하는 시험 DB 소유 계정을 사용하고, 관리자 API/암호화/권한 회귀는 별도의 비소유 runtime 계정에서 검증한다.

## 후보 산출물

소스 커밋 `02df67904949aa34d525734928750a6b7d4702e5`. API SHA-256 `43b80c5e73668d3d16c2f7e50cdae0e5f5924e0bcc36c1a52cd230145b27775c`. 후보는 빌드 호스트 `/home/etcom-hub/build/gps-provision22-20261108c/candidate-provision22c-20261108-r1.tar.gz`에 보관했다. 압축파일 SHA-256 `37fcd1172f17eb52860434af02aee3388a555652ea8023d4821c6711b69e7b31`이며, Git 기준 소스797개·후보70파일의 해시를 대조했다. [패키지 대조](../evidence/provision22c-20261108/package-verification.json)와 [증빙 해시](../evidence/provision22c-20261108/SHA256SUMS.txt)를 확인한다.

시험 컨테이너2개·내부 네트워크·tmpfs DB·임시 저장소·시험 키/runtime/감시 자격증명과 로컬 검수 서버를 정리했다. 후보와 검증 기록은 보존했다.

## 재실행 및 인계

빌드 호스트 작업 경로는 `/home/etcom-hub/build/gps-provision22-20261108c`다. Rust 1.88/Node 22.22.2 고정 이미지를 사용하며 로컬 Windows 실행을 검증 기준으로 삼지 않는다.

1. `source.tar.gz`/`source-manifest.json`을 대조한다. 원본 마이그레이션의 바이트는 바꾸지 않는다.
2. `ops/dev_provision22c.sh`를 작업 폴더의 `dev22.sh`로 복사한다. `api-check`, `api-release`, `up`을 순서대로 실행한다. 이 환경은 내부 Docker 네트워크·tmpfs DB·APP_ENV=test이며 실제 FCM 키가 없다.
3. `run_notice22c_load.py`와 `run_provision22c_checks.py`를 작업 폴더에 두고 각각 `bash dev22.sh suite ...`로 실행한다. 이전 22차 fixture/python-deps, 16차 PDF 처리기, 고정 해시의 22B API가 필요하다.
4. 웹 시험과 루트/기존 하위 경로 빌드, `test_notice_queue_watch.py`, `rehearse_gps_watch.py`를 실행한다. UI fixture는 검수 후 웹 루트에서 제거하고 증빙 폴더에만 보관한다.
5. `stage_provision22c.py --job ... --commit ...`는 검증 API·소스·schema107·부하·경보·업무 8시험군이 일치해야 후보를 만든다. 기존 후보는 덮어쓰지 않는다. 후보는 키·DB 사본·업로드·PDF 서비스 교체 파일을 포함하지 않는다.
6. 시험 컨테이너·네트워크·키·runtime/monitor 자격증명·임시 저장소를 정리한다. 증빙과 후보는 보존한다.

## 남은 운영 인수

실제 FCM 휴대폰 도착·알림 진입·대체 채널, 검토 대기 처리 정책, 담당자의 통보/동의 문안, 전용 감시 계정과 실제 장애 메일 인수, 누적 99→107 운영 규모 보호 리허설은 남아 있다. 18B~22B의 정책·키 보관·checkpoint·관리자 PC/IP·실물 TLS/수집 중지/24시간 절전 조건도 유지한다. 다음 기술 항목은 미연결 매핑 정정·재동의/변경·외부 제공 경계이며, 이번 통보 처리량 검증과 구분한다. **후보 `activation_ready=false`, 운영·실제 통보 OFF.**
