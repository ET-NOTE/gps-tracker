# 112차 전체 월간 이력·집계 / 지속 부하 검증 증빙

이 폴더는 합성 자료를 사용한 격리 시험의 실제 결과다. 운영 배포·실제 LTE·운영 보안 화면의 증빙이 아니다. `verification-report.png`는 저장된 측정값을 읽기 쉽게 렌더링한 보고서 캡처다.

- `validation-summary.json`: 완료 범위와 한계. 운영 미배포/activation_ready=false.
- `baseline111-full-month.json`, `final112-full-month.json`, 해당 `*-plan.json`: 전체283,001행의 모든 열3회 조회·해시·실행계획/임시I/O.
- `final112-sustained.json`, `stress112-sustained.json`: 8작업자900초/16작업자300초. 성공 응답·429 재시도 안내·오류를 구분한 원시 시각/지연/자원 측정. 서명TLS1.2 수집은 실제API 경로이며 실물LTE가 아니다.
- `baseline111-sustained.json`, `candidate112-preflight-sustained.json`, `attempt-*`: 실패했던 비교/수정 전 시험. 삭제하거나 최종 성공 수치에 섞지 않았다.
- `equivalence112.json`, `projection112.json`, `compression112.json`: 독립 기존 함수/뷰 기준, 인증 문맥/부동소수점·시간대·압축 자료.
- `catchup112.json`: 중단된 기존 집계를 영속 재집계 대기열로 보충한 실제 워커 기록. 누락일 자동 재개를 새로 구현했다는 증빙은 아니다.
- `cumulative112.json`, `rehearsal112.log`, `check112.log`, `regressions112.json`, `business-regressions.json`, `additional112-tests.json`: 최종099eb53b 바이너리의 실제99→112·보호 복원·동의/철회·업무 검증. `rehearse112.log`는 조회 제한 추가 전의 역사적 시험 로그다.
- `api-check-final.log`: 최종fmt/Clippy/83시험. 제외된7시험은 `external-all.log`, `external-boundary.log`에서 별도 실행했다. `api-*-prebudget.log`, 접미사 없는 초기빌드 로그는 이전 시도다.
- `code-provenance.json`, `source-newline-check.json`, `api-release-normalized.log`: Git 원본 입력과 대조·줄바꿈 정규화 후 별도 재빌드의 바이너리 해시 일치.
- `candidate-manifest.json`, `package-verification.json`: 후보76파일+manifest, 기존SQL/웹 불변, 키/자격증명/덤프 없는 묶음.
- `production-capacity-readonly.txt`: 2026-11-11 VPS의 자원/용량/PG설정만 읽은 결과. 스키마·사용자 자료 조회나 설정 변경은 없다.
- `cleanup-query112.json`, `cleanup112.json`: 고정된 이 라운드 합성 자원·키만 정리. 다른 프로젝트/과거후보/운영 변경 없음.
- `evidence-secret-check.json`: 해당 합성 시험에서 사용한 키와 실행계정 비밀번호가 증빙에 포함되지 않았는지 검사. 고정된 폐기용 시험용 문자열은 스크립트에 남아 있다.

재실행 방법·정확한 한계·열린 항목은 [112차 문서](../../operations/location-business-query112-20261111.md)를 참고한다. `ops/`가 원본 시험 코드이며, 이 폴더의Python/shell은 실제로 실행한 경로·해시가 들어 있는 생성된 도구 또는 보정 절차다. 운영에서 실행하지 않는다.
