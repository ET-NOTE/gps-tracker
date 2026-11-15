# 134차 실제 기능 검증 증거

구현된 API·React 이력 컴포넌트와 합성 자료의 기능 검사다. 운영 접속/배포·지속 부하·이전300초 비교·동시성 확대를 하지 않았다. 캡처는 실제 컴포넌트와 로컬 합성 응답이며 운영 적용 증빙이 아니다.

| 파일 | 확인 내용 |
|---|---|
| `functional134.json`, `*-functional.log` | 내부TLS1.2·분리 runtime,5계정/4요청의7묶음. 본인 이력·승인/처리·25/25/6 탐색·권한·취소·결과 전용 포털 회귀 |
| `*-functional-source.py` | 각 실행 당시 실제 검사 소스. 실패1회와 통과2회의 원본을 모두 보존 |
| `build-api.log` | 수정판 fmt/clippy/release·Rust94통과, 기존9ignored는 통과 수에서 제외 |
| `build-api-first.log`, `rejected-api134.json` | 첫 후보의 빌드는 통과했으나 연속404 후429가 발생하여 기각. 정상 빈 조회의 finish 누락을 수정 |
| `build-web.log` | Node22.22.2 전체262테스트·Vite 빌드 통과. 기존 번들 크기/혼합 import 경고 유지 |
| `ui-unit-first.log` | lazy 조회·접기/취소·페이지/오류/재조회4검사와 기존 요청 처리3검사 통과 |
| `ui-browser-first.log`, `ui-validation.json` | 실제 React/Edge6개 확인·브라우저 오류0 |
| `history-public-desktop.png`, `history-public-mobile.png` | 상태·공개 안내·당시 처리기한,390px 배치·가로 넘침 없음 |
| `history-third-page-mobile.png` |56개 이력의 세 번째 페이지6건과 새 처리 알림 |
| `history-retry-mobile.png` | 실패 안내와 명시적 재조회, 빈 이력으로 오인하지 않음 |
| `routes.json`, `routes-negative.log` |320경로/원장80개 분류·누락 거부3검사 |
| `source-normalization134.json` | Git 소스1074파일 대조. manifest/ops3파일의CRLF만LF로 정규화, 의미 변경 없음 |
| `host-before.json`, `host-after.json` | 기존 산출물/다른 컨테이너 불변·시험DB/키/망 제거 |
| `candidate-manifest134.json` | 최종 Git/API/웹/증거 묶음 읽기 재검증·activation_ready=false |

첫 실행은 정상적으로 끝난 빈 조회에서404를 반환하기 전에 읽기 트랜잭션을 종료하지 않아 중단 정리 경로를 탔고, 연속 조회 뒤429로 실패했다. 수정판은 finish 후404를 반환하며 연속 타인/없는 요청 조회 뒤 본인 조회200을 확인했다. 책임자 승인·관리자 실행을 거친 실제 처리3회를 포함해 통과했다. 이후 재실행할 날짜에 따라 테스트 기한이 만료되지 않도록 기한 표본을 실행일+3/+4일로 바꾸고 새 격리 DB에서 최종7묶음을 다시 통과했다. UI 날짜는 과거 합성 날짜다.

읽기 전후 요청/이력의 해시 불변 검사는 명시적인 합성 처리/이력 추가/취소/계정 제한 변경과 구분한다. 기존 결과 전용 포털은 패스워드로 제한 계정의 공개 이력을 확인하며 일반 세션을 복원하지 않는다. 이번 변경으로 포털의 기존 전체 이력 응답을 페이지화한 것은 아니다.

`remote-byte-check.json`은 원격 원본14파일의 바이트/해시다. 전송 tar SHA256은 `09523896de36f6f3f4dac5f716f64633407bbe7ca845455d998e5ccf38967826`. `SHA256SUMS`는 자기 자신을 제외한 최종 파일 전체 해시다. 실제 키·세션·DB 자격증명은 수집하지 않았다. 검사 소스의 비밀번호는 격리 합성 계정 전용이다.
