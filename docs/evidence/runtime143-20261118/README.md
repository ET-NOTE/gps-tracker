# 143차 회사 연결 단서 검색·과거 범위 선택 기능 검증 증거

실제 API/DB와 React 컴포넌트에 합성 자료를 사용했다. 운영/dev 접속·배포, 실계정·운영 키·외부 발송 없이 기능만 검증했다. 부하 시험 시간·동시성·범위를 늘리지 않았다.

| 파일 | 확인 내용 |
|---|---|
| `functional143.json`, `*-functional.log`, `*-functional-source.py` | 실제 실행 소스·원본 로그·7묶음 결과. 최초 실행에 모두 통과 |
| `migration143.log` | 합성 DB의 스키마114 구성. 새 마이그레이션 없음 |
| `build-api.log` | Rust fmt/clippy `-D warnings`·103통과/기존9 ignored·release 빌드 |
| `build-web.log`, `web-files.json` | 웹306통과·Vite 루트 경로 빌드·41파일 해시 |
| `web-focused-first.log` | 후보 페이지/필터/취소/기존 회사 검토/세션30검사. 전체306검사와 중복 |
| `ui-validation.json`, `ui-first.log` | 실제 React/React Query+Edge6묶음·390px 가로 넘침 및 JS 오류0 |
| `company-candidate-third-page-desktop.png` | 107개 연결 단서의50/50/7 탐색, 마지막 페이지 |
| `company-candidate-search-mobile.png` | 명단 번호 검색과 연결 해제 이력 필터 |
| `company-candidate-selection-mobile.png` | 과거 연결 선택·본인 범위 별도 확인·KST 포함 종료일 |
| `company-candidate-approval-error-mobile.png` | 추가 실행 오류를 표시하고 선택·입력 유지 |
| `company-candidate-access-error-mobile.png` | 접근 오류를 빈 목록과 구분하고 수동 재조회 제공 |
| `company-candidate-cancel-mobile.png` | 취소 후 늦은 결과와 이전 선택 버튼을 표시하지 않음 |
| `routes.json`, `routes-tests.log` |322경로/원장80개·미등록 경로 거부3건. 경로 추가 없음 |
| `source-final143.json`, `verify-source143.py` | Git archive1130파일과 검증 소스 바이트 일치, 실행 API 해시 동일 |
| `host-before.json`, `host-after.json` | 합성 컨테이너/망 제거·기존911산출물/다른32컨테이너 불변 |
| `candidate-manifest143.json` | 소스/API/웹/증거 묶음 해시와 전체 재읽기, activation_ready=false |
| `SHA256SUMS.json` | 이 폴더 원본 파일 SHA256(자기 자신 제외) |

## 기능 검증 범위

- 내부 TLS1.2·PostgreSQL14/Timescale·분리된 gps_runtime·필드 암호화ON·관리자 보안ON으로 실행했다. 7계정, 요청자 연결107쌍(현재2·과거105), 타인 연결1쌍을 직접 심었다. 회사·명단 번호를 교차 생성해 회사 경계의 복합 커서를 확인했다. 요청 생성/취소, TOTP 등록, 승인/실행은 실제 API를 사용했다.
- 회사명은 대소문자 무시 문자열 검색이다. `%`, `_`는 와일드카드가 아니다. 번호는 정확히 일치시킨다. 회사 이름 검색54건의50/4, 전체107건의50/50/7, 현재2·해제105, 잘못된 조건400·없는 요청404, 빈 페이지를 확인했다.
- 다른 요청자 이력을 제외하고 공개 필드를6개로 제한한다. 조회 응답은 no-store이고 identity_confirmed=false다. 조회 단계의 업무5테이블 해시 불변을 확인했으며 아래 승인 실행과 요청 취소는 의도한 별도 변경이다.
- 익명·일반 사용자·회사 계정·TOTP 미확인 관리자·취급자·위임 컨텍스트·잘못된IP·비활성 권한·폐기 세션은 거부한다. 조작된 전달IP도 허용하지 않는다. 관리자 접근/응답 기록을 확인하고, 감사 저장에 합성 오류를 주입하면500으로 차단·복구 후200이다.
- 단일 목록 SELECT를 잠금 대기시킨 뒤 TLS 연결을 종료하여 SQL 종료와 다음 조회200을 확인했다. 지속/동시 부하 시험이 아니다.
- 별도 책임자 승인 없이 추가하면409, 책임자의 직접 실행은403, 승인한 본문을 바꾸면409다. 현재 명단 소속이 바뀐 과거 연결로도 승인된 검토 항목을 추가할 수 있고, 결과는 identity_pending/pending·후보 건수일 뿐이다. 중복은409, 회사 제출 요청 생성0건으로 자동 제공/본인 확인을 하지 않는다.
- 취소된 상위 요청에서도 권한 있는 관리자의 이력 조회는 유지한다. 회사 정책·보관 기간·자동 파기·PASS 본인인증·실제 관리자 회선 인수를 완료한 것이 아니다.
- 캡처는 실제 컴포넌트에 합성 응답을 연결한 기능 검수다. 운영 적용·실제 회사 자료·실물 APK·파일 저장 창의 증거로 사용하지 않는다. 과거 이력 날짜와 향후 검토 기한은 구분한다.

## 재현 및 보관

최종 소스 `b1e044d2760a8e4a34a3278bc7d055b30454ea97`. `git -c core.autocrlf=true archive -o source143-final.tar b1e044d2760a8e4a34a3278bc7d055b30454ea97 gps-tracker-api gps-tracker-web ops`로 export한다. 기존 SQL 바이트와 `.gitattributes` 예외를 유지한다. 빌드한 API/웹 소스를 수정하지 않고 UI 실행기만 최종 archive와 동기화했다.

빌드 호스트 `/home/etcom-hub/build/gps-runtime143-20261118`의 전용 실행기 build→setup→test→cleanup 및 package를 사용한다. 이전142차 baseline99 API/PDF 실행 파일, `gps-runtime123:20261113`, `gps-build:rust1.88-node22.22.2`를 의존물로 보존했다. 화면 검수는 `ops/check-company-tasks143-ui.mjs`와 localhost8043을 사용했다.

묶음 생성 뒤 외부 `candidate-manifest143.json`을 추가하므로 내부 evidence143.tar.gz에는 외부 manifest가 없다. 저장소의 최종 SHA256SUMS.json은 이 파일까지 포함한다. 증거는 이전 라운드 산출물과 함께 보존한다.
