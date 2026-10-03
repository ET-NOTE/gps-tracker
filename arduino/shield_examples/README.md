# Arduino UNO R3 · SIM7080G 쉴드 따라 하기

6개의 독립 예제입니다. 기존 `03_8`, 실물 시험용 `03_10`, KC 펌웨어를 바꾸거나 자동 업로드하지 않습니다.
각 ZIP을 풀고 **폴더 이름과 같은 .ino**를 Arduino IDE로 여세요. `src` 폴더도 함께 있어야 합니다.
저장소 원본을 받았다면 `python tools/package_examples.py`를 실행하여 `dist/`의 완성 스케치/ZIP을 만드세요.

| 순서 | 폴더 | 결과 | 외부 준비 |
|---|---|---|---|
| 1 | 01_connection | AT·SIM·망 상태, 인증서 설치용 브리지 | 쉴드·안테나·USIM |
| 2 | 02_dht11 | D2의 DHT11 온습도 시리얼 출력 | DHT 센서 라이브러리 |
| 3 | 03_gnss | SIM7080G 내장 GNSS 좌표·UTC·가시 위성 | GNSS 안테나·하늘 시야 |
| 4 | 04_shield_upload | HTTPS → Shield 내 데이터의 센서 카드·표 | 계정·장치 등록·UID/단말 키·APN·CA |
| 5 | 05_firebase | LTE HTTPS → Firebase 함수 → Firestore 최신 측정 | 사용자 소유 Firebase 프로젝트·배포·별도 장치 키·CA |
| 6 | 06_first_upload | 센서 없이 LTE 상태 → Shield 내 장치 | 계정·장치 등록·UID/단말 키·APN·CA |

## 공통 준비

1. Arduino IDE의 Boards Manager에서 **Arduino AVR Boards**, 보드 **Arduino Uno**를 선택합니다. UNO R4/ESP32-C3용이 아닙니다. 컴파일 확인 코어: 1.8.6.
2. 쉴드는 D6=DTR, D7=PWRKEY(NPN 드라이버, idle LOW), D8=UNO RX, D9=UNO TX입니다. 현재 실물 쉴드에 맞춰 D6 HIGH를 유지합니다. 다른 리비전은 회로를 먼저 확인하세요.
3. 쉴드를 장착/배선할 때 전원을 끕니다. 모뎀은 쉴드가 지정한 전원 입력을 사용하세요. UNO 3.3V 핀에서 모뎀에 전원을 공급하지 않습니다. USB만으로 송신 시 전압이 떨어지면 쉴드 규격에 맞는 외부 전원을 사용합니다.
4. LTE·GNSS 안테나를 각각 해당 커넥터에 연결합니다. 이 쉴드는 별도 L80 GPS가 아니라 SIM7080G 내장 GNSS를 사용합니다.
5. USB 포트를 선택하고 예제를 업로드합니다. 시리얼 모니터는 **115200 baud**, 모뎀 UART는 9600입니다. 업로드할 때 모니터와 인증서 설치 프로그램이 COM 포트를 잡고 있지 않아야 합니다.
6. 예제 2/4/5는 Library Manager에서 **DHT sensor library by Adafruit**와 의존성 **Adafruit Unified Sensor**를 설치하세요. 검증 버전은 1.4.6 / 1.1.15입니다.

## placeholder와 키

예제 4/5/6의 `config.example.h`를 같은 폴더의 `config.h`로 복사합니다. `YOUR_*`를 본인 값으로 바꿉니다. placeholder 상태도 컴파일되지만 전송은 `[STOP]`으로 중단됩니다. `config.h`는 Git 제외 대상입니다.

- `SHIELD_APN`: USIM 사업자의 APN. 1NCE는 `iot.1nce.net`이지만 다른 USIM에 그대로 쓰지 않습니다.
- `SHIELD_UID`/`SHIELD_KEY`: Shield 장치 프로비저닝으로 발급된 값. 키는 소문자 16진수 64자입니다. 로그인 비밀번호, ICCID, 일회용 등록 코드와 다릅니다. 내 장치에서 먼저 본인 계정에 등록해야 합니다. 키를 받지 못했다면 운영자에게 발급 자료를 요청하세요. 예제에 다른 사람의 시험 키를 복사하지 않습니다.
- `FIREBASE_DEVICE_ID`/`FIREBASE_DEVICE_KEY`: 사용자 Firebase 예제 전용으로 새로 만드는 값. Shield 키나 Firebase 서비스 계정 JSON을 넣지 않습니다.
- 전송 주기는 기본 60초 **대기 + 망/NTP/HTTPS 처리 시간**입니다. 실시간 1초 스트리밍이나 전송 보장 큐가 아닙니다. 실패 시 다음 주기에 새 표본을 측정합니다.

## TLS 루트 CA 설치 (예제 4/5/6 최초 한 번)

PC에 Python 3.10 이상을 설치하고 `python -m pip install pyserial==3.5`를 실행합니다.
아래 `COMx`는 실제 포트, Firebase 호스트는 배포 결과의 도메인으로 바꿉니다.

