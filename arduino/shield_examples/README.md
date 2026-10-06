# Arduino UNO R3 · SIM7080G 쉴드 예제 v3

각 **전체 ZIP을 새 폴더에 풀고 폴더 이름과 같은 .ino**를 여세요. src 폴더를 함께 유지합니다.
기존 ZIP의 config.h를 새 예제로 복사하지 마세요. 예제를 자동으로 실물에 업로드하지 않습니다.
저장소에서 패키지를 만들려면 `python tools/package_examples.py --out PATH`를 실행합니다.

| 예제 | 결과 | 사용자 준비 |
|---|---|---|
| 01_connection | AT·SIM·LTE 점검, 시리얼 AT 브리지 | 쉴드·안테나·USIM, 계정 불필요 |
| 02_dht11 | DHT11 측정을 시리얼에 출력 | DHT 라이브러리, 계정 불필요 |
| 03_gnss | 내장 GNSS 좌표를 시리얼에 출력 | GNSS 안테나·하늘 시야, 계정 불필요 |
| 04_shield_upload | DHT11 → Shield 센서 카드·그래프·표 | 1NCE USIM·DHT11·Shield 로그인 |
| 05_firebase | DHT11 → 본인 Firebase → Firestore | 1NCE USIM·본인 Firebase 설정·CA 설치 |
| 06_first_upload | LTE 상태 → Shield 내 장치 | 1NCE USIM·Shield 로그인 |
| 07_easy_https | 간편 HTTPS LTE 상태 전송 | 06과 같은 자동 등록 절차 |
| 08_shield_http_pairing | 교육용 HTTP LTE 상태 전송 | 등록된 내 장치의 24시간 교육용 전송 코드 |

## 공통 준비

- Arduino AVR Boards → **Arduino Uno (UNO R3)**, 실제 USB COM 포트를 선택합니다. UNO R4/ESP32용이 아닙니다.
- 모니터는 **115200 baud**, 모뎀은 9600 baud입니다. 업로드 시 COM 포트를 사용하는 다른 프로그램은 닫습니다.
- 쉴드는 D6=DTR, D7=PWRKEY(NPN, idle LOW), D8=UNO RX, D9=UNO TX입니다. 쉴드 리비전의 배선을 확인하세요.
- 장착·배선은 전원을 끈 상태에서 합니다. 모뎀을 UNO 3.3V 핀으로 급전하지 말고 제품 규격의 전원을 사용하세요.
- GPS는 별도 L80 모듈이 아닌 SIM7080G 내장 GNSS입니다. LTE·GNSS 안테나는 해당 단자에 연결합니다.
- 02/04/05는 DHT11 DATA=D2. Adafruit DHT sensor library와 Adafruit Unified Sensor를 설치합니다.
- 이 패키지의 통신 설정은 **1NCE APN iot.1nce.net** 기준입니다. 다른 사업자 USIM용 무설정 예제가 아닙니다.

## Shield HTTPS 등록 — 04·06·07 공통

1. 전체 ZIP을 풀어 **코드 수정 없이 업로드**합니다. 별도 설정값·Python·인증서 브리지가 필요 없습니다.
2. 시리얼에 `[AUTO v3]`가 보이고, LTE/HTTPS 준비 후 `[REGISTER] abcd-1234-ef56-7890` 형태의 코드가 나옵니다.
3. https://shield.serial.kr/devices 에 로그인 → 장치 등록 → **시리얼 등록 코드와 원하는 이름**을 입력합니다.
4. `[HTTPS] 409`는 등록 대기입니다. 등록 후 다음 주기의 200과 마지막 수신을 확인합니다.
5. 같은 보드에서 최신 04·06·07 예제를 바꿔 올려도 연결이 유지됩니다. 사용자가 기기 식별자나 인증키를 찾아 입력하지 않습니다.

06/07은 실제 LTE 상태만 전송합니다. 온습도·GPS·임의 TEXT 값은 보내지 않습니다.
04는 유효한 DHT11 측정만 전송합니다. 센서/시각 오류를 0으로 채워 보내지 않습니다.
기본 전송 간격은 **60초 대기 + 통신 처리 시간**입니다. 실패 표본을 저장하는 무손실 큐는 없습니다.

