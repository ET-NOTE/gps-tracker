# 115차 검증 증빙

운영 전환 전, 내부 네트워크의 합성 자료로 수행한 실제 실행 결과다. 운영 사용자 자료나 실제 LTE 단말기 성능 측정이 아니다. 운영 서버에는 읽기 전용 자원 확인만 했다.

- `sql-comparison.json`: 기존 월간 SQL의 제한 시간 도달과 수정 SQL의 실행 시간.
- `sql-exact-oracle.json`: 8개 SIM·714,240점의 기존 일간 결과 합계와 수정 월간 결과 비교.
- `business-tests.json`: Fleet 리포트·다운로드·지도·집계의 제한, TLS 연결 종료 취소, 이용 중지와 매핑 철회.
- `single.json`, `dual.json`, `io-limited.json`: 요청별 결과를 합산한 부하 결과, SIM별 성공·제한 수, 자원 표본, TLS 수신과 실제 저장 건수.
- `load-summary.json`: 위 세 결과의 주요 항목을 뽑은 요약. 원본의 429를 성공으로 바꾸지 않는다.
- `io-limits.json`, `io-cgroup*.json`: 인공 디스크 제한 설정과 실제 cgroup 계수. 실제 VPS I/O 측정과 구분한다.
- `repair.json`: 5초 poll을 쓰는 가속 누락 집계 복구 관측. 운영 기본300초의 완료 시간은 아니다.
- `api-check.log`, `api-release.log`, `web-*.log`: 고정 빌드 환경의 검사·시험·빌드 출력.
- `source-verification.json`, `candidate-manifest.json`: Git 소스 대조와 운영 미활성 후보의 파일 해시.
- `final-state.json`, `cleanup.json`: 종료 시 암호화 원본·잔여 조회 확인과 전용 시험 자원·키 정리 결과.
- `production-resources-readonly.txt`: 별도 운영 VPS 자원 확인. 운영 배포 증빙이 아니다.
- `evidence-manifest.json`: 빌드 호스트에서 복사한 원본 파일들의 SHA-256. 이 README와 별도 운영 확인 파일은 대상에서 제외된다.

세부 판정과 제한은 [115차 문서](../../operations/location-business-query115-20261111.md)를 따른다. 초기 구성 실패는 문서에 별도로 남겼으며 최종 통과 건수에 합산하지 않는다. 키·토큰·DB 접속 비밀번호와 원본 시험 DB는 이 폴더에 포함하지 않는다.
