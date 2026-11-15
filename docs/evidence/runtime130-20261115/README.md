# 130차 실제 검증 증거

합성 내부망에서 실행한 실제 출력이며 운영/실물 단말기 증거가 아니다. **이번 합성 조건의 8대×1Hz 무누락 기준 통과·운영 미배포**. [결과와 한계](../../operations/location-business-runtime130-20261115.md).

- `summary130.json`: 세 조건의 전송·조회·구간 계측. `*-130.json`은 각 요청·자원 원본, `audit130-*.json`은 미발송/미계상과 실제DB 카운터 대조다.
- `ingest-profile130-*.json`: 정확한 API InvocationID·구간별 숫자·요청 원본. 부하 종료 직후 저장하며 무부하 조회와 구분한다.
- `guards130-baseline.json`, `guards130-candidate.json`: 통계 예약 실패의 위치1→0행, 서명/재시도/중지/잠금/추가 입력경로 검증.
- `build130-*.log`, `installed130-*.json`, `source130-*.json`: 실제 빌드·설치·소스. `candidate`는 캐시 재사용으로 기각, **candidate-r1만 수정판**이다. `read-settings130.log`는 제한계정의 실제DB 테스트다.
- `commands.jsonl`과 시각별 `.log`: 성공뿐 아니라 용량 실패·시험 가정 수정·기각 빌드 실행도 보존한다. 테스트오류를 제품 보호 완화로 해결하지 않았다.
- `rights124.log`, `cancellation122.json`, `cleanup-contention122.json`, `reference-guard122.json`, `final130.json`, `final-state122.json`: 권리·취소·정리·최종 상태. 실제 파일 목록은 아래 해시 목록을 따른다.
- `durability130.json`과 `adapters/durability130.py`: 실제 실행DB역할의 내구성 설정on을 확인한 읽기 전용 출력/실행 소스.
- `running-source130.json`, `isolation130.json`, `units/`, `api130-journal.log`, `db130-journal.log`: 실행 소스·제한·서비스 원본. 운영 변경 없음.
- `remote-byte-check.json`: 원격 원본95개 크기/SHA 및 fixture키/비밀번호 검사. 다운로드 아카이브 SHA `5f0e0d65e1d6a516d79f6acb25d0f3b1b848ef74ce99728bd617349ae53ff317`.
- `host-after.json`, `cleanup-byte-check.json`: 21:07:09 KST 시험자원 제거, 기존868파일/다른32컨테이너 불변, 여유29.545GiB.
- `candidate-manifest130.json`, `package-byte-check.json`: `/home/etcom-hub/build/gps-runtime130-20261115/candidate-runtime130-20261115-r1.tar.gz`, SHA `0759789c07f40a471e19a7f0b477be333f714b64e4dad6393970b95a32ef7f76`, 19,517,991바이트/971파일. 기준·수정 소스/바이너리와 의존 해시, 전체 재읽기 검증. 기준판의rustfmt 선언순서1개 차이는 `baseline_source_adjustments`와 Git입력/실제빌드바이트로 따로 보존한다. 수정판245소스는 실제빌드해시와 정확히 같다. 운영 설치기 아님.

수정 소스 `e4c2dc5b4203fa32f17832c07a1b6c927b299d76`, 기준 `fe5a5d39970db8b23fb0a220e29427a7b061f137`. API `42d3e8768c66d280bc623fe7c3eb9a1a24bd63cddf635413a339886ec5e8bb59`. 모든 파일의 Git바이트는 [sha256.json](sha256.json)에 기록한다. APIdebug 수신 계측에는 식별자/좌표/본문/키를 추가하지 않았으며 원본 로그의 기존 식별자·위치는 합성 시험 데이터다.
