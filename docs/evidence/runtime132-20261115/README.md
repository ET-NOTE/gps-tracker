# 132차 실제 기능 검증 증거

운영 접속/배포 없음. 구현된 API·React 컴포넌트와 합성 자료로 검증했다. 지속 부하·기존300초 비교는 실행하지 않았다. 화면 이미지는 실제 컴포넌트의 로컬 합성 응답 캡처이며 운영 적용 증거가 아니다.

| 파일 | 확인 내용 |
|---|---|
| `functional132.json` | 제한된 DB 실행 계정·내부 TLS1.2·관리자 MFA/IP로7묶음 기능 검사. 위치16행/이벤트9행 전후 해시 일치 |
| `build-api.log` | Rust fmt/clippy/release,92통과·9ignored(통과로 계산하지 않음) |
| `build-web.log` | Node22.22.2 전체255테스트와 Vite 빌드 통과. 기존 큰 번들/혼합import 경고 유지 |
| `ui-unit.log`, `ui-validation.json` | KST기간/페이지/오류·취소/오래된 응답 방지, 실제 브라우저6개 검사 |
| `unattributed-desktop.png` | 관리자 분류 목록·읽기 전용 범위·현재 연결과 과거 귀속의 구분 |
| `unattributed-mobile.png` | 390px 배치·표 내부 가로 스크롤·문서 가로 넘침 없음 |
| `unattributed-empty-mobile.png` | 빈 결과를 전체 자료 없음/확인 완료로 표시하지 않음 |
| `routes.json`, `routes-negative.log` |318경로·80원장경로 분류 일치 및 미분류/동적 등록3거부 검사 |
| `host-before.json`, `host-after.json` | 이전 산출물과 다른 컨테이너 불변, 시험DB/키/망 제거 |
| `candidate-manifest132.json` | 코드/API/웹/증거 재현 묶음 및 파일별 해시·읽기 재검증 |

최초 실패도 보존한다. `ui-unit-first.log`는 React 테스트에서 마운트 완료 전 root에 접근한 시험 코드 오류다. 첫 서버 시험은 nginx 리슨 준비 전 연결 거부, 두 번째는 psycopg2의 빈 매개변수와 LIKE `%` 해석 오류, 세 번째는 재시작 시 기존 FCM 작업이 미처리 이벤트의 `notified_at`을 갱신한 것이다. 날짜별 `*-functional.log`와 당시 `*-functional-source.py`/`test-unattributed132-first.py`를 남겼다. `fixture-worker-diagnosis.json`에서9행 모두 같은 알림 처리 시각으로 변경된 것을 확인했다. 이미 처리된 이벤트 표본으로 분리했고, 제품 FCM 작업을 끄거나 해시 일치 조건을 완화하지 않았다.

`build-web-first.log`는 컨테이너 UID1000이 기본 `/.npm` 캐시를 만들지 못한 빌드 환경 오류다. 컨테이너 전용 `/tmp/npm-cache`로 수정 후 전체 시험/빌드가 통과했다. 초기 fixture 재생성 보호 검사도 새로 만든 이번 API 파일을 기존 입력과 비교해 중단했으며, 기존 파일 불변+이번 작업 경로의 추가 파일만 허용하도록 고쳤다.

`remote-byte-check.json`은 원격 원본15파일의 바이트/해시다. 전송 tar SHA256은 `ca6390fba137e1c8a2972d65986d58d67f6e3309eb0d0d36f53d7123e00b24ac`. `SHA256SUMS`는 이 디렉터리의 최종 파일 전체(자기 자신 제외)를 검증한다. 비밀키·세션·DB 자격증명은 수집하지 않았다. 실패 소스의 비밀번호는 격리 합성 계정 전용이다.
