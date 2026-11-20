# 123차 실제 검증 자료

2026-11-13~14 빌드 호스트 `etcom-hub`의 합성 격리 시험 자료다. 운영 VPS에 배포하거나 운영 데이터에 부하를 준 결과가 아니다. 스키마112 후보를 사용하며 마지막으로 확인한 운영 스키마99는 별개다.

## 재현 입력

- 도구 정본: `ops/build_runtime123.py`, `ops/rehearse_runtime123.py`, `ops/load_runtime123.py`, `ops/verify_runtime123.py`, `ops/run_runtime123.py`, `ops/collect_runtime123.py`, `ops/summarize_runtime123.py`.
- 이전 API: `56912e102bd55db65f253d7f19c409a04e239b8e993f60baead577e51efbf536`.
- 최종123 API: `1052de1ee68e700b6565e73124e727ef45ee26527c7eb9f196c71efcdd0221f5`.
- PDF 처리기는120차와 동일하다. 새 PDF 처리기 또는 새 스키마를 검증했다고 표현하지 않는다.
- 122차 보호 서비스와 데이터 생성기를 재사용한다. 전체2CPU, 읽기/쓰기 각8MiB/s·200IOPS, swap0, core0, 보호 임시 저장소, DB/API/PDF/정리 합계3,328MiB다.
- 전체31일·8SIM의 암호화119,040행/714,240점, 8조회 작업자와 서명TLS 수신·health·PDF·파일 정리를 동시에 실행한다. 이전/수정본 비교는 각300초, 수정본 지속 시험은 전용·공유 각900초다.

## 해석

`statuses`는 최대2회429 재시도 뒤의 최종 응답이다. `attempts`는 최초 호출과 재시도를 모두 센다. 성공 응답의`per_route.latency`는 재시도 대기를 포함한다. 단일 SQL 시간이나 순수 네트워크 왕복 시간과 같지 않다.429는 성공으로 세지 않는다.

같은 시각의 무작위 대조 시험이 아니라 순차 시험이다. DB 캐시와 실행 길이, 무작위 재시도의 차이가 있으므로 작은 수치 차이를 통계적으로 입증된 개선으로 해석하지 않는다. 공유 부하의 다른 서비스와 백신은 압력 모사이며 실제 제품의 업무/탐지 품질을 검증하지 않는다.15분 메모리 관측은 하루 이상 누수 부재의 증명이 아니다.

초기3초 대기 후보는429가 줄어도 페이지/이력 지연이 악화돼 채택하지 않았다. `initial123/`에는 해당900초 결과와 약111초에 의도적으로 중단한 공유 시험을 보존한다. 중단한 시험은 통과 횟수에 넣지 않는다. 최종 후보는250ms 대기다.

`executable123-*.json`은 root 소유 읽기 전용 실행 파일의 해시, 시작 링크, 실제 health의 릴리스 식별자를 함께 확인한다. dump 보호가 `/proc/PID/exe` 접근을 막기 때문에 실행 프로세스 메모리를 읽은 증거로 표현하지 않는다. 이 보호를 풀거나 ptrace 권한을 추가하지 않았다.

`fairness123.json`과`cancellation122.json`은 이번123 바이너리에서 수행한 결과다. 후자의 파일명은 재사용한 검증기 이름이며, 정규 조회2경로와 전체이력 별도 시험으로 구성한다. `final-state122.json`도 이번123 바이너리 최종 검사다. 권리 시험은 네이티브121 전송 어댑터를 사용하며, TLS 부하/수집 거부 시험과 구분한다.

`memory.peak`와`memory.events`는 cgroup 수명 전체의 누적 값이다. 단계별 새 OOM은`before`와`after`의 차이로 판정한다. 정렬 임시 쓰기량은 누적 작업량이며 잔여 평문 파일 크기와 같지 않다. 시험 TLS 인증서는 격리 환경의 자체서명이며 운영 인증서 또는 실물 LTE 시험을 대신하지 않는다.

공개 증빙에는 자격증명·키·DB 덤프·실제 사용자 위치를 포함하지 않는다. 합성 자료라도 실행 자원은 종료 시 제거한다. 원시 파일의 바이트와 해시는 변경 없이 보존하며, 결과 요약과 상세 판정은 [작업 문서](../../operations/location-business-runtime123-20261113.md)에 기록한다.

## 파일 안내

| 자료 | 확인할 내용 |
|---|---|
| `summary123.json` | 이전300초·수정 전용/공유900초의 응답·지연·자원 요약 |
| `baseline-4g.json`, `screen-123.json` | 이전/수정본 각300초 사전 비교 |
| `dedicated-123.json`, `shared-123.json` | 각900초 전체 결과와10초 자원 표본 |
| `equivalence123-before.json`, `equivalence123-after.json` | 28개 조회 응답의 의미 일치 |
| `fairness123.json`, `cancellation122.json` | 실행 자리 분리·대기/실행 취소·429·자리 회수 |
| `round22*.json`, `test_provision22*.log` | 권리·회사·SIM·제공 경계20개 업무 시험군 |
| `final-state122.json`, `verify-final.log` | 최종 정상/타 계정 조회·수집 거부·평문/잔여 자료 확인 |
| `build-api.log`, `running-source123.json`, `executable123-*.json` | 빌드 검사·소스·실행 파일 확인 |
| `environment123.json`, `units/`, `mounts123.txt` | 실제 시험 자원 한도·서비스·보호 저장 설정 |
| `candidate-manifest123.json`, `cleanup123.json` | 보존 후보·해시·시험 자원 정리·기존 자료 보존 |
| `initial123/`, `rights-initial-*.log`, `initial-proc-attestation-denied.log` | 채택하지 않은 후보와 도구 실패의 원본 |
| `remote-byte-check.json` | 빌드 호스트 원본66파일과 로컬 증빙의 SHA-256 대조 |
| `sha256.json` | 이 디렉터리 최종 파일별 해시(목록 자체 제외) |

`rights-initial-restore-failure.log`는 권리 시험 후 시험 정책을 복구하는 순서 오류다. 제품은 정책이 꺼진 상태의 시작을 거부했으며, 도구의 복구 순서를 고친 뒤20개 시험군과 최종 확인을 다시 통과했다. 실패 로그를 최종 제품 실패 또는 통과 증빙으로 혼용하지 않는다.
