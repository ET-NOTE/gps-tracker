# 간편 HTTP 페어링: 교육용 UID로 LTE 상태 보내기

Arduino UNO R3 + SIM7080G에서 인증서·NTP·운영 장치키 없이 첫 HTTP 전송을 배웁니다.
GPS의 UID 연결과 비슷한 사용법이지만 **계정과 데이터는 Shield에만 저장**됩니다.
목적지는 `http://shield.serial.kr/ingest/shield-demo`로 고정되어 있습니다.

## 준비

1. 전원을 끄고 UNO R3에 쉴드·LTE 안테나·USIM을 연결합니다. 제품 규격의 전원을 사용합니다.
   UNO 3.3V 핀으로 모뎀을 구동하지 않습니다. 별도 센서는 필요 없습니다.
2. https://shield.serial.kr 에 로그인합니다. 내 장치에서 제품의 등록 코드로 장치를 등록합니다.
3. 해당 장치의 **HTTP 학습 연결 → 24시간 켜고 UID 발급**을 누릅니다.
   `demo-`로 시작하는 교육용 UID가 한 번 표시됩니다. 일반 장치 UID/등록 코드/장치키와 다릅니다.
4. 전체 ZIP을 풀어 `08_shield_http_pairing/08_shield_http_pairing.ino`를 엽니다. src 폴더를 유지합니다.
5. `config.example.h`를 `config.h`로 복사하고 APN과 교육용 UID만 넣습니다.
   1NCE APN은 `iot.1nce.net`입니다. 다른 USIM은 사업자가 안내한 APN을 사용합니다.
6. Arduino AVR Boards → Arduino Uno와 COM 포트를 선택하고 업로드합니다.
   시리얼 모니터는 115200 baud입니다. SoftwareSerial은 보드 코어에 포함됩니다.
7. `[HTTP] 200`과 내 장치의 마지막 수신을 확인합니다. 내 데이터의 상세 로그에도 수신됩니다.
8. 학습이 끝나면 **HTTP 학습 연결 → 학습 연결 끄기**를 누릅니다.

## 어떤 값을 보내나요?

실제 CSQ(신호), 망 등록 상태, UNO 가동 시간만 60초 대기 + 통신 처리 주기로 보냅니다.
`shield_v=2`, `build_tag=example-http-8`, `diag.gnss=0`, `points=[]`를 사용합니다.
센서·GPS·배터리 값을 만들지 않습니다. 센서 카드와 지도에 값이 없는 것이 정상입니다.
서버는 HTTP 경로에서 온습도·GPS·임의 센서·전압 전송을 거절합니다.
수신 시각은 서버가 기록하므로 NTP가 필요하지 않습니다.

## HTTP와 교육용 UID의 범위

HTTP 본문은 암호화되지 않습니다. UID를 가로채거나 전달받은 사람도 만료 전까지
이 장치에 학습용 상태를 보낼 수 있습니다. 이 예제는 보안 인증을 대신하지 않습니다.
개인정보·위치·센서 운영 데이터에는 기존 HTTPS 예제를 사용하세요.

- 기본값은 꺼짐입니다. 로그인한 소유자만 장치별로 켤 수 있습니다.
- UID는 24시간 후 만료됩니다. 재발급 시 이전 UID는 즉시 폐기됩니다.
- 서버에는 UID 원문 대신 해시만 저장합니다. 설정 화면에서는 재조회할 수 없습니다.
- 교육용 UID는 계정 로그인·장치 등록·결제·USIM 충전에 사용할 수 없습니다.
- 기존 64자 운영 장치키를 이 예제에 넣지 마세요. `config.h`나 UID 화면을 공개하지 마세요.
- 새 HTTP 드라이버는 모뎀의 TLS 설정과 인증서 파일을 변경하지 않습니다.
- 다른 예제 01~07은 그대로 유지됩니다. HTTPS 예제가 실패할 때 자동으로 HTTP로 전환하지 않습니다.

## 오류 확인

| 표시 | 조치 |
|---|---|
| CONFIG / STOP | APN과 demo-UID 설정 후 UNO 리셋 |
| MODEM | 전원·D6/D7/D8/D9·UART 속도 확인 |
| SIM | USIM 삽입·개통·PIN 확인 |
| NET | APN·안테나·망 등록·잔량 확인 |
| HTTP 200 | 접수 완료; 내 장치에서 마지막 수신 확인 |
| HTTP 401 | 만료·끄기·재발급 여부 확인; 새 UID로 config.h 수정 후 업로드 |
| HTTP 400 / 413 | 교육용 규격·본문 크기 확인 |
| HTTP 429 | 장치당 15분 30회 제한. 예제가 15분 대기 후 다음 상태를 전송 |
| HTTP 3xx | 주소 정책 확인. 스케치는 다른 주소로 재전송하지 않고 정지 |
| HTTP CONNECT / SEND | 통신 상태 확인. 응답 경계가 불명확하면 리셋 필요 |

실패한 표본을 저장하지 않으며 즉시 중복 재전송하지 않습니다.
이 스케치의 **실물 LTE 전송은 아직 검증 전**입니다. 컴파일·모뎀 응답 시뮬레이션과
격리 서버 규격을 검사하며, 실제 장치에는 자동 업로드하지 않습니다.

다음 단계: https://shield.serial.kr/examples/shield-uno-easy-https
공식 명령 참고: SIMCom HTTP(S) Application Note V1.02, AT Command Manual V1.03.
