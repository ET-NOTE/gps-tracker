# 122차 실제 관측·격리 시험 증빙

이 폴더는 실제 출력과 측정 자료다. 합성 계정·SIM·위치·PDF·파일만 부하 시험에 사용했다. 다른 프로젝트와 백신의 부담은 모사 작업이며 실제 서비스 부하 인수나 백신 검사 증빙이 아니다. 운영 VPS는 읽기 전용으로 관측했고 설정을 변경하지 않았다.

| 파일 | 범위 |
|---|---|
| `production-before.json`, `production-after.json`, `production-comparison.json` | 각각60초 운영 RAM·역할별 접속·설정·I/O·서비스 시각 관측과 불변 대조. 쿼리 본문·비밀값 미수집 |
| `budget122.json` | 현재 서버의 인수 불가 판단,4/6GiB 후보 예산, 상한과 측정값의 구분 |
| `budget-tests122.log`, `summary122.json`, `sha256.json` | 예산 계산 4검사, 원본 부하 결과에서 추출한 요약·cgroup 증분, 파일별 바이트 해시 |
| `seed122.json`, `fixture.json`, `mappings.json`, `repair.json` | 8SIM·31일·119,040암호화행·714,240점·개인/법인 매핑·248일 집계 생성 |
| `dedicated-4g.json`, `shared-6g.json`, `dedicated.log`, `shared.log` | 각300초8조회 작업자+서명TLS수신+실제PDF+정리,429/성공 구분, 지연·전체18페이지 순회·자원·DB I/O |
| `cleanup-contention122.json`, `reference-guard122.json` | psycopg2/3 잠금 충돌 롤백·대기열/파일 보존·재실행, 동시 참조 생성 후 삭제 금지 |
| `connection-boundary122.json` | 타 프로젝트 모사24접속,25번째 거부, 운영 접속 가능 |
| `cancellation122.json` | TLS프록시를 통한3조회 경로의429·취소·DB작업 회수·슬롯 재사용 |
| `final-state122.json` | 최종28조회·타계정8거부·TLS/장치 인증 거부·물리 평문0·잔여 정리/이미지/처리기/열린 거래0 |
| `environment122.json`, `units/`, `mounts122.txt`, `running-source122.json` | 실제 컨테이너 자원/네트워크, 실제 서비스·임시경로, 실행 소스 해시 |
| `candidate-manifest122.json`, `cleanup122.json` | 작은 재현 도구 묶음·원본 대조, 시험 환경 정리·기존 컨테이너/이전 산출물 보존 확인 |
| `seed-initial-failure.log`, `dedicated-initial-failure.*` | 서비스 최초 초기화와 파일 정리 잠금 충돌의 초기 실패. 최종 통과 결과 아님 |
| `dedicated384-oom.*`, `dedicated384-api-journal.log` | API384MiB 초기 한도가 OOM으로 종료된 미통과 시험 |

주의: `memory.peak`와`memory.events`는 해당cgroup의 수명 동안 누적된다. GPS묶음/컨테이너에는 초기384MiB 실패의OOM1건이 남아 있다. 수정 후 각300초 시험의`before→after` 증가분과 서비스별 상한을 대조하며 이를 새로운OOM으로 세거나 초기 실패를 지우지 않는다. DB의`max` 이벤트는 한도 부근에서의 회수도 포함하며OOM과 다르다. 정렬 임시바이트는 반복 작업의 누적 쓰기량이고 디스크 잔여 평문량이 아니다.

시험 프록시 인증서는 격리 환경의 자체서명이다. 운영 공개 인증서·실물LTE TLS 검증의 대체 자료가 아니다. DB는 워밍업된 상태이며 실제VPS의 콜드캐시 I/O·장기 운영 품질을 보장하지 않는다. 실패를 포함한 실제 결과와 해시는 그대로 보존하고 비밀키·환경설정·DB덤프·실사용자 자료는 포함하지 않는다.

상세 판단은 [122차 문서](../../operations/location-business-runtime122-20261113.md)와 [인계](../../operations/HANDOFF.md)를 따른다.
