# Shield 교육 예제 5종

요청: placeholder로 본인 설정을 채우는 로컬 예제 펌웨어와 실제 예제 게시물. Firebase 외부 작업/화면은 사용자가 진행하고 `(이미지)`를 캡처 자리로 둔다.

## 구성

`arduino/shield_examples`에 연결 진단·DHT11 로컬 측정·SIM7080G 내장 GNSS·Shield HTTPS 전송·Firebase HTTPS/Firestore 예제를 작성했다. 기존 03_8/03_10/KC 소스와 실물 펌웨어는 바꾸지 않는다.

- 패키저가 공통 모뎀 코드와 안내문을 각 스케치의 src/README에 포함하여 독립 ZIP을 만든다. 실제 config.h, node_modules, 개인 Secret/인증서는 화이트리스트로 제외한다.
- 신형 쉴드의 D6 HIGH/D7 idle LOW/D8·D9 SoftwareSerial 9600 흐름과 기존 v12의 TLS/NTP 명령 순서를 참고했다. 자동 전원 반복 복구·운영 장치 키·HTTP 우회는 넣지 않았다.
- TLS 루트 선택 도구는 공식 ISRG/Google 루트만 받아 PC에서 대상 호스트의 TLS 1.2 체인/호스트명을 검증한다. 모뎀에는 예제 전용 CA 파일명을 사용하고 시각/TLS 설정 성공 후에만 키·본문을 전송한다. 모뎀 SAN/호스트명 처리의 독립 실측 검증을 주장하지 않는다.
- Firebase는 사용자 소유 새 프로젝트의 2세대 HTTPS 함수·Firestore 최신 한 문서 구조다. Secret Manager 장치 키, 고정 장치 ID, 범위/시각 검사, 중복 쓰기 방지, 트랜잭션 기반 간격 제한, 익명 DB 접근 차단을 구현했다. 서비스 계정 JSON은 단말에 넣지 않는다.
- Blaze 요금제·예산·배포·장치별 값 입력은 사용자 액션이다. 실제 Firebase 프로젝트/청구/결제/USIM 주문을 실행하지 않는다.

## 검증

- Arduino AVR Boards 1.8.6 / arduino:avr:uno, DHT 1.4.6 / Unified Sensor 1.1.15.
- 설정을 채운 빌드: 연결 Flash 11,196 / RAM 769; DHT11 5,202 / 219; GNSS 11,380 / 773; Shield 전송 18,880 / 1,396; Firebase 18,588 / 1,192 bytes. 모든 코드는 UNO 한도 안이다. SRAM 잔여량은 실물 스택 최고 사용량 검증을 대신하지 않는다.
- 설정이 없는 placeholder 빌드도 별도 컴파일. 실행 시 설정 안내 후 정지하도록 작성했다.
- g++ -Wall/-Wextra/-Werror 및 ASan/UBSan으로 UTC·시간대·윤일·좌표·HDOP·가시 위성·미설정값 파서 검증 통과.
- 실제 04 스케치의 printf JSON 템플릿으로 격리 Shield preview(shield_test)의 인증/수신/소유자별 동적 센서 조회 통과. 운영 단말에 합성 데이터를 넣지 않았다.
- Firebase Node 22 단위 검사 20개 통과. demo-shield-examples 에뮬레이터에서 인증·입력·저장·조회·중복·충돌·간격 제한·익명 읽기 거부 8개 확인. 실제 Cloud 호출 없음, 에뮬레이터 종료 완료.
- 최신 SDK 전이 의존성 gaxios의 uuid를 CJS 호환 11.1.1로 한정 override하고 npm ci/에뮬레이터 검증. npm audit --omit=dev 0건.
- CA 도구로 실제 shield.serial.kr TLS 1.2 확인. ISRG Root X1 SHA256 22b557a27055b33606b6559f37703928d3e4ad79f110b407d04986e1843543d1.
- ZIP 5개/첨부 15개 해시 및 config.h·Secret 제외 확인. 모든 안내 단계에 `(이미지)` 위치 지정.

새 예제를 실제 쉴드에 플래시하거나 실물 LTE/GNSS/센서·사용자 Firebase TLS를 검증하지 않았다. 학습 예제로 오프라인 영구 큐/무손실 재전송/여러 사용자의 Firebase 접근 관리는 제공하지 않는다.

## 콘텐츠 게시

