# 144차 회사 검토 변경 이력 기능 검증 증거

운영/dev 접속·배포 없이 실제 API/DB와 React 컴포넌트에 합성 자료를 사용했다. 실계정·운영 키·외부 발송을 사용하지 않았고 부하 시험 시간·동시성·범위를 확대하지 않았다.

| 파일 | 확인 내용 |
|---|---|
| `functional144.json`, `*-functional.log`, `*-functional-source.py` | 실제 실행 소스·원본 로그·7묶음 통과 |
| `migration144.log` | 합성 DB 스키마114 구성. 새 마이그레이션 없음 |
| `build-api.log` | Rust fmt/clippy `-D warnings`·104통과/기존9 ignored·release 빌드 |
| `build-web.log`, `web-files.json` | 웹311통과·Vite 루트 경로 빌드·41파일 해시 |
| `web-focused-first.log`, `web-focused-final.log` | 첫 회귀31통과/4실패, 중복 React key를 고친 뒤35통과. 전체311검사와 중복 |
| `ui-validation.json`, `ui-first.log` | 실제 AdminCompanyReviews·React Query·Edge6묶음,390px 가로 넘침/JS 오류0 |
| `company-review-history-third-page-desktop.png` | 변경 이력107건의50/50/7 탐색·마지막 페이지 |
| `company-review-history-recorded-state-mobile.png` | 당시 상태/검토 항목 필터·본인 판정·내부 사유·근거·요청자 안내. 긴 참조번호 줄바꿈 |
| `company-review-history-empty-mobile.png` | 해당 필터의 빈 결과 표시 |
| `company-review-history-error-mobile.png` | 접근 오류와 빈 결과 구분·수동 재조회 |
| `company-review-history-cancel-mobile.png` | 조회 취소 후 이전 결과 제거 |
| `routes.json`, `routes-tests.log` |323경로/원장80개·미등록 거부3건. 새 경로는 검토 이력 메타데이터 조회 |
| `source-final144.json`, `verify-source144.py` | Git archive1138소스와 검증 소스 바이트 일치·동일 API 해시 |
| `host-before.json`, `host-after.json` |144전용 합성 컨테이너/망 제거·기존915산출물/다른32컨테이너 불변 |
| `candidate-manifest144.json` | 소스/API/웹/증거 후보 해시·전체 재읽기 확인, activation_ready=false |
| `SHA256SUMS.json` | 이 폴더 원본 파일 SHA256(자기 자신 제외) |

## 검증 경계

- 내부 TLS1.2·PostgreSQL14/Timescale·분리 gps_runtime·암호화ON·관리자 보안ON에서6계정을 구성했다. 요청 생성/취소·TOTP 등록은 실제 API를 사용했다.3검토 항목의107이력과 다른 요청의1이력은 합성 DB에 준비했다. 과거 판정과 현재 검토 행이 다른 표본을 넣어 현재 값을 대신 보여주지 않는지 검증했다.
- 이력은6개 상위 필드와11개 당시 상태 필드만 반환한다. 원시 state JSON, 회사 계정/명단 정보·inventory·임의 추가 필드를 새 응답에 포함하지 않는다. 관리자 전용 내부 사유·근거는 의도적으로 표시하며 실제 좌표/파일 원본을 신규 조회하지 않는다.
-107건50/50/7 전량 대조,7상태×3검토항목의21필터 조합, 정확히100건인 상태의50/50 종료, 잘못된 조건400·없는 요청404·다른 요청의 검토 번호는 빈 목록을 확인했다.
- 익명·회사 계정·일반 사용자·TOTP 미확인 관리자·취급자·위임 컨텍스트·잘못된IP·비활성 권한·폐기 세션을 거부한다. 위조 전달IP로 우회할 수 없다. 관리자 접근/응답 감사 저장에 오류를 주입하면500으로 차단하고 복구 후200이다.
- 조회 단계의 업무5테이블 해시가 변하지 않았다. 새로운 검토 결정·자료 제공 완료 기록을 만들지 않는다. 단일 SELECT 잠금 대기를 TLS 연결 종료로 중단한 뒤 SQL 종료·다음 조회200을 확인했다. 지속/동시 부하 시험이 아니다.
- 기존 회사 검토 API의 최근100 events와 본인용 공개 요약은 유지된다. 본인 요약에는 내부 사유/본인 확인 근거를 노출하지 않는다. 취소된 요청도 권한 있는 관리자는 과거 이력을 읽을 수 있다.
- 초기 웹 회귀에서 새 이력과 생성 폼의 React key가 중복되어 후보 선택4검사가 실패했다. history 접두어로 구분한 뒤 관련35검사와 전체311검사가 통과했다. 실패 로그를 덮어쓰지 않았다. 브라우저에서는 열린 요청의 생성 폼과 이력 화면 공존도 확인했다.
- 화면은 실제 컴포넌트+합성 응답이며 운영 적용이나 실제 업무 완료 증거가 아니다. 별도 PASS 본인인증·실제 관리자 회선·실물 APK·정책 활성화·한글PDF 품질을 재검증하지 않았다.

## 재현

최종 후보 소스 `d4ecfa39c4bd274b85fa85c8cd62faf94ffa4316`. `git -c core.autocrlf=true archive -o source144-final.tar d4ecfa39c4bd274b85fa85c8cd62faf94ffa4316 gps-tracker-api gps-tracker-web ops`로 export한다. 기존 SQL 바이트와 `.gitattributes` 예외를 유지한다. 빌드 API/웹 소스는 변경하지 않았으며 새 UI 실행기만 최종 archive에서 동기화했다.

빌드 호스트 `/home/etcom-hub/build/gps-runtime144-20261118`에서 전용 build→setup→test→cleanup 및 package 실행기를 사용한다. 이전143차 baseline99 API/PDF와 runtime123/build 이미지를 의존물로 보존한다. 화면 검수는 `ops/check-company-tasks144-ui.mjs`, Playwright, localhost8044를 사용한다.

묶음 생성 후 외부 candidate-manifest144.json을 추가하므로 내부 evidence144.tar.gz에는 외부 manifest가 없다. 저장소 SHA256SUMS.json은 이 외부 파일까지 포함한다.
