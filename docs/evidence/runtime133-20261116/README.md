# 133차 실제 기능 검증 증거

구현된 API·React 컴포넌트와 합성 자료만 검증했다. 운영 접속/배포, 지속 부하, 이전300초 부하 비교는 실행하지 않았다. 캡처는 실제 컴포넌트의 합성 요청이며 운영 적용 증빙이 아니다.

| 파일 | 확인 내용 |
|---|---|
| `functional133.json`, `*-functional.log` | 내부 TLS1.2·최소권한 DB 계정에서6묶음,5계정/115요청. 개인110건50/50/10 전량 대조·필터·권한·취소/재조회 |
| `*-functional-source.py` | 실제 실행한 기능 검사 소스.132차의 격리 TLS/계정/MFA 도우미를 재사용 |
| `build-api.log` | fmt/clippy/release·Rust93통과, 기존9ignored는 통과로 계산하지 않음 |
| `build-web.log` | Node22.22.2 전체258테스트·Vite 빌드 통과. 기존 번들 크기/혼합 import 경고 유지 |
| `ui-unit-first.log` | 새 목록 hook3검사와 기존 접수/완료 보호3검사 모두 첫 실행 통과 |
| `ui-browser-first.log`, `ui-validation.json` | 실제 React/Edge6개 확인, 첫 실행 통과 |
| `rights-overdue-desktop.png` | 진행 중 기한 경과 + 내 담당, 서버 비교 기준 시각 표시 |
| `rights-overdue-mobile.png` |390px 필터/버튼/목록 배치, 문서 가로 넘침 없음 |
| `rights-filter-empty-mobile.png` | 필터 조합의 빈 결과와 전체 자료 부재 구분 |
| `rights-personal-third-page-mobile.png` |110개 중 세 번째 페이지10건과 오래된 요청 접근 |
| `routes.json`, `routes-negative.log` |319경로·80원장경로 분류, 미분류/동적 등록3거부 검사 |
| `host-before.json`, `host-after.json` | 기존 산출물/다른 컨테이너 불변, 시험DB/키/내부망 정리 |
| `candidate-manifest133.json` | 검증 소스와 Git 바이트 일치·API/웹·재현 묶음 읽기 재검증 |

`remote-byte-check.json`은 원격 원본7파일의 바이트/해시다. 전송 tar SHA256은 `d67a7140786385b0622a0eba169caf2232bcdc2cba6ec639c34c7989906a6537`. `SHA256SUMS`는 최종 파일 전체(자기 자신 제외) 해시다. 실제 키/세션/DB 자격증명은 수집하지 않았다. 테스트 도우미의 비밀번호는 격리 합성 계정 전용이다.

읽기 전후 원본 요청/이력 해시 일치는 실제 검사에서 assert했다. 이후 별도 변경 회귀에서 합성 요청1개를 본인만 취소하고 revision2·이력1건·오래된 revision409를 확인했다. 이 의도된 변경을 읽기 전후 불변 검사와 혼동하지 않는다. 캡처 응답은 로컬 합성이며 실제 서버 경계 검사는 위 TLS/DB 원본을 따른다.
