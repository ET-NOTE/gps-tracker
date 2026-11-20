# 116차 누적 전환·복구 증빙

내부 네트워크의 합성 자료로 수행한 실제 실행 출력이다. 운영 배포·실제 사용자 데이터·실제 LTE 전송 증빙이 아니다. 이번 라운드에서는 운영 서버를 조회하거나 변경하지 않았다.

| 파일 | 확인할 내용 |
|---|---|
| `preparation116.json` | 초기 소스와 고정 기반 산출물 검사. 이때의 작업 중 소스 수는 최종 포장 소스 수와 다름 |
| `cumulative116.json`, `rehearsal116.log` | 99→112의 13단계 실패·재개, 제한 계정, 암호화 중단·재개, 전체 DB·파일 복원, 시간·용량 |
| `release116.json`, `release116.log` | 실제 API 시작·준비·웹 교체 실패 후 호환 112 복구, 최종 115 재기동, SIM·암호문 불변 |
| `regressions116.json`, `round22*.json` | 정보주체·법인·외부 제공 통합 실행과 중간 재기동 |
| `business-regressions.json`, `test_*.log` | 지점·운행·지출·차량·영수증·자료 제공 8개 업무 시험 묶음 |
| `protected-restore116.json` | 오래된 백업 복원 후 최신 철회·중지·파기 재적용. 실제 외부 사본 보관 검증은 false |
| `file-owner116.json` | 변환 계정과 API 계정이 다른 경우의 파일 소유권·읽기 권한 |
| `ancestry109-regression.json`, `mapping109-queries.json` | 동의·철회 기준 결과 대조와 매핑 회귀 |
| `mapping-history116.json`, `*-plan.json` | 32,000행 매핑 이력 성능과 실행 계획. 운영 분포 재현 아님 |
| `additional116-tests.json`, `external-*.log` | 추가 4단계와 외부 처리 시험 7개. 통보 1,200건은 모의 수신기 사용 |
| `final-state116.json` | 최종 실행 소스 `7ba85b1`, 130,020행·평문 잔여 0·조회 준비 대기 0·잔여 쿼리 0 |
| `candidate-manifest.json`, `package-verification.json` | 최종 포장 소스 `5124653`, 894개 입력·76개 후보 파일 대조. 운영 비활성, 115차 부하 미통과 결과 유지 |
| `cleanup116.json` | 이번 시험 자원·키·비밀값·파일 저장소 정리. 후보와 증빙 보존 |
| `evidence-manifest.json` | 원본 61파일의 SHA-256. 이 README는 해시 대상에서 제외 |

`.py`, `dev22.sh`는 실제 실행한 고정 시험 도구 사본이다. 내부 임시 DB/JWT의 공개된 시험용 상수는 있지만 운영 자격증명·생성된 runtime 비밀번호·키 파일·사용자 토큰은 포함하지 않는다. 시험 DB와 생성된 비밀값은 정리됐다.

최종 포장 단계에서 이전 후보로부터 따라온 기반 해시·매핑 시간을 이번 결과로 정정했다. 실행 검증 뒤의 변경은 포장 메타데이터에 한정하며 API·웹은 동일하다. 과거 115차 부하 결과를 이번 실행 결과로 혼동하지 않는다. 전체 판정과 남은 운영 조건은 [116차 문서](../../operations/location-business-cumulative116-20261111.md)를 따른다.
