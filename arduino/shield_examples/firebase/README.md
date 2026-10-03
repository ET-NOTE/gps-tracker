# LTE 쉴드 → HTTPS 함수 → Cloud Firestore

`05_firebase`는 DHT11 실측을 LTE로 본인 Firebase에 보냅니다. PC는 설정/업로드 때만 필요하며 실행 중 USB 중계기는 필요하지 않습니다. Shield의 내 데이터로 동시 전송하지 않습니다.

이 예제는 **한 프로젝트·한 장치**의 최신 측정 한 문서만 저장합니다. Firestore 클라이언트 공개 읽기/쓰기는 닫고, HTTPS 함수가 별도 장치 키를 검사한 뒤 관리형 서비스 계정으로 씁니다. Firebase Auth 로그인이나 브라우저 대시보드는 이 예제 범위가 아니며 결과는 Firebase 콘솔에서 확인합니다.

## 1. 프로젝트와 Firestore

- Firebase 콘솔에서 **새 실습 프로젝트**를 만듭니다. 기존 운영 프로젝트에는 아래 전역 거부 규칙을 덮어쓰지 마세요.
- Cloud Firestore **Standard / Native mode, (default)** 데이터베이스를 만들고 production mode를 선택합니다. 가능한 가까운 위치를 고릅니다. 함수 기본 리전은 `asia-northeast3`입니다.
- 함수 실제 배포에는 Blaze 요금제/결제 계정이 필요합니다. 요금 동의와 예산 알림 설정은 직접 진행하세요. 예산 알림 및 `maxInstances: 1`은 지출을 완전히 차단하는 한도가 아닙니다. 여기서는 외부 리소스를 대신 만들거나 결제하지 않습니다.
- (이미지) 프로젝트 생성, Firestore 생성·위치, 요금제/예산 화면.

## 2. PC 준비

Node.js 22와 Firebase CLI를 설치합니다. 이 폴더에서:

```powershell
npm install --global firebase-tools@15.32.1
firebase login
cd functions
npm ci
npm test
cd ..
```

`functions/index.js`의 `DEVICE_ID = "YOUR_FIREBASE_DEVICE_ID"`를 `my-shield-01`처럼 본인이 정한 영문/숫자/하이픈 이름(40자 이내)으로 바꾸세요. 펌웨어 `config.h`의 ID에도 같은 값을 씁니다.
(이미지) CLI 로그인 완료 및 DEVICE_ID 수정.

## 3. 별도 키 준비

PC에서 `python -c "import secrets; print(secrets.token_hex(32))"`로 새 64자 키를 한 번 생성해 본인만 접근할 수 있는 곳에 보관하세요. 이 출력/설정 화면은 캡처에 넣지 않습니다. Shield 키를 재사용하지 않습니다.

```powershell
firebase functions:secrets:set SHIELD_INGEST_KEY --project YOUR_PROJECT_ID
```

프롬프트에 생성한 키를 입력합니다. 같은 키를 05의 `config.h` → `FIREBASE_DEVICE_KEY`에 넣습니다. 서비스 계정 JSON, Firebase Web API Key, 로그인 비밀번호가 아닙니다.
(이미지) 값이 보이지 않는 Secret 이름/버전 확인 화면.

## 4. 새 실습 프로젝트에 배포

```powershell
firebase deploy --only firestore:rules,functions:shieldIngest --project YOUR_PROJECT_ID
```

CLI가 출력한 `Function URL (shieldIngest)`를 그대로 사용합니다. 공개 호출 가능한 함수이지만 키가 없으면 401이고 DB에는 쓰지 않습니다. 조직 정책으로 public invoker를 막는 경우 프로젝트 관리자와 접근 방식을 협의하세요.

예: `https://asia-northeast3-PROJECT.cloudfunctions.net/shieldIngest`이면 HOST는 도메인, PATH는 `/shieldIngest`입니다. CLI가 `https://...run.app` 루트 주소를 주면 HOST는 `...run.app`, PATH는 `/`입니다. URL을 임의 조합하지 않습니다. 함수 설정상 경로는 라우팅된 요청 전체를 처리합니다.
(이미지) 배포 완료와 함수 URL (키 없음).

## 5. CA와 펌웨어

패키지 루트 README의 TLS 설치를 실행하되 **실제 함수 HOST**로 CA를 검증/다운로드합니다. `firebase-example-ca.pem` 이름으로 설치합니다. 05의 `config.h`에서 APN, HOST, PATH, DEVICE_ID, KEY를 채우고 DHT11 D2 배선을 확인한 뒤 UNO에 업로드합니다.
(이미지) 비밀값을 가린 config.h, DHT11 배선, Arduino 업로드 완료.

## 6. 데이터 확인

시리얼 `[FIREBASE HTTP] 200` 뒤 Firestore의 `shieldDevices / 본인 ID / latest / sample`을 엽니다. `temperature_c`, `humidity_pct`, `at`(UTC 초), `received_at_ms`(서버 Unix ms)를 확인합니다. 약 60초 대기와 네트워크 처리 후 같은 문서가 갱신됩니다. 중간 부모 문서는 없는 상태로 콘솔에 보일 수 있습니다.
(이미지) 키·계정 정보 없이 Firestore sample 필드와 시리얼 HTTP 200 캡처.

401은 함수와 펌웨어 키, 400은 시각·센서 값·DEVICE_ID, 409는 오래된/서로 다른 중복 표본, 429는 빠른 전송, 503은 Secret/Firestore/권한 설정을 확인하세요. 요청 원문이나 키를 로그에 추가하지 않습니다. 키가 노출되면 Secret을 새 버전으로 바꾸고 함수를 다시 배포하며 펌웨어도 같은 새 키로 업로드하세요.

## 로컬 서버 검증 (선택)

실제 프로젝트 없이 Node 단위 검사를 실행할 수 있습니다. Firestore 연동까지 확인하려면 Java 21 이상과 Firebase Emulator Suite를 사용합니다. 임시 테스트 복사본에서만 ID를 테스트용으로 바꾸고 `functions/.secret.local`에 테스트 전용 `SHIELD_INGEST_KEY`를 둡니다.

```powershell
firebase emulators:start --only functions,firestore --project demo-shield-examples
```

`demo-` 프로젝트는 실제 Cloud 리소스를 호출하지 않습니다. 이 HTTP 에뮬레이터는 PC 검증용이며 펌웨어의 HTTPS 검사를 끄고 여기에 연결하지 않습니다.

외부 배포·실물 LTE·모뎀별 Google TLS 연결은 사용자 설정 후 확인해야 합니다. 예제의 maxInstances·1분 저장 간격 제한은 운영용 공격 방어/비용 한도를 대체하지 않습니다. 여러 장치를 운영하려면 장치별 자격 증명과 사용자 권한/수명 관리가 필요합니다.
