# 141차 회사 처리 요청함·증빙 검토 기능 검증 증거

실제 API/DB와 React 컴포넌트에 합성 자료를 사용했다. 운영/dev 서버, 실계정, 운영 키와 외부 발송을 사용하지 않았다. 부하 시험 시간·동시성·범위를 늘리지 않았다.

| 파일 | 확인 내용 |
|---|---|
| `functional141.json`, `20261118T054302Z-functional.log` | 내부 TLS1.2·PostgreSQL14/Timescale·분리 gps_runtime·저장 암호화ON. 4계정, 유효 요청107개와 제외4개, 증빙2개의 기능7묶음 |
| `20261118T054302Z-functional-source.py`, `migration141.log` | 실제 실행 원문, 스키마114 구성. 목록 표본은 직접 삽입하고 제출·보완·재제출·검토·회수·상위 요청 취소는 API로 수행 |
| `build-api.log` | Rust fmt/clippy `-D warnings`,101통과·기존9 ignored, release 빌드 |
| `build-web.log`, `web-files.json` | Node22.22.2·웹296통과·Vite 루트 경로 빌드·41파일 해시 |
| `proof-ui-first.log`, `web-focused-final.log` | 저장 결과/지연 응답/검토 잠금10검사, 목록/상세/취소/제출4검사. 전체296검사에 포함되는 집중 검사 |
| `web-focused-first.log` | 최초 실패 원문. 필터 옵션과 행에 같은 문구가 있어 시험 선택자가 중복 매칭됨. 특정 행 버튼으로 좁혀 수정했으며 제품 동작을 바꾸지 않음 |
| `ui-validation.json`, `ui-first.log` | 실제 React/React Query+Edge의7확인, 합성 API와 파일 저장 결과. JS 오류0,390px 가로 넘침 없음 |
| `company-tasks-third-page-desktop.png` | 107개 요청을50/50/7로 탐색한 세 번째 페이지, 다음 없음·직전 페이지 이동 |
| `company-task-correction-mobile.png` | 보완 요청·첨부자료 필터와 해당 요청의 새 상세/제출 폼 |
| `company-tasks-error-mobile.png` | 실패를 빈 목록과 구분하며 명시적 새로고침 제공 |
| `company-tasks-cancel-mobile.png` | 취소 뒤 오래된 목록을 숨기고 새로고침 대기 |
| `company-proof-save-cancel-mobile.png` | 파일 저장 취소 안내, 최신 증빙 확인 체크박스·검토 반영 버튼 비활성 |
| `routes.json`, `routes-tests.log` |321경로/원장80개 유지·미등록 경로 거부3건 |
| `source-final141.json`, `verify-source141.py` | 최종 Git archive1114파일과 검증 호스트 소스 바이트 전량 일치. 실행 API 해시 동일 |
| `host-before.json`, `host-after.json` | 이번 합성 컨테이너/내부망 제거, 기존903산출물·다른32컨테이너 보존 |
| `candidate-manifest141.json` | 검증 소스/API/웹/증거 후보 해시·전체 재읽기 확인, activation_ready=false |
| `SHA256SUMS.json` | 이 디렉터리 원본 파일의 SHA256(자기 자신 제외) |

## 결과의 범위

- 요청함4상태×자료6종류,50/50/7 페이지와 정확히100건의 마지막 페이지, 이전 API 호출, 잘못된 조건400을 확인했다. 조회만으로 원본이나 증빙 이력을 바꾸지 않는다.
- 하나의 잠금 대기 목록 SELECT를 TLS 연결 중단으로 취소하고 SQL 종료·다음 요청200을 확인했다. 지속/동시 부하 시험이 아니며 상세 조회의 DB 잠금 취소까지 증명하는 것은 아니다.
- 합성 관리자 보안 플래그는OFF이고 기존 역할·회사 소유자 격리와 분리 DB역할을 사용했다. 실제 관리자MFA/IP 인증 인수나 운영 암호화 활성화 증거가 아니다.
- 브라우저는 실제 컴포넌트 캡처다. Android 파일 브리지의 응답은 합성으로 주입했으며 실물 저장 창·공유 앱·APK 설치를 다시 검증한 것은 아니다. `share_opened`/`browser_started`도 실제 열람·전달 완료를 뜻하지 않는다. 검토자는 별도로 확인해야 한다.
- 서버의 ‘증빙 응답 생성’ 기록은 파일 저장 취소와 별개다. 취소 시 이를 지우지 않으며, 화면의 검토 확인만 허용하지 않는다. 재요청/실패/다른 리비전의 늦은 결과도 기존 확인 권한을 유지하지 않는다.
- PDF 표본은 파일 저장·해시·권한 확인용 합성 바이트다. 실제 한글 PDF 렌더링 품질 검사가 아니다.

## 소스·묶음 재현

최종 소스는 `bc0864163141f2ba09c20c3053cd383706e149da`다. 이 작업장의 기존 archive 방식은 `core.autocrlf=true`이며 파일별 `.gitattributes` 예외를 함께 적용한다. Rustfmt가 수정한 `privacy_company_tasks.rs`의LF를 명시해 검증한 소스 그대로 보존했다. 최초 최종 묶음 대조는 해당 파일의 줄바꿈 차이로 멈췄고, `core.autocrlf=false`를 적용하면 기존 다른 파일들도 달라짐을 확인했다. 제품 소스를 재변환하지 않고 export 설정을 고정했다. 최종1114파일 대조는 통과했고 API/웹 소스와 실행 파일을 변경하지 않았다. `verify-source141.py`가 동기화한 것은 새 UI 검수 스크립트1개뿐이다.

재현 명령: `git -c core.autocrlf=true archive -o source141-final.tar bc0864163141f2ba09c20c3053cd383706e149da gps-tracker-api gps-tracker-web ops`. 배포된 SQLx 마이그레이션0085의 원래 바이트도 유지한다. 외부 후보 manifest는 묶음 생성 후에 추가되므로 내부 `evidence141.tar.gz`에는 포함되지 않는다. 저장소의 `SHA256SUMS.json`은 외부 manifest까지 포함하는 최종 목록이다.
