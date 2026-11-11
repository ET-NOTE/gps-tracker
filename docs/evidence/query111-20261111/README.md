# 111차 암호화 위치 페이지 — 격리 검증 증빙

2026-11-11, 합성 자료를 사용한 실제 실행 결과다. 운영 서비스 화면이나 운영 인수 증빙이 아니다. 이번 라운드에서는 운영 VPS·실제 회원/위치·SIM·키를 조회하거나 변경하지 않았다.

- 확정 소스: `a223ff04ab948da69ef95179cd9d6185433992fc`
- API SHA-256: `37de345292ebb75e8ef733192155dad1cec0b0744cbbd59dc12fe432b720b3e9`
- 후보 archive SHA-256: `2b22794ef68bd50f8214d208cd7d40a8618de6160278bca79e0a869cae46b7b2`
- 후보 스키마111, `activation_ready=false` / 마지막 확인된 운영 스키마99
- [라운드 설명·범위·재실행](../../operations/location-business-query111-20261111.md)

| 파일 | 확인할 내용 |
|---|---|
| `validation-summary.json` | 최종 결과와 검증 한계 |
| `verification-report.png`, `.html`, `capture-report.cjs` | 실제 JSON 측정값으로 만든 격리 검증 보고서와 재생성 도구 |
| `baseline110-http8.json`, `load111-8.json`, `load111-16.json` | 같은 조건의 실제 API 응답·오류·암호화 쓰기·상태 확인 |
| `connection-budget.json` | 격리 DB25→50 수정, API조회10+보호16 유지. 운영에 적용하지 않음 |
| `page-equivalence111.json`, `page-dataset111.json` | 2,230개 비교와 전체283,001점/57페이지의 모든 반환 열 일치 |
| `http-pages111.json`, `page-snapshot111.json`, `compression111.json` | 실제 응답·커서 호환, 동시 쓰기 스냅샷, 압축 자료 전환 |
| `cumulative111.json`, `protected-restore111.json`, `file-owner111.json` | 99→111 중단/재개·암호화·전체 복원·철회/파기/중지·파일 소유권 |
| `regressions111.json`, `business-regressions.json`, `additional111-tests.json` | 기존 기능과 동의/철회/외부 경계 회귀 |
| `ancestry109-regression.json`, `mapping109-queries.json` | 독립 동의 판정기·매핑 성능 기준 |
| `api-check-final.log`, `api-release-final.log`, `external-all.log`, `external-boundary.log` | 최종 빌드·81개 단위 시험·별도7개 DB/외부 경계 시험 |
| `candidate-manifest.json`, `package-verification.json`, `code-provenance.json`, `source-manifest.json` | 524개 Git 원본 입력·컴파일 입력·75개 후보 파일과 archive 대조 |
| `cleanup-query111.json`, `cleanup111.json`, `evidence-secret-check.json` | 고정 합성 시험 자원/키 정리와 비밀값 검사 |

`attempt*`, `recheck-load.log` 등 첫 실패 기록도 함께 보관했다. 페이지 인자형 불일치, DB25 연결 부족, 삭제된 시험 API의 잔여 세션 잠금,110 바이너리의111 스키마 거부는 라운드 문서의 수정·재검증 결과와 함께 읽는다. 과거/중간 빌드 로그를 최종 결과로 오해하지 않는다.

HTTP 부하는 디스크 기반 격리 DB(2CPU/1,500MiB, ext4/NVMe)와 API(2CPU/550MiB), 최근/하루/월간5경로 각20%의 첫500건 warm-cache 시험이다. 누적 복원 시험은 tmpfs다. 직접 암호화 DB INSERT는 LTE 인증 수집 API의 처리량 검증이 아니다. 전체 월 이력/통계·실제 VPS 연결 예산/I/O·지속 부하는 남는다.

생성된 실행 보조 도구는 이번 합성 환경의 경로를 담고 있다. 운영 배포 도구로 그대로 실행하지 않는다. 키·자격증명·DB덤프·사용자 파일·바이너리는 이 증빙 폴더에 포함하지 않는다. `SHA256SUMS`는 그 파일 자신을 제외한 모든 파일의 원본 바이트를 검증한다.
