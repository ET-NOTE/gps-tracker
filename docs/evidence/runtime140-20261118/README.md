# 140차 본인 연결·제공 내역 기능 검증 증거

실제 API/DB와 React 컴포넌트에 합성 자료를 사용했다. 운영 데이터·실계정·외부 발송을 사용하지 않았다. 운영/dev 배포, 실물 앱 재설치, 추가 부하/지속 시간/동시성 확대를 수행하지 않았다.

| 파일 | 확인 내용 |
|---|---|
| `functional140.json`, `*-functional.log` | 내부 TLS1.2·PostgreSQL14/Timescale·분리 gps_runtime. 본인 연결207/외부1, 본인 통보109(표시107)/외부1, 3계정의 기능6묶음 |
| `*-functional-source.py` | 실행 시점의 테스트 원문. 최초 실패와 수정 후 성공을 모두 보존 |
| `build-api.log` | 최종 Git 소스 Rust100 통과·기존9 ignored, fmt/clippy 경고 오류화·release 빌드 |
| `build-web.log`, `web-files.json` | 최종 Git 소스 Node22.22.2·웹284 통과·Vite 루트 경로 빌드·파일41개 해시 |
| `web-focused-initial.log`, `api-client-contract.log` | 화면20건, 실제 API 클라이언트/세션19건. 전체284검사와 중복되는 별도 집중 검사 |
| `ui-validation.json`, `ui-final.log` | 실제 React/React Query+Edge, 합성 응답의 페이지·필터·취소·동의/확인/재시도와390px 레이아웃 확인 |
| `personal-fifth-page-desktop.png` | 207연결의 다섯 번째 페이지7건, 다음 없음·직전 페이지 이동 |
| `personal-consent-filter-mobile.png` | 본인 확인 대기 필터, 과거 요청의 동의/거절 선택 |
| `personal-unread-second-page-mobile.png` | 미확인 내역 두 번째 페이지에서 명시적 확인 후49건으로 감소, 현재 페이지 유지 |
| `personal-error-mobile.png` | 조회 실패와 빈 목록 구분·새로고침 |
| `personal-cancel-mobile.png` | 조회 취소 후 이전 항목을 표시하지 않고 명시적 새로고침 대기 |
| `routes.json`, `routes-tests.log` | 321경로/원장80개 유지·미등록 경로 거부3건 |
| `source-normalization140.json`, `source-final140.json`, `normalize-source.py` | Git1106파일 대조, Windows/Linux 줄바꿈614개 정규화·의미 변경0. 정규화 후 빌드/API 기능 검증 재실행 |
| `host-before.json`, `host-after.json` | 이번 합성 컨테이너/내부망 제거, 기존 산출물·다른 컨테이너 보존 확인 |
| `candidate-manifest140.json` | 검증한 소스/API/웹/원본 증거 묶음 해시·읽기 검증, activation_ready=false |
| `SHA256SUMS.json` | 이 디렉터리의 원본 파일 해시(자기 자신 제외) |

## 실패와 수정 경계

1. 최초 API 시험은 기능 플래그를 켠 뒤 오래된 `waiting` 합성 통보의 확인 요청이404일 것으로 가정했다. 기존 복구 작업이15분 이상 지난 waiting을 `pending/delivery_unknown`으로 전환하여 실패했다. 제품 코드를 바꾸지 않고, waiting 거부는 플래그를 켜기 전 확인하고 이후에는 `not_provided` 거부를 확인하도록 시험 순서를 수정했다. 수정 후 전체 기능6묶음을 통과했다.
2. `build-web-initial-cache-error.log`: 빌드 컨테이너의 비루트 사용자가 기본 npm 캐시 `/.npm`을 만들지 못했다. 이 컨테이너의 캐시만 `/tmp/npm-cache`로 지정했다. 호스트 권한 변경은 없었다.
3. `build-web-form-timing-failure.log`: 기존 차량 검색 시험이 고정20ms 뒤 폼 준비를 가정해 전체 검사에서 실패했다. 상한1초 안에서 폼이 실제로 렌더링될 때까지 기다리도록 보완했다. 수정 후 전체284건 통과.
4. `*-pre-normalization.*`는 Git 소스 줄바꿈 정규화 전 성공 기록이다. 최종 산출물은 정규화 후 빌드·기능 재검증 결과를 기준으로 한다.
5. 최초 화면 검수의 호스트에 실제 부모의 `rights-panel` CSS 범위가 빠져 있었다. 검수 호스트를 실제 컴포넌트 배치와 일치시켜 다시 확인했다. 여기 실은5장과 `ui-validation.json`은 수정 후 캡처다. 제품 CSS를 임의로 바꾸지 않았다.

6. 정규화 후 API 재빌드의 정리 검사는 이번 라운드 자체의 실행 파일 별칭(`out/gps-tracker-api`)이 새 빌드로 바뀐 것을 보호 대상 변경으로 감지했다. 이전 해시는 보존한 정규화 전 바이너리와, 새 해시는 최종 검증 바이너리와 각각 일치한다. `cleanup-initial-alias-assertion.json`과 `cleanup-check.py`로 이1개 외 기존 파일/32컨테이너 불변을 확인했다. 후보 별칭을 먼저 준비하고 그 뒤 기준을 기록하도록 setup 순서를 고쳤으며, setup/cleanup을 다시 실행해 최종898파일/32컨테이너 보존과 시험자원 제거를 확인했다. API 제품 코드는 바꾸지 않았다.

캡처는 구현된 화면의 합성 기능 검수이며 실제 서비스 개시·정책 활성화·휴대폰 푸시 수신 증빙이 아니다. 기존 수집 중지/보관/암호화/관리자 보안·제공 정책을 완료로 바꾸지 않는다.
