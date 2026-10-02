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