### 재등록과 보드 공유

등록 코드는 24시간 동안 한 번 사용합니다. 아직 등록하지 않은 코드가 만료됐을 때만 모니터의 줄 끝을 새 줄로 두고 `NEW`를 전송하세요.
대기 구간에서 새 장치 연결 정보를 만들며, 이전 서버 기록은 남습니다. **이미 등록한 장치에는 NEW를 쓰지 마세요.**
HTTPS 연결 정보는 UNO EEPROM **768~896**에 체크섬과 함께 보관되며 암호화 저장이 아닙니다.
보드·EEPROM 덤프를 다른 사람에게 넘기기 전 계정 연결을 확인하세요. 08은 이 저장 영역을 읽거나 지우지 않습니다.
자세한 인증서·오류 설명은 04/06/07 ZIP의 `HTTPS.md`를 참고하세요.

## HTTP 학습 — 08

먼저 HTTPS 예제로 본인 장치를 등록합니다. 내 장치 → HTTP 학습 연결에서 24시간 교육용 전송 코드를 받습니다.
08 ZIP을 그대로 업로드하고 모니터(115200 baud · 새 줄)에 `demo-`로 시작하는 전체 코드를 붙여 넣습니다.
**펌웨어 수정·재업로드가 필요 없습니다.** 코드는 RAM에만 있으므로 리셋 후 다시 입력합니다.
만료/꺼짐/재발급으로 401이 나오면 새 전송 코드를 받아 시리얼에 붙여 넣으세요. 웹 등록 코드와는 다른 값입니다.
HTTP는 암호화되지 않습니다. 코드를 아는 사람도 만료 전까지 LTE 학습 상태를 보낼 수 있습니다.
위치·개인정보·운영 센서 데이터는 HTTPS를 사용합니다. 학습 종료 후 웹에서 연결을 끄세요.

## Firebase 외부 서버 — 05

Shield 계정·등록 코드는 **사용하지 않습니다**. APN은 포함되어 있으나 목적지가 본인 Firebase이므로 외부 설정은 필요합니다.
`config.example.h`를 `config.h`로 복사하여 **Firebase 호스트·경로·실습 장치 이름·새 비밀값**을 입력합니다.
이 값은 본인이 Firebase 실습에서 만든 것이며 Shield 웹에서 발급받는 값이 아닙니다. `firebase/README.md`의 배포 절차를 따르세요.
Firebase 서비스 계정 JSON, 로그인 비밀번호, Shield 등록 코드는 펌웨어에 넣지 않습니다. config.h와 비밀값을 공유하지 마세요.

### Firebase CA 설치 (05만 최초 한 번)

1. ZIP의 `01_connection/01_connection.ino`를 업로드하고 READY 확인 후 모니터를 닫습니다.
2. PC에 Python 3.10 이상과 `python -m pip install pyserial==3.5`를 준비합니다.
3. 실제 함수 호스트에 대해 아래 명령을 실행합니다. 첫 명령이 출력한 SHA256과 실제 COM 포트를 사용하세요.

```powershell
python tools/fetch_ca.py --host YOUR_FUNCTION_HOST --out firebase-root.pem
python tools/install_ca.py --port COMx --pem firebase-root.pem --sha256 YOUR_PRINTED_SHA256 --name firebase-example-ca.pem
```

4. Installed 확인 후 05_firebase.ino를 올립니다. 서버 체인이 달라지면 신뢰 관계를 다시 확인합니다.
5. TLS 또는 날짜 검사를 끄는 우회는 사용하지 않습니다. 실물 모뎀 검증은 PC TLS 검증과 별개입니다.

## 검증 범위

UNO R3 컴파일·파서/모뎀 응답 시뮬레이션·격리 서버 수신 규격을 검사합니다.
**이 v3 교육용 스케치를 실제 장치에 업로드한 LTE/TLS 검증은 아직 하지 않았습니다.**
사용자 Firebase 프로젝트 생성·과금 동의·배포는 해당 사용자가 수행합니다.
01/02/03은 서버 전송이 없으므로 서버 카드·지도에 값이 나타나지 않는 것이 정상입니다.
