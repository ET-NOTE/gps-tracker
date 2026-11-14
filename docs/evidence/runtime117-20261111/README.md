# 117차 실제 관측·합성 검증 증빙

2026-11-11. [결과와 해석](../../operations/location-business-runtime117-20261111.md).

운영 자료는 읽기 전용 관측이고 나머지는 외부 포트 없는 별도 합성 환경 결과다. 실제 위치·계정·비밀번호·개인키는 포함하지 않는다. 생성한 화면이나 가공한 성공 캡처가 아니다.

| 파일 | 범위 |
|---|---|
| `production-observation.json` | 운영180초·36표본, 메모리/I/O압력·DB 임시 파일 카운터·설정 |
| `production-final.json`, `prod-final.py` | 운영 최종health·스키마99·서비스시각·전체연결·리소스, 읽기 전용 수집 원문 |
| `limited-disk.json`, `limited-disk-timing.log` | 기존 디스크의 실패 재현, 시작 잠금/coverage 지연 |
| `limited-disk-metadata-correction.json` | 첫 시험 해시 표기 오류의 명시적 정정. 원본 JSON을 바꾸지 않음 |
| `limited-protected.json` | 중간 보호 후보300초. 기본 fallback 보호 전 결과이므로 최종 보안 인수 자료가 아님 |
| `limited-protected-final.json` | 최종 후보180초, 기본 fallback까지 보호한 구성 |
| `configuration-disk.json`, `configuration-protected.json` | 실제 장치I/O 제한·마운트·swap/core 설정. protected는 최종 구성 |
| `faults.json`, `faults-timing.log` | 20개 장애 검증, 데이터 차단·용량/경로·지연·복구 |
| `protected-sort-plan.json` | 합성 external merge spill 실행계획 |
| `temp-preflight.json` | 장애 복구 후 두tmpfs·swap/core·권한/한도 재검사. 운영 준비=false |
| `business-tests.json` | 법인6경로·429·TLS취소·이용중지·철회·복구16결과 |
| `probe.json`, `recovery.json` | 정상28조회·타 계정8차단 |
| `repair.json` | 합성31일×8장치 집계 준비. 시험은5초poll이므로 운영300초poll의 복구시간이 아님 |
| `build-final.log` | 최종 fmt/clippy, Rust84통과·8제외, release 빌드 |
| `build.log`, `build-guard.log` | 중간 후보 빌드 이력. 최종 테스트 수와 혼용하지 않음 |
| `source-verification.json`, `verify-source.py` | API 소스242파일 LF정규화 일치 |
| `tested-binaries.json` | 초기·중간·최종 실제 보존 바이너리 해시 |
| `candidate.json`, `candidate-manifest.json` | API 교체 후보250파일+manifest 검증, 운영활성화=false |
| `final-state.json`, `cleanup.json` | 암호화119,710행·평문0·남은 조회/열린거래0, 시험 환경 제거 |

`limited-protected-final-timing.log`가 빈 것은 최종 부하 중 출력 기준(250ms 이상 또는 실패)에 해당하는 원장 단계가 없었다는 뜻이다. 원장을 기록하지 않았다는 뜻이 아니다. `faults-timing.log`에는 같은 최종 바이너리에 강제한 시작·완료 실패가 남아 있다.

부하의429는 성공으로 세지 않는다. `temp_bytes`는 누적 생성량이며 실제 저장장치 쓰기량이나 동시 사용량이 아니다. `error_or_cancelled`는 완료를 관측하지 못했다는 뜻으로 DB커밋 실패를 단정하지 않는다. 실제 운영 자원 인수와 마운트/부팅 보호 검증은 별도 열린 조건이다.

`temp-preflight.json`의 core 검사는 한도0 설정만 확인한다. 파이프 코어 처리기가 이 한도를 우회할 수 있어 실제 충돌·덤프 미생성 검증은 완료로 보지 않는다.

해시는 `SHA256SUMS.json`에 LF정규화 기준으로 기록한다(Windows Git 줄바꿈 변환 허용). 바이너리·후보 압축파일의 해시는 별도 manifest에 적힌 원시 바이트 기준이다.
