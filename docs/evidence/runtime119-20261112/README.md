# 119차 실제 검증 기록 — 2026-11-12

운영은 읽기 전용 관측만 했다. 나머지는 빌드 호스트의 합성 계정·SIM·문서·좌표를 쓰는 격리 시험이다. 운영 설치·규제 요건 충족·실물LTE 완료 증빙으로 사용하지 않는다. 원본 파일 해시는 [sha256.json](sha256.json)에 있다.

| 확인 항목 | 기록 |
|---|---|
| API84·PDF5 단위시험/정적검사/빌드 | api-build.log, pdf-build-retry.log |
| 99→112 13변경·중단/재개·전체 암호화 복원 | cumulative-cumulative119.json, cumulative-rehearse_cumulative119.py.log |
| 동의/철회·법인 통합8단계, 업무8시험군 | cumulative-regressions119.json, cumulative-business-regressions.json 및 각 log |
| 오래된 백업 권리 체크포인트 복원 | cumulative-protected-restore119.json |
|32,000행 매핑 이력 | cumulative-mapping-history116.json, cumulative-mapping-history-plan.json |
| API/웹 실패3구간 복구 | cumulative-release116.json |
| 시작 전 거부·프로세스·정적PDF·재시작9검사 | cumulative-process119.json |
| 실제 별도 PDF 서비스34요청·보호 실패/복구 | pdf-service119.json, receipt-pdf-validation.json |
| 8SIM×31일·8작업자·300초·TLS1.2 | monthly-fixture.json, monthly-protected-corrected.json |
| 6법인경로·취소·중지/철회16결과 | monthly-business-tests.json |
| 임시경로·원장·swap 등 장애20항목 | monthly-faults.json |
|28정상조회, 타계정 비공개 단언8회 | monthly-probe.json, monthly-benchmark_runtime119.py-probe.log (타계정 개별 응답코드는 미기록) |
| 최종 평문0·작업잔여0·cgroup/image/IO한도 | final-state119.json |
| 시험 이미지와 최종 도구 소스의 proxy 추가 차이 | image-source119.json |
| 운영 스키마99·자원·시작시각·PDF최대연결 | production-inventory.json |
| 후보700파일+manifest·해시 | package119.json |
| 테스트 컨테이너·내부망·키·저장소 정리 | cleanup119.json |

실패도 보존: `checksum-rejected-api.log`는117 후보의108번 바이트 해시 불일치, `recovery-1500m-failure119.json`과 DB로그는1.5GiB 전체 RAM 복구 실패다. 이후4GiB 복구 시험과1.5GiB 월간 부하 성공을 섞지 않는다. PDF 초기 소켓 그룹 미정의/BPF 경고, 릴리스 시험 초기 API 미시작 출력도 포함한다. 시험 원본의116/115 파일명·문구가 일부 남아 있지만119실행이며 실제 API/PDF 해시로 구분한다.

`production-inventory.json`의 관리자 관측은 별도이고 계정 비밀번호·키·조회 SQL본문은 수집하지 않았다. 일부 실패 스택에는 격리 fixture의 무효한 합성DSN/JWT설정이 나타날 수 있으며 실제 자격증명이 아니다. 원본 데이터 파일·시험키는 정리했다.

한계와 다음 순서는 [119차 문서](../../operations/location-business-runtime119-20261112.md)와 [인계 문서](../../operations/HANDOFF.md)를 따른다.