`ops/shield/publish-examples.py`로 정상 관리자 API를 사용한다. 5개의 새 slug만 생성하며 기존 글/시작가이드/이미지 수정은 보존한다. 파일 SHA 확인 후 업로드, revision=0 신규 저장, 공개 첨부 다운로드 재검증, 금융 테이블 불변 검사를 한다. 재실행 시 기존 튜토리얼이 운영자 편집 내용과 다르면 덮어쓰지 않는다.

게시 전 백업 `shield-20261002T063857Z.tar.gz`, SHA256 `9cf5e948f147979abc2b85ee890ffce981814719b19f368da162ed43560ebb19`. 러너 별도 PostgreSQL 14 복원/첨부 해시 검증 완료. 기존 게시물 7개·이미지 링크 4개를 보존한다. 앱 배포나 서비스 재시작 없이 콘텐츠만 추가한다.

게시 완료: 소스 `ab66e21`, `shield-uno-connect`, `shield-uno-dht11`, `shield-uno-gnss`, `shield-uno-upload`, `shield-uno-firebase` 5개. 각 3개 첨부의 공개 다운로드 SHA-256 확인, 기존 7개 글 내용/revision과 금융 테이블 불변 확인. 관리자가 추가한 기존 이미지도 유지했다.

운영 브라우저에서 Firebase 단계 이동·`(이미지)` 문구·코드/첨부 표시 확인. ZIP 실제 다운로드 `05_firebase.zip` 성공, 콘솔 오류/경고 없음. 사용자용 로컬 완성본은 `E:\project\2025\shield-examples\2026-10-02`에 ZIP·압축 해제한 스케치·README·소스 커밋/해시 INDEX.json으로 제공했다. 실행 중인 앱 릴리스는 기존 `shield-20261001-213325-0510998`을 유지한다.

## 코드 가독성과 첨부 영역 후속 수정

코드 배경은 밝게 덮어쓰면서 전역 pre의 밝은 글자색이 남아 저대비가 발생했다. 예제 코드 영역에 글자색/배경을 함께 지정하고 14px 고정폭 글꼴, 1.7 줄 간격, 원본 들여쓰기와 내부 가로 스크롤을 적용했다. 키보드로 코드 스크롤 영역에 진입할 수 있다. 첨부 패널은 데스크톱 24px·모바일 18px 안쪽 여백을 두고 제목의 중복 여백을 제거했다.

- 사용자 페이지 1280px, 모바일 390/320px에서 페이지 가로 넘침 없음. 관리자 저장 전 미리보기도 동일한 코드 대비/여백 확인.
- 예제 5개 INO의 공백·줄바꿈을 정리했다. placeholder 상태 UNO 빌드 5개 통과, Flash/RAM 사용량은 이전과 동일하다. 공통 모뎀·Firebase 함수·실물 펌웨어는 변경하지 않았다.
- 정렬된 04 스케치의 실제 JSON 템플릿으로 격리 preview 인증·수신·소유자 센서 조회 통과.
- `refresh-example-code.py`는 이전 게시 코드와 일치하는 경우에만 코드/기존 첨부 ID를 교체한다. 관리자 본문·이미지·게시 여부·추가 첨부는 보존하고 revision 충돌 시 중단한다.
- 배포 전 백업 `shield-20261002T065612Z.tar.gz` / SHA256 `c9775cf56e7c0e4bc48c187d6d715a98eee91169ae1c2513ea9b2a05c9699c49`. 별도 PostgreSQL 14 복원과 이미지/첨부 해시 검증 통과.

운영 반영 완료: `shield-20261002-155845-16098be`, 아티팩트 SHA256 `50fdd4fc561f1a6f991c0b7afbeffcb5f4ba630ec7d8660b07310b8b3c0f3f23`. etcom-hub에서 Rust 5/프론트 14/Clippy/GPS check·빌드 통과 후 배포했다. 스키마 1~9, GPS 바이너리/프로세스, nginx와 Shield 환경 설정은 불변이다. 운영 점검 28개 통과, 금융 요청 없음.

게시된 예제 5개 코드/첨부를 갱신하고 기존 본문·사진·다른 게시물과 금융 장부 불변을 확인했다. 운영 브라우저 1280/320px에서 코드 대비·첨부 여백·넘침 없음 확인. Firebase ZIP 실제 다운로드 SHA256 `6aa33b6bb01852522e84d449b0b908e28f57db611d44936670884ff76e4f773a` 일치, 콘솔 경고/오류 없음. 로컬 배포 폴더의 변경 전 해시를 확인한 뒤 ZIP·INO·INDEX만 갱신해 사용자 파일을 보존했다. `code-readability-fixed.png`에 수정 화면을 기록했다.
