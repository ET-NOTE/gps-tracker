# 136차 실제 기능 검증 증거

실제 API와 React 회사 연결 화면에 합성 자료를 사용한 기능 검사다. 운영 접속/배포·실물·FCM·지속 부하·기존300초 비교·동시성 확대는 하지 않았다. 화면은 실제 컴포넌트에 로컬 합성 응답을 붙인 것이며 운영 적용 증빙이 아니다.

| 파일 | 확인 내용 |
|---|---|
| `functional136.json`, `*-functional.log` | 내부TLS1.2·분리 runtime.6계정·회사207연결/무SIM1/타사1,7묶음 통과 |
| `*-functional-source.py` | 실행 당시 검사 소스. 검사 오류3회와 최종 성공1회의 원본 모두 보존 |
| `build-api.log` | fmt/clippy `-D warnings`·release·Rust96통과, 기존9ignored 제외 |
| `build-web.log` | Node22.22.2 전체271테스트·Vite 빌드. 기존 큰 번들/혼합 import 경고 유지 |
| `ui-unit-first.log` | 새 검색5·기존 회사 페이지4·동의/정정6의15검사 통과 |
| `ui-validation.json`, `ui-browser-first.log` | 실제 React/Edge7확인·브라우저 오류0·390px 가로 넘침/중첩 form 없음 |
| `binding-fifth-page-desktop.png` |207연결의 다섯 번째 페이지7건, 첫 요청이 없는 과거 연결 도달 |
| `binding-search-mobile.png` | 이름의 문자 그대로 검색, 검색 조건과 결과·연결 기간 표시 |
| `binding-selected-mobile.png` | 최근200개 밖의 선택 유지·연결 기간 안내·사용자 요청 기간 유지 |
| `binding-retry-mobile.png` | 오류와 빈 결과 구분·명시적 재조회/취소 |
| `routes.json`, `routes-negative.log` |321경로/원장80개·누락 거부3검사, 새 경로는 좌표 없는 회사 연결 메타데이터 |
| `source-normalization136.json` | Git1088소스와 검증 소스 바이트 일치, 정규화/의미 변경 없음 |
| `host-before.json`, `host-after.json` | 기존893보존파일·다른32컨테이너 불변·시험DB/키/내부망 제거 |
| `candidate-manifest136.json` | 최종 소스/API/웹/증거 묶음 전량 읽기 재검증·activation_ready=false |

검사 오류를 성공으로 바꾸거나 삭제하지 않았다. 첫 실행은 합성 이름 `100%_`를 매개변수 SQL 문자열에 직접 넣어 psycopg2가 placeholder로 해석한 문제이며 이름을 바인딩 인자로 바꿨다. 두 번째는 일반 새 요청을 접수 단계에서409로 기대했으나 기존22D 규칙은 접수200/pending 후 동의 확정409였다. 세 번째는 기능OFF 위치 조회를404로 기대했으나 기존 활성화 검사가 먼저409를 반환했다. 해당 기존 규칙과 DB pending/revoked·effective 상태까지 명시적으로 대조하도록 검사 도구를 수정했다. 각 수정 뒤 새 격리 DB를 사용했고 최종7묶음을 통과했다. 제품 API/웹은 첫 빌드 결과 그대로다.

읽기 불변 해시의 매핑/행위/위치 표본은 그 시점0행이며 차량연결은209행이다. 이후 업무 검증에서 요청/본인 동의/철회/재동의와 암호화 위치1행을 추가하고 제공 통보2건을 확인했다. 검색 자체의 불변과 명시적 업무 변경을 구분한다. 선택한 연결의 회사/기간/직원 상태를 실제 제안 API에서 다시 검사했다. 단일 SQL 잠금 대기 취소는 기능 검사이며 부하 시험이 아니다.

원격14파일의 바이트/해시는 `remote-byte-check.json`, 전송 tar SHA256은 `d15d98153ea2f70276fade01654aee3c9b6b33fcc756adbc2b34c3fd09cd90a9`다. `SHA256SUMS`는 자기 자신을 제외한 최종 파일 전체 해시다. 실제 키·세션·DB 자격증명은 보관하지 않았다. 소스에 있는 테스트 비밀번호는 격리 합성 계정 전용이다.
