# 135차 실제 기능 검증 증거

구현된 API·React 회사 연결 화면과 합성 자료의 기능 검사다. 운영 접속/배포·지속 부하·이전300초 비교·동시성 확대는 하지 않았다. 캡처는 실제 컴포넌트와 로컬 합성 응답이며 운영 적용 증빙이 아니다.

| 파일 | 확인 내용 |
|---|---|
| `functional135.json`, `*-functional.log` | 내부TLS1.2·분리 runtime,6계정/207연결/206차량-SIM 연결의7묶음. 페이지·상태·권한·목록 SQL 취소·정정·철회·재동의·OFF 회귀 |
| `*-functional-source.py` | 각 실행 당시 검사 소스. 첫 검사 도구 오류와 수정 후 통과 원본 모두 보존 |
| `build-api.log` | fmt/clippy `-D warnings`·release·Rust95통과, 기존9ignored는 통과 수에서 제외 |
| `build-web.log` | Node22.22.2 전체266테스트·Vite 빌드 통과. 기존 번들 크기/혼합 import 경고 유지 |
| `ui-unit-first.log`, `existing-ui-first.log` | 신규 페이지/취소/늦은 위치 응답4검사·기존 정정/재동의/기능OFF6검사 통과 |
| `ui-browser-first.log`, `ui-validation.json` | 실제 React/Edge7개 확인·브라우저 오류0 |
| `company-fifth-page-desktop.png` |207연결의 다섯 번째 페이지7건, 오래된 연결에 도달 |
| `company-old-correction-mobile.png` | 최근200차량-SIM 연결 밖의 기존 연결 선택 유지,390px 정정 화면 |
| `company-reconsent-mobile.png` | 기존 본인·차량·기간 잠금, 초·밀리초 포함 원래 기간으로 재동의 요청 |
| `company-retry-mobile.png` | 조회 실패 안내·명시적 재조회·취소. 빈 목록과 실패 구분 |
| `routes.json`, `routes-negative.log` |320경로/원장80개 분류·누락 거부3검사 |
| `source-normalization135.json` | Git 소스1081파일 대조. 웹2파일의CRLF만LF로 정규화, 의미 변경 없음 |
| `host-before.json`, `host-after.json` | 기존 산출물/다른 컨테이너 불변·시험DB/키/망 제거 |
| `candidate-manifest135.json` | 최종 Git/API/웹/증거 묶음 읽기 재검증·activation_ready=false |

첫 네이티브 실행은 검사 도구의 해시 정렬에 모든 테이블의 `id`가 있다고 가정해 `location_records`에서 UndefinedColumn으로 중단했다. 제품 API 오류가 아니다. `to_jsonb(x)::text` 정렬로 수정하고 새 격리 DB에서7묶음 전체를 통과했다. 첫 실행 로그/소스도 삭제하지 않았다. API 빌드와 웹 전체 검사는 첫 실행에서 통과했다.

페이지 조회 전후 매핑/행위/차량연결/위치 원본의 해시를 대조했다. 이 읽기 표본 단계의 위치 테이블은0행이며, 이후 정정·동의·철회 검증에서 암호화 위치1행을 별도로 넣어 실제 조회와 제공 통보3건을 확인했다. 읽기 전후 불변과 명시적인 업무 변경을 구분한다. 회사 목록 SQL 취소와 브라우저 위치 요청 중단을 검사했으며 위치조회 SQL 취소를 새로 구현·검증했다고 주장하지 않는다.

`remote-byte-check.json`은 원격 원본10파일의 바이트/해시다. 전송 tar SHA256은 `668281f81fc72842f4bb8029ddde091a4f159dd57f722b514888737ac8d2ea0e`. `SHA256SUMS`는 자기 자신을 제외한 최종 파일 전체 해시다. 실제 키·세션·DB 자격증명은 수집하지 않았다. 검사 소스의 비밀번호는 격리 합성 계정 전용이다.