1. `01_connection`을 UNO에 업로드하고 `[READY]`를 확인합니다. 시리얼 모니터를 닫습니다.
2. 압축 해제한 패키지의 `tools`가 있는 폴더에서 실행합니다. 공식 CA만 다운로드하고 PC에서 TLS 1.2 인증서 체인/호스트명을 검증해 선택합니다. 이 과정은 HTTP 데이터/키를 보내지 않습니다.

```powershell
# Shield 예제
python tools/fetch_ca.py --host shield.serial.kr --out shield-root.pem
# 또는 Firebase 예제 (배포한 실제 호스트)
python tools/fetch_ca.py --host YOUR_FUNCTION_HOST --out firebase-root.pem
```

3. 출력의 SHA256을 그대로 다음 명령에 넣습니다. 설치할 파일명은 펌웨어의 CA 설정과 같아야 합니다.

```powershell
python tools/install_ca.py --port COMx --pem shield-root.pem --sha256 YOUR_PRINTED_SHA256 --name shield-example-ca.pem
# Firebase용은 별도 파일명
python tools/install_ca.py --port COMx --pem firebase-root.pem --sha256 YOUR_PRINTED_SHA256 --name firebase-example-ca.pem
```

4. `Installed`를 확인한 후 예제 4, 5 또는 6을 업로드합니다. 설치 과정은 UNO를 리셋하고 READY를 기다립니다. 모뎀 파일 저장 영역의 **예제 전용 이름**에만 쓰며 기존 시험 장치의 `shield-ca.pem`을 덮어쓰지 않습니다.
5. 인증서 오류에는 올바른 CA·NTP 시각·호스트를 확인합니다. `SHSSL=0`, 빈 CA, 날짜 검사 무시는 사용하지 않습니다. 서버 체인이 바뀌면 새 이름으로 CA를 다시 받아 검증/설치하세요. PC 검증은 실물 모뎀의 TLS 호환성 검증을 대신하지 않습니다.

## 출력 읽기

| 출력 | 의미 / 확인할 것 |
|---|---|
| SIM=READY | SIM 인식 성공. 인터넷 성공을 뜻하지 않습니다. |
| CEREG=1 / 5 | 홈망 / 로밍 등록. 2는 탐색, 3은 거절, -1은 미확인입니다. |
| CSQ=99 | 신호 미확인. 0 dBm로 읽지 않습니다. |
| HTTP -1 | 망·시각·TLS·모뎀 응답 실패. 성공으로 처리하지 않습니다. |
| HTTP 200 | 서버가 측정을 접수했습니다. 해당 서비스의 화면에서 확인하세요. |
| 400 | 페이로드/시각/범위 확인. |
| 401 / 403 | 해당 서비스의 장치 UID/키·접근 설정 확인. |
| 409 | Shield 장치 등록 미완료 또는 Firebase 오래된/충돌 표본. |
| 429 | 전송을 줄이고 기다리세요. 즉시 재전송하지 않습니다. |
| 5xx | 서버 설정/일시 장애 확인. Firebase는 함수 로그를 확인합니다. |

## 센서 없이 첫 전송 (예제 6)

처음 시작한다면 장치 등록 → `01_connection`으로 CA 설치 → `06_first_upload` 순서로 진행합니다.
06 ZIP에는 인증서 설치에 필요한 01_connection 스케치도 포함되어 있습니다.
전송 설정은 예제 4와 같지만 DHT 라이브러리나 추가 센서는 필요 없습니다. 실제 모뎀의 CSQ와 망 등록 상태만 보냅니다.
HTTP 200 후 **내 장치의 마지막 수신 시각·LTE·최근 데이터**를 확인합니다. 온습도와 GPS 좌표는 보내지 않으므로 해당 카드·지도는 비어 있어도 정상입니다.
단말 키는 상품과 함께 발급된 본인 값만 사용합니다. 등록 코드나 로그인 비밀번호로 대체할 수 없습니다.

## 검증 범위와 출처

신규 예제는 UNO 컴파일과 파서/서버 검사로 확인합니다. 기존 v12에서 확인한 AT/TLS 흐름을 참고했지만 **이번 예제를 실물에 업로드하거나 사용자 Firebase 프로젝트에 배포하지 않습니다**. GNSS는 새 유효 표본만 출력하며 가시 위성 수는 사용 위성 수와 다릅니다. 예제 4/5는 온습도만 전송하고 GNSS를 꺼 LTE 통신과 겹치지 않게 합니다.

- [SIMCom HTTP(S) Application Note](https://files.waveshare.com/wiki/SIM7070G%20Cat-MNB-IoT-GPRS-HAT/SIM7070_SIM7080_SIM7090_Series_HTTP%28S%29_Application_Note_V1.02.pdf)
- [Arduino SoftwareSerial](https://docs.arduino.cc/learn/built-in-libraries/software-serial/)
- [Adafruit DHT 라이브러리](https://github.com/adafruit/DHT-sensor-library)
- [Firebase HTTPS 함수](https://firebase.google.com/docs/functions/http-events)
- [Firebase Secret Manager 설정](https://firebase.google.com/docs/functions/config-env)
- [Firebase 시작/배포](https://firebase.google.com/docs/functions/get-started)
- [Google Trust Services 루트](https://pki.goog/repository/), [ISRG 루트](https://letsencrypt.org/certificates/)

글과 배선/IDE/Firebase 화면의 `(이미지)` 위치는 운영자가 실제 캡처로 채웁니다.
