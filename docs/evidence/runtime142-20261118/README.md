# 142차 관리자 회사 처리 이력 기능 검증 증거

운영/dev 접속·배포 없이 실제 API/DB와 React 컴포넌트에 합성 자료를 사용했다. 실계정·운영 키·외부 발송은 사용하지 않았으며 부하 시험 시간·동시성·범위를 늘리지 않았다.

| 파일 | 확인 내용 |
|---|---|
| `functional142.json`, 성공 `*-functional.log` | 내부 TLS1.2·PostgreSQL14/Timescale·분리 gps_runtime·암호화ON·관리자 보안ON의 기능7묶음 |
| `*-functional-source.py`, 최초 실패 `*-functional.log` | 실제 실행 원문과 최초 합성자료 오류. 검토 행의 필수 due_at 누락을 수정했으며 제품 코드는 변경하지 않음 |
| `migration142.log` | 스키마114 구성. 새 마이그레이션 없음 |
| `build-api.log` | Rust fmt/clippy `-D warnings`·102통과/기존9 ignored·release 빌드 |
| `build-web.log`, `web-files.json` | 웹301통과·Vite 루트 경로 빌드·41파일 해시 |
| `web-focused-first.log` | 페이지/필터/취소/기존 회사 제출/증빙/세션39검사. 전체301검사와 중복되는 집중 확인 |
| `ui-validation.json`, `ui-first.log`, `ui-final.log` | 실제 React/React Query+Edge7확인. 마지막 검수는 기존 관리자 패널에서 종료된 요청의 이력 열기까지 포함. JS 오류0 |
| `company-history-third-page-desktop.png` | 이력107개를50/50/7로 탐색, 마지막 페이지와 직전 이동 |
| `company-history-revoke-filter-mobile.png` | 회수 행위·요청 번호 필터와 기록 내용 |
| `company-history-proof-hash-mobile.png` | 증빙 응답 생성 이력, 실제 열람/전달 완료와 구분, 긴 해시의390px 줄바꿈 |
| `company-history-error-mobile.png` | 접근 오류를 빈 목록과 구분, 수동 재조회 제공 |
| `company-history-cancel-mobile.png` | 취소 후 과거 행을 숨기고 재조회 대기 |
| `routes.json`, `routes-tests.log` |322경로/원장80개·미등록 경로 거부3건. 새 경로는 관리자 업무 이력 메타데이터 조회로 분류 |
| `source-final142.json`, `verify-source142.py` | 최종 Git archive1122파일과 검증 호스트 소스 바이트 일치, 실행 API 해시 동일 |
| `host-before.json`, `host-after.json` | 전용 합성 컨테이너/망 제거, 기존907산출물·다른32컨테이너 유지 |
| `candidate-manifest142.json` | 소스/API/웹/증거 묶음의 해시와 전체 재읽기 결과, activation_ready=false |
| `SHA256SUMS.json` | 이 폴더 원본 파일의 SHA256(자기 자신 제외) |

## 검증 경계

- 관리자5종 표본(책임자·관리자·취급자·일반 사용자·회사 소유자), 해당 검토 범위107이력/타 범위1이력,3요청, 암호화 증빙1개를 구성했다. 시험 행은 직접 삽입했고 본인 요청 생성·취소와 TOTP 등록/검증은 실제 API로 수행했다. 실제 업무 처리나 회사의 승인 완료 증거가 아니다.
- 18개 행위/요청 조합, 응답 생성100건의50/50 마지막 페이지, 타 범위 요청 제외, 잘못된 조건400·없는 검토404, 기존 최근100 API를 확인했다.
- 관리자 보안ON에서 TOTP 미확인·취급자·일반 사용자·위임 컨텍스트·잘못된IP·비활성 권한·폐기된 2차 세션을 거부했다. 위조 전달IP도 거부했다. 합성 환경의 기존 TOTP 구현 검증이며 PASS 본인인증이나 실제 관리자 회선 인수가 아니다.
- 새 조회도 관리자 접근/응답 감사기록을 남긴다. 감사기록 쓰기에 합성 오류를 주입하면500으로 접근을 차단하고, 오류 제거 후 다시200을 확인했다. 업무 이력/증빙 원본 해시는 그대로다. 조회 자체가 ‘증빙 다운로드’ 이력을 만들거나 검토 확인을 대신하지 않는다.
- 단일 목록 SQL을 잠금 대기시킨 뒤 TLS 연결을 종료해 SQL 종료와 다음 조회200을 확인했다. 지속/동시 부하 시험이 아니다.
- 회수·기한 만료·상위 요청 취소 후에도 권한 있는 관리자가 이력을 조회할 수 있다. 회사의 접근 권한·보관 기간·자동 파기 정책을 바꾸지 않았다.
- 캡처는 합성 응답을 연결한 실제 컴포넌트이며 운영 정책 활성화 증거가 아니다. 실물 APK·휴대폰·회사 자료·한글PDF 품질을 재검증하지 않았다. 운영의 관리자 보안 플래그는 변경하지 않았다.

## 재현

최종 소스 `d2a153f9862d3e9ea0f92d7486b2a2ed2ab0b085`. `git -c core.autocrlf=true archive -o source142-final.tar d2a153f9862d3e9ea0f92d7486b2a2ed2ab0b085 gps-tracker-api gps-tracker-web ops`를 사용하고 `.gitattributes` 예외 및0085 SQL 원래 바이트를 유지한다. Rustfmt 결과는 Git에 반영했으며 최종 API/웹 소스는 검증한 바이트와 같다. 묶음 생성 뒤 외부 `candidate-manifest142.json`을 추가하므로 내부 `evidence142.tar.gz`에는 이 외부 manifest가 없다. 저장소의 최종 `SHA256SUMS.json`은 외부 manifest까지 포함한다.
