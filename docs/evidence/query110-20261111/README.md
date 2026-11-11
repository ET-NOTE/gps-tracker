# 110차 검증 증빙

운영 사용자 자료가 없는 **합성·격리 검증**이다. `verification-report.png`는 실제 결과 JSON을 렌더링한 보고서 캡처이며 운영 관리자 화면이 아니다. 검증 범위·한계·재현은 [110차 문서](../../operations/location-business-query110-20261111.md)를 따른다.

| 파일 | 의미 |
|---|---|
| `validation-summary.json` | 최종 판정·원본 결과 연결 |
| `baseline109.json`, `final110.json` | 디스크 기반 동일 자료의 단독 SQL 측정 |
| `narrow-context.json`, `bounds110.json`, `backfill.json` | 개발 중 단계별 관측. 최종 성능 판정은 `final110.json` 사용 |
| `baseline-functions.json`, `equivalence110.json` | 기존109 SQL 비교 대상과585개 비교 결과 |
| `dataset110.json` |283,001행 전체 반환값 해시 및 실제HTTP 권한/빈값 검사 |
| `compression110.json` | 평문/암호화 기존 압축chunk 전환과 시각 보정 |
| `bounds-index-plan.json` | 순차 스캔 OFF로 확인한 인덱스 사용 가능 경로. 일반 실행 계획/응답 보장 아님 |
| `load110-4.json`, `load110-8.json` | 실제HTTP 혼합 동시 요청·별도 암호화 DB INSERT·health. 실물LTE 수집 부하 아님 |
| `cumulative110.json`, `protected-restore110.json` | 실제99→110·암호화·중단/재개·전체복원·최신 checkpoint 검사 |
| `regressions110.json`, `business-regressions.json`, `additional110-tests.json` | 개인정보 경계·기존 업무·109 동의 판정기·별도Rust 시험 |
| `api-check-final.log`, `api-release-final.log` | 최종 API 소스의 format/Clippy/기본81시험 및 릴리스 빌드 |
| `attempt1-check110.log` | 소스가 컨테이너 밖으로 연결된 최초 시험환경 오류. 준비 도구 수정 후 깨끗한99부터 재실행 |
| `source-manifest.json`, `build-input-manifest.json`, `code-provenance.json` | 확정Git 입력·빌드 당시 입력·API/migration 동일성 및 도구 추가 내역 |
| `candidate-manifest.json`, `package-verification.json` | 운영 미배포 후보 파일/압축파일 검증. `activation_ready=false` |
| `cleanup-query110.json`, `cleanup110.json` | 고정된 시험 자원·시험 키/자격증명 정리 |
| `SHA256SUMS` | 이 폴더 원본 바이트의SHA-256. 해시 파일 자체는 제외 |

기간/좌표/계정은 합성 자료다. 운영 키·토큰·DSN·DB 덤프·사용자 파일은 포함하지 않는다. 원본 로그의 고정 시험용 인증 문자열은 외부 접속이 없는 폐기된 시험 DB용이며 운영 자격증명이 아니다.
