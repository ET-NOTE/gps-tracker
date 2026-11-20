# 124차 실제 검증 자료

2026-11-14 빌드 호스트 `etcom-hub`의 합성 격리 시험 자료다. 운영 VPS에 접근하거나 운영 데이터에 부하를 준 결과가 아니다. 후보 스키마112→113의 함수 변경과 새 API를 검증한다. 마지막 확인 운영99와의 누적 전환·복구는 이번 검증 범위가 아니다.

## 재현 입력과 결과 해석

- 이전123 API SHA: `1052de1ee68e700b6565e73124e727ef45ee26527c7eb9f196c71efcdd0221f5`.
- 수정124 API SHA: `89293eb52d7c07229e7fdfa594a63aa61282abe14ed1bf5d0a66d21fb3e15bc8`.
- PDF는120차 바이너리를 그대로 사용한다. 웹·펌웨어 변경은 없다.
- 이전·수정본 각각 전용300초2회와 공유300초1회, 총6회를 순서대로 실행한다. 2CPU·8MiB/s·200IOPS, GPS 합계3328MiB, 보호 임시 저장소·swap0·core0을 유지한다.
- 고정 암호화8SIM×31일119040행·714240점과248일 집계를 조회하고, 별도 합성 장치의 현재 시각 서명TLS 수신·health·PDF·파일 정리를 병행한다. 추가 수신은 고정10월 조회 범위 밖이다.
- 공유의 다른 프로젝트·백신은 부담 모사다. warm cache·순차 비교이며 현재3GB 공유 운영VPS 또는 실제 백신 품질의 인수 자료가 아니다.

`statuses`는 최대3회 시도 뒤 최종 응답이다. `attempts`는 재시도를 포함한 실제 HTTP 호출 수다. 성공 응답 지연에는 재시도 대기가 포함되고, 최종429는 성공이 아니다. `per_route.phases`는 성공 응답의 HTTP 시간 합계와 재시도 대기다. 중도 취소된 대기는 완료 표본에 포함하지 않는다. 서로 다른 지표의 p95를 더하지 않는다.

API 계측은 조회 트랜잭션 단위다. 한 HTTP 요청이 여러 트랜잭션을 사용할 수 있고 월간 페이지 순회도 포함하므로 완료 계측 건수와 HTTP 성공 수가 일대일로 같지 않다. `scope_ms`는 연결을 보유한 SQL·결과 전달·애플리케이션 처리·COMMIT 시간이며, 비동기 취소 정리는 제외한다. DB 풀 대기와 실행 허용 대기는 별도다. 공개 자료에는 허용된 숫자·고정 분류만 추출한다.

SQL 계측은 비소유 런타임 DB 역할과 실제 API의 준비된 SQL을 사용한다. 각 경로의 custom/generic 계획을3회씩 실행했다. `gps_open_cell`과 내부 `pgp_sym_decrypt` 시간은 SQL 실행 시간에 이미 포함되며 서로 중첩된다. 강제 generic 계획은 위험 대조군이고, 이전 API의 느린 모든 요청이 그 계획을 사용했다는 증명은 아니다. 임시 쓰기 블록은 누적 작업량으로 잔여 파일이나 최대 메모리와 같지 않다.

## 자료 안내

| 자료 | 확인할 내용 |
|---|---|
| `summary124.json` | 6개 부하·SQL·API 단계별 숫자 요약 |
| `baseline-*-124.json`, `candidate-*-124.json`, `shared-*-124.json` | 고정 길이 부하, 응답·재시도·수신·PDF·정리·자원 표본 |
| `timings124-*.json` | 수정 API의 opt-in 단계별 계측; 원본 로그의 개인정보를 복사하지 않음 |
| `profile124-before.json`, `profile124-after.json` | 실제 SQL 계획48개와 복호화 함수 통계 |
| `query124-equivalence.json`, `query124-final.log` | 80+80개 경계 비교, 키 누락·문맥 불일치의 실제 복호화 거부, rollback |
| `equivalence124-before.json`, `equivalence124-after.json` | 이전/수정28개 HTTP 응답의 의미 일치 |
| `activation124.json`, `migration124.log`, `read-settings124.log` | 실제112→113 적용, 비특권 역할의 읽기 설정과 COMMIT 후 풀 기본값 복원 |
| `fairness124.json`, `cancellation122.json` | 실제 HTTPS 대기·실행 취소·429·자리 회수 |
| `round22*.json`, `test_provision22*.log`, `rights124.log` | 정보주체·동의·철회·SIM·제공 경계 회귀 |
| `final-state122.json`, `verify-final.log` | 이번124 후보 최종 정상/타 계정 조회·수집 거부·잔여 자료 확인 |
| `build-api.log`, `running-source124.json`, `executable124-*.json` | 빌드·소스 바이트·실행 파일 및 health 확인 |
| `environment124.json`, `units/`, `mounts124.txt` | 실제 격리 자원과 서비스·임시 저장소 설정 |
| `cache-cleanup124.json`, `cleanup124.json` | 재생성 가능한 캐시 정리, 시험 자원 제거와 기존 자료 보존 |
| `candidate-manifest124.json` | 재현 후보·의존성·소스·바이너리 해시, activation_ready=false |
| `remote-byte-check.json`, `sha256.json` | 원격 원본 바이트 대조와 최종 파일별 해시 |

XLSX 응답 비교에서는 생성 시각이 달라지는 `docProps/core.xml`만 제외하고 모든 나머지 ZIP 항목을 비교한다. `cancellation122`·`final-state122`는 재사용한 검증기의 파일명이며 이번124 바이너리 결과다. 권리 시험은121차 네이티브 전송 어댑터로 실행하며 실제 TLS 부하와 구분한다. 외부 FCM 발송은 하지 않는다.

첫 fixture 생성은 압축 Timescale 테이블의 `DISABLE TRIGGER` 거부로 실패했다. `profile-trial124-initial-hypertable.log`에 원본을 남긴다. 검증기에서 트랜잭션 안의 경계 메타데이터 트리거 함수만 잠시 대체·복구하도록 고쳤으며 암호화·소유권 트리거를 끄지 않았다. 제품 SQL은 이 오류 때문에 변경하지 않았다.

`memory.peak`·`memory.events`는 cgroup 수명 전체 누적 값이다. 새 OOM 여부는 단계 전후 차이로 확인한다. 시험 인증서는 격리 환경 자체서명이며 운영 공개 인증서 또는 실물LTE 검증이 아니다. 실행 파일은 dump 보호를 풀지 않고 root 소유 바이트·시작 링크·실제 health 릴리스로 확인한다.

공개 증빙에는 자격증명·키·DB 덤프·실제 사용자 위치를 넣지 않는다. 최종 결과와 남은 항목은 [작업 문서](../../operations/location-business-runtime124-20261114.md)를 따른다.
